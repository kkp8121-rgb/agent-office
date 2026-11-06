// Hidden-tab connection policy (pure). With the call-alert switch on, a hidden tab keeps its event stream so the alerts can still arrive;
// while it is hidden only `state` frames are taken (nothing is drawn, the area modules get them through ctx.onState with hidden: true).

/** True when pause() must leave the stream open. An open small window keeps today's behaviour (the opener never pauses then), so it never counts here. */
export function keepOpen({ hidden, pip, alerts }) {
  return Boolean(hidden && !pip && alerts);
}

/** Which frames a paused tab that kept its stream still takes. */
export function takeWhilePaused(type) {
  return type === 'state';
}
