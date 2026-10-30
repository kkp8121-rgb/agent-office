// Coins, shop, storage and decorating (the page side). Server state arrives by the `shop` and `earn` events; every change goes
// through the shop API, so the person's screen only previews (with the same placement rule the server enforces).
// No frame loop and no polling: the work is event handlers; drag work exists only while a pointer is down in 꾸미기 mode.
import { checkPlacement } from './placement.mjs';
import { buyBlock, changedDesigns, ownedList } from './decor.mjs';

const $ = (id) => document.getElementById(id);
const DRAG_CLICK_PX = 4; // a press that moved less than this is a click (select), not a drag
const imgUrl = (id) => `/assets/decor/${id}.png`;

/**
 * @param {{ui: () => object, floorRecs: Map<string, object>, floorsEl: HTMLElement, pipOpen: () => boolean,
 *          applyDecor: (designs: string[], placed: object) => void, setPlayOff: (off: boolean) => void}} ctx
 */
export function createShop(ctx) {
  const coinsEl = $('coins');
  const numEl = $('coin-n');
  const shopEl = $('shop');
  const titleEl = $('shop-title');
  const hintEl = $('shop-hint');
  const storeSec = $('shop-store');
  const listEl = $('shop-list');
  const invListEl = $('inv-list');
  const invEmptyEl = $('inv-empty');
  const openBtn = $('shop-open');
  const decorBtn = $('decorate');
  const toastEl = $('toast');

  let state = null; // {coins, inventory, placed}
  let catalog = [];
  let kinds = new Map(); // id -> catalog entry
  const rows = new Map(); // item id -> {buy, why}
  const tiles = new Map(); // item id -> {el, count}
  const floats = new Set();
  let decorating = false;
  let modeAc = null; // aborts every listener that exists only in 꾸미기 mode
  let modeListeners = 0;
  let drag = null;
  let sel = null; // {uid, design, btn}
  let toastTimer = 0;

  const sizeOf = (id) => ctx.ui().ui.decor.items[id];
  const nameOf = (id) => kinds.get(id)?.name ?? id;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ctx.ui().ui.decor.toastMs);
  }

  /** POSTs to the shop API. Shows the server's Korean message when it refuses. Returns the answer or null. */
  async function call(path, body) {
    let res;
    try {
      res = await fetch(`/api/shop/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      toast('서버에 연결하지 못했어요');
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      toast(json?.message ?? '처리하지 못했어요');
      return null;
    }
    if (json.shop) apply(json.shop);
    return json;
  }

  // ---------- counter and floats ----------

  function bump() {
    coinsEl.classList.remove('bump');
    void coinsEl.offsetWidth;
    coinsEl.classList.add('bump');
  }

  /** "+10" rises from the character who finished (or from its floor, or the middle of the window) and flies to the counter. */
  function earn(e) {
    numEl.textContent = String(e.coins);
    const doc = ctx.floorsEl.ownerDocument;
    const win = doc.defaultView;
    const D = ctx.ui().ui.decor;
    if (floats.size >= D.maxFloats || (doc === document && document.body.classList.contains('paused'))) return bump();
    const frec = e.sessionId ? ctx.floorRecs.get(e.sessionId) : null;
    let sx = win.innerWidth / 2;
    let sy = win.innerHeight / 2;
    if (frec) {
      const rec = e.key ? frec.agents.get(e.key) : null;
      const box = frec.stage.getBoundingClientRect();
      const k = box.width / frec.scene.r.size[0];
      const at = rec ? [rec.x, rec.y - 70] : [frec.scene.r.door.at[0], frec.scene.r.door.at[1] - 70];
      sx = box.left + at[0] * k;
      sy = box.top + at[1] * k;
    }
    const to = coinsEl.getBoundingClientRect();
    const f = doc.createElement('div');
    f.className = 'coinfloat';
    f.textContent = `+${e.amount}`;
    f.style.left = `${sx}px`;
    f.style.top = `${sy}px`;
    f.style.setProperty('--dx', `${to.left + to.width / 2 - sx}px`);
    f.style.setProperty('--dy', `${to.top + to.height / 2 - sy}px`);
    f.style.setProperty('--ms', `${D.floatMs}ms`);
    f.addEventListener('animationend', () => {
      f.remove();
      floats.delete(f);
      bump();
    }, { once: true });
    doc.body.append(f);
    floats.add(f);
  }

  /** Hidden tab or closed small window: a float whose animation can no longer end would stay. */
  function clearFloats() {
    for (const f of floats) f.remove();
    floats.clear();
  }

  // ---------- shop panel ----------

  function buildPanel() {
    for (const c of catalog) {
      const li = document.createElement('li');
      li.className = 'si';
      const img = document.createElement('img');
      img.src = imgUrl(c.id);
      img.alt = '';
      const info = document.createElement('div');
      info.className = 'si-t';
      const nm = document.createElement('b');
      nm.textContent = c.name;
      const pr = document.createElement('span');
      pr.textContent = `${c.price} 코인`;
      const why = document.createElement('em');
      why.id = `why-${c.id}`;
      info.append(nm, pr, why);
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.className = 'mini';
      buy.textContent = '사기';
      buy.setAttribute('aria-describedby', why.id);
      buy.addEventListener('click', () => call('buy', { item: c.id }));
      li.append(img, info, buy);
      listEl.append(li);
      rows.set(c.id, { buy, why });

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'inv';
      tile.hidden = true;
      const timg = document.createElement('img');
      timg.src = imgUrl(c.id);
      timg.alt = '';
      timg.draggable = false;
      const tn = document.createElement('span');
      tn.textContent = c.name;
      const cnt = document.createElement('i');
      tile.append(timg, tn, cnt);
      tile.addEventListener('pointerdown', (e) => {
        if (decorating) startDrag(e, tile, c.id, null);
      });
      invListEl.append(tile);
      tiles.set(c.id, { el: tile, cnt });
    }
  }

  function renderPanel() {
    for (const c of catalog) {
      const why = buyBlock(state.coins, c.price);
      const row = rows.get(c.id);
      row.buy.disabled = why !== '';
      row.why.textContent = why;
    }
    const owned = new Map(ownedList(catalog, state.inventory).map((o) => [o.id, o.count]));
    for (const [id, t] of tiles) {
      const n = owned.get(id) ?? 0;
      t.el.hidden = n === 0;
      t.cnt.textContent = `×${n}`;
      t.el.disabled = !decorating;
      t.el.title = decorating ? '방 바닥으로 끌어다 놓으세요' : '꾸미기를 켜면 방에 놓을 수 있어요';
    }
    invEmptyEl.hidden = owned.size > 0;
  }

  function renderMode() {
    document.body.classList.toggle('decorating', decorating);
    decorBtn.setAttribute('aria-pressed', String(decorating));
    decorBtn.textContent = decorating ? '꾸미기 끝내기' : '꾸미기';
    titleEl.textContent = decorating ? '꾸미기' : '상점';
    storeSec.hidden = decorating;
    hintEl.textContent = decorating ? '보관함의 가구를 방 바닥으로 끌어다 놓으세요. 놓인 가구는 끌어서 옮기고, 눌러서 「보관함에 넣기」를 할 수 있어요.' : '';
    openBtn.setAttribute('aria-expanded', String(!shopEl.hidden));
    if (state) renderPanel();
  }

  // ---------- state from the server ----------

  function apply(data) {
    const prev = state;
    state = { coins: data.coins, inventory: data.inventory ?? {}, placed: data.placed ?? {} };
    numEl.textContent = String(state.coins);
    renderPanel();
    const changed = changedDesigns(prev?.placed, state.placed);
    if (changed.length) ctx.applyDecor(changed, state.placed);
    if (sel) refreshSel();
  }

  async function load() {
    let data;
    try {
      const res = await fetch('/api/shop');
      if (!res.ok) return false; // an office without a shop: no counter, no buttons
      data = await res.json();
    } catch {
      return false;
    }
    catalog = data.catalog;
    kinds = new Map(catalog.map((c) => [c.id, c]));
    buildPanel();
    coinsEl.hidden = false;
    openBtn.hidden = false;
    decorBtn.hidden = false;
    openBtn.addEventListener('click', () => {
      if (decorating) return setDecorating(false);
      shopEl.hidden = !shopEl.hidden;
      renderMode();
    });
    decorBtn.addEventListener('click', () => setDecorating(!decorating));
    $('shop-close').addEventListener('click', () => {
      if (decorating) setDecorating(false);
      shopEl.hidden = true;
      renderMode();
    });
    apply(data);
    return true;
  }

  // ---------- decorating ----------

  function listen(target, type, fn) {
    target.addEventListener(type, fn, { signal: modeAc.signal });
    modeListeners++;
  }

  function setDecorating(on) {
    if (on === decorating || !state) return;
    if (on && ctx.pipOpen()) return toast('작은 창을 닫은 뒤에 꾸밀 수 있어요');
    decorating = on;
    if (on) {
      modeAc = new AbortController();
      modeListeners = 0;
      ctx.setPlayOff(true);
      shopEl.hidden = false;
      listen(ctx.floorsEl, 'pointerdown', onFloorDown);
      listen(document, 'keydown', (e) => {
        if (e.key === 'Escape') (drag ? cancelDrag : () => setDecorating(false))();
      });
    } else {
      cancelDrag();
      clearSel();
      modeAc.abort();
      modeAc = null;
      modeListeners = 0;
      ctx.setPlayOff(false);
    }
    renderMode();
  }

  const designOf = (uid) => Object.keys(state.placed).find((d) => state.placed[d].some((p) => p.uid === uid)) ?? null;

  function floorAt(cx, cy) {
    for (const frec of ctx.floorRecs.values()) {
      const b = frec.stage.getBoundingClientRect();
      if (cx >= b.left && cx < b.right && cy >= b.top && cy < b.bottom) return frec;
    }
    return null;
  }

  function makeGhost(item) {
    const k = kinds.get(item);
    const s = sizeOf(item);
    const g = document.createElement('div');
    g.className = 'ghost';
    const img = document.createElement('img');
    img.src = imgUrl(item);
    img.alt = '';
    Object.assign(img.style, { left: `${-s.anchor[0]}px`, top: `${-s.anchor[1]}px` });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'gfoot');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', k.footprint.map((p) => p.join(',')).join(' '));
    svg.append(poly);
    g.append(img, svg);
    return g;
  }

  function startDrag(e, cap, item, uid) {
    if (drag || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    cap.setPointerCapture(e.pointerId);
    const ac = new AbortController();
    drag = { id: e.pointerId, item, uid, cap, ghost: makeGhost(item), x0: e.clientX, y0: e.clientY, moved: false, off: [0, 0], frec: null, pos: '', res: null, ac, source: uid ? [...ctx.floorsEl.querySelectorAll(`.decor[data-uid="${uid}"]`)] : [] };
    for (const s of drag.source) s.classList.add('lifted');
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) cap.addEventListener(type, onDrag, { signal: ac.signal });
    clearSel();
    if (uid) drag.off = grabOffset(e, uid); // a placed item moves by where it was grabbed, not by its contact point
    onDrag(e);
  }

  /** Scene-pixel distance from the pointer to the item's contact point. */
  function grabOffset(e, uid) {
    const frec = floorAt(e.clientX, e.clientY);
    const p = frec && state.placed[frec.design]?.find((q) => q.uid === uid);
    if (!p) return [0, 0];
    const box = frec.stage.getBoundingClientRect();
    const k = box.width / frec.scene.r.size[0];
    return [p.x - (e.clientX - box.left) / k, p.y - (e.clientY - box.top) / k];
  }

  function onDrag(e) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (e.type === 'pointercancel' || e.type === 'lostpointercapture') return cancelDrag();
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) >= DRAG_CLICK_PX) d.moved = true;
    if (e.type === 'pointerup') return endDrag(e);
    const frec = floorAt(e.clientX, e.clientY);
    if (!frec) {
      // outside every floor: the picture just follows the pointer
      if (d.frec || !d.ghost.isConnected) document.body.append(d.ghost);
      d.frec = null;
      d.res = null;
      d.pos = '';
      d.ghost.classList.add('free');
      d.ghost.classList.remove('ok', 'bad');
      Object.assign(d.ghost.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
      return;
    }
    const box = frec.stage.getBoundingClientRect();
    const k = box.width / frec.scene.r.size[0];
    const x = Math.round((e.clientX - box.left) / k + d.off[0]);
    const y = Math.round((e.clientY - box.top) / k + d.off[1]);
    if (d.frec !== frec) {
      frec.stage.append(d.ghost);
      d.frec = frec;
      d.pos = '';
      d.ghost.classList.remove('free');
    }
    Object.assign(d.ghost.style, { left: `${x}px`, top: `${y}px` });
    if (d.pos === `${x},${y}`) return;
    d.pos = `${x},${y}`;
    d.res = verdict(frec, d, x, y);
    d.ghost.classList.toggle('ok', d.res.ok);
    d.ghost.classList.toggle('bad', !d.res.ok);
    hintEl.textContent = d.res.ok ? '여기에 놓을 수 있어요' : d.res.message;
  }

  /** The same rule the server applies (placement.mjs), run on the room this floor shows. */
  function verdict(frec, d, x, y) {
    if (d.uid && designOf(d.uid) !== frec.design) return { ok: false, message: '같은 방 안에서만 옮길 수 있어요. 보관함에 넣었다가 다시 놓아 주세요' };
    const here = (state.placed[frec.design] ?? []).filter((p) => p.uid !== d.uid);
    return checkPlacement(frec.scene.r, ctx.ui().nav, kinds, here, { item: d.item, x, y });
  }

  function dragCleanup() {
    const d = drag;
    drag = null;
    d.ac.abort();
    if (d.cap.hasPointerCapture(d.id)) d.cap.releasePointerCapture(d.id);
    d.ghost.remove();
    for (const s of d.source) s.classList.remove('lifted');
    return d;
  }

  function cancelDrag() {
    if (drag) dragCleanup();
    if (decorating) renderMode();
  }

  async function endDrag(e) {
    const d = dragCleanup();
    renderMode();
    if (d.uid && !d.moved) return select(d.uid); // a click on a placed item
    const over = shopEl.getBoundingClientRect();
    const onPanel = !shopEl.hidden && e.clientX >= over.left && e.clientX <= over.right && e.clientY >= over.top && e.clientY <= over.bottom;
    if (onPanel) {
      if (d.uid) await call('store', { uid: d.uid });
      return;
    }
    if (!d.frec || !d.res) return;
    if (!d.res.ok) return toast(d.res.message);
    const [x, y] = d.pos.split(',').map(Number);
    if (d.uid) await call('move', { uid: d.uid, x, y });
    else await call('place', { item: d.item, design: d.frec.design, x, y });
  }

  function onFloorDown(e) {
    const decor = e.target.closest?.('.decor');
    if (decor) return startDrag(e, decor, decor.dataset.item, decor.dataset.uid);
    if (!e.target.closest?.('.decor-store')) clearSel();
  }

  // ---------- selected item: the 「보관함에 넣기」 control ----------

  function select(uid) {
    clearSel();
    const design = designOf(uid);
    const frec = [...ctx.floorRecs.values()].find((f) => f.design === design && f.decorEls.has(uid));
    if (!frec) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'decor-store';
    btn.textContent = '보관함에 넣기';
    btn.addEventListener('click', async () => {
      const id = sel?.uid;
      clearSel();
      if (id) await call('store', { uid: id });
    });
    frec.stage.append(btn);
    sel = { uid, design, btn };
    refreshSel();
    btn.focus({ preventScroll: true });
  }

  /** Puts the control above the selected item again (it moved), or drops it when the item is gone. */
  function refreshSel() {
    const frec = [...ctx.floorRecs.values()].find((f) => f.design === sel.design && f.decorEls.has(sel.uid));
    const n = frec?.scene.decorNodes.find((q) => q.uid === sel.uid);
    if (!n || !decorating) return clearSel();
    if (sel.btn.parentNode !== frec.stage) frec.stage.append(sel.btn);
    Object.assign(sel.btn.style, { left: `${n.x + n.w / 2}px`, top: `${n.y - 4}px` });
  }

  function clearSel() {
    sel?.btn.remove();
    sel = null;
  }

  return {
    load, apply, earn, clearFloats, kinds: () => kinds,
    forceOut: () => setDecorating(false),
    debug: () => ({ decorating, listeners: modeListeners, drag: !!drag, floats: floats.size, sel: sel?.uid ?? null, coins: state?.coins, state }),
  };
}
