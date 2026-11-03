// Effects area "hit": clicking, grabbing, throwing, landing and feeding snacks feel punchy and different per character personality.
//
// What it does, all on the GPU compositor (WAAPI element.animate with transform / translate / opacity only, no per-frame script, no rAF):
//  - a poke (or a cat pet): hit-stop at the impact, then squash and stretch, a knockback away from the click with a springy return and a tilt on the
//    character's .fx-hit wrapper; an impact burst, the impact word and (from level 3) a floor shake and a white flash; the combo counter; the persona's
//    combo line past the top level; each of the ten personality types (and the cat) has its own motion set (web/fx-hit-rules.mjs, numbers in ui.fx.hit.types)
//  - lift, dangling wiggle, throw (stretch along the flight, a spin per type), landing (dust, squash, hop), snacks (love: hearts and a bounce, dislike: "!?" and a head shake)
//  - persona lines: the page's line picker asks the persona first (createLinePicker); with no persona line today's generic line is used
//  - sound: synthesized, only for the viewer's own clicks, drags and drops (fx-hit-sound.mjs), the AudioContext only after a gesture and only while 「효과음」 is on
// While the effects are off (fxOn()) nothing here runs: the bus does not call the handlers, no element exists, no timer or listener is armed.
// Particles are a small pool of detached elements put into the floor's .fx-layer while they play and taken out when they end, so the layer is empty (and not drawn) otherwise.
import { bounceFrames, burstPlan, comboSpeaks, comboView, createLinePicker, flightFrames, headShakeFrames, hitStopMs, knockDir, landFrames, liftFrames, motionFrames, personaOf, snackMood, typeOf } from './fx-hit-rules.mjs';
import { createSound, soundPlan } from './fx-hit-sound.mjs';

const px = (n) => `${Math.round(n * 100) / 100}px`;

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const H = ctx.ui.fx?.hit;
  if (!H?.enabled) return;
  const personas = ctx.server?.personas ?? {};
  const rng = Math.random;
  const picker = createLinePicker({ personas, generic: ctx.ui.lines, rng });
  ctx.addLinePicker(picker.pick); // persona lines are text, not an effect: they follow the persona file, whatever the switches say

  const sound = createSound({
    Ctor: globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null,
    enabled: ctx.fx.sfxOn,
    volume: ctx.fx.fxVolume,
    maxVoices: H.sound.maxVoices,
    noiseMs: H.sound.noiseMs,
    attackMs: H.sound.attackMs,
    tailMs: H.sound.tailMs,
  });
  const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // ---- what is playing (so it can all be taken away) ----
  const free = []; // detached particle elements ready for reuse
  let made = 0;
  const live = new Set(); // {node, anim, floor, pooled}
  const hitAnims = new Map(); // rec -> its current reaction animation on .fx-hit
  const wiggles = new Map(); // rec -> the dangling wiggle while held
  const flashes = new Map(); // rec -> {node, anim}
  const combos = new Map(); // rec -> its combo counter {node, anim}
  const shakes = new Map(); // floor -> shake animation

  function release(item) {
    if (!live.delete(item)) return;
    item.anim.onfinish = item.anim.oncancel = null;
    item.node.remove();
    if (item.pooled) free.push(item.node);
  }

  /** Puts one particle on the floor's effects layer and plays `frames`; null when the pool is used up (the effect is simply skipped). */
  function fly(floor, cls, text, x, y, frames, ms, { delay = 0, color = '', size = 0, easing = 'ease-out' } = {}) {
    if (!floor.layer || live.size >= H.pool.maxActive) return null;
    let node = free.pop();
    if (!node) {
      if (made >= H.pool.max) return null;
      made++;
      node = document.createElement('i');
    }
    node.className = `fxh ${cls}`;
    node.textContent = text ?? '';
    node.style.left = px(x);
    node.style.top = px(y);
    node.style.fontSize = size ? px(size) : '';
    if (color) node.style.setProperty('--c', color);
    else node.style.removeProperty('--c');
    floor.layer.append(node);
    const anim = node.animate(frames, { duration: ms, delay, easing, fill: 'both' });
    const item = { node, anim, floor, pooled: true };
    live.add(item);
    anim.onfinish = anim.oncancel = () => release(item);
    return item;
  }

  function stopHit(rec) {
    hitAnims.get(rec)?.cancel();
    hitAnims.delete(rec);
  }

  function stopWiggle(rec) {
    wiggles.get(rec)?.cancel();
    wiggles.delete(rec);
  }

  /** Plays a reaction on the character's .fx-hit wrapper (replacing the one before). */
  function playOn(rec, frames, ms) {
    stopHit(rec);
    const anim = rec.fxHit.animate(frames, { duration: ms });
    hitAnims.set(rec, anim);
    const done = () => {
      if (hitAnims.get(rec) === anim) hitAnims.delete(rec);
    };
    anim.onfinish = anim.oncancel = done;
    return anim;
  }

  function tidyFloor(floor) {
    for (const item of [...live]) {
      if (item.floor === floor) {
        item.anim.cancel();
        release(item);
      }
    }
    for (const map of [hitAnims, wiggles, flashes, combos]) {
      for (const [rec, v] of [...map]) {
        if (rec.frec !== floor) continue;
        (v.anim ?? v).cancel();
        v.node?.remove();
        map.delete(rec);
      }
    }
    shakes.get(floor)?.cancel();
    shakes.delete(floor);
  }

  function tidyAll() {
    for (const floor of new Set([...live].map((i) => i.floor))) tidyFloor(floor);
    for (const map of [hitAnims, wiggles, flashes, combos]) {
      for (const [rec, v] of [...map]) {
        (v.anim ?? v).cancel();
        v.node?.remove();
        map.delete(rec);
      }
    }
    for (const a of shakes.values()) a.cancel();
    shakes.clear();
  }

  // ---- geometry: where things are, in floor pixels (the layer's own space) ----
  function frame(rec) {
    const floor = rec.frec;
    const box = floor.stage.getBoundingClientRect();
    const k = box.width / floor.scene.r.size[0];
    const bb = rec.body.getBoundingClientRect();
    const seated = !!rec.seated;
    const bodyH = rec.isCat ? H.bodyHeightPx.cat : seated ? H.bodyHeightPx.seated : H.bodyHeightPx.person;
    const midX = (bb.left + bb.right) / 2;
    const to = (cx, cy) => [(cx - box.left) / k, (cy - box.top) / k];
    return { floor, midX, seated, head: to(midX, bb.bottom - bodyH * k), feet: to(midX, bb.bottom), to, bodyH };
  }

  const active = (rec) => !!rec?.frec && !!rec.fxHit && ctx.floorActive(rec.frec);

  // ---- the pieces ----
  const levelIndex = (level, list) => Math.min(Math.max(level, 1), list.length) - 1;

  function word(floor, text, x, y, color) {
    const W = H.word;
    const lift = W.liftPx;
    return fly(floor, 'word', text, x, y, [
      { offset: 0, transform: 'translate(0px, 0px) scale(0.4)', opacity: 0 },
      { offset: 0.18, transform: `translate(0px, ${px(-lift)}) scale(${W.pop})`, opacity: 1 },
      { offset: 0.5, transform: `translate(0px, ${px(-lift - W.risePx * 0.5)}) scale(1)`, opacity: 1 },
      { offset: 1, transform: `translate(0px, ${px(-lift - W.risePx)}) scale(0.95)`, opacity: 0 },
    ], W.ms, { color, size: W.sizePx });
  }

  function burst(floor, glyph, count, dist, x, y, color, ms = H.burst.ms) {
    for (const q of burstPlan(count, dist, rng)) {
      fly(floor, 'glyph', glyph, x, y, [
        { offset: 0, transform: 'translate(0px, 0px) rotate(0deg) scale(0.3)', opacity: 1 },
        { offset: 0.3, transform: `translate(${px(q.dx * 0.6)}, ${px(q.dy * 0.6)}) rotate(${q.rot * 0.5}deg) scale(${q.scale * 1.25})`, opacity: 1 },
        { offset: 1, transform: `translate(${px(q.dx)}, ${px(q.dy + dist * 0.35)}) rotate(${q.rot}deg) scale(${q.scale * 0.6})`, opacity: 0 },
      ], ms, { color, size: H.burst.sizePx, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    }
  }

  /** Small round puffs (dust at the feet, steam, blush) flying out sideways/upwards from (x, y). */
  function puffs(floor, cls, count, x, y, spreadPx, riseOrDrop, ms, color) {
    for (let i = 0; i < count; i++) {
      const side = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2;
      const jitter = (rng() - 0.5) * 0.4;
      fly(floor, cls, '', x + side * spreadPx * 0.3, y, [
        { offset: 0, transform: 'translate(0px, 0px) scale(0.4)', opacity: 0.9 },
        { offset: 1, transform: `translate(${px((side + jitter) * spreadPx)}, ${px(riseOrDrop)}) scale(1.15)`, opacity: 0 },
      ], ms, { color, delay: i * 40 });
    }
  }

  function comboCounter(rec, f, n) {
    const view = comboView(n, H);
    if (!view) return;
    const C = H.combo;
    combos.get(rec)?.anim.cancel();
    const [x, y] = f.head;
    const item = fly(f.floor, 'combo', view.text, x, y - C.gapPx, [
      { offset: 0, transform: `translate(0px, 0px) scale(${view.scale * 0.5})`, opacity: 0 },
      { offset: 0.15, transform: `translate(0px, ${px(-C.gapPx * 0.4)}) scale(${view.scale * 1.2})`, opacity: 1 },
      { offset: 0.3, transform: `translate(0px, ${px(-C.gapPx * 0.6)}) scale(${view.scale})`, opacity: 1 },
      { offset: 0.8, transform: `translate(0px, ${px(-C.gapPx * 1.2)}) scale(${view.scale})`, opacity: 1 },
      { offset: 1, transform: `translate(0px, ${px(-C.gapPx * 1.8)}) scale(${view.scale * 0.9})`, opacity: 0 },
    ], C.ms, { color: H.types[typeOf(rec, personaOf(personas, rec))]?.color ?? '' });
    if (item) combos.set(rec, item);
  }

  function whiteFlash(rec, floor) {
    const F = H.flash;
    flashes.get(rec)?.anim.cancel();
    const node = rec.spr.cloneNode(true); // a copy of the picture, whitened by a static filter (style sheet); only its opacity moves
    node.className = 'spr fxw';
    node.setAttribute('aria-hidden', 'true');
    rec.flip.append(node);
    const anim = node.animate([{ opacity: 0 }, { offset: 0.2, opacity: F.opacity }, { opacity: 0 }], { duration: F.ms, easing: 'ease-out' });
    const item = { node, anim, floor, pooled: false };
    live.add(item);
    flashes.set(rec, item);
    anim.onfinish = anim.oncancel = () => {
      if (flashes.get(rec) === item) flashes.delete(rec);
      release(item);
    };
  }

  function shakeFloor(floor) {
    const S = H.shake;
    shakes.get(floor)?.cancel();
    const frames = [{ translate: '0px 0px' }];
    for (let i = 1; i <= S.steps; i++) {
      const decay = 1 - i / (S.steps + 1);
      const a = (i % 2 ? 1 : -1) * S.px * decay;
      frames.push({ translate: `${px(a)} ${px(-a * 0.4)}` });
    }
    frames.push({ translate: '0px 0px' });
    const anim = floor.stage.animate(frames, { duration: S.ms, easing: 'linear' });
    shakes.set(floor, anim);
    anim.onfinish = anim.oncancel = () => {
      if (shakes.get(floor) === anim) shakes.delete(floor);
    };
  }

  function extras(rec, f, T, level, persona) {
    const E = T.extra;
    const X = H.extras;
    if (!E || level < E.from) return;
    const [hx, hy] = f.head;
    const color = T.color;
    if (E.kind === 'drop') {
      for (let i = 0; i < X.drops; i++) {
        const sx = (i % 2 ? 1 : -1) * (X.puffSpreadPx * 0.7 + i * 2);
        fly(f.floor, 'drop', '', hx + sx, hy + 4, [
          { offset: 0, transform: 'translate(0px, 0px) scale(0.5)', opacity: 0 },
          { offset: 0.2, transform: 'translate(0px, 1px) scale(1)', opacity: 1 },
          { offset: 1, transform: `translate(0px, ${px(X.dropFallPx)}) scale(0.9)`, opacity: 0 },
        ], X.puffMs * 0.7, { delay: i * 90, easing: 'ease-in' });
      }
    } else if (E.kind === 'steam') {
      puffs(f.floor, 'puff', X.puffs, hx, hy, X.puffSpreadPx, -X.puffRisePx, X.puffMs);
    } else if (E.kind === 'mark') {
      word(f.floor, H.marks[E.mark], hx, hy - 6, color);
    } else if (E.kind === 'sparkle') {
      for (const q of burstPlan(X.sparkles, X.sparkDistPx, rng)) {
        fly(f.floor, 'glyph', '✦', hx, hy + 10, [
          { offset: 0, transform: 'translate(0px, 0px) scale(0.2) rotate(0deg)', opacity: 0 },
          { offset: 0.35, transform: `translate(${px(q.dx * 0.7)}, ${px(q.dy * 0.7)}) scale(${q.scale * 1.2}) rotate(${q.rot * 0.4}deg)`, opacity: 1 },
          { offset: 1, transform: `translate(${px(q.dx)}, ${px(q.dy)}) scale(0.2) rotate(${q.rot}deg)`, opacity: 0 },
        ], X.puffMs * 0.8, { color: '#ffe27a', size: H.burst.sizePx });
      }
    } else if (E.kind === 'blush') {
      for (let i = 0; i < X.blush; i++) {
        const sx = (i % 2 ? 1 : -1) * X.blushSpreadPx;
        fly(f.floor, 'blush', '', hx + sx, hy + 12, [
          { offset: 0, transform: 'translate(0px, 0px) scale(0.5)', opacity: 0 },
          { offset: 0.25, transform: 'translate(0px, -2px) scale(1)', opacity: 0.85 },
          { offset: 1, transform: 'translate(0px, -6px) scale(1.1)', opacity: 0 },
        ], X.blushMs);
      }
    }
    void persona;
  }

  // ---- sound: only the viewer's own gestures reach these events ----
  function ping(kind, persona, combo = 1) {
    if (!ctx.fx.sfxOn()) return;
    sound.play(soundPlan(kind, persona.voice, combo, H.sound));
  }

  // ---- the poke (and the cat's pet) ----
  function react(rec, level, combo, cx, cy) {
    if (!active(rec)) return;
    const persona = personaOf(personas, rec);
    const name = typeOf(rec, persona);
    const T = H.types[name];
    if (!T) return;
    rec.body.classList.remove('squash', 'fid-hop'); // our reaction replaces the office's own squash and hop
    const f = frame(rec);
    const [ix, iy] = f.to(cx, cy);
    const li = levelIndex(level, H.hitStopMs);
    const miss = !!T.missChance && rng() < T.missChance[Math.min(li, T.missChance.length - 1)];
    const dir = knockDir(cx, f.midX, combo);
    const stopMs = hitStopMs(level, T, H);
    const mf = motionFrames(T, level, dir, { stopMs, seated: f.seated, miss, H });
    playOn(rec, mf.frames, mf.ms);
    const words = persona.hitWords.length > 0 ? persona.hitWords : T.words;
    if (miss) {
      word(f.floor, H.marks.miss, ix, iy, T.color);
      ping(T.snd, persona, combo);
    } else {
      const heartsOnly = T.hearts === true;
      if (!heartsOnly || level >= H.flash.fromLevel) burst(f.floor, heartsOnly ? H.burst.heartGlyph : H.burst.glyphs[li], H.burst.counts[li], H.burst.distPx[li], ix, iy, heartsOnly ? '#ff5d8f' : T.color);
      word(f.floor, words[(combo - 1) % words.length], ix, iy, T.color);
      ping(T.snd, persona, combo);
      if (T.thud) puffs(f.floor, 'puff dust', H.land.dropDust, f.feet[0], f.feet[1], H.land.dustDistPx * 0.6, -3, H.land.dustMs * 0.7);
      if (level >= H.flash.fromLevel && !reduced()) whiteFlash(rec, f.floor);
      if (level >= H.shake.fromLevel && !reduced()) shakeFloor(f.floor);
      extras(rec, f, T, level, persona);
    }
    comboCounter(rec, f, combo);
    const P = rec.isCat ? ctx.ui.cat.pet : ctx.ui.poke;
    if (comboSpeaks(combo, P.maxLevel)) ctx.sayFor(rec, ctx.line(rec.isCat ? 'catCombo' : 'combo', undefined, rec), P.sayMs);
  }

  // ---- grab, throw, landing ----
  function onLift({ rec }) {
    if (!active(rec)) return;
    const persona = personaOf(personas, rec);
    const T = H.types[typeOf(rec, persona)];
    if (!T) return;
    const lf = liftFrames(T, H);
    const anim = playOn(rec, lf.pop, lf.popMs);
    anim.onfinish = () => {
      hitAnims.delete(rec);
      if (!rec.grab || !active(rec)) return;
      const w = rec.fxHit.animate(lf.wiggle, { duration: lf.wiggleMs, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
      wiggles.set(rec, w);
      w.oncancel = () => {
        if (wiggles.get(rec) === w) wiggles.delete(rec);
      };
    };
    ping('pop', persona, 1);
  }

  function onThrown({ rec, vx, vy }) {
    stopWiggle(rec);
    if (!active(rec)) return;
    const persona = personaOf(personas, rec);
    const T = H.types[typeOf(rec, persona)];
    if (!T) return;
    const timing = rec.grab?.anims?.[0]?.effect?.getTiming?.();
    const ms = typeof timing?.duration === 'number' ? timing.duration : H.throw.fallbackMs;
    const ff = flightFrames(T, vx, vy, ms, H);
    playOn(rec, ff.frames, ff.ms);
    ping('whoosh', persona, 1);
  }

  /** The landing look runs once the office has put the character down (a microtask later): the dust sits at the real feet, the office's own thump gives way. */
  function onDown({ rec }, thrown) {
    stopWiggle(rec);
    if (thrown) stopHit(rec);
    if (!active(rec)) return;
    queueMicrotask(() => {
      if (!ctx.fx.fxOn() || !active(rec)) return;
      rec.body.classList.remove('thump');
      const persona = personaOf(personas, rec);
      const T = H.types[typeOf(rec, persona)];
      if (!T) return;
      const lf = landFrames(T, H);
      playOn(rec, lf.frames, lf.ms);
      const f = frame(rec);
      puffs(f.floor, 'puff dust', thrown ? H.land.dust : H.land.dropDust, f.feet[0], f.feet[1], H.land.dustDistPx, -4, H.land.dustMs);
      ping(T.thud || thrown ? 'thump' : 'pop', persona, 1);
    });
  }

  // ---- snacks ----
  function onSnack({ rec, kind, result }) {
    if (!active(rec)) return;
    const persona = personaOf(personas, rec);
    const T = H.types[typeOf(rec, persona)];
    if (!T) return;
    const f = frame(rec);
    const S = H.snack;
    if (result !== 'eat') {
      picker.setMood(rec, null);
      const hs = headShakeFrames(H);
      playOn(rec, hs.frames, hs.ms);
      ping('buzz', persona, 1);
      return;
    }
    const mood = snackMood(persona, kind);
    picker.setMood(rec, mood);
    if (mood === 'love') {
      burst(f.floor, H.burst.heartGlyph, S.hearts, S.heartDistPx, f.head[0], f.head[1] + 8, '#ff5d8f', S.heartMs);
      const bf = bounceFrames(T, H);
      playOn(rec, bf.frames, bf.ms);
      ping('chime', persona, 1);
    } else if (mood === 'dislike') {
      word(f.floor, H.marks.dislike, f.head[0], f.head[1] - 4, T.color);
      const hs = headShakeFrames(H);
      playOn(rec, hs.frames, hs.ms);
      ping('buzz', persona, 1);
    } else {
      ping('pop', persona, 1);
    }
  }

  // ---- wiring ----
  const offs = [
    ctx.fx.onFx('poke', (d) => react(d.rec, d.level, d.combo, d.x, d.y)),
    ctx.fx.onFx('cat-pet', (d) => react(d.cat, d.level, d.combo, d.x, d.y)),
    ctx.fx.onFx('lift', onLift),
    ctx.fx.onFx('drop', (d) => onDown(d, false)),
    ctx.fx.onFx('thrown', onThrown),
    ctx.fx.onFx('landed', (d) => onDown(d, true)),
    ctx.fx.onFx('snack', onSnack),
    ctx.fx.onFx('floor-hidden', (d) => tidyFloor(d.floor)),
    ctx.fx.onFx('crop', (d) => {
      if (d.cropped && d.floor) tidyFloor(d.floor);
    }),
  ];
  void offs;
  ctx.onPauseChange((paused) => {
    if (paused) tidyAll();
  });

  // The sound context is made by the viewer's own gesture, and only while the sound switch is on; the listener exists only then.
  const gesture = () => sound.gesture();
  let listening = false;
  function syncSound() {
    const want = ctx.fx.sfxOn();
    if (want && !listening) {
      listening = true;
      document.addEventListener('pointerdown', gesture, true);
      document.addEventListener('pointerup', gesture, true);
    } else if (!want && listening) {
      listening = false;
      document.removeEventListener('pointerdown', gesture, true);
      document.removeEventListener('pointerup', gesture, true);
      sound.sleep();
    }
  }
  ctx.fx.onFxChange(({ fx }) => {
    if (!fx) tidyAll();
    syncSound();
  });
  syncSound();
}
