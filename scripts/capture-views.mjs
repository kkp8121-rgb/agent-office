// Captures the three empty-office designs (ui.empty.variant a|b|c) in light and dark theme at two window sizes (1280x800 and the small window 420x640)
// and writes one self-contained comparison page for choosing between them.
//   node scripts/capture-views.mjs --work <scratch dir> [--out <comparison html>]
// It starts its own office server on 47811 over empty temporary folders (never the real office on 47800), its own headless Chrome on 9352 with its own profile
// folder, and blocks every outbound call (proxy variables point at a closed local port, loopback is excepted). It stops only the two processes it started.
// The page has no external reference: every picture is a data: URI. --out defaults to .superpowers/sdd/2026-10-28-agent-office/empty-compare.html under the repo.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47811;
const CDP_PORT = 9352;
const CLOSED = 'http://127.0.0.1:9';
const SIZES = [[1280, 800], [420, 640]];
const THEMES = ['light', 'dark'];
const DESIGNS = [
  {
    key: 'a', title: '(가) 불 꺼진 로비',
    what: '건물 보기에서 로비만 크게 보여 줍니다. 불을 낮춘 로비 소파에서 고양이가 자고, 안내 데스크 위 세움 간판이 「오늘은 아직 아무도 출근하지 않았어요」 라고 알려 줍니다. 위층과 지하는 어둡게 잘려 보입니다.',
    plus: '지금 쓰는 로비 그림을 그대로 써서 가장 사무실답고, 자는 고양이 덕분에 정이 갑니다.',
  },
  {
    key: 'b', title: '(나) 건물 바깥',
    what: '건물 전체를 바깥에서 보여 줍니다. 모든 창이 꺼져 있고 1층 로비 창만 켜져 있으며(낮에는 블라인드가 내려가 있습니다), 정문 위 간판에 안내 문구가 걸립니다.',
    plus: '「건물은 있는데 아직 아무도 없다」 가 한눈에 보이고, 첫 층이 생기면 건물이 채워지는 흐름이 가장 자연스럽습니다.',
  },
  {
    key: 'c', title: '(다) 출근 준비 중인 사무실',
    what: '사장실 아래에 불이 켜진 빈 사무실 한 층을 보여 주고, 화이트보드 자리에 「출근 준비 완료」 카드와 시작 순서 세 줄을 띄웁니다.',
    plus: '무엇을 하면 되는지 순서가 바로 보여서 처음 쓰는 사람에게 가장 친절합니다.',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 100) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout waiting for a condition');
    await sleep(step);
  }
}
const killTree = (pid) => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid);
  } catch { /* already gone */ }
};

function args() {
  const a = process.argv.slice(2);
  const get = (name) => {
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : null;
  };
  const work = get('--work');
  if (!work) {
    console.error('사용법: node scripts/capture-views.mjs --work <작업 폴더> [--out <비교 페이지 경로>]');
    process.exit(1);
  }
  return { work: resolve(work), out: resolve(get('--out') ?? join(ROOT, '.superpowers/sdd/2026-10-28-agent-office/empty-compare.html')) };
}

function chromePath() {
  const e = process.env;
  const list = [e.AGENT_OFFICE_CHROME, e.ProgramFiles && join(e.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    e['ProgramFiles(x86)'] && join(e['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  const found = list.find((p) => existsSync(p));
  if (found) return found;
  throw new Error('Chrome not found: set AGENT_OFFICE_CHROME');
}

async function connect(port) {
  const t = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page');
    } catch { return null; }
  });
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const i = ++id;
    pending.set(i, (d) => (d.error ? no(new Error(JSON.stringify(d.error))) : ok(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, ev, close: () => ws.close() };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(shots) {
  const fig = (d, theme, [w, h]) => {
    const file = `${d.key}-${theme}-${w}x${h}`;
    const label = `${theme === 'light' ? '밝은 화면' : '어두운 화면'} · ${w}×${h}${w < 600 ? ' (작은 창)' : ''}`;
    return `<figure class="s${w < 600 ? ' small' : ''}"><img src="data:image/png;base64,${shots.get(file).toString('base64')}" alt="${esc(`${d.title} ${label}`)}"><figcaption>${label}</figcaption></figure>`;
  };
  const sections = DESIGNS.map((d) => `<section>
<h2>${esc(d.title)}</h2>
<p class="what">${esc(d.what)}</p>
<p class="plus"><b>장점</b> ${esc(d.plus)}</p>
<div class="grid">${THEMES.flatMap((t) => SIZES.map((s) => fig(d, t, s))).join('\n')}</div>
</section>`).join('\n');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>빈 화면 시안 비교</title>
<style>
:root { color-scheme: light dark; --bg: #efe6d2; --ink: #3b2f22; --card: #fbf8f1; --line: #ddd2bb; --muted: #7a6a4e; --accent: #a8402b; }
@media (prefers-color-scheme: dark) { :root { --bg: #17120c; --ink: #efe6d2; --card: #251e15; --line: #4a3e2d; --muted: #b8aa8f; --accent: #ff9d80; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 4px; font-size: 24px; }
.lead { margin: 0 0 24px; color: var(--muted); }
section { margin: 0 0 32px; padding: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
h2 { margin: 0 0 6px; font-size: 19px; color: var(--accent); }
.what, .plus { margin: 4px 0; }
.grid { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; margin-top: 12px; }
figure { margin: 0; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
figure.s { flex: 1 1 520px; max-width: 560px; }
figure.small { flex: 0 1 210px; max-width: 220px; }
figcaption { margin-top: 4px; font-size: 13px; color: var(--muted); }
code { padding: 1px 5px; background: var(--bg); border-radius: 4px; }
</style>
</head>
<body>
<main>
<h1>빈 화면 시안 비교</h1>
<p class="lead">일하는 층이 하나도 없을 때 보이는 화면입니다. 문구는 세 시안 모두 같습니다: 「터미널이나 데스크톱 앱에서 Claude Code·Codex를 켜면 첫 직원이 출근합니다」. 고르면 설정 <code>ui.empty.variant</code> 를 <code>a</code> · <code>b</code> · <code>c</code> 중 하나로 정합니다(지금은 <code>a</code>). 직접 보려면 주소 끝에 <code>?debug=empty&amp;empty=b</code> 를 붙이면 됩니다.</p>
${sections}
</main>
</body>
</html>
`;
}

async function main() {
  const { work, out } = args();
  rmSync(work, { recursive: true, force: true });
  for (const d of ['claude', 'codex', 'data', 'profile', 'shots']) mkdirSync(join(work, d), { recursive: true });
  const pids = [];
  let cdp = null;
  try {
    const log = openSync(join(work, 'server.log'), 'a');
    const server = spawn(process.execPath, ['server/main.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env, AGENT_OFFICE_CLAUDE_HOME: join(work, 'claude'), AGENT_OFFICE_CODEX_HOME: join(work, 'codex'), AGENT_OFFICE_DATA_DIR: join(work, 'data'),
        AGENT_OFFICE_PORT: String(PORT), HTTP_PROXY: CLOSED, HTTPS_PROXY: CLOSED, http_proxy: CLOSED, https_proxy: CLOSED, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['ignore', log, log], windowsHide: true,
    });
    pids.push(server.pid);
    await until(async () => {
      try { return (await fetch(`http://127.0.0.1:${PORT}/api/ui`)).ok; } catch { return false; }
    });
    const chrome = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run',
      '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', `--proxy-server=${CLOSED}`, '--proxy-bypass-list=127.0.0.1;localhost', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    pids.push(chrome.pid);
    cdp = await connect(CDP_PORT);
    const shots = new Map();
    for (const d of DESIGNS) {
      for (const theme of THEMES) {
        for (const [w, h] of SIZES) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
          const url = `http://127.0.0.1:${PORT}/?debug=empty&empty=${d.key}${theme === 'light' ? '&time=day' : ''}`;
          await cdp.send('Page.navigate', { url });
          await until(() => cdp.ev('document.readyState === "complete"'));
          await cdp.ev(`localStorage.setItem('agent-office.theme', '${theme}')`);
          await cdp.send('Page.reload');
          await until(() => cdp.ev(`(() => { const r = document.querySelector('.em-root[data-ready="1"]'); return !!r && !r.hidden && document.documentElement.dataset.theme === '${theme}'; })()`));
          await cdp.ev('document.fonts.ready.then(() => true)');
          await until(() => cdp.ev('document.getAnimations().every((a) => a.effect.getComputedTiming().iterations === Infinity || a.playState !== "running")')); // the card has finished appearing
          let before = '';
          await until(async () => { // the box has stopped moving
            const now = await cdp.ev('JSON.stringify(document.querySelector(".em-root").getBoundingClientRect())');
            const same = now === before;
            before = now;
            return same;
          });
          const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
          const key = `${d.key}-${theme}-${w}x${h}`;
          const png = Buffer.from(r.data, 'base64');
          writeFileSync(join(work, 'shots', `${key}.png`), png);
          shots.set(key, png);
          console.log(`shot ${key} (${png.length} bytes)`);
        }
      }
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, page(shots), 'utf8');
    console.log(`page ${out}`);
  } finally {
    try { cdp?.close(); } catch { /* closed */ }
    for (const pid of pids.reverse()) killTree(pid);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
