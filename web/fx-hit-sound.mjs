// Hit sounds: tiny Web Audio synth voices (pops, thumps, whooshes, squeaks), no audio files. Only played in answer to the viewer's own
// clicks, drags and drops. The AudioContext is created by the first user gesture and only while the 「효과음」 switch is on; at most
// `maxVoices` sounds play at once; the master volume is ui.fx.volume times the recipe's own gain.
// soundPlan is pure (tests read it); createSound takes the AudioContext constructor and the switches as dependencies.

/**
 * The voices of a sound: the recipe of `kind` (config ui.fx.hit.sound.recipes) with its pitch multiplied by the persona voice and
 * the combo (each further click raises it a little, up to comboPitchMax). Returns [] for an unknown kind.
 * @returns {{wave?: string, noise: boolean, f0: number, f1: number, ms: number, at: number, gain: number, q: number}[]}
 */
export function soundPlan(kind, voice, combo, S) {
  const recipe = S.recipes[kind];
  if (!recipe) return [];
  const pitch = voice * Math.min(1 + S.comboPitchStep * Math.max(combo - 1, 0), S.comboPitchMax);
  return recipe.map((v) => ({ wave: v.wave, noise: !!v.noise, f0: v.f0 * pitch, f1: v.f1 * pitch, ms: v.ms, at: v.at ?? 0, gain: v.gain * S.master, q: v.q ?? 1 }));
}

const SILENCE = 0.0001; // the lowest gain an exponential ramp can reach (it cannot reach 0)

/**
 * One synth. deps: Ctor (AudioContext constructor or null), enabled() (the 「효과음」 switch), volume() (0..1), maxVoices, noiseMs (length of the shared noise buffer), attackMs and tailMs (the voice's fade-in and the grace before it is stopped).
 * gesture() is called from a user gesture (pointerdown on the page): it creates the context when sound is on. Nothing else ever creates it.
 */
export function createSound(deps) {
  let ac = null;
  let failed = false;
  let noise = null;
  let active = 0;

  function noiseBuffer() {
    if (noise) return noise;
    const len = Math.round((ac.sampleRate * deps.noiseMs) / 1000);
    noise = ac.createBuffer(1, len, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noise;
  }

  const api = {
    /** True once the context exists. */
    ready: () => ac !== null,
    gesture() {
      if (!deps.enabled() || failed) return;
      if (!ac) {
        if (!deps.Ctor) return;
        try {
          ac = new deps.Ctor();
        } catch {
          failed = true; // blocked or unsupported: the office stays silent, nothing retries
          return;
        }
      }
      if (ac.state === 'suspended') ac.resume?.();
    },
    /** The sound is off again (switch or effects): the context sleeps and costs nothing. */
    sleep() {
      if (ac && ac.state === 'running') ac.suspend?.();
    },
    /** Plays one sound (a plan from soundPlan). Returns false when it did not (no context yet, switch off, too many voices). */
    play(plan) {
      if (!ac || !deps.enabled() || plan.length === 0 || active >= deps.maxVoices) return false;
      if (ac.state === 'suspended') ac.resume?.();
      const t0 = ac.currentTime;
      const vol = deps.volume();
      active++;
      let open = plan.length;
      const done = () => {
        if (--open === 0) active--;
      };
      for (const v of plan) {
        const start = t0 + v.at / 1000;
        const end = start + v.ms / 1000;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(SILENCE, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(v.gain * vol, SILENCE), start + deps.attackMs / 1000);
        gain.gain.exponentialRampToValueAtTime(SILENCE, end);
        let src;
        let sweep;
        if (v.noise) {
          src = ac.createBufferSource();
          src.buffer = noiseBuffer();
          const filter = ac.createBiquadFilter();
          filter.type = 'bandpass';
          filter.Q.value = v.q;
          sweep = filter.frequency;
          src.connect(filter);
          filter.connect(gain);
        } else {
          src = ac.createOscillator();
          src.type = v.wave;
          sweep = src.frequency;
          src.connect(gain);
        }
        sweep.setValueAtTime(v.f0, start);
        sweep.exponentialRampToValueAtTime(Math.max(v.f1, 1), end);
        gain.connect(ac.destination);
        src.onended = done;
        src.start(start);
        src.stop(end + deps.tailMs / 1000);
      }
      return true;
    },
    /** Voices playing now (tests). */
    voices: () => active,
  };
  return api;
}
