// Bell meeting order rules (pure): who may ring, who speaks when, what happens when a phase meeting arrives.
// Numbers come from `ui.bellMeeting` (sayMs, gapMs, maxSpeakers, cooldownMs). Walking, DOM and timers live elsewhere.

/**
 * May the bell on this floor start a meeting now? A refusal says why and what to show (a sign only, never a wobble).
 * `s`: {phaseActive, bellActive, lunch, offFloor, now, lastRingAt}; `bm`: ui.bellMeeting.
 * @returns {{ok: boolean, reason?: string, sign?: string, wobble: boolean}}
 */
export function ringDecision(s, bm) {
  if (s.offFloor) return { ok: false, reason: 'hidden', wobble: false };
  if (s.phaseActive) return { ok: false, reason: 'phase', sign: bm.busyText, wobble: false };
  if (s.lunch) return { ok: false, reason: 'lunch', sign: bm.restText, wobble: false };
  if (s.bellActive) return { ok: false, reason: 'busy', wobble: false };
  if (s.lastRingAt != null && s.now - s.lastRingAt < bm.cooldownMs) return { ok: false, reason: 'cooldown', wobble: false };
  return { ok: true, wobble: false };
}

/**
 * Speaking order: the lead first, then staff by meeting-spot number, cut to `maxSpeakers` (the rest only gather).
 * `people`: [{id, isLead, spot, bubble}]. Returns {speakers, gatherOnly}.
 */
export function speakingOrder(people, maxSpeakers) {
  const lead = people.filter((p) => p.isLead);
  const staff = people.filter((p) => !p.isLead).sort((a, b) => a.spot - b.spot);
  const all = [...lead, ...staff];
  return { speakers: all.slice(0, maxSpeakers), gatherOnly: all.slice(maxSpeakers) };
}

/**
 * Schedule of one bell meeting. Each speaker says their current bubble text, or `lines.idle` when it is empty;
 * the chair opens only when the boss comes down, and always closes. `effects` off means no boss: the lead chairs.
 * @returns {{chair: 'ceo'|'lead', slots: {id, text, atMs}[], open: ?{text, atMs}, close: {text, atMs}, totalMs: number, gatherOnly: any[]}}
 */
export function planBell(people, opts) {
  const { sayMs, gapMs, maxSpeakers } = opts.bm;
  const { speakers, gatherOnly } = speakingOrder(people, maxSpeakers);
  const chair = opts.effects && !opts.reducedMotion ? 'ceo' : 'lead';
  const slots = speakers.map((p, i) => ({
    id: p.id,
    text: p.bubble ? p.bubble : opts.lines.idle,
    atMs: i * (sayMs + gapMs),
  }));
  const speakMs = speakers.length * sayMs + Math.max(0, speakers.length - 1) * gapMs;
  const close = { text: opts.lines.close, atMs: speakMs + (speakers.length ? gapMs : 0) };
  return {
    chair,
    slots,
    open: chair === 'ceo' ? { text: opts.lines.open, atMs: 0 } : null,
    close,
    totalMs: speakMs + (speakers.length ? gapMs : 0) + sayMs,
    gatherOnly,
  };
}

/** A phase signal arrives. During a bell meeting it ends the bell and hands over to a phase meeting chaired by the lead. */
export function onPhaseSignal(bellActive) {
  if (!bellActive) return { endBell: false, chair: 'lead', ceoStepAside: false };
  return { endBell: true, clearBubbles: true, chair: 'lead', ceoStepAside: true };
}
