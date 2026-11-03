// Hit feel rules (pure): which motion set a character has, how a poke is staged in time (hit-stop, squash, knockback, springs),
// the particles of an impact, the combo counter, which persona line answers a situation. No DOM, no clock, no Math.random:
// web/fx-hit.mjs draws what these return, the numbers come from config ui.fx.hit (and server/persona.mjs reuses TYPES and hashType).
import { pickLine } from './play.mjs';

/** The ten personality types (and so motion sets) a persona can have. The cat has a set of its own ('cat'). */
export const TYPES = Object.freeze(['flinch', 'angry', 'dodge', 'proud', 'lazy', 'bubbly', 'tough', 'dramatic', 'shy', 'goofy']);

/** The type picked by a hash of a sprite key (FNV-1a), the same everywhere: a character without a persona (or with an unknown type) keeps one forever. */
export function hashType(key, types = TYPES) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return types[h % types.length];
}

/** The persona key of a character record: the cat is 'cat', everyone else the sprite key they are drawn with. */
export const personaKey = (rec) => (rec.isCat ? 'cat' : rec.sprite);

/** The persona of a character (from the server's validated personas) or a bare one: type from the hash, no lines, voice 1. */
export function personaOf(personas, rec) {
  const key = personaKey(rec);
  const p = personas?.[key];
  if (p) return p;
  return { type: rec.isCat ? 'cat' : hashType(key), voice: 1, hitWords: [], snack: { love: [], dislike: [] }, lines: {} };
}

/** A persona's motion set name: 'cat' for the cat, else its type. */
export const typeOf = (rec, persona) => (rec.isCat ? 'cat' : persona.type);

// ---- lines ----

const LEAD_KEYS = { poke: /^pokeLead([1-4])$/, lift: /^liftLead$/, grumble: /^grumbleLead$/ };
const CAT_KEYS = { catCombo: 'combo', catSnackLove: 'snackLove', catSnackDislike: 'snackDislike' };

/** The persona line key a situation asks for: a lead variant maps onto the plain one (pokeLead3 -> poke3, liftLead -> lift, grumbleLead -> grumble), the cat's generic combo and snack keys onto the persona's. */
export function lineKeyFor(situation, rec) {
  const m = LEAD_KEYS.poke.exec(situation);
  if (m) return `poke${m[1]}`;
  if (LEAD_KEYS.lift.test(situation)) return 'lift';
  if (LEAD_KEYS.grumble.test(situation)) return 'grumble';
  if (rec?.isCat && CAT_KEYS[situation]) return CAT_KEYS[situation];
  return situation;
}

/** `{task}` and `{phase}` of a canned line are filled with `fill` (the same rule as the office's own line picker). */
const fillIn = (text, fill) => (fill === undefined ? text : text.replace('{task}', fill).replace('{phase}', fill));

/**
 * The persona-aware line picker the office asks first (ctx.addLinePicker). `personas` = the server's validated personas by sprite key,
 * `generic` = ui.lines, `rng` returns [0, 1). pick(situation, fill, rec) returns a line of the character's persona (lead variants mapped,
 * never the one it said last), or undefined: the office then says today's generic line. A snack eaten with a mood (setMood) turns the
 * next "done" line into the persona's snackLove / snackDislike line (the generic one of that name when the persona has none).
 */
export function createLinePicker({ personas, generic, rng }) {
  const last = new Map();
  const moods = new WeakMap();
  return {
    setMood(rec, mood) {
      if (mood) moods.set(rec, mood);
      else moods.delete(rec);
    },
    pick(situation, fill, rec) {
      if (!rec) return undefined;
      const mood = moods.get(rec);
      const done = situation === 'snackDone' || situation === 'catSnackDone';
      if (mood && done) moods.delete(rec);
      const key = mood && done ? moodLineKey(situation, mood) : situation;
      const id = `${personaKey(rec)}|${key}`;
      const text = personaLine(personas?.[personaKey(rec)], key, rec, rng, last.get(id), pickLine);
      if (text !== undefined) {
        last.set(id, text);
        return fillIn(text, fill);
      }
      if (key === situation) return undefined;
      const name = `${rec.isCat ? 'catSnack' : 'snack'}${mood === 'love' ? 'Love' : 'Dislike'}`;
      return generic?.[name] ? fillIn(pickLine(rng, generic[name], last.get(`generic|${name}`)), fill) : undefined;
    },
  };
}

/** The snack key a "done" line shows under a mood: snackDone -> snackLove / snackDislike (the cat's catSnackDone too). */
export function moodLineKey(situation, mood) {
  if (!mood || (situation !== 'snackDone' && situation !== 'catSnackDone')) return situation;
  return mood === 'love' ? 'snackLove' : 'snackDislike';
}

/** A line of a persona for a situation (never the one `last` says), or undefined when the persona has none: the caller falls back to today's generic line. */
export function personaLine(persona, situation, rec, rng, last, pickLine) {
  const pool = persona?.lines?.[lineKeyFor(situation, rec)];
  if (!Array.isArray(pool) || pool.length === 0) return undefined;
  return pickLine(rng, pool, last);
}

// ---- time staging of a hit ----

/** The hit-stop of a poke level in ms (config hitStopMs by level), plus the type's bonus (tough ones hold a little longer). */
export function hitStopMs(level, p, H) {
  const at = Math.min(Math.max(level, 1), H.hitStopMs.length) - 1;
  return H.hitStopMs[at] + (p.stopBonus ?? 0);
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const xf = (x, y, r, sx, sy) => `translate(${r3(x)}px, ${r3(y)}px) rotate(${r3(r)}deg) scale(${r3(sx)}, ${r3(sy)})`;

/**
 * The keyframes of one reaction on the character's .fx-hit wrapper (every frame is the same transform list so the browser interpolates them).
 * Timeline: rest -> pressed within `pressMs` -> held (the hit-stop, `stopMs` + the type's `delay`) -> peak (knockback away from the click:
 * `dir` is +1 right or -1 left) -> springy return (springs of decaying size, alternating sides) -> rest. Levels scale the move (`H.levelScale`);
 * a seated character moves less (`H.seatedScale`) and does not spin. `miss` (dodge) skips the press and the hold: it was not hit.
 * Specials: 'shake' (angry: a rapid left-right shake instead of the knockback), 'spin' (dramatic: a full turn from `spinFromLevel`),
 * 'turn' (shy: turns its back, a negative x scale, from `turnFromLevel`), `side` (dodge: the sidestep comes first, at full size).
 * @returns {{frames: {offset: number, transform: string, easing: string}[], ms: number, pressedAt: number, stopEnd: number}} ms = the whole length, pressedAt/stopEnd as offsets
 */
export function motionFrames(p, level, dir, { stopMs, seated = false, miss = false, H }) {
  const lv = Math.min(Math.max(level, 1), H.levelScale.length);
  const k = H.levelScale[lv - 1];
  const kt = k * (seated ? H.seatedScale : 1); // how far it travels and tilts
  const amount = (v) => 1 + (v - 1) * k; // squash and stretch grow with the level
  const press = miss ? [1, 1] : [amount(p.press[0]), amount(p.press[1])];
  const peak = [amount(p.peak[0]), amount(p.peak[1])];
  const hold = miss ? 0 : stopMs + (p.delay ?? 0);
  const poses = []; // {t, x, y, r, sx, sy, ease}: t in ms from the impact
  const at = (t, x, y, r, sx, sy, ease = 'ease-in-out') => poses.push({ t, x, y, r, sx, sy, ease });
  const reach = dir * p.knock * kt;
  const punch = 'cubic-bezier(0.15, 0.8, 0.25, 1)';
  at(0, 0, 0, 0, 1, 1, miss ? punch : 'ease-out');
  if (!miss) {
    const stood = reach * (p.side ? 0.85 : 0.15); // a dodger has already stepped aside when the tap lands
    at(Math.min(H.pressMs, hold), stood, 0, 0, press[0], press[1], 'linear'); // pressed ...
    at(hold, stood, 0, 0, press[0], press[1], punch); // ... and held: the hit-stop
  }
  const total = hold + p.ms;
  const peakAt = hold + p.ms * p.peakShare;
  const tilt = dir * p.tilt * kt;
  if (p.special === 'shake') {
    const n = p.shakes;
    const step = (total - hold) / (n + 1);
    for (let i = 1; i <= n; i++) at(hold + step * i, (i % 2 ? 1 : -1) * p.shakePx * kt * (1 - i / (n + 2)) * 2, 0, (i % 2 ? 1 : -1) * tilt, peak[0], peak[1], 'ease-in-out');
  } else if (p.special === 'turn' && lv >= p.turnFromLevel) {
    at(peakAt, reach, 0, tilt, -peak[0], peak[1], 'ease-in-out'); // turned away ...
    at(hold + p.ms * 0.7, reach * 0.5, 0, tilt * 0.5, -peak[0], peak[1], 'ease-in-out'); // ... stays turned ...
  } else {
    const spin = p.special === 'spin' && lv >= p.spinFromLevel && !seated;
    at(peakAt, reach, -p.hop * k, spin ? dir * 180 : tilt, peak[0], peak[1], 'ease-in-out');
    if (spin) at(hold + p.ms * 0.55, reach * 0.6, -p.hop * k * 0.4, dir * 360, 1, 1, 'ease-in-out');
    const first = spin ? hold + p.ms * 0.55 : peakAt;
    const n = p.springs;
    for (let i = 1; i <= n; i++) {
      const a = (-p.decay) ** i; // alternating sign, shrinking
      const t = first + ((total - first) * i) / (n + 1);
      const base = spin ? dir * 360 : 0;
      at(t, reach * a * 0.6, -p.hop * k * Math.abs(a) * 0.5, base + tilt * a, 1 - p.jelly * a * k, 1 + p.jelly * a * k, 'ease-in-out');
    }
  }
  const rest = p.special === 'spin' && !seated && lv >= p.spinFromLevel ? dir * 360 : 0; // a finished spin looks like rest
  at(total, 0, 0, rest, 1, 1, 'ease-out');
  return {
    frames: poses.map((q) => ({ offset: r3(Math.min(q.t / total, 1)), transform: xf(q.x, q.y, q.r, q.sx, q.sy), easing: q.ease })),
    ms: total,
    pressedAt: r3(Math.min(H.pressMs, hold) / total),
    stopEnd: r3(hold / total),
  };
}

/** The lift: stretched up as it leaves the ground, then settles; and the dangling wiggle while held (one swing, played alternate and infinite). */
export function liftFrames(p, H) {
  const L = H.lift;
  const t = (sx, sy) => xf(0, 0, 0, sx, sy);
  return {
    pop: [{ offset: 0, transform: t(1, 1), easing: 'ease-out' }, { offset: 0.35, transform: t(L.press[0], L.press[1]), easing: 'ease-in-out' }, { offset: 1, transform: t(1, 1) }],
    popMs: L.ms,
    wiggle: [{ transform: xf(0, 0, -L.wiggleDeg * p.wig, 1, 1) }, { transform: xf(0, 0, L.wiggleDeg * p.wig, 1, 1) }],
    wiggleMs: L.wiggleMs,
  };
}

/**
 * The flight: a stretch along the throw velocity that relaxes, plus the type's spin over the whole flight (`spin` turns, the way it was thrown).
 * Everything turns about the body's middle (`H.throw.spinMidPx` above the feet), not about the feet. Frames share one transform list:
 * translate(0, -mid) rotate(spin) rotate(a) scale(sx, sy) rotate(-a) translate(0, mid).
 */
export function flightFrames(p, vx, vy, ms, H) {
  const a = Math.atan2(vy, vx) * (180 / Math.PI);
  const T = H.throw;
  const spin = (vx < 0 ? -1 : 1) * 360 * p.spin;
  const f = (turn, sx, sy) => `translate(0px, ${-T.spinMidPx}px) rotate(${r3(turn)}deg) rotate(${r3(a)}deg) scale(${r3(sx)}, ${r3(sy)}) rotate(${r3(-a)}deg) translate(0px, ${T.spinMidPx}px)`;
  return {
    frames: [
      { offset: 0, transform: f(0, T.stretch[0], T.stretch[1]), easing: 'ease-out' },
      { offset: T.relaxShare, transform: f(spin * T.relaxShare, 1 + (T.stretch[0] - 1) * 0.35, 1 + (T.stretch[1] - 1) * 0.35), easing: 'linear' },
      { offset: 1, transform: f(spin, 1, 1) },
    ],
    ms: Math.max(ms, 1),
  };
}

/** The landing: squashed harder than a poke (`pressBoost`), a small rebound hop, then settles. */
export function landFrames(p, H) {
  const L = H.land;
  const sx = 1 + (p.press[0] - 1) * L.pressBoost;
  const sy = 1 - (1 - p.press[1]) * L.pressBoost;
  return {
    frames: [
      { offset: 0, transform: xf(0, 0, 0, sx, sy), easing: 'ease-out' },
      { offset: 0.4, transform: xf(0, -L.hopPx, 0, 1 - (sx - 1) * 0.3, 1 + (1 - sy) * 0.3), easing: 'ease-in' },
      { offset: 0.7, transform: xf(0, 0, 0, 1 + (sx - 1) * 0.4, 1 - (1 - sy) * 0.4), easing: 'ease-out' },
      { offset: 1, transform: xf(0, 0, 0, 1, 1) },
    ],
    ms: L.ms,
  };
}

/** The happy bounce of a loved snack: hops with a jelly squash, decaying. */
export function bounceFrames(p, H) {
  const S = H.snack;
  const hop = S.bounceHopPx;
  return {
    frames: [
      { offset: 0, transform: xf(0, 0, 0, 1.12, 0.86), easing: 'ease-out' },
      { offset: 0.22, transform: xf(0, -hop, 0, 0.92, 1.12), easing: 'ease-in' },
      { offset: 0.42, transform: xf(0, 0, 0, 1.1, 0.9), easing: 'ease-out' },
      { offset: 0.62, transform: xf(0, -hop * 0.5, 0, 0.95, 1.06), easing: 'ease-in' },
      { offset: 0.8, transform: xf(0, 0, 0, 1.04, 0.96), easing: 'ease-out' },
      { offset: 1, transform: xf(0, 0, 0, 1, 1) },
    ],
    ms: S.bounceMs,
  };
}

/** The head shake of a disliked snack: left and right with a tilt, fading out. */
export function headShakeFrames(H) {
  const S = H.snack;
  const frames = [{ offset: 0, transform: xf(0, 0, 0, 1, 1), easing: 'ease-in-out' }];
  for (let i = 1; i <= S.shakes; i++) {
    const a = (i % 2 ? 1 : -1) * (1 - (i - 1) / (S.shakes + 1));
    frames.push({ offset: r3(i / (S.shakes + 1)), transform: xf(S.shakePx * a, 0, S.shakeDeg * a, 1, 1), easing: 'ease-in-out' });
  }
  frames.push({ offset: 1, transform: xf(0, 0, 0, 1, 1) });
  return { frames, ms: S.shakeMs };
}

// ---- particles ----

/**
 * The impact burst: `count` particles flying out of the click point, evenly spread round the circle with a little jitter and a tilt upwards.
 * `rng` returns [0, 1). Returns {dx, dy, rot, scale} per particle (floor px, degrees).
 */
export function burstPlan(count, distPx, rng) {
  const out = [];
  const turn = rng() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = turn + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const d = distPx * (0.7 + rng() * 0.5);
    out.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8 - distPx * 0.25, rot: (rng() - 0.5) * 240, scale: 0.8 + rng() * 0.5 });
  }
  return out;
}

/** The label and size of the combo counter, or null below `H.combo.from`. The size grows with each further click up to maxScale. */
export function comboView(n, H) {
  const C = H.combo;
  if (n < C.from) return null;
  return { text: C.label.replace('{n}', String(n)), scale: Math.min(C.baseScale + C.stepScale * (n - C.from), C.maxScale) };
}

/** Whether the persona's combo line replaces the poke line: the clicks went on past the top level. */
export const comboSpeaks = (combo, maxLevel) => combo > maxLevel;

/** Which way a character is knocked: away from the click (+1 right, -1 left). `centerX` and `clickX` share a coordinate space; dead centre alternates with the combo. */
export function knockDir(clickX, centerX, combo) {
  if (clickX === centerX) return combo % 2 ? 1 : -1;
  return clickX > centerX ? -1 : 1;
}

/** The snack mood of a persona for a kind that was eaten: 'love', 'dislike' or null. */
export function snackMood(persona, kind) {
  if (persona?.snack?.love?.includes(kind)) return 'love';
  if (persona?.snack?.dislike?.includes(kind)) return 'dislike';
  return null;
}
