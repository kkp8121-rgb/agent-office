// Effects area "chars" (walking bounce, smooth sit and stand, GPU conversion of the character animations): not built yet. init(ctx) is called once at start-up (see the ctx typedef in fx.mjs).
// Rules: listen with ctx.fx.onFx (called only while the effects are on), keep numbers in config ui.fx.chars, animate only transform and opacity.

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  void ctx;
}
