// Area "actor" (the marks on people): the model band under a name tag, the paper pile on a desk and the hourglass over a slow command.
// The rules are pure and live in web/actor-view.mjs; this file only reads the floor views (ctx.onState) and keeps a few DOM nodes in step.
// Nothing here moves a character, runs a frame loop or reads anything but the view fields model, pile, slowSince (and the floor's rest).
//
//   band       a strip under the name tag, floors and lobby (lobby: through ctx.chars(ctx.lobby())). Information: drawn with the effects off too.
//   pile       a picture on the person's desk (stage 1..4, the last one wobbles). Decoration: built only while the effects are on.
//   hourglass  a picture and the elapsed time beside the head. Information: drawn with the effects off too (a still picture); the
//              picture only flips while the effects are on (CSS, web/actor.css). The time text is refreshed by one timer per shown
//              floor that has an hourglass (ctx.timers with the floor's mark), nothing runs for a floor that is not shown.
import { GLASS_SRC, bandOf, createTicker, deskOf, glassPlan, pileAnchor, pilePlan, pileSrc } from './actor-view.mjs';

const make = (tag, cls) => {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
};

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const { badge, pile: pileCfg, hourglass: glassCfg } = ctx.ui;
  const fxOn = () => ctx.fx.fxOn();
  const piles = new WeakMap(); // floor record -> Map(person key -> {el, mark})

  // ---------- the model band ----------
  function setBand(rec, model) {
    const light = bandOf(badge, model, false);
    if (!light) {
      rec.acBand?.remove();
      rec.acBand = null;
      return;
    }
    let band = rec.acBand;
    if (!band) {
      band = make('i', 'ac-band');
      band.setAttribute('role', 'img');
      rec.acBand = band;
    }
    if (band.dataset.model !== model) {
      band.dataset.model = model;
      band.title = light.label;
      band.setAttribute('aria-label', light.label);
      band.style.setProperty('--ac-band-l', light.color);
      band.style.setProperty('--ac-band-d', bandOf(badge, model, true).color);
      band.style.height = `${badge.bandPx}px`;
    }
    if (band.parentElement !== rec.tag) rec.tag.append(band);
  }

  // ---------- the hourglass ----------
  function setGlass(rec, plan) {
    if (!plan) {
      rec.acGlass?.remove();
      rec.acGlass = null;
      return;
    }
    let g = rec.acGlass;
    if (!g) {
      g = make('div', 'ac-glass');
      const img = make('img', 'ac-glass-img');
      img.src = GLASS_SRC;
      img.alt = '';
      img.draggable = false;
      g.append(img, make('span', 'ac-glass-t'));
      g.style.setProperty('--ac-flip', `${glassCfg.flipMs}ms`);
      rec.acGlass = g;
    }
    if (g.parentElement !== rec.tagRoot) rec.tagRoot.append(g);
    g.classList.toggle('ac-spin', plan.spin);
    const t = g.lastChild;
    if (t.textContent !== plan.text) t.textContent = plan.text;
  }

  // ---------- the pile ----------
  /** z of a desk's picture, and one above it. */
  const deskZ = (frec, deskId) => frec.scene.nodes.reduce((z, n) => (n.objId === deskId ? Math.max(z, n.z + 1) : z), 0);

  function setPile(frec, key, draw, desk) {
    let mine = piles.get(frec);
    if (!mine) piles.set(frec, (mine = new Map()));
    const have = mine.get(key);
    if (!draw || !desk) {
      have?.el.remove();
      mine.delete(key);
      return;
    }
    const mark = `${draw.level}|${desk.id}|${draw.wobble}`;
    if (have?.mark === mark) return;
    const [x, y] = pileAnchor(desk, draw.offset);
    const el = have?.el ?? make('img', 'ac-pile');
    el.src = pileSrc(draw.level);
    el.alt = '';
    el.draggable = false;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.zIndex = String(deskZ(frec, desk.id));
    el.style.setProperty('--ac-wobble', `${pileCfg.wobbleMs}ms`);
    el.classList.toggle('ac-wobble', draw.wobble);
    if (!have) frec.stage.append(el);
    mine.set(key, { el, mark });
  }

  /** The tag's title, with the last stage's words after it when no picture shows them (applied after the office wrote the title). */
  function setTitle(rec, words) {
    const mark = rec.acTitle;
    if (mark && rec.tag.title.endsWith(mark)) rec.tag.title = rec.tag.title.slice(0, -mark.length);
    rec.acTitle = words ? ` · ${words}` : '';
    if (words) rec.tag.title += rec.acTitle;
  }

  // ---------- one floor ----------
  function syncFloor(fv) {
    const frec = ctx.floor(fv.sessionId);
    if (!frec || frec === ctx.lobby()) return;
    const on = fxOn();
    const nowMs = ctx.serverNow();
    const alive = new Set();
    for (const person of [{ key: 'lead', ...fv.lead }, ...fv.agents]) {
      const rec = frec.agents.get(person.key);
      if (!rec) continue;
      alive.add(person.key);
      setBand(rec, person.model);
      setGlass(rec, glassPlan({ slowSince: person.slowSince, nowMs, rest: fv.rest, fxOn: on }, glassCfg));
      const plan = pilePlan({ pile: person.pile, design: fv.design, fxOn: on }, pileCfg);
      setPile(frec, person.key, plan.draw, deskOf(frec.scene.r, person.key, person.slot));
      setTitle(rec, plan.title);
    }
    for (const key of [...(piles.get(frec)?.keys() ?? [])]) if (!alive.has(key)) setPile(frec, key, null, null);
  }

  // ---------- the lobby tags (the lobby's figures: ctx.chars(ctx.lobby())) ----------
  function syncLobby() {
    const lobby = ctx.lobby();
    if (!lobby) return;
    const keyOf = new Map([...lobby.chars].map(([key, rec]) => [rec, key]));
    for (const rec of ctx.chars(lobby)) {
      const fv = ctx.view(rec.sid);
      const key = keyOf.get(rec) ?? '';
      const person = !fv ? null : key === `${rec.sid}:lead` ? fv.lead : fv.agents.find((a) => a.key === key);
      setBand(rec, person?.model ?? null);
    }
  }

  // ---------- the hourglass clock ----------
  const hasGlass = (f) => [...f.agents.values()].some((r) => r.acGlass);
  const ticker = createTicker({
    timers: ctx.timers,
    tickMs: glassCfg.tickMs,
    ids: () => [...ctx.floors()].filter((f) => f.agents && ctx.floorActive(f) && hasGlass(f)).map((f) => f.sid),
    run: (id) => {
      const fv = ctx.view(id);
      if (fv) syncFloor(fv);
    },
  });

  let last = null; // the last floor list the office drew
  const syncAll = () => {
    if (!last) return;
    last.forEach(syncFloor);
    syncLobby();
    ticker.sync();
  };

  ctx.onState((list) => {
    last = list;
    syncAll();
  });
  ctx.onPauseChange((paused) => {
    if (!paused) syncAll(); // the elapsed times catch up at once
    else ticker.sync();
  });
  const again = ({ floor }) => {
    if (floor === ctx.lobby()) syncLobby(); // the lobby draws its figures when it is first shown, after the state frame that made them
    else if (ctx.view(floor.sid)) syncFloor(ctx.view(floor.sid));
    ticker.sync();
  };
  ctx.fx.onFx('floor-shown', again, { always: true });
  ctx.fx.onFx('floor-hidden', () => ticker.sync(), { always: true });
  ctx.fx.onFxChange(syncAll); // the effects switch: piles appear or go, the hourglass starts or stops flipping, the stage-4 words move
}
