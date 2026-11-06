// Area "empty": the screen for an office without session floors (one of three designs, see web/empty-view.mjs and config.json ui.empty).
// It draws one box over the building column (class em-root, role="status") and is told by the building view (ctx.building.setEmptyRenderer)
// whenever the floor count or the shown view may have changed; the old one-line notice is hidden as soon as this area is registered.
// The rooms are drawn from the scene data the server sends (the same picture + object rules as a real floor, no characters, nothing that moves);
// the only motion is CSS (empty.css) and only while the effects are on (html.fx-on). Nothing here runs on a timer or on frames.
import { resolveScene } from './scene.mjs';
import { objectNodes } from './depth.mjs';
import { catPoint, queryOf, resolveEmpty, stackRooms } from './empty-view.mjs';

const BUILDING = '/assets/building/';
const CAT_SLEEP = '/assets/sprites/cat-sleep.png';
const LOBBY = 'lobby';
const CEO = 'ceo';
const READY_ATTR = 'ready'; // data-ready="1" once every picture of the box has loaded (the capture script waits for it)

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.empty;
  if (!cfg) return;
  const doc = globalThis.document;
  const win = globalThis.window;
  const appEl = doc.getElementById('app');
  const floorsEl = doc.getElementById('floors');
  const panelEl = doc.getElementById('panel');
  const query = queryOf(win.location.search);
  let last = { floorCount: 0, view: 'building' };
  let root = null;
  let builtKey = '';

  const mk = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const px = (e, o) => {
    for (const [k, v] of Object.entries(o)) e.style[k] = typeof v === 'number' ? `${v}px` : v;
  };
  const img = (src, cls) => {
    const e = mk('img', cls);
    e.alt = '';
    e.draggable = false;
    e.src = src;
    return e;
  };

  /** The box the screen covers: the part of the page left of the side panel (the whole width when the panel sits below), as high as the building column. */
  function measure() {
    const app = appEl.getBoundingClientRect();
    const fl = floorsEl.getBoundingClientRect();
    const pn = panelEl.getBoundingClientRect();
    const cs = win.getComputedStyle(appEl);
    const pad = Number.parseFloat(cs.paddingLeft) || 0;
    const gap = Number.parseFloat(cs.columnGap) || 0;
    const beside = pn.left >= fl.right;
    const w = beside ? pn.left - gap - app.left - pad : app.width - pad - pad;
    const h = fl.height > 0 ? fl.height : win.innerHeight - fl.top - pad;
    return { left: pad, top: fl.top - app.top, w: Math.max(w, 0), h: Math.max(h, 0) };
  }

  // ---------- rooms (drawn from the scene data) ----------

  const sizeOf = (design) => ctx.server.scenes?.[design]?.size ?? null;

  /** One room of the server's scene list as a scaled slot: its picture and objects like a real floor's stage, no people. Null when the scene is not there. */
  function room(design, k, left, top, light, urls) {
    const raw = ctx.server.scenes?.[design];
    if (!raw) return null;
    const r = resolveScene(raw);
    const [w, h] = r.size;
    const file = (name) => `${raw.url}${encodeURIComponent(name)}`;
    const stage = mk('div', 'stage scened');
    stage.dataset.light = light;
    urls.push(file(r.shell), file(r.atlas));
    if (r.view) {
      const { origin: [vx, vy], size: [vw, vh] } = r.view;
      stage.classList.add('viewed');
      stage.style.setProperty('--shell', `url(${file(r.shell)})`);
      stage.style.setProperty('--view-day', `url(${file(r.view.day)})`);
      stage.style.setProperty('--view-night', `url(${file(r.view.night)})`);
      stage.style.setProperty('--view-hz', `${(((r.view.horizon - vy) / vh) * 100).toFixed(1)}%`);
      stage.style.backgroundPosition = `0 0, ${vx}px ${vy}px, ${vx}px ${vy}px`;
      stage.style.backgroundSize = `${w}px ${h}px, ${vw}px ${vh}px, ${vw}px ${vh}px`;
      urls.push(file(r.view.day), file(r.view.night));
    } else {
      stage.style.backgroundImage = `url(${file(r.shell)})`;
      stage.style.backgroundSize = `${w}px ${h}px`;
    }
    stage.style.setProperty('--atlas', `url(${file(r.atlas)})`);
    for (const n of objectNodes(r, ctx.server.depth)) {
      const d = mk('div', n.flipX ? 'obj flip' : 'obj');
      px(d, { left: n.x, top: n.y, width: n.w, height: n.h, backgroundPosition: `${-n.bgX}px ${-n.bgY}px`, zIndex: String(n.z) });
      stage.append(d);
    }
    if (r.front) {
      const front = mk('div', 'front');
      front.style.backgroundImage = `url(${file(r.front)})`;
      front.style.zIndex = String(ctx.server.depth.frontZ);
      stage.append(front);
      urls.push(file(r.front));
    }
    if (r.outline) stage.style.setProperty('--bd-clip', `path(evenodd, "M0 0H${w}V${h}H0Z M${r.outline.map((p) => p.join(' ')).join(' L')}Z")`);
    const slot = mk('div', 'em-slot');
    px(slot, { left, top, width: w * k, height: h * k });
    const fit = mk('div', 'em-fit');
    px(fit, { width: w, height: h });
    fit.style.transform = `scale(${k})`;
    fit.style.setProperty('--em-k', String(k));
    fit.append(stage);
    slot.append(fit);
    return { slot, fit, raw, r, k };
  }

  /** A dark film over a rectangle (decoration only). */
  const film = (cls, box) => {
    const e = mk('div', cls);
    px(e, box);
    return e;
  };

  // ---------- the three designs ----------

  /** (a) The lobby with its lights down, the cat asleep on the sofa and a standing sign on the front desk; the floors above and below are cut off in the dark. */
  function designA(box, light, urls, lines) {
    const lobbySize = sizeOf(LOBBY);
    if (!lobbySize) return [];
    const out = [];
    const k = box.w / lobbySize[0];
    const lobbyH = lobbySize[1] * k;
    const top = (box.h - lobbyH) / 2;
    const bottom = top + lobbyH;
    const ceoSize = sizeOf(CEO);
    const ceo = ceoSize && room(CEO, box.w / ceoSize[0], 0, 0, light, urls);
    if (ceo) {
      px(ceo.slot, { top: top - ceoSize[1] * ceo.k });
      out.push(ceo.slot);
    }
    const base = mk('div', 'em-a-base');
    px(base, { left: 0, top: bottom, width: box.w, height: box.h - bottom });
    urls.push(`${BUILDING}basement.png`);
    out.push(base);
    out.push(film('em-film em-film-up', { left: 0, top: 0, width: box.w, height: top }));
    out.push(film('em-film em-film-down', { left: 0, top: bottom, width: box.w, height: box.h - bottom }));
    const placed = room(LOBBY, k, 0, top, light, urls);
    const dim = mk('div', 'em-dim');
    dim.style.opacity = String(cfg.dimA);
    if (placed.r.outline) dim.style.clipPath = `polygon(${placed.r.outline.map((p) => `${p[0]}px ${p[1]}px`).join(', ')})`; // the film lies on the room only, not on the corners of its picture
    placed.fit.append(dim);
    const at = catPoint(cfg.catAt, placed.raw.spots);
    if (at) {
      const cat = mk('div', 'em-cat');
      px(cat, { left: at[0], top: at[1] });
      const zzA = mk('span', 'em-zz em-zz-a', 'z');
      const zzB = mk('span', 'em-zz em-zz-b', 'Z');
      zzA.setAttribute('aria-hidden', 'true'); // the sleeping letters are a picture, not words
      zzB.setAttribute('aria-hidden', 'true');
      cat.append(img(CAT_SLEEP, 'em-cat-img'), zzA, zzB);
      placed.fit.append(cat);
      urls.push(CAT_SLEEP);
    }
    const desk = (placed.raw.objects ?? []).find((o) => o.id === 'reception');
    if (desk) {
      const sign = mk('div', 'em-sign');
      px(sign, { left: desk.at[0], top: desk.at[1] });
      sign.append(mk('span', 'em-sign-t', lines[0]));
      placed.fit.append(sign);
    }
    out.push(placed.slot, mk('p', 'em-cap', lines[1]));
    return out;
  }

  /** (b) The building from outside: every window dark or blinded, the lobby windows lit, the sign board over the door carries the words. */
  function designB(box, light, urls, lines) {
    const night = light === 'night';
    const pic = mk('div', 'em-b-pic');
    pic.append(img(`${BUILDING}exterior-${night ? 'night' : 'day'}.png`, 'em-b-img'));
    urls.push(`${BUILDING}exterior-${night ? 'night' : 'day'}.png`);
    const board = mk('p', 'em-b-board', lines[0]);
    pic.append(board);
    const ground = mk('div', 'em-b-ground');
    ground.style.backgroundImage = `url(${BUILDING}exterior-${night ? 'night' : 'day'}.png)`;
    root.style.setProperty('--em-h', `${box.h}px`);
    return [ground, pic];
  }

  /** (c) The empty office on the floor under the boss room, lights on, nobody in it; a card stands where the whiteboard is. */
  function designC(box, light, urls, lines) {
    const out = [];
    const ceoSize = sizeOf(CEO);
    const readySize = sizeOf(cfg.readyDesign);
    if (!ceoSize || !readySize) return out;
    const baseSize = [ceoSize[0], ceoSize[0] / 6]; // the basement strip is a sixth as high as it is wide
    const stack = stackRooms(box.w, box.h, [ceoSize, readySize, baseSize]);
    const left = (box.w - stack.W) / 2;
    const top = (box.h - stack.height) / 2;
    const [rc, rr, rb] = stack.rooms;
    const upper = room(CEO, rc.k, left, top + rc.top, light, urls);
    const ready = room(cfg.readyDesign, rr.k, left, top + rr.top, light, urls);
    if (upper) {
      upper.fit.append(mk('div', 'em-dim em-dim-c'));
      out.push(upper.slot);
    }
    const base = mk('div', 'em-c-base');
    px(base, { left, top: top + rb.top, width: stack.W, height: rb.h });
    urls.push(`${BUILDING}basement.png`);
    out.push(base);
    if (ready) {
      out.push(ready.slot);
      const quad = ready.raw.whiteboard?.quad;
      const card = mk('div', 'em-card');
      if (quad) {
        const cx = quad.reduce((s, p) => s + p[0], 0) / quad.length;
        const cy = quad.reduce((s, p) => s + p[1], 0) / quad.length;
        card.style.setProperty('--em-x', `${left + cx * ready.k}px`);
        card.style.top = `${top + rr.top + cy * ready.k}px`;
      }
      const steps = mk('ol', 'em-card-steps');
      for (const s of lines.slice(2)) steps.append(mk('li', '', s));
      card.append(mk('div', 'em-card-hd', lines[0]), mk('p', 'em-card-tx', lines[1]), steps);
      root.style.setProperty('--em-w', `${stack.W}px`);
      root.style.setProperty('--em-l', `${left}px`);
      out.push(card);
    }
    return out;
  }

  // ---------- sync ----------

  function hide() {
    if (root) root.hidden = true;
    appEl.classList.remove('em-on');
  }

  function sync() {
    const res = resolveEmpty({ ...last, query, cfg });
    if (!res.show) {
      hide();
      return;
    }
    const box = measure();
    const light = ctx.light();
    const key = [res.variant, light, Math.round(box.w), Math.round(box.h), Math.round(box.top), cfg.catAt, ...res.lines].join('|');
    appEl.classList.add('em-on');
    if (root && key === builtKey) {
      root.hidden = false;
      return;
    }
    builtKey = key;
    root?.remove();
    root = mk('div', `em-root em-${res.variant}`);
    root.setAttribute('role', 'status');
    root.dataset.light = light === 'night' ? 'night' : 'day';
    px(root, { left: box.left, top: box.top, width: box.w, height: box.h });
    const urls = [];
    const parts = { a: designA, b: designB, c: designC }[res.variant](box, light, urls, res.lines);
    root.append(...parts);
    appEl.append(root);
    Promise.all(urls.map((u) => new Promise((done) => {
      const i = new win.Image();
      i.onload = done;
      i.onerror = done;
      i.src = u;
    }))).then(() => {
      if (root && builtKey === key) root.dataset[READY_ATTR] = '1';
    });
  }

  ctx.building.setEmptyRenderer((a) => {
    last = a;
    sync();
  });
  ctx.building.onLayout(sync);
  ctx.fx.onFx('daylight', sync, { always: true });
  win.addEventListener('resize', sync);
}
