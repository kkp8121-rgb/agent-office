// Effects area "chars" (character motion): a bouncy walk, and a smooth sit and stand. Everything is a Web Animation on the character's
// .fx-move wrapper (transform only, so the compositor runs it: no per-frame script, no layout, no style recalculation).
//
// What shows, and when (only while the effects are on; with them off the office looks exactly as before):
//   walk   a small hop and a slight squash in time with the steps. The legs swap every half of style.css "walking legs" (leg cycle
//          ui.fx.chars.legCycleMs, two steps per cycle), so one bob = one step. Walking is 150 px/s, a step is about 30 px. The bob starts
//          on 'walk-start' (the same task that turns the legs on, so both start on the same frame) and, on 'walk-end', runs to the end
//          of its current step instead of stopping dead, then eases from the landing squash back to the normal pose (settle) so the
//          figure never snaps out of the squash.
//   sit    on 'pose' (seated) with animate: the figure drops into the chair, dips a little and settles.
//   stand  on 'pose' (standing) with animate: a small crouch, a push-off hop and settle (a walk that follows waits for it).
// A pose change without animate (the first draw, a hidden tab catching up) shows nothing: no invented activity.
// Nothing runs for a floor that is not shown, or while the page is hidden; the cat keeps its own frames.
// The rules (frames, timing) are pure functions below; the DOM part is createMotion (an element with .animate is all it needs).

/** One step of the walk in ms: the legs' cycle divided by its steps (a bob is one step). */
export const stepMs = (cfg) => cfg.legCycleMs / cfg.stepsPerCycle;

/** The delay (ms) that puts a new bob on the step grid after something that still has `remainingMs` to run. */
export const alignDelay = (remainingMs, periodMs) => (remainingMs > 0 ? Math.ceil(remainingMs / periodMs) * periodMs : 0);

/** The total iteration count that ends a bob animation at the end of the step it is in, `elapsedMs` after its start (at least one). */
export const iterationsToFinish = (elapsedMs, periodMs) => Math.max(1, Math.ceil(elapsedMs / periodMs));

const pose = (y, sx, sy) => `translateY(${y}px) scale(${sx}, ${sy})`;

/** One bob (one step): lands squashed, is stretched at the top of the hop. Starts and ends on the same pose so it repeats without a seam. */
export function bobFrames(b) {
  const land = pose(0, b.landX, b.landY);
  return [
    { offset: 0, transform: land, easing: 'ease-out' },
    { offset: 0.5, transform: pose(-b.upPx, b.airX, b.airY), easing: 'ease-in' },
    { offset: 1, transform: land },
  ];
}

/** The end of a walk: from the landing squash (where a bob's last step ends) back to the normal pose. */
export function settleFrames(b) {
  return [
    { offset: 0, transform: pose(0, b.landX, b.landY), easing: 'ease-out' },
    { offset: 1, transform: pose(0, 1, 1) },
  ];
}

/** Sitting down: the figure comes from above the seat, dips (squashed) and settles. */
export function sitFrames(s) {
  return [
    { offset: 0, transform: pose(-s.fromPx, 1, 1), easing: 'ease-in' },
    { offset: s.dipAt, transform: pose(s.dipPx, s.squashX, s.squashY), easing: 'ease-out' },
    { offset: 1, transform: pose(0, 1, 1) },
  ];
}

/** Standing up: a small crouch, a push-off hop (stretched), settle. */
export function standFrames(s) {
  return [
    { offset: 0, transform: pose(s.dipPx, s.squashX, s.squashY), easing: 'ease-out' },
    { offset: s.hopAt, transform: pose(-s.hopPx, s.stretchX, s.stretchY), easing: 'ease-in-out' },
    { offset: 1, transform: pose(0, 1, 1) },
  ];
}

/**
 * The motion of one character. `el` = its .fx-move (anything with .animate(frames, timing) returning an Animation).
 * `onIdle()` is called when nothing of it runs any more. Bob and dip are two independent slots on the same element: a bob that
 * starts while a stand-up dip still runs waits for the dip's end, rounded up to the step grid (the legs started with the walk).
 */
export function createMotion(cfg, el, onIdle = () => {}) {
  const period = stepMs(cfg);
  let bob = null; // {anim, delay, finishing}
  let dip = null; // {anim, ms}
  let settle = null; // {anim}: the walk's end easing out of the landing squash
  const idle = () => {
    if (!bob && !dip && !settle) onIdle();
  };
  const run = (frames, timing, onDone) => {
    const anim = el.animate(frames, { fill: 'none', ...timing });
    anim.onfinish = anim.oncancel = onDone;
    return anim;
  };
  const time = (a) => a.currentTime ?? 0;

  const api = {
    /** Walking started (true) or ended (false). */
    walking(on) {
      if (on) {
        if (bob) {
          if (bob.finishing) {
            bob.anim.effect.updateTiming({ iterations: Infinity });
            bob.finishing = false;
          }
          return;
        }
        // a settle that still runs ends where the new bob starts (both are the landing squash)
        const s0 = settle;
        settle = null;
        s0?.anim.cancel();
        const delay = dip ? alignDelay(dip.ms - time(dip.anim), period) : 0;
        const mine = { delay, finishing: false };
        mine.anim = run(bobFrames(cfg.bob), { duration: period, iterations: Infinity, delay }, () => {
          if (bob === mine) bob = null;
          idle();
        });
        mine.anim.onfinish = () => {
          if (bob !== mine) return;
          bob = null;
          const set = {};
          set.anim = run(settleFrames(cfg.bob), { duration: cfg.settleMs }, () => {
            if (settle === set) settle = null;
            idle();
          });
          settle = set;
        };
        bob = mine;
        return;
      }
      if (!bob || bob.finishing) return;
      const elapsed = time(bob.anim) - bob.delay;
      if (elapsed <= 0) return void bob.anim.cancel();
      bob.finishing = true;
      bob.anim.effect.updateTiming({ iterations: iterationsToFinish(elapsed, period) });
    },
    /** Sat down (true) or stood up (false) with an animated change. */
    pose(seated) {
      api.cancel();
      const c = seated ? cfg.sit : cfg.stand;
      const mine = { ms: c.ms };
      mine.anim = run((seated ? sitFrames : standFrames)(c), { duration: c.ms }, () => {
        if (dip === mine) dip = null;
        idle();
      });
      dip = mine;
    },
    /** Everything stops at once (picked up, floor hidden, effects off). */
    cancel() {
      const all = [bob, dip, settle];
      bob = dip = settle = null;
      for (const s of all) s?.anim.cancel();
    },
    /** The page is hidden (true) or shown again (false). */
    pause(on) {
      for (const s of [bob, dip, settle]) if (s) on ? s.anim.pause() : s.anim.play();
    },
    running: () => !!(bob || dip || settle),
  };
  return api;
}

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.fx?.chars;
  if (!cfg?.enabled) return;
  const motions = new Map(); // rec -> motion (only while something of it runs)

  const membersOf = (f) => [...(f.agents ?? f.chars).values()];
  const floorOf = (rec) => [...ctx.floors()].find((f) => membersOf(f).includes(rec)) ?? null;
  const motionOf = (rec) => {
    let m = motions.get(rec);
    if (!m) motions.set(rec, (m = createMotion(cfg, rec.fxMove, () => motions.delete(rec))));
    return m;
  };
  const shown = (rec) => {
    const f = floorOf(rec);
    return !!f && ctx.floorActive(f);
  };
  const stopFloor = (f) => f && membersOf(f).forEach((rec) => motions.get(rec)?.cancel());
  /** Everyone of the floor that is walking right now gets a bob (a floor that came on screen, effects switched on). */
  const startFloor = (f) => {
    if (!f || !ctx.floorActive(f)) return;
    for (const rec of membersOf(f)) if (rec.walk && !rec.isCat && !rec.grab) motionOf(rec).walking(true);
  };

  ctx.fx.onFx('walk-start', ({ rec }) => {
    if (!rec.isCat && shown(rec)) motionOf(rec).walking(true);
  });
  ctx.fx.onFx('walk-end', ({ rec }) => motions.get(rec)?.walking(false));
  ctx.fx.onFx('pose', ({ rec, seated, animate }) => {
    if (animate && !rec.isCat && shown(rec)) motionOf(rec).pose(seated);
  });
  ctx.fx.onFx('lift', ({ rec }) => motions.get(rec)?.cancel());
  ctx.fx.onFx('floor-hidden', ({ floor }) => stopFloor(floor));
  ctx.fx.onFx('floor-shown', ({ floor }) => startFloor(floor));
  ctx.onPauseChange((paused) => motions.forEach((m) => m.pause(paused)));
  ctx.fx.onFxChange(({ fx }) => {
    if (fx) [...ctx.floors()].forEach(startFloor);
    else [...motions.values()].forEach((m) => m.cancel());
  });
}
