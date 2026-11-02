// Real weather for the room windows. The only outbound connection of the whole app: one GET to Open-Meteo's forecast endpoint
// (no key, no account) carrying nothing but the configured coordinates and fixed parameters. It runs only while a page is
// connected, on one timer, and the page gets a small field (kind, city, time) only when that changes - never the raw answer.

const MINUTE = 60000;
const MAX_BODY_CHARS = 20000; // the real answer is ~300 bytes

/** Weather kinds the page can draw. */
export const KINDS = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm', 'unknown'];

/**
 * WMO weather code (Open-Meteo `weather_code`, the "WW" table of open-meteo.com/en/docs) -> kind.
 * 0-1 clear, 2-3 cloudy, 45/48 fog, 51-57 drizzle and 61-67 rain (freezing ones too) and 80-82 rain showers -> rain,
 * 71-77 snow and 85-86 snow showers -> snow, 95-99 thunderstorm (hail too) -> storm; anything else -> unknown.
 */
export function kindOf(code) {
  if (!Number.isInteger(code)) return 'unknown';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 75) || code === 77 || code === 85 || code === 86) return 'snow';
  if (code === 95 || code === 96 || code === 97 || code === 99) return 'storm';
  return 'unknown';
}

/** The request URL: the configured coordinates and fixed parameters, nothing else. */
export function requestUrl(baseUrl, latitude, longitude) {
  return `${baseUrl}/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=weather_code`;
}

const validCoords = (w) => Number.isFinite(w.latitude) && Math.abs(w.latitude) <= 90 && Number.isFinite(w.longitude) && Math.abs(w.longitude) <= 180;

/**
 * @param w config.json `weather`: {enabled, city, latitude, longitude, refreshMinutes, staleMinutes, timeoutSeconds, backoffMinutes}
 * @param deps test hooks: fetchFn, baseUrl, now, setTimer, clearTimer, log
 * @returns {{enabled, connect(), disconnect(), current(), subscribe(fn), connections, timerActive}}
 */
export function createWeather(w, deps = {}) {
  const {
    fetchFn = (...a) => globalThis.fetch(...a), baseUrl = 'https://api.open-meteo.com', now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, log = (m) => console.log(m),
  } = deps;
  const refreshMs = w.refreshMinutes * MINUTE;
  const staleMs = w.staleMinutes * MINUTE;
  const timeoutMs = w.timeoutSeconds * 1000;
  let enabled = Boolean(w.enabled);
  if (enabled && !validCoords(w)) {
    log('날씨: 좌표가 올바르지 않아 끕니다 (config.json weather.latitude / longitude)');
    enabled = false;
  }
  const url = enabled ? requestUrl(baseUrl, w.latitude, w.longitude) : '';

  let connections = 0;
  let timer = null;
  let good = null; // {kind, at}: the last answer that parsed
  let failures = 0;
  let nextFetchAt = 0; // the earliest moment of the next request (refresh after a success, backoff after a failure)
  let busy = false;
  let lastError = '';
  let reported = ''; // kind and city of the last field handed out
  let logged = ''; // the last state line written
  const listeners = new Set();

  const fresh = () => good !== null && now() - good.at < staleMs;
  const field = () => ({ kind: fresh() ? good.kind : 'unknown', city: w.city, time: good ? good.at : null });

  /** One log line per state change (kind or health), never one per failed attempt. */
  function logState() {
    const state = `${failures === 0 ? 'ok' : 'fail'}:${field().kind}`;
    if (state === logged) return;
    logged = state;
    log(failures === 0 ? `날씨: ${field().kind}` : `날씨 서비스에 닿지 않습니다 (${lastError}) - ${good && fresh() ? `마지막 값(${good.kind}) 유지` : '알 수 없음으로 표시'}, 다시 시도합니다`);
  }

  function emit() {
    const f = field();
    const key = `${f.kind}|${f.city}`; // the page needs the kind: a newer `time` alone is not worth a push
    logState();
    if (key === reported) return;
    reported = key;
    for (const fn of listeners) fn(f);
  }

  async function request() {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new Error('answer too large');
    const code = JSON.parse(text)?.current?.weather_code;
    if (!Number.isInteger(code)) throw new Error('no weather_code in the answer');
    return code;
  }

  async function fetchNow() {
    busy = true;
    try {
      const code = await request();
      good = { kind: kindOf(code), at: now() };
      failures = 0;
      nextFetchAt = now() + refreshMs;
    } catch (e) {
      lastError = e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? String(e));
      failures += 1;
      const steps = w.backoffMinutes;
      nextFetchAt = now() + steps[Math.min(failures, steps.length) - 1] * MINUTE;
    }
    busy = false;
    emit();
  }

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  /** The one timer: wakes for the next request or for the moment the held value turns stale, whichever is first. */
  function arm() {
    clear();
    if (!enabled || connections === 0 || busy) return;
    let at = nextFetchAt;
    if (good && fresh()) at = Math.min(at, good.at + staleMs);
    timer = setTimer(wake, Math.max(0, at - now()));
    timer.unref?.();
  }

  async function wake() {
    timer = null;
    if (connections === 0 || busy) return; // a request in flight re-arms the timer when it ends
    if (now() >= nextFetchAt) await fetchNow();
    else emit();
    arm();
  }

  return {
    enabled,
    /** A page connected. The first one fetches when the held value is older than refreshMinutes (or there is none) and starts the timer. */
    connect() {
      if (!enabled) return;
      connections += 1;
      if (connections === 1) void wake();
    },
    /** A page left. The last one stops the timer. */
    disconnect() {
      if (connections === 0) return;
      connections -= 1;
      if (connections === 0) clear();
    },
    current: field,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get connections() { return connections; },
    get timerActive() { return timer !== null; },
  };
}
