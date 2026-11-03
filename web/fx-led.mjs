// Effects area "led" (the 1F lobby LED status wall): makes the wall read like a real LED board.
// What it adds (all gated by the effects switch, nothing is built or listened to while they are off):
//   - colour steps on the CPU and memory numbers of the board header (config ui.fx.led.load.steps, e.g. 80 and 90 percent),
//   - a blink (opacity only) on a wall number whose text really changed,
//   - a marquee (one transform animation per line) on a news ticker whose text does not fit, paused while the lobby is not
//     shown, cropped (PiP) or the page is hidden, and removed when the line fits again.
// The dot-matrix texture and the glow are static CSS in fx-led.css (html.fx-on). The wall itself is built by app.mjs (buildWall); this
// module only reads its nodes (lobby.wall) and sets data-load / data-mq attributes and Web Animations on them.
// Rules are pure functions below (tests/fx-led.test.mjs); the DOM glue lives in init().

/** Colour step of a load percent: how many thresholds it reaches (0 = normal). A non-number is step 0. */
export function loadStep(value, steps) {
  if (!Number.isFinite(value)) return 0;
  return steps.reduce((n, t) => (value >= t ? n + 1 : n), 0);
}

/** True when a wall number's text really changed: it had a text before (the first fill never blinks) and now reads differently. */
export const textChanged = (prev, next) => typeof prev === 'string' && prev !== '' && prev !== next;

/** How many px a line sticks out of its box, or 0 when it fits (within `slack` px of rounding noise). */
export function overflowPx(textW, boxW, slack) {
  const over = textW - boxW;
  return over > slack ? Math.ceil(over) : 0;
}

/** The marquee of an overflowing line: it scrolls out `over` px at `speed` px/s and back, resting `holdMs` at each end. Null when it fits. */
export function marqueePlan(over, cfg) {
  if (!(over > 0)) return null;
  const move = (over / cfg.speed) * 1000;
  const durationMs = Math.round(move + 2 * cfg.holdMs);
  const hold = cfg.holdMs / durationMs;
  return {
    durationMs,
    keyframes: [
      { transform: 'translateX(0)', offset: 0 },
      { transform: 'translateX(0)', offset: hold },
      { transform: `translateX(${-over}px)`, offset: 1 - hold },
      { transform: `translateX(${-over}px)`, offset: 1 },
    ],
  };
}

/** Opacity keyframes of a blink: `count` dips down to `min` and back to full. */
export function blinkFrames(count, min) {
  const frames = [{ opacity: 1 }];
  for (let i = 0; i < count; i++) frames.push({ opacity: min }, { opacity: 1 });
  return frames;
}

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.fx.led;
  if (!cfg?.enabled) return;
  const { fx } = ctx;
  /** @type {null | {wall: object, obs: MutationObserver, texts: Map<Node, string>, tickers: Set<Element>, anims: Map<Element, {anim: Animation, over: number}>, blinks: Map<Node, Animation>, vals: Set<Element>}} */
  let att = null;

  const active = () => !!att && ctx.floorActive(ctx.lobby());

  function setAttr(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function paintLoad(s = ctx.sysload()) {
    if (!att || !s) return;
    for (const k of ['cpu', 'mem']) {
      const node = att.wall.sysVal?.[k];
      if (node) setAttr(node, 'data-load', String(loadStep(s[k], cfg.load.steps)));
    }
  }

  function stopMarquee(inner) {
    att.anims.get(inner)?.anim.cancel();
    att.anims.delete(inner);
    inner.parentElement.removeAttribute('data-mq');
  }

  /** Measures one ticker line and starts, keeps or stops its marquee. Only runs when its text changed or the lobby came into view.
   *  A line that still overflows by the same px keeps its running animation (no restart, no attribute churn). */
  function updateMarquee(inner) {
    const box = inner.parentElement;
    const over = overflowPx(inner.offsetWidth, box.clientWidth, cfg.marquee.minOverflow);
    const cur = att.anims.get(inner);
    if (cur && over > 0 && cur.over === over) return;
    const plan = marqueePlan(over, cfg.marquee);
    if (cur) stopMarquee(inner);
    if (!plan) return;
    setAttr(box, 'data-mq', 'on');
    const anim = inner.animate(plan.keyframes, { duration: plan.durationMs, iterations: Infinity, direction: 'alternate', easing: 'linear' });
    att.anims.set(inner, { anim, over });
    if (!active()) anim.pause();
  }

  function syncActive() {
    if (!att) return;
    const on = active();
    for (const { anim: a } of att.anims.values()) {
      if (on && a.playState === 'paused') a.play();
      else if (!on && a.playState === 'running') a.pause();
    }
  }

  function refresh() {
    if (!att) return;
    if (ctx.floorActive(ctx.lobby())) for (const t of att.tickers) updateMarquee(t);
    syncActive();
    paintLoad();
  }

  function onMutations(records) {
    if (!att) return;
    const on = active();
    for (const r of new Set(records.map((m) => m.target))) {
      if (att.tickers.has(r)) {
        if (on) updateMarquee(r);
        continue;
      }
      const text = r.textContent;
      const prev = att.texts.get(r);
      att.texts.set(r, text);
      // a number that is still blinking is not restarted: bursts of changes cost one short-lived layer, not a new one each time
      if (on && textChanged(prev, text) && att.blinks.get(r)?.playState !== 'running') {
        att.blinks.set(r, r.animate(blinkFrames(cfg.blink.count, cfg.blink.min), { duration: cfg.blink.ms, easing: 'linear' }));
      }
    }
  }

  function attach() {
    const lb = ctx.lobby();
    if (!lb?.wall || att?.wall === lb.wall) return;
    const w = lb.wall;
    const vals = [...Object.values(w.cells ?? {}), w.idxVal, ...Object.values(w.sysVal ?? {})].filter(Boolean);
    const tickers = (w.tickers ?? []).filter(Boolean);
    att = { wall: w, obs: new MutationObserver(onMutations), texts: new Map(vals.map((n) => [n, n.textContent])), tickers: new Set(tickers), anims: new Map(), blinks: new Map(), vals: new Set(vals) };
    for (const n of [...vals, ...tickers]) att.obs.observe(n, { childList: true, characterData: true });
    refresh();
  }

  function tidy() {
    if (!att) return;
    att.obs.disconnect();
    for (const t of att.tickers) stopMarquee(t);
    for (const n of att.vals) n.removeAttribute('data-load');
    att = null;
  }

  fx.onFx('sysload', (d) => { attach(); paintLoad(d); });
  for (const name of ['floor-shown', 'floor-hidden', 'crop']) fx.onFx(name, () => { attach(); refresh(); });
  ctx.onPauseChange(() => syncActive());
  fx.onFxChange(({ fx: on }) => {
    if (on) { attach(); refresh(); } else tidy();
  });
  if (fx.fxOn()) attach();
}
