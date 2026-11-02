// Weather in the room windows (page side). Pure helpers (which weather to draw, the remembered choice, the window boxes, the
// panel's status line) and the small DOM builder for the overlays. The animation is CSS only (style.css "weather"): nothing here
// runs on a timer. Strings come from `ui.ui.weather`; the real weather arrives as the SSE event `weather` {kind, city, time}.

/** What the settings panel offers, in order: follow the real weather, force one, or none at all. */
export const CHOICES = ['auto', 'clear', 'cloudy', 'fog', 'rain', 'snow', 'storm', 'off'];
const FORCED = new Set(['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm']);

/** The kind the windows show: 'none' (off, or auto while the real weather is unknown) or one of clear|cloudy|fog|rain|snow|storm. */
export function effectKind(choice, real) {
  if (choice === 'off') return 'none';
  if (FORCED.has(choice)) return choice;
  return FORCED.has(real) ? real : 'none';
}

/** The remembered choice, or 'auto' when nothing valid is stored or the storage cannot be read. `getStorage` may throw (blocked storage). */
export function loadChoice(getStorage, key) {
  try {
    const v = getStorage().getItem(key);
    return CHOICES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Remembers the choice; false when the storage refuses (the choice then lasts for this page only). */
export function saveChoice(getStorage, key, choice) {
  try {
    getStorage().setItem(key, choice);
    return true;
  } catch {
    return false;
  }
}

/**
 * The panel's line about the real weather. `strings` = ui.ui.weather ({now, unknown, disabled, kinds}), `enabled` = ui.weather.enabled
 * (config.json), `field` = the last `weather` event or null, `city` = ui.weather.city (shown until the first event).
 */
export function statusLine(strings, enabled, field, city = '') {
  if (!enabled) return strings.disabled;
  const kind = field?.kind ?? 'unknown';
  const name = strings.kinds[kind] ?? strings.kinds.unknown;
  return (kind === 'unknown' ? strings.unknown : strings.now).replace('{city}', field?.city || city).replace('{kind}', name);
}

/**
 * One box per window polygon (scene pixels): its bounding box and the polygon as a clip-path in the box's own coordinates.
 * @returns {{left, top, width, height, clip}[]}
 */
export function windowBoxes(polygons) {
  return polygons.map((poly) => {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
      left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top,
      clip: `polygon(${poly.map((p) => `${p[0] - left}px ${p[1] - top}px`).join(', ')})`,
    };
  });
}

const GOLDEN = 0.6180339887; // spreads the animation phase of neighbouring windows

/**
 * The overlay of one floor: a layer holding one clipped box per window, each with two moving layers (a, b) and a flash layer (f).
 * Which of them show, and how they move, is decided by the layer's `data-wx` in style.css. Starts hidden.
 */
export function buildWeather(doc, polygons, z) {
  const root = doc.createElement('div');
  root.className = 'wx';
  root.hidden = true;
  root.style.zIndex = String(z);
  windowBoxes(polygons).forEach((b, i) => {
    const win = doc.createElement('div');
    win.className = 'wx-win';
    Object.assign(win.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, clipPath: b.clip });
    win.style.setProperty('--wx-p', ((i * GOLDEN) % 1).toFixed(3));
    for (const cls of ['wx-a', 'wx-b', 'wx-f']) {
      const layer = doc.createElement('div');
      layer.className = cls;
      win.append(layer);
    }
    root.append(win);
  });
  return root;
}

/** Shows `kind` on a built overlay ('none' and 'clear' draw nothing, so the layer is hidden and has no animation to run). */
export function setWeatherKind(root, kind) {
  const draws = kind !== 'none' && kind !== 'clear';
  if (draws) root.dataset.wx = kind;
  else delete root.dataset.wx;
  root.hidden = !draws;
}
