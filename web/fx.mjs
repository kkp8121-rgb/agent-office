// The effects switchboard (page side): whether the effects are on, and the one bus the office's events travel on.
//
// The office announces what really happens (a click, a throw, a meeting, a failure, ...) with emitFx(name, detail) and each effects
// area (web/fx-*.mjs, web/officelife.mjs) listens with onFx(name, fn). Nothing here draws or plays anything. app.mjs only emits.
//
// ---- the switches ----
//   fxOn()      the 「화려한 효과」 switch. Default: ui.fx.enabled, but OFF while the OS asks for reduced motion, until the viewer chooses.
//   sfxOn()     the 「효과음」 switch AND fxOn() (sound belongs to the effects: with the effects off the office stays silent as before).
//   fxVolume()  ui.fx.volume (0..1), the master volume of every effect sound.
//   The viewer's choices persist in localStorage 'agent-office.fx' / 'agent-office.sfx' ('1' or '0'); a blocked storage only means
//   the choice lasts for this page. <html> carries class fx-on while fxOn() (also the small window's <html>, see trackDoc).
//   onFxChange(fn) -> unsubscribe: fn({fx, sfx, volume}) after either switch changed (also when reduced motion flips the default).
//
// ---- the bus ----
//   emitFx(name, detail)  synchronous. A listener that throws is caught and logged once (per listener), so one area cannot break
//                         another area or the office.
//   onFx(name, fn, {always}) -> unsubscribe. By default fn is called only WHILE fxOn(): an area that is off does no work at all.
//                         Pass {always: true} to hear the events while the effects are off too (to keep a small state in step).
//   An area that is off must also hold nothing: on onFxChange(fx = false) remove what it built or let it run out.
//
// ---- gating an area (the pattern every area follows) ----
//   init(ctx): if (!ctx.ui.fx.<area>.enabled) return;           // config switch of the area
//     const off = ctx.fx.onFx('poke', (d) => { ... });           // only called while effects are on
//     ctx.fx.onFxChange(({ fx }) => { if (!fx) tidy(); });
//     inside a listener or timer: if (!ctx.floorActive(d.floor)) return;   // not shown / page hidden -> nothing
//     while the page is hidden: ctx.onPauseChange((paused) => ...) and ctx.paused().
//
// ---- the events (detail shapes). rec = a character record (see ctx.chars), floor = a floor record (see ctx.floors) ----
//   'poke'          {rec, key, level, combo, x, y}   a plain click on a character (not the cat). key = its sprite key, level = the
//                                                    escalation 1..ui.poke.maxLevel, combo = consecutive clicks on the same character
//                                                    each within ui.poke.resetMs of the one before (1,2,3,... NOT capped), x/y = page
//                                                    (client) coordinates of the click.
//   'cat-pet'       {cat, level, combo, x, y}        a plain click on the cat. cat = the cat's character record (cat.isCat), level
//                                                    1..ui.cat.pet.maxLevel, combo and x/y as in 'poke'.
//   'lift'          {rec}                            the character was picked up (the cat too).
//   'drop'          {rec}                            let go without a throw, before it lands (the cat too).
//   'thrown'        {rec, vx, vy}                    let go fast: it flies. vx, vy = pointer velocity in floor px per second.
//   'landed'        {rec, bounces}                   the thrown character came down; bounces = wall bounces on the way.
//   'snack'         {rec, kind, result}              a snack was dropped on a character (the cat too). kind = coffee|donut|cookie|fish,
//                                                    result = 'eat' | 'refuse' | 'full'.
//   'report'        {rec, lead}                      rec was dropped on the boss and reports; lead = the boss's character record.
//   'high-five'     {a, b}                           two characters high-five (character records).
//   'meeting-start' {floor, title}                   a workflow meeting began on the floor; title = the phase (clipped as on the board).
//   'meeting-end'   {floor}                          that meeting ended (time up, or everybody left).
//   'phase'         {floor, title}                   a workflow went on to its next phase (every real phase signal of a known floor,
//                                                    also while it is not shown or a meeting is running; title as in 'meeting-start').
//   'fail-start'    {rec}                            a command or test failed: the mood (sweat drop / rain cloud) shows. May fire
//                                                    again for the same rec while its mood still shows (a new failure).
//   'fail-end'      {rec}                            the mood is gone.
//   'state'         {rec, from, to}                  the agent's state changed (working, thinking, idle, enter, stale, done, ...).
//                                                    from === '' means the first time this page sees that character (page load or newcomer).
//   'walk-start'    {rec}                            the character started walking (not fired for a move on a floor that is not shown).
//   'walk-end'      {rec}                            it stopped: arrived, or the walk was cut (picked up, hidden tab, new route).
//   'pose'          {rec, seated, animate}           it sat down or stood up (a changed pose only); animate = a visible change, not a first draw.
//   'weather'       {kind, real}                     what the windows show now: kind = clear|cloudy|fog|rain|snow|storm|none (viewer's
//                                                    choice applied), real = the server's real weather kind or null. Fires on every
//                                                    change of either (and once at start-up).
//   'daylight'      {phase}                          the light outside changed: day | sunset | night (dark mode counts as night).
//   'sysload'       {cpu, mem}                       the server's CPU / memory sample (integer percents), every ui sample.
//   'floor-shown'   {floor}                          a floor came on screen (also a floor created while shown, and the lobby).
//   'floor-hidden'  {floor, removed}                 a floor went off screen; removed = true when the floor is gone for good.
//
// ---- ctx: what init(ctx) of an area receives (built in app.mjs, "effects"). An area never needs app.mjs internals. ----
/**
 * @typedef {object} FxCtx
 * @property {object} ui                config ui (everything under "ui" of config.json: ui.fx.<area>, ui.poke, ui.lines, ...)
 * @property {object} server            the whole /api/ui answer (scenes, nav, depth, lobby, weather, ...)
 * @property {object} fx                this module: fxOn, sfxOn, fxVolume, onFxChange, emitFx, onFx
 * @property {() => Iterable<object>} floors   live: every floor record {el, stage, layer, sid, off, design, scene, agents: Map, status, ...} and the lobby's
 * @property {(id: string) => object|null} floor   one floor record by session id ('lobby' = the lobby)
 * @property {() => object|null} lobby         the lobby's floor record (agents live in .chars) or null
 * @property {(floor?: object) => object[]} chars   live: the character records of one floor (the lobby's figures included), or of all
 *                                              floors plus the cat. Record: {el, tagRoot, body, flip, spr, fxMove, fxHit, tag, img, sprite,
 *                                              x, y, state, seated, walk, away, grab, play, frec, isLead, isCat, ...}
 * @property {(key: string) => object[]} bySprite   the character records drawn with that sprite key (e.g. 'worker')
 * @property {(el: Element) => object|undefined} recOf   the record of a character's element (.ag)
 * @property {() => object|null} cat           the cat's record {rec, frec, ...} or null
 * @property {(situation: string, fill?: string, rec?: object) => string} line   a canned line (ui.lines), never the one before it
 * @property {(fn: (situation: string, fill: string|undefined, rec: object|undefined) => string|undefined) => () => void} addLinePicker
 *                                             a persona-aware picker: asked first by line(); return a line or undefined to leave it to the default
 * @property {(rec: object, text: string, ms: number, shiftPx?: number) => void} sayFor   a short bubble (replaces its current one)
 * @property {(rec: object) => void} clearSay
 * @property {(rec: object, text: string, ms: number, force?: boolean) => void} chatter   small talk / greeting bubble (skipped while busy)
 * @property {(floor: object) => boolean} floorActive   shown (not off) AND page not hidden
 * @property {() => boolean} paused            the page is hidden (nothing may run)
 * @property {(fn: (paused: boolean) => void) => () => void} onPauseChange
 * @property {() => number} now                the clock (Date.now)
 * @property {{setTimeout: Function, clearTimeout: Function}} timers   the office's timers: they follow the small window, so they are not throttled
 * @property {() => string} light              day | sunset | night
 * @property {() => string} season             halloween | christmas | lunar | none
 * @property {() => {choice: string, real: string|null, kind: string}} weather   the viewer's choice, the real kind, what the windows show
 * @property {() => {cpu: number, mem: number}|null} sysload   the last sample
 * @property {(rec: object, frec: object, points: number[][], onArrive?: Function) => number} walkPath   walk a polyline (floor px); returns ms
 * @property {(rec: object, frec: object, target: {x, y, face, seated, seat}, onArrive?: Function) => number} goTo   route to a target from anywhere
 * @property {(rec: object, p: number[], commit?: boolean) => void} placeAt   put it there at once
 * @property {(rec: object, seated: boolean, animate: boolean) => void} setPose
 * @property {(rec: object, target: object, animate?: boolean) => void} arriveAt
 * @property {(rec: object, face: 'left'|'right') => void} setFacing
 * @property {(rec: object) => void} freeze    stop a walk where the character is
 * @property {(rec: object) => void} clearGestures
 * @property {{path: Function, snap: Function, grid: Function}} nav   the walking grid: path(design, from, to), snap(design, p), grid(design)
 * @property {{start: (frec: object, opts?: {kind?: 'phase'|'bell', phase?: string, onHold?: Function, onEnd?: Function, onSwitch?: Function}) => object|null,
 *   end: (frec: object) => boolean, active: (frec: object) => 'phase'|'bell'|null}} meeting
 *                                             the one meeting machine (a workflow phase runs on it too): start gathers the crew at the meeting spots (the lead stands at
 *                                             the boss spot and chairs), then calls onHold(mt); a 'phase' meeting ends by itself, a 'bell' one when you call end(frec);
 *                                             onEnd(mt) after it; onSwitch(mt) when a workflow phase takes a bell meeting over. start returns null when
 *                                             there is nothing to hold (no spots, nobody, a meeting runs already)
 * @property {object} life                     the life area's hooks (all optional to use; each returns an unsubscribe):
 *   life.ambient          ui.ambient as the office runs it (scaled under ?debug=ambient)
 *   life.cat              ui.cat as the office runs it
 *   life.takenSpots(floor, exceptRec) -> Map(spotId -> n)   spots someone is on a trip to (the cat included)
 *   life.addTripPicker(fn(floor, rec) -> legs[]|null)        extra trips: legs are {x, y, face, spotId?, slot?}; the first picker that answers wins, before the default ones
 *   life.addFidgetPicker(fn(floor, rec) -> boolean)          a fidget of its own: return true when it handled this tick (the default fidget is then skipped)
 *   life.addCatPicker(fn({cat, floor}) -> pick|null)         the cat's next act in the shape of cat.mjs chooseCatAct ({act, x, y, face, pose, ms, spotId?, desk?}); first answer wins
 *   life.members(floor)   the characters that take part in the office life of that floor
 */

const KEY_FX = 'agent-office.fx';
const KEY_SFX = 'agent-office.sfx';

/** Every event name the office emits (tests check app.mjs emits exactly these). */
export const FX_EVENTS = Object.freeze([
  'poke', 'cat-pet', 'lift', 'drop', 'thrown', 'landed', 'snack', 'report', 'high-five', 'meeting-start', 'meeting-end', 'phase', 'fail-start',
  'fail-end', 'state', 'walk-start', 'walk-end', 'pose', 'weather', 'daylight', 'sysload', 'floor-shown', 'floor-hidden',
]);

/** '1' -> true, '0' -> false, anything else (nothing stored, junk) -> null: the viewer has not chosen. */
export function parseChoice(v) {
  return v === '1' ? true : v === '0' ? false : null;
}

/** The effects switch: the viewer's choice, else off under reduced motion, else the config default. */
export function resolveFx(choice, reduced, enabledDefault) {
  return choice ?? (reduced ? false : !!enabledDefault);
}

/** The sound switch: the viewer's choice, else the config default (sound is on by default). */
export function resolveSfx(choice, soundDefault) {
  return choice ?? !!soundDefault;
}

/**
 * The combo counter of clicks on one character: `prev` = {n, at} of its last click (or null), `now` in ms, `resetMs` = ui.poke.resetMs.
 * A click within resetMs of the one before counts on (1, 2, 3, ... with no upper limit), otherwise it starts again at 1.
 */
export function nextCombo(prev, now, resetMs) {
  return { n: prev && now - prev.at <= resetMs ? prev.n + 1 : 1, at: now };
}

/** The remembered choice (true/false) or null; `getStorage` may throw (blocked storage). */
export function loadStored(getStorage, key) {
  try {
    return parseChoice(getStorage().getItem(key));
  } catch {
    return null;
  }
}

/** Remembers a choice; false when the storage refuses (the choice then lasts for this page only). */
export function saveStored(getStorage, key, on) {
  try {
    getStorage().setItem(key, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/**
 * One switchboard. `deps`: getStorage() (may throw), matchMedia(query) -> {matches, addEventListener} (or null), log(...args) for the
 * one-time listener error report. The page uses the shared instance below; tests build their own with fakes.
 */
export function createFx(deps = {}) {
  const log = deps.log ?? ((...a) => console.error(...a));
  const listeners = new Map(); // name -> Set<{fn, always}>
  const changeFns = new Set();
  const docs = new Set();
  const complained = new WeakSet();
  let cfg = { enabled: true, sound: true, volume: 0.25 };
  let choiceFx = null;
  let choiceSfx = null;
  let reduced = false;
  let mql = null;
  let fxState = false;
  let sfxState = false;
  let started = false;

  const paintDoc = (d) => d.documentElement.classList.toggle('fx-on', fxState);

  /** Recomputes the two switches from the choices; tells the listeners and paints <html> when something changed. */
  function recompute(force = false) {
    const fx = resolveFx(choiceFx, reduced, cfg.enabled);
    const sfx = fx && resolveSfx(choiceSfx, cfg.sound);
    if (!force && fx === fxState && sfx === sfxState) return;
    fxState = fx;
    sfxState = sfx;
    for (const d of docs) paintDoc(d);
    const now = { fx: fxState, sfx: sfxState, volume: cfg.volume };
    for (const fn of [...changeFns]) safe(fn, now);
  }

  function safe(fn, arg) {
    try {
      fn(arg);
    } catch (err) {
      if (complained.has(fn)) return;
      complained.add(fn);
      log('효과 처리기에서 오류가 났습니다 (한 번만 알립니다):', err);
    }
  }

  const api = {
    /** Reads the config and the stored choices and starts following the media query. Call once, when the config is known. */
    start(config, doc) {
      cfg = { ...cfg, ...config };
      choiceFx = loadStored(deps.getStorage ?? (() => localStorage), KEY_FX);
      choiceSfx = loadStored(deps.getStorage ?? (() => localStorage), KEY_SFX);
      mql = deps.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
      reduced = !!mql?.matches;
      if (!started) {
        started = true;
        mql?.addEventListener?.('change', (e) => {
          reduced = e.matches;
          recompute();
        });
      }
      if (doc) docs.add(doc);
      recompute(true);
    },
    fxOn: () => fxState,
    sfxOn: () => sfxState,
    fxVolume: () => cfg.volume,
    /** The viewer's switch itself (what the checkbox shows), whatever fxOn() says. */
    choices: () => ({ fx: resolveFx(choiceFx, reduced, cfg.enabled), sfx: resolveSfx(choiceSfx, cfg.sound) }),
    setFx(on) {
      choiceFx = !!on;
      saveStored(deps.getStorage ?? (() => localStorage), KEY_FX, choiceFx);
      recompute();
    },
    setSfx(on) {
      choiceSfx = !!on;
      saveStored(deps.getStorage ?? (() => localStorage), KEY_SFX, choiceSfx);
      recompute();
    },
    onFxChange(fn) {
      changeFns.add(fn);
      return () => changeFns.delete(fn);
    },
    /** Another document (the small window's) gets the fx-on class too. Returns the stop function. */
    trackDoc(doc) {
      docs.add(doc);
      paintDoc(doc);
      return () => docs.delete(doc);
    },
    emitFx(name, detail) {
      const set = listeners.get(name);
      if (!set || set.size === 0) return;
      for (const l of [...set]) {
        if (!fxState && !l.always) continue;
        safe(l.fn, detail);
      }
    },
    onFx(name, fn, opts = {}) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      const l = { fn, always: !!opts.always };
      set.add(l);
      return () => set.delete(l);
    },
  };
  return api;
}

const shared = createFx({
  getStorage: () => localStorage,
  matchMedia: (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null),
});

export const startFx = shared.start;
export const fxOn = shared.fxOn;
export const sfxOn = shared.sfxOn;
export const fxVolume = shared.fxVolume;
export const fxChoices = shared.choices;
export const setFx = shared.setFx;
export const setSfx = shared.setSfx;
export const onFxChange = shared.onFxChange;
export const trackDoc = shared.trackDoc;
export const emitFx = shared.emitFx;
export const onFx = shared.onFx;
