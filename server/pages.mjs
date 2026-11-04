// The two HTML documents the server answers for "/" and "/log". They live in a module (not .html files) so that
// no file in the project carries an extension that upload filters refuse. Served by server/http.mjs byte for byte.
// The inline <script> in <head> applies the saved light/dark theme before first paint (no CSP script-src is sent, so it needs no hash).
export const INDEX_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>에이전트 사무실</title>
<link rel="icon" href="data:,">
<script>try{var t=localStorage.getItem("agent-office.theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="stylesheet" href="/web/style.css">
<link rel="stylesheet" href="/web/fx-weather.css">
<link rel="stylesheet" href="/web/fx-chars.css">
<link rel="stylesheet" href="/web/fx-events.css">
<link rel="stylesheet" href="/web/fx-led.css">
<link rel="stylesheet" href="/web/fx-hit.css">
<link rel="stylesheet" href="/web/officelife.css">
<link rel="stylesheet" href="/web/decor.css">
<link rel="stylesheet" href="/web/card.css">
</head>
<body>
<header id="topbar">
  <nav id="floor-tabs" aria-label="층 전환">
    <button id="tab-lobby" class="tab lobby" type="button" aria-pressed="false" hidden></button>
    <span id="tab-list"></span>
    <button id="view-all" type="button" aria-pressed="true" title="모든 층을 쌓아서 보기">전체</button>
  </nav>
  <div class="tb-right">
    <div id="snacks" role="group" aria-label="간식 주기">
      <button class="snack" type="button" data-snack="coffee" title="커피 — 끌어다 캐릭터에게 주세요"><img src="/assets/snacks/snack-coffee.png" alt="커피" draggable="false"></button>
      <button class="snack" type="button" data-snack="donut" title="도넛 — 끌어다 캐릭터에게 주세요"><img src="/assets/snacks/snack-donut.png" alt="도넛" draggable="false"></button>
      <button class="snack" type="button" data-snack="cookie" title="쿠키 — 끌어다 캐릭터에게 주세요"><img src="/assets/snacks/snack-cookie.png" alt="쿠키" draggable="false"></button>
      <button class="snack" type="button" data-snack="fish" title="생선 — 끌어다 캐릭터에게 주세요"><img src="/assets/snacks/snack-fish.png" alt="생선" draggable="false"></button>
    </div>
    <button id="theme" type="button" aria-pressed="false"></button>
    <button id="follow" type="button" aria-pressed="false"></button>
    <button id="rotate" type="button" aria-pressed="false" title="전체 화면에서 층을 차례로 돌아보기">순환</button>
    <button id="fullscreen" type="button" title="전체 화면으로 보기">전체 화면</button>
    <button id="panel-toggle" type="button" aria-controls="panel" aria-expanded="true">층별 안내 숨기기</button>
    <button id="pip" type="button" hidden title="항상 위 작은 창으로 띄우기">작은 창</button>
    <button id="settings" type="button" popovertarget="settings-panel" aria-haspopup="dialog" aria-expanded="false"></button>
    <div id="settings-panel" popover role="dialog" aria-labelledby="settings-title">
      <h2 id="settings-title"></h2>
      <fieldset id="wx-choices"><legend></legend></fieldset>
      <fieldset id="fx-choices"><legend></legend></fieldset>
      <fieldset id="nl-choices"><legend></legend></fieldset>
      <fieldset id="sys-choices"><legend></legend></fieldset>
      <p id="wx-now" role="status"></p>
      <p class="wx-credit" id="wx-credit"></p>
      <button id="settings-close" type="button" popovertarget="settings-panel" popovertargetaction="hide"></button>
    </div>
    <button id="quit" type="button">끄기</button>
  </div>
</header>
<main id="app">
  <div id="floors"></div>
  <div id="pip-hold" hidden>
    <p>작은 창에서 보는 중</p>
    <button id="pip-back" type="button">여기로 되돌리기</button>
  </div>
  <aside id="panel">
    <h2>층별 안내</h2>
    <div id="sessions"></div>
    <div id="empty" hidden>아직 일하는 층이 없습니다. Claude Code나 Codex를 실행하면 층이 생깁니다.</div>
    <h2 class="log-head"><span>업무 일지</span><a href="/log" target="_blank" rel="noopener">전체 업무 일지 ↗</a></h2>
    <div id="log" role="log" aria-label="업무 일지"></div>
  </aside>
</main>
<div id="conn" role="status" hidden></div>
<script src="/web/logrow.mjs"></script>
<script type="module" src="/web/app.mjs"></script>
</body>
</html>
`;

export const LOG_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>전체 업무 일지 · 에이전트 사무실</title>
<link rel="icon" href="data:,">
<script>try{var t=localStorage.getItem("agent-office.theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="stylesheet" href="/web/style.css">
</head>
<body class="logpage">
<main id="logmain">
  <header id="logbar">
    <h1>전체 업무 일지</h1>
    <label>층 <select id="fsession"><option value="">전체</option></select></label>
    <label>이름 <select id="fname"><option value="">전체</option></select></label>
    <button id="refresh" type="button" class="mini">새로 고침</button>
    <a href="/" class="back">← 사무실</a>
  </header>
  <div id="logmeta"></div>
  <div id="log"></div>
</main>
<script src="/web/logrow.mjs"></script>
<script src="/web/log.mjs"></script>
</body>
</html>
`;
