// Weather: the code -> kind table, the fetch scheduler (fake clock, fake fetch: nothing here touches the network), the SSE hookup,
// and the page helpers (forced choice, storage-blocked fallback, window boxes, status line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { createWeather, kindOf, requestUrl } from '../server/weather.mjs';
import { CHOICES, buildWeather, effectKind, loadChoice, saveChoice, setWeatherKind, statusLine, windowBoxes } from '../web/weather.mjs';

const MIN = 60000;
const W = { enabled: true, city: '서울', latitude: 37.5665, longitude: 126.978, refreshMinutes: 30, staleMinutes: 180, timeoutSeconds: 10, backoffMinutes: [5, 15, 30] };
const flush = () => new Promise((r) => setImmediate(r));

/** A clock whose timers fire only when the test advances it. */
function fakeClock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms, unref() {} };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    get pending() { return timers.length; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift();
        t = Math.max(t, h.at);
        await h.fn();
        await flush();
      }
      t = end;
    },
  };
}

/** A fetch that answers with the queued codes (a number = weather_code, an Error = failure, a string = raw body) and records the calls. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    if (typeof a === 'string') return { ok: true, status: 200, text: async () => a };
    return { ok: true, status: 200, text: async () => JSON.stringify({ current: { time: '2026-11-02T06:45', interval: 900, weather_code: a } }) };
  };
  fn.calls = calls;
  fn.set = (...next) => { answers.length = 0; answers.push(...next); };
  return fn;
}

function setup(answers, w = W) {
  const clock = fakeClock();
  const fetchFn = fakeFetch(...answers);
  const logs = [];
  const pushed = [];
  const svc = createWeather(w, { fetchFn, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (m) => logs.push(m), baseUrl: 'http://fake.test' });
  svc.subscribe((f) => pushed.push(f));
  return { clock, fetchFn, logs, pushed, svc };
}

// ---- code -> kind ----

test('weather: every WMO code of the Open-Meteo table maps to the documented kind', () => {
  const table = {
    clear: [0, 1], cloudy: [2, 3], fog: [45, 48], rain: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82],
    snow: [71, 73, 75, 77, 85, 86], storm: [95, 96, 97, 99], unknown: [4, 10, 44, 100, -1, 1.5, NaN, null, undefined, '63'],
  };
  for (const [kind, codes] of Object.entries(table)) for (const c of codes) assert.equal(kindOf(c), kind, `code ${c}`);
});

test('weather: the request carries only the configured coordinates and the fixed parameter', () => {
  assert.equal(requestUrl('https://api.open-meteo.com', 37.5665, 126.978), 'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978&current=weather_code');
  const { fetchFn, svc } = setup([63]);
  svc.connect();
  return flush().then(() => {
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].url, 'http://fake.test/v1/forecast?latitude=37.5665&longitude=126.978&current=weather_code');
    assert.equal(fetchFn.calls[0].opts.redirect, 'error');
    assert.deepEqual(Object.keys(fetchFn.calls[0].opts).sort(), ['headers', 'redirect', 'signal']);
  });
});

// ---- scheduler ----

test('weather: no fetch and no timer without a connection, and none at all when disabled', async () => {
  const a = setup([0]);
  await a.clock.advance(10 * 60 * MIN);
  assert.equal(a.fetchFn.calls.length, 0);
  assert.equal(a.clock.pending, 0);
  const b = setup([0], { ...W, enabled: false });
  b.svc.connect();
  await flush();
  await b.clock.advance(10 * 60 * MIN);
  assert.equal(b.svc.enabled, false);
  assert.equal(b.fetchFn.calls.length, 0);
  assert.equal(b.clock.pending, 0);
  assert.equal(b.svc.connections, 0);
});

test('weather: the first connection fetches, one timer runs while connected, the last page leaving clears it', async () => {
  const { clock, fetchFn, svc } = setup([63]);
  svc.connect();
  await flush();
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(clock.pending, 1);
  svc.connect(); // a second page: no second request, still one timer
  svc.connect();
  await flush();
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(clock.pending, 1);
  svc.disconnect();
  svc.disconnect();
  assert.equal(clock.pending, 1);
  svc.disconnect(); // the last one
  assert.equal(clock.pending, 0);
  assert.equal(svc.timerActive, false);
  await clock.advance(5 * 60 * MIN);
  assert.equal(fetchFn.calls.length, 1, 'nothing fetched while nobody is connected');
  svc.disconnect(); // extra calls never go below zero
  assert.equal(svc.connections, 0);
});

test('weather: one request every refreshMinutes while connected; a page reconnecting within that time does not fetch', async () => {
  const { clock, fetchFn, svc } = setup([63]);
  svc.connect();
  await flush();
  await clock.advance(29 * MIN);
  assert.equal(fetchFn.calls.length, 1);
  await clock.advance(1 * MIN);
  assert.equal(fetchFn.calls.length, 2);
  await clock.advance(30 * MIN);
  assert.equal(fetchFn.calls.length, 3);
  svc.disconnect();
  await clock.advance(10 * MIN);
  svc.connect(); // 10 minutes after the last fetch: the value is fresh enough
  await flush();
  assert.equal(fetchFn.calls.length, 3);
  assert.equal(clock.pending, 1);
  svc.disconnect();
  await clock.advance(60 * MIN);
  svc.connect(); // an hour later: older than refreshMinutes, so the first page fetches
  await flush();
  assert.equal(fetchFn.calls.length, 4);
});

test('weather: a field (kind, city, time) is pushed only when the kind changes, never the raw answer', async () => {
  const { clock, pushed, svc } = setup([63, 63, 61, 71]);
  svc.connect();
  await flush();
  assert.equal(pushed.length, 1);
  assert.deepEqual(Object.keys(pushed[0]), ['kind', 'city', 'time']);
  assert.equal(pushed[0].kind, 'rain');
  assert.equal(pushed[0].city, '서울');
  await clock.advance(30 * MIN); // code 63 again
  await clock.advance(30 * MIN); // code 61: still rain
  assert.equal(pushed.length, 1, 'same kind: nothing pushed');
  assert.ok(svc.current().time > pushed[0].time, 'but a reconnecting page gets the newer time');
  await clock.advance(30 * MIN); // 71: snow
  assert.equal(pushed.length, 2);
  assert.equal(pushed.at(-1).kind, 'snow');
  assert.deepEqual(svc.current(), pushed.at(-1));
});

test('weather: failures keep the last value, back off 5 -> 15 -> 30 -> 30 minutes, and log once', async () => {
  const boom = new Error('HTTP 503');
  const { clock, fetchFn, logs, pushed, svc } = setup([63, boom]);
  svc.connect();
  await flush();
  assert.equal(fetchFn.calls.length, 1);
  await clock.advance(30 * MIN); // refresh due: fails
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(svc.current().kind, 'rain', 'the last good value stays');
  await clock.advance(4 * MIN);
  assert.equal(fetchFn.calls.length, 2);
  await clock.advance(1 * MIN); // +5 min: second failure
  assert.equal(fetchFn.calls.length, 3);
  await clock.advance(14 * MIN);
  assert.equal(fetchFn.calls.length, 3);
  await clock.advance(1 * MIN); // +15 min
  assert.equal(fetchFn.calls.length, 4);
  await clock.advance(30 * MIN); // +30 min
  assert.equal(fetchFn.calls.length, 5);
  await clock.advance(30 * MIN); // and again +30
  assert.equal(fetchFn.calls.length, 6);
  assert.equal(logs.filter((l) => l.includes('닿지 않습니다')).length, 1, 'one line for the whole failing stretch');
  assert.equal(pushed.at(-1).kind, 'rain');
});

test('weather: a value older than staleMinutes is reported as unknown, and a recovery is logged and pushed', async () => {
  const boom = new Error('HTTP 503');
  const { clock, fetchFn, logs, pushed, svc } = setup([63, boom]);
  svc.connect();
  await flush();
  const t0 = clock.now();
  await clock.advance(179 * MIN);
  assert.equal(svc.current().kind, 'rain');
  await clock.advance(2 * MIN); // 181 minutes after the last success
  assert.ok(clock.now() - t0 > 180 * MIN);
  assert.equal(svc.current().kind, 'unknown');
  assert.equal(pushed.find((f) => f.kind === 'unknown') !== undefined, true);
  assert.equal(svc.current().time, t0, 'time stays the last good one');
  assert.ok(logs.some((l) => l.includes('알 수 없음')));
  assert.equal(logs.filter((l) => l.includes('닿지 않습니다')).length, 2, 'one line when it starts failing, one when the value turns stale');
  fetchFn.set(71); // the service is back
  await clock.advance(30 * MIN);
  assert.equal(svc.current().kind, 'snow');
  assert.equal(pushed.at(-1).kind, 'snow');
  assert.ok(logs.at(-1).startsWith('날씨: snow'));
});

test('weather: an answer without a usable weather_code, or an HTTP error, counts as a failure', async () => {
  for (const bad of ['not json', '{}', '{"current":{"weather_code":"63"}}', '{"current":{"weather_code":null}}', 'x'.repeat(30000)]) {
    const { svc, logs } = setup([bad]);
    svc.connect();
    await flush();
    assert.equal(svc.current().kind, 'unknown', bad.slice(0, 20));
    assert.equal(logs.length, 1);
  }
  const clock = fakeClock();
  const svc = createWeather(W, { fetchFn: async () => ({ ok: false, status: 429 }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
  svc.connect();
  await flush();
  assert.equal(svc.current().kind, 'unknown');
});

test('weather: a request that never answers is aborted after timeoutSeconds', async () => {
  const logs = [];
  const fetchFn = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const svc = createWeather({ ...W, timeoutSeconds: 0.05 }, { fetchFn, log: (m) => logs.push(m) });
  svc.connect();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(svc.current().kind, 'unknown');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /timeout/);
  svc.disconnect();
  assert.equal(svc.timerActive, false);
});

test('weather: bad coordinates in config.json turn the weather off with one line', () => {
  for (const bad of [{ latitude: 91 }, { longitude: -181 }, { latitude: 'x' }, { longitude: null }]) {
    const logs = [];
    const svc = createWeather({ ...W, ...bad }, { log: (m) => logs.push(m), fetchFn: () => assert.fail('no request') });
    assert.equal(svc.enabled, false);
    svc.connect();
    assert.equal(logs.length, 1);
  }
});

test('weather: config.json ships Seoul, 30 minutes, 180 minutes stale', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    { enabled: cfg.weather.enabled, city: cfg.weather.city, latitude: cfg.weather.latitude, longitude: cfg.weather.longitude, refresh: cfg.weather.refreshMinutes, stale: cfg.weather.staleMinutes },
    { enabled: true, city: '서울', latitude: 37.5665, longitude: 126.978, refresh: 30, stale: 180 },
  );
  for (const k of CHOICES) assert.ok(cfg.ui.weather.choices[k], `ui.weather.choices.${k}`);
  for (const k of ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm', 'unknown']) assert.ok(cfg.ui.weather.kinds[k], `ui.weather.kinds.${k}`);
});

// ---- server hookup ----

/** Opens /api/events and collects the event names and the weather payloads. */
function listen(port) {
  const out = { events: [], weather: [], closed: false };
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev) continue;
        out.events.push(ev);
        if (ev === 'weather') out.weather.push(JSON.parse(data));
      }
    });
  });
  out.close = () => req.destroy();
  return out;
}

test('server: a connected page gets the weather field first, then only changes; the source runs only while a page is connected', async (t) => {
  const clock = fakeClock();
  const fetchFn = fakeFetch(63, 71);
  const svc = createWeather(W, { fetchFn, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {}, baseUrl: 'http://fake.test' });
  const cfg = loadConfig();
  const server = createServer(cfg, new Office(cfg, { hidden: [], names: {} }), { weather: svc });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  assert.equal(svc.connections, 0);

  const ui = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/ui', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve(JSON.parse(b)));
  }));
  assert.deepEqual(ui.weather, { enabled: true, city: '서울' });

  const a = listen(port);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(svc.connections, 1);
  assert.equal(fetchFn.calls.length, 1);
  assert.deepEqual(a.weather.map((f) => f.kind), ['unknown', 'rain'], 'first the held value, then the fetched one');
  await clock.advance(30 * MIN);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.weather.at(-1).kind, 'snow');
  assert.deepEqual(Object.keys(a.weather.at(-1)), ['kind', 'city', 'time']);
  a.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(svc.connections, 0);
  assert.equal(clock.pending, 0, 'the last page left: no timer');
});

test('server: without a weather source nothing is sent and /api/ui says it is off', async (t) => {
  const cfg = loadConfig();
  const server = createServer(cfg, new Office(cfg, { hidden: [], names: {} }), {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  const a = listen(port);
  await new Promise((r) => setTimeout(r, 150));
  a.close();
  assert.ok(a.events.includes('state'));
  assert.equal(a.weather.length, 0);
  const ui = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/ui', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve(JSON.parse(b)));
  }));
  assert.equal(ui.weather.enabled, false);
});

// ---- page helpers ----

test('page: the forced choice wins over the real weather, off removes everything, auto follows the real kind', () => {
  for (const real of ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm', 'unknown', undefined]) {
    for (const forced of ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm']) assert.equal(effectKind(forced, real), forced);
    assert.equal(effectKind('off', real), 'none');
  }
  assert.equal(effectKind('auto', 'rain'), 'rain');
  assert.equal(effectKind('auto', 'storm'), 'storm');
  assert.equal(effectKind('auto', 'unknown'), 'none');
  assert.equal(effectKind('auto', undefined), 'none');
});

test('page: the choice is remembered, and a blocked or broken storage falls back to auto without throwing', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadChoice(() => storage, 'k'), 'auto');
  assert.equal(saveChoice(() => storage, 'k', 'rain'), true);
  assert.equal(loadChoice(() => storage, 'k'), 'rain');
  mem.set('k', 'blizzard');
  assert.equal(loadChoice(() => storage, 'k'), 'auto', 'an unknown stored value is ignored');
  const blocked = () => { throw new DOMException('denied', 'SecurityError'); }; // reading window.localStorage itself throws
  assert.equal(loadChoice(blocked, 'k'), 'auto');
  assert.equal(saveChoice(blocked, 'k', 'snow'), false);
  const quota = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(loadChoice(() => quota, 'k'), 'auto');
  assert.equal(saveChoice(() => quota, 'k', 'snow'), false);
});

test('page: the panel line says the real weather, unknown, or that config.json turned it off', () => {
  const S = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).ui.weather;
  assert.equal(statusLine(S, true, { kind: 'rain', city: '서울', time: 1 }, '서울'), '지금 서울: 비');
  assert.match(statusLine(S, true, { kind: 'unknown', city: '서울', time: null }, '서울'), /^지금 서울: 알 수 없음/);
  assert.match(statusLine(S, true, null, '서울'), /^지금 서울: 알 수 없음/);
  assert.equal(statusLine(S, false, { kind: 'rain', city: '서울' }, '서울'), S.disabled);
  assert.equal(S.credit, '날씨 정보: Open-Meteo.com');
});

test('page: one box per window polygon with the polygon in the box\'s own coordinates', () => {
  const boxes = windowBoxes([[[77, 160], [103, 148], [103, 226], [77, 236]], [[426, 40], [479, 40], [479, 114], [426, 114]]]);
  assert.deepEqual(boxes[0], { left: 77, top: 148, width: 26, height: 88, clip: 'polygon(0px 12px, 26px 0px, 26px 78px, 0px 88px)' });
  assert.deepEqual(boxes[1], { left: 426, top: 40, width: 53, height: 74, clip: 'polygon(0px 0px, 53px 0px, 53px 74px, 0px 74px)' });
});

test('page: the overlay is built hidden, shows a kind, and hides again for clear and none', () => {
  const made = [];
  const doc = {
    createElement: (tag) => {
      const e = { tag, className: '', hidden: false, style: { setProperty(k, v) { this[k] = v; } }, dataset: {}, children: [], append(...c) { this.children.push(...c); } };
      made.push(e);
      return e;
    },
  };
  const root = buildWeather(doc, [[[0, 0], [10, 0], [10, 20], [0, 20]], [[20, 0], [30, 0], [30, 20], [20, 20]]], 1);
  assert.equal(root.hidden, true);
  assert.equal(root.style.zIndex, '1');
  assert.equal(root.children.length, 2);
  assert.deepEqual(root.children[0].children.map((c) => c.className), ['wx-a', 'wx-b', 'wx-f']);
  assert.notEqual(root.children[0].style['--wx-p'], root.children[1].style['--wx-p'], 'neighbouring windows start at different phases');
  setWeatherKind(root, 'rain');
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.wx, 'rain');
  for (const k of ['clear', 'none']) {
    setWeatherKind(root, k);
    assert.equal(root.hidden, true);
    assert.equal(root.dataset.wx, undefined);
  }
});
