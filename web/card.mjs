// The character card: a file folder with a form sheet that opens from a character's name tag (hover shows a small folder icon, a click opens).
// Pure rules first (what a click on a tag means, which fields the card shows, the signature, the fit scale, the open/close state), then the DOM.
//
// Nothing here runs while no card is open: the only standing code is the listeners of the tags themselves (bindTag). An open card listens
// for Esc / Tab / resize on its own document and removes them again on close. The live fields refresh when the office calls refreshCard()
// after a state update (no timers). Opening and closing animate transform and opacity only (Web Animations), and only while the
// effects switch is on and the viewer does not ask for reduced motion; otherwise the card appears and disappears at once.
import { fmtDuration, stateLabel } from './lobby.mjs';

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

// ---------- pure rules ----------

/**
 * What an event on a name tag means. `open`: this event opens the card (a primary click, Enter or Space). `stop`: the event must not travel on,
 * so a press on a tag never reaches a poke, lift, throw or drag handler of the character (the tag layer is a sibling of the body, this is the belt on top of the braces).
 * `prevent`: the browser's own default (scrolling on Space) must not happen.
 */
export function tagRoute(type, e = {}) {
  const none = { open: false, stop: false, prevent: false };
  switch (type) {
    case 'click':
      return { open: !e.button, stop: true, prevent: false };
    case 'keydown':
      if (e.altKey || e.ctrlKey || e.metaKey) return none;
      return e.key === 'Enter' || e.key === ' ' ? { open: true, stop: true, prevent: true } : none;
    case 'pointerdown':
    case 'pointerup':
    case 'pointercancel':
    case 'dblclick':
      return { open: false, stop: true, prevent: false };
    default:
      return none;
  }
}

/** Which card is open: one at a time. open(id) returns the id it replaced (or null); close() returns the id that was open (or null). */
export function createCardState() {
  let current = null;
  return {
    get current() {
      return current;
    },
    isOpen: () => current !== null,
    open(id) {
      const prev = current;
      current = id;
      return prev;
    },
    close() {
      const prev = current;
      current = null;
      return prev;
    },
  };
}

/** 32-bit FNV-1a of a text (by UTF-16 unit): the seed of a signature. */
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIGNATURE_BOX = Object.freeze({ w: 200, h: 64 });

/**
 * A scribbled signature drawn from the name (no font): {d, under} = two SVG path strings in a 200x64 box. The same name always gives the
 * same strokes, a different name gives different ones (one loop per letter, heights and slants from the name's hash).
 */
export function signature(name) {
  const rnd = mulberry32(hashText(name));
  const r = (n) => Math.round(n * 10) / 10;
  const n = Math.min(Math.max(Array.from(name).length + 1, 3), 6);
  const step = 176 / n;
  const base = 40;
  let x = 10;
  let d = `M${x} ${base}`;
  for (let i = 0; i < n; i++) {
    const up = 10 + rnd() * 26;
    const down = 4 + rnd() * 10;
    d += ` C${r(x + step * 0.15)} ${r(base - up)} ${r(x + step * 0.45)} ${r(base + down)} ${r(x + step * 0.7)} ${r(base - rnd() * 8)}`;
    d += ` S${r(x + step * 0.92)} ${r(base - up * 0.5)} ${r(x + step)} ${r(base + (rnd() - 0.5) * 6)}`;
    x += step;
  }
  const under = `M${r(8 + rnd() * 22)} ${r(50 + rnd() * 3)} Q${r(100 + rnd() * 20)} ${r(58 + rnd() * 4)} ${r(150 + rnd() * 40)} ${r(46 + rnd() * 5)}`;
  return { d, under };
}

/** Scale that fits the card (design size `layout`) into a window of vw x vh with a margin all round; never above 1, never below layout.minScale. */
export function fitScale(vw, vh, layout) {
  const k = Math.min((vw - 2 * layout.margin) / layout.width, (vh - 2 * layout.margin) / layout.height, 1);
  return Math.max(layout.minScale, Number.isFinite(k) ? k : 1);
}

/**
 * Everything the sheet writes, from one character.
 * who   = {sprite, name, role, rank ('lead'|'staff'|'project'|'cat'), state, floorStatus, floorNo, lobby, startedAt}: what the office shows of it right now
 * entry = the cards.json card of its sprite key (or undefined: the fields show the placeholder)
 * cfg   = ui.card, lobbyLabels = ui.lobby (floor label, rank and state words, duration words), now in ms, type = the persona type or ''
 * 사는 곳 and 메모 are live: only the office's own words (role, rank, state, how long, which team a lobby figure belongs to), never anything from the logs.
 */
export function cardFields(who, entry, cfg, lobbyLabels, now, type = '') {
  const L = cfg.labels;
  const e = entry ?? {};
  const val = (v) => (typeof v === 'string' && v !== '' ? v : L.empty);
  const isCat = who.rank === 'cat';
  const role = isCat ? L.catRole : who.role;
  const floor = who.floorNo > 0 ? fill(lobbyLabels.floorLabel, { n: who.floorNo }) : L.empty;
  const memo = [isCat ? role : fill(L.memoRole, { role, rank: lobbyLabels.rank[who.rank] ?? '' })];
  if (!isCat && who.state) {
    const state = stateLabel(who, lobbyLabels);
    memo.push(who.startedAt > 0 ? fill(L.memoState, { state, dur: fmtDuration(now - who.startedAt, lobbyLabels) }) : state);
  }
  if (who.lobby && who.floorNo > 0) memo.push(fill(L.memoFloor, { floor }));
  return {
    name: `${who.name} · ${role}`,
    age: val(e.age),
    birthplace: val(e.birthplace),
    residence: who.lobby ? L.lobbyName : floor,
    hair: val(e.hair),
    eye: val(e.eye),
    height: val(e.height),
    weight: val(e.weight),
    skills: Array.isArray(e.skills) ? e.skills : [],
    bio: val(e.bio),
    memo,
    stamp: cfg.typeLabels[type] ?? '',
  };
}

// ---------- the tag ----------

/**
 * Makes a name tag open a card: reachable by keyboard (tabindex 0, role button), clickable, and a press on it goes no further.
 * `open` runs on a click, Enter or Space. The visible folder icon and the pointer cursor are CSS on `.card-tag`.
 */
export function bindTag(tag, open) {
  tag.classList.add('card-tag');
  tag.tabIndex = 0;
  tag.setAttribute('role', 'button');
  for (const type of ['click', 'keydown', 'pointerdown', 'pointerup', 'pointercancel', 'dblclick']) {
    tag.addEventListener(type, (e) => {
      const r = tagRoute(type, e);
      if (r.prevent) e.preventDefault();
      if (r.stop) e.stopPropagation();
      if (r.open) open();
    });
  }
}

// ---------- the card ----------

function mk(doc, tagName, cls, text) {
  const n = doc.createElement(tagName);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const setText = (n, t) => {
  if (n.textContent !== t) n.textContent = t;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One labelled box of the form: <div class="cd-cell {cls}"><span class="cd-lab">label</span>{value node}</div>. */
function cell(doc, cls, label, valueNode) {
  const c = mk(doc, 'div', `cd-cell ${cls}`);
  c.append(mk(doc, 'span', 'cd-lab', label), valueNode);
  return c;
}

function buildSheet(doc, cfg) {
  const L = cfg.labels;
  const refs = {};
  const sheet = mk(doc, 'div', 'cd-sheet');
  const text = (key, cls = 'cd-val') => (refs[key] = mk(doc, 'div', cls));
  const nameVal = text('name');
  nameVal.id = 'cd-name';
  refs.skills = mk(doc, 'ul', 'cd-list');
  refs.memo = mk(doc, 'ul', 'cd-list');
  refs.stamp = mk(doc, 'div', 'cd-stamp');
  refs.stamp.hidden = true;

  const photos = mk(doc, 'div', 'cd-cell cd-photos');
  refs.clip = mk(doc, 'img', 'cd-clip');
  refs.clip.src = '/assets/card/clip.png';
  refs.clip.alt = '';
  refs.clip.draggable = false;
  for (const kind of ['id', 'body']) {
    const outer = mk(doc, 'div', `cd-ph ${kind}`);
    const inner = mk(doc, 'div', 'cd-ph-in');
    const win = mk(doc, 'div', 'cd-ph-win');
    const img = mk(doc, 'img', 'cd-pic');
    img.alt = kind === 'id' ? L.idPhoto : L.bodyPhoto;
    img.draggable = false;
    win.append(img);
    inner.append(win);
    outer.append(inner);
    photos.append(outer);
    refs[`${kind}Img`] = img;
    refs[`${kind}Ph`] = inner;
  }
  photos.append(refs.clip);

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIGNATURE_BOX.w} ${SIGNATURE_BOX.h}`);
  svg.setAttribute('class', 'cd-sig');
  svg.setAttribute('aria-hidden', 'true');
  refs.sigPath = doc.createElementNS(SVG_NS, 'path');
  refs.sigUnder = doc.createElementNS(SVG_NS, 'path');
  svg.append(refs.sigPath, refs.sigUnder);

  sheet.append(
    photos,
    cell(doc, 'c-name', L.name, nameVal),
    cell(doc, 'c-age', L.age, text('age')),
    cell(doc, 'c-birth', L.birthplace, text('birthplace')),
    cell(doc, 'c-home', L.residence, text('residence')),
    cell(doc, 'c-hair', L.hair, text('hair')),
    cell(doc, 'c-eye', L.eye, text('eye')),
    cell(doc, 'c-height', L.height, text('height')),
    cell(doc, 'c-weight', L.weight, text('weight')),
    cell(doc, 'c-sign', L.signature, svg),
    cell(doc, 'c-skill', L.skills, refs.skills),
    cell(doc, 'c-bio', L.bio, text('bio', 'cd-val cd-text')),
    cell(doc, 'c-memo', L.memo, refs.memo),
    refs.stamp,
  );
  return { sheet, refs };
}

/**
 * The card component. deps: {cfg (ui.card), lobbyLabels (ui.lobby), server (the /api/ui answer: cards, personas), fx ({fxOn}), now () -> ms,
 * reduced () -> boolean (the OS asks for less motion), spriteHeights?}. Returns {open(rec, tag, who), refresh(), close(), isOpen()}.
 * `who(rec)` (given to open) answers what the office shows of that character right now, or null once it has left.
 */
export function createCard(deps) {
  const { cfg, lobbyLabels, server, fx } = deps;
  const state = createCardState();
  let live = null; // {rec, who, tag, doc, back, fit, cd, refs, stop: () => void, last: object, gone: boolean}
  let closing = null; // {node, cancel}: a card that is animating away

  function lookup(w) {
    const key = w.rank === 'cat' ? 'cat' : w.sprite;
    return { entry: server.cards?.[key], type: server.personas?.[key]?.type ?? '' };
  }

  function pictures(w, refs, f) {
    const cat = w.rank === 'cat';
    const sets = [['id', w.pics.id, cat ? cfg.photo.catIdScale : cfg.photo.idScale], ['body', w.pics.body, cat ? cfg.photo.catBodyScale : cfg.photo.bodyScale]];
    for (const [kind, pic, scale] of sets) {
      const img = refs[`${kind}Img`];
      if (img.dataset.src !== pic.url) {
        img.dataset.src = pic.url;
        img.src = pic.url;
      }
      img.style.height = `${pic.h * scale}px`;
    }
    const sig = signature(w.name);
    if (refs.sigPath.getAttribute('d') !== sig.d) {
      refs.sigPath.setAttribute('d', sig.d);
      refs.sigUnder.setAttribute('d', sig.under);
    }
    refs.stamp.hidden = f.stamp === '';
    setText(refs.stamp, f.stamp);
  }

  function paint(w) {
    const { refs } = live;
    const { entry, type } = lookup(w);
    const f = cardFields(w, entry, cfg, lobbyLabels, deps.now(), type);
    for (const k of ['name', 'age', 'birthplace', 'residence', 'hair', 'eye', 'height', 'weight', 'bio']) setText(refs[k], f[k]);
    for (const [key, items] of [['skills', f.skills], ['memo', f.memo]]) {
      const ul = refs[key];
      const have = Array.from(ul.children, (li) => li.textContent);
      if (have.length !== items.length || items.some((t, i) => t !== have[i])) ul.replaceChildren(...items.map((t) => mk(live.doc, 'li', '', t)));
    }
    pictures(w, refs, f);
    live.last = w;
  }

  const motionOn = () => fx.fxOn() && !deps.reduced();

  function teardown(c) {
    c.stop();
    c.back.remove();
  }

  function fit() {
    const de = live.doc.documentElement;
    const k = fitScale(de.clientWidth, de.clientHeight, cfg.layout);
    live.fit.style.transform = `scale(${k})`;
  }

  /**
   * The motion: the backdrop fades, the folder slides up, the sheet slides out of it and the photos settle (transform and opacity only).
   * Opening ends within motion.openMs; closing plays the same parts mirrored in time (the photos and the sheet go first, the folder last) within motion.closeMs.
   */
  function sequence(c, opening) {
    const m = cfg.motion;
    const k = opening ? 1 : m.closeMs / m.openMs;
    const ease = opening ? 'cubic-bezier(.2,.8,.25,1)' : 'cubic-bezier(.5,0,.8,.4)';
    const anims = [];
    const part = (node, from, delay, dur) => {
      const frames = [from, { opacity: 1, transform: 'none' }];
      anims.push(node.animate(opening ? frames : frames.reverse(), { duration: dur * k, delay: (opening ? delay : m.openMs - delay - dur) * k, easing: ease, fill: 'both' }));
    };
    part(c.back, { opacity: 0 }, 0, m.backdropMs);
    part(c.refs.folder, { opacity: 0, transform: `translateY(${m.riseFolderPx}px)` }, 0, m.folderMs);
    part(c.refs.sheet, { opacity: 0, transform: `translateY(${m.risePx}px)` }, m.sheetDelayMs, m.openMs - m.sheetDelayMs);
    for (const ph of [c.refs.idPh, c.refs.bodyPh]) part(ph, { opacity: 0, transform: 'translate(-8px, -18px) scale(1.14)' }, m.photoDelayMs, m.openMs - m.photoDelayMs);
    return anims;
  }

  function finishClosing() {
    if (!closing) return;
    const c = closing;
    closing = null;
    c.cancel();
    c.node.remove();
  }

  function build(rec, tag, who) {
    const doc = tag.ownerDocument;
    const back = mk(doc, 'div', 'cd-back');
    const fitEl = mk(doc, 'div', 'cd-fit');
    fitEl.style.width = `${cfg.layout.width}px`;
    fitEl.style.height = `${cfg.layout.height}px`;
    fitEl.style.marginLeft = `${-cfg.layout.width / 2}px`;
    fitEl.style.marginTop = `${-cfg.layout.height / 2}px`;
    const cd = mk(doc, 'div', 'cd');
    cd.setAttribute('role', 'dialog');
    cd.setAttribute('aria-modal', 'true');
    cd.setAttribute('aria-labelledby', 'cd-name');
    const folder = mk(doc, 'div', 'cd-folder');
    folder.append(mk(doc, 'div', 'cd-tab'));
    const { sheet, refs } = buildSheet(doc, cfg);
    refs.folder = folder;
    refs.sheet = sheet;
    refs.gone = mk(doc, 'div', 'cd-gone', cfg.labels.gone);
    refs.gone.hidden = true;
    const closeBtn = mk(doc, 'button', 'cd-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', cfg.labels.closeLabel);
    closeBtn.title = cfg.labels.close;
    cd.append(folder, sheet, refs.gone, closeBtn);
    fitEl.append(cd);
    back.append(fitEl);
    doc.body.append(back);

    const win = doc.defaultView;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // the only control is the close button: focus stays in the card
        closeBtn.focus({ preventScroll: true });
      }
    };
    const onResize = () => fit();
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('resize', onResize);
    back.addEventListener('click', (e) => {
      if (!cd.contains(e.target)) close();
    });
    closeBtn.addEventListener('click', close);
    const stop = () => {
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', onResize);
    };
    live = { rec, who, tag, doc, back, fit: fitEl, cd, refs, closeBtn, stop, last: null, gone: false };
    paint(who(rec));
    fit();
    return live;
  }

  function open(rec, tag, who) {
    const first = who(rec);
    if (!first) return;
    finishClosing();
    if (live) {
      teardown(live);
      live = null;
      state.close();
    }
    state.open(rec);
    const c = build(rec, tag, who);
    if (motionOn()) {
      const anims = sequence(c, true);
      Promise.all(anims.map((a) => a.finished)).then(() => anims.forEach((a) => a.cancel()), () => {});
    }
    c.closeBtn.focus({ preventScroll: true });
  }

  /** The office updated: the live fields follow; a character that left keeps its last data with the 「퇴근」 note. */
  function refresh() {
    if (!live) return;
    const w = live.who(live.rec);
    if (w) {
      live.gone = false;
      live.refs.gone.hidden = true;
      paint(w);
    } else if (!live.gone) {
      live.gone = true;
      live.refs.gone.hidden = false;
      live.cd.classList.add('gone');
    }
  }

  function close() {
    if (!live) return;
    const c = live;
    live = null;
    state.close();
    c.stop();
    const { tag } = c;
    const finish = () => {
      c.back.remove();
      if (closing?.node === c.back) closing = null;
    };
    if (motionOn()) {
      c.back.style.pointerEvents = 'none';
      const anims = sequence(c, false);
      closing = { node: c.back, cancel: () => anims.forEach((a) => a.cancel()) };
      Promise.all(anims.map((a) => a.finished)).then(finish, finish);
    } else c.back.remove();
    if (tag.isConnected) tag.focus({ preventScroll: true });
  }

  return { open, refresh, close, isOpen: state.isOpen };
}
