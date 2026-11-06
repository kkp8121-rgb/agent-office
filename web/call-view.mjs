// The bell (floor calls the boss) as plain rules, no DOM: which floors show the bell sign, the tab title, and the call-alert switch with its
// Windows notifications. web/fx-incidents.mjs draws; tests/call-view.test.mjs checks these.
// The sign and the wave on screen do not depend on the alert switch. Only the notifications and the hidden-tab connection do.

/** `{n}`-style placeholders of a config text. */
export const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));

/** The bell sign of a floor view: {kind, text} from ui.bell.text, or null. A floor on its lunch break shows no bell (the lunch sign wins), an unknown kind has no sign. */
export function bellOf(view, cfg) {
  if (!view || view.rest) return null;
  const kind = view.call;
  if (typeof kind !== 'string' || !Object.hasOwn(cfg.text, kind)) return null;
  return { kind, text: cfg.text[kind] };
}

/** The floor views that call right now (a list never holds the floors the viewer hid). */
export const callingFloors = (list, cfg) => list.filter((view) => bellOf(view, cfg));

/** The tab title: `ui.bell.titlePrefix` with the count in front of the plain title, the plain title at zero. */
export const titleWith = (base, count, prefix) => (count > 0 ? fill(prefix, { n: count }) + base : base);

/**
 * The 「호출 알림」 switch. `on` is remembered in this browser (storage may be blocked: then it only lasts for this page).
 * Turning on asks for the browser permission, which must happen inside the click: request() is called before anything is awaited.
 * Turning off stops both the notifications (the notifier asks isOn()) and the hidden-tab connection (keepAlive.set(false)).
 */
export function createAlertSwitch({ storage, key, keepAlive, permission, request }) {
  let on = false;
  const save = (value) => {
    try {
      storage.setItem(key, value ? '1' : '0');
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  };
  const set = (value) => {
    on = value;
    keepAlive.set(value);
    save(value);
  };
  return {
    isOn: () => on,
    /** Restores the remembered choice. It never asks: a remembered "on" without a granted permission stays off. */
    restore() {
      let saved = null;
      try {
        saved = storage.getItem(key);
      } catch {
        // storage blocked: off
      }
      on = saved === '1' && permission() === 'granted';
      keepAlive.set(on);
      return on;
    },
    /** @returns {Promise<boolean>} true when the switch is on now */
    async turnOn() {
      const asked = permission() === 'default' ? request() : null; // first statement: still inside the click
      const result = asked ? await asked : permission();
      if (result !== 'granted') return false;
      set(true);
      return true;
    },
    turnOff() {
      set(false);
    },
    permission,
  };
}

/**
 * Decides when a Windows notification is due: a floor's call went from none to a value. The first state this page sees is only remembered
 * (a call that was already there is not news). A floor is not notified again inside ui.bell.notifyMinGapMs.
 * @param {{cfg: object, isOn: () => boolean, now: () => number, notify: (n: {sessionId: string, title: string, body: string}) => void}} deps
 */
export function createNotifier({ cfg, isOn, now, notify }) {
  const seen = new Map(); // sessionId -> call kind or null, as of the last state
  const lastAt = new Map(); // sessionId -> when it was notified
  let first = true;
  return {
    update(list) {
      const ids = new Set();
      for (const view of list) {
        ids.add(view.sessionId);
        const sign = bellOf(view, cfg);
        const before = seen.has(view.sessionId) ? seen.get(view.sessionId) : first ? sign?.kind ?? null : null;
        seen.set(view.sessionId, sign?.kind ?? null);
        if (!sign || before !== null || !isOn()) continue;
        const t = now();
        if (t - (lastAt.get(view.sessionId) ?? -Infinity) < cfg.notifyMinGapMs) continue;
        lastAt.set(view.sessionId, t);
        notify({ sessionId: view.sessionId, title: cfg.notifyTitle, body: `${view.title} ${sign.text}` });
      }
      for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
      first = false;
    },
  };
}
