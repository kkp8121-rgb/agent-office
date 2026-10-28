# 에이전트 사무실 (Agent Office) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이 PC 의 Claude Code 세션(층)과 그 서브에이전트·워크플로 에이전트(픽셀 SD 캐릭터)를 실시간으로 보여 주는 로컬 웹 화면과, 그것을 띄우는 런처를 만든다.

**Architecture:** Node 기본 기능만 쓰는 로컬 서버가 `~/.claude` 의 세션 레지스트리·기록 파일을 가볍게 주기 확인하고 새로 붙은 줄만 읽어, 개인정보를 걸러 낸 「사무실 상태」를 만든다. 브라우저는 SSE 로 상태와 기록을 받아 CSS `transform` 애니메이션만으로 캐릭터를 움직인다. 런처(`agent-office.cmd`)는 서버가 떠 있으면 화면만, 아니면 서버를 최소화 창으로 띄운다.

**Tech Stack:** Node.js v24.18.0 (npm 패키지 0, ES modules, `node:test`), 바닐라 HTML/CSS/JS, Python 3.12 + Pillow(그림 격자 정리), Codex CLI `codex exec` + 내장 `image_gen`(역할별 그림), 크롬 헤드리스(화면 캡처 확인).

**Spec:** `C:\Users\gustj\agent-office\docs\superpowers\specs\2026-10-28-agent-office-design.md` — 실행자는 계획과 설계서를 함께 읽는다.

## Global Constraints

- 프로젝트 루트: `C:\Users\gustj\agent-office\`. 모든 경로는 이 루트 기준.
- npm 의존성 0. `package.json` 은 `"type": "module"` 과 `"test": "node --test tests/"` 만.
- 외부 CDN·폰트·스크립트 0. 서버는 `127.0.0.1` 에만 listen.
- 자원 절약 최우선: 그리기 반복 루프·캔버스 매 프레임 그리기 금지, 움직임은 CSS `transform` 애니메이션/transition 만. 서버 대기 CPU 1% 안팎·메모리 100MB 이하. 탭이 가려지면 애니메이션·수신 정지.
- 기획 수치·이름·좌표는 `config.json` 에만 둔다(코드에 매직넘버 금지).
- 개인정보(설계서 §8): 화면·기록·API 로 나가는 문자열은 `server/sanitize.mjs` 를 거친 것만. 사용자 메시지·답변 본문·thinking·도구 결과·파일 내용·Bash 명령 전체·검색어·`queue-operation`·계정 id 금지. `~/.claude/sessions/*.key` 는 열지 않는다.
- 사용자에게 보이는 글은 한국어. 코드 식별자·주석은 영어.
- 파일 인코딩 UTF-8(BOM 없음 — 브라우저·Node 모듈이라 BOM 이 해롭다). 줄바꿈 LF.
- 프로세스는 자기가 띄운 PID 로만 끈다(이름으로 끄기 금지).
- 커밋: 사용자 승인(2026-10-28) — 각 Task 끝에서 이 저장소(`C:\Users\gustj\agent-office`)에 경로 지정 `git add <파일>` 후 커밋. `git add -A`/`.` 금지. 작성자는 전역 git 설정 그대로.
- 원격 저장소: 사용자가 계정을 정해 알려 줄 예정 — 그 전까지 `git remote add`·push 금지.
- 사무실 배경은 넓고 다양하고 디테일하게(설계서 §5.1): 배경 4종, 층마다 생성 순서대로 돌려 쓴다. 자리 좌표는 배경별 표.
- 숨김은 **강제 숨김**(설계서 §5.4): 숨긴 세션은 상태·목록·기록 어디에도 나오지 않고, 그 세션의 프로세스(pid·startedAt)가 바뀌면 다시 나온다. 이름 바꾸기는 §5.5.

## Review Focus

1. 기록 줄이 두 번의 읽기 사이에서 잘림(파일 끝의 반쪽 줄) — 버리거나 깨진 JSON 으로 읽지 말고 다음 읽기에서 이어 붙여야 한다. → Task 2 `tail: partial line is completed on next poll`
2. 한글 등 여러 바이트 글자가 읽기 경계에서 잘림 — 글자가 깨지면 안 된다. → Task 2 `tail: multibyte char split across chunks decodes intact`
3. 한 줄이 수 MB(첨부·api-request) — 메모리에 다 올리지 않고 건너뛰고, 그 다음 줄은 정상 처리. → Task 2 `tail: oversized line is skipped, next line parsed`
4. 세션 파일은 남았는데 프로세스가 죽음 — 층이 「퇴근」 뒤 사라져야 한다. → Task 3 `sessions: dead pid is excluded`, Task 4 `office: floor leaves then disappears`
5. Bash 명령에 토큰·URL 이 들어 있음 / 깨진 JSON 줄·모르는 type — 새어 나가거나 서버가 죽으면 안 된다. → Task 1 `sanitize: bash without description exposes first word only`, Task 2 `parse: malformed and unknown lines yield []`

---

## File Structure

```
agent-office/
  agent-office.cmd            런처 (Task 8)
  package.json                (Task 1)
  config.json                 모든 수치·이름·좌표 표 (Task 1, 좌표는 Task 6 에서 보정)
  README.md                   쓰는 법 (Task 8)
  server/
    config.mjs                설정 읽기 (Task 1)
    sanitize.mjs              도구 호출 → 안전한 한국어 짧은 문구 (Task 1)
    parse.mjs                 기록 한 줄 → 이벤트 배열 (Task 2)
    tail.mjs                  파일 뒤에 붙은 부분만 읽기 (Task 2)
    sessions.mjs              살아 있는 세션·기록 파일 찾기 (Task 3)
    agents.mjs                서브에이전트·워크플로 에이전트 meta 읽기 (Task 3)
    workflows.mjs             워크플로 일지·단계 (Task 3)
    office.mjs                사무실 상태 기계·이름·자리·기록 (Task 4)
    hidden.mjs                숨김 저장 (Task 5)
    poller.mjs                주기 확인 → office 갱신 (Task 5)
    http.mjs                  라우트·SSE·보안 검사 (Task 5, /api/log 는 Task 7)
    main.mjs                  진입점 (Task 5)
    launch.mjs                런처 본체 (Task 8)
  web/
    index.html  style.css  app.js     건물·층·캐릭터·기록 칸 (Task 6)
    log.html    log.js                전체 기록 (Task 7)
  assets/
    floors/<design>.png       층 배경 (studio 는 Task 1, 넓은 4종은 Task 10)
    sprites/<roleKey>.png     64px 높이 캐릭터 (default 는 Task 1, 나머지 Task 9)
    icon.ico                  (Task 9)
  art/
    snap.py                   격자 정리 도구 (Task 1)
    floors.json               배경 4종 프롬프트 (Task 10)
    prompts.json              역할별 그림 프롬프트 (Task 9)
    contact-sheet.png         전체 캐릭터 한눈에 보기 (Task 9)
  scripts/
    demo-feed.mjs             가짜 ~/.claude 를 만들어 줄을 계속 붙이는 시연기 (Task 6)
    make-shortcut.ps1         바탕화면 바로가기 (Task 8)
  data/                       hidden.json (실행 중 생성, git 제외)
  tests/                      *.test.mjs + fixtures/
```

## Shared types (모든 Task 공통 — 이름 그대로 쓴다)

```js
// server/parse.mjs
/** @typedef {{kind:'tool', ts:number, toolUseId:string, name:string, text:string, agentType?:string, description?:string}
 *          | {kind:'toolDone', ts:number, toolUseId:string}
 *          | {kind:'think', ts:number}
 *          | {kind:'end', ts:number}
 *          | {kind:'title', ts:number, title:string}
 *          | {kind:'workflowLaunch', ts:number, runId:string, workflowName:string, scriptPath:string}} Ev */
// server/sessions.mjs
/** @typedef {{provider:'claude'|'codex', pid:number, sessionId:string, cwd:string, status:string, name:string, startedAt:number}} Session */
// provider: Task 3 의 Claude 세션은 항상 'claude'. 'codex' 는 Task 11(Codex 대응)이 만든다. Office 는 provider 를 FloorView 에 그대로 싣는다.
// server/agents.mjs
/** @typedef {{agentId:string, agentType:string, description:string, finished:boolean, transcriptPath:string, mtimeMs:number,
 *             workflow: null | {runId:string, phase:string, label:string}}} AgentMeta */
// server/office.mjs — 브라우저로 나가는 모양
/** @typedef {{key:string, agentId:string, name:string, role:string, sprite:string, slot:{x:number,y:number,i:number},
 *             state:'enter'|'working'|'thinking'|'done'|'stale', bubble:string, since:number}} AgentView */
/** @typedef {{sessionId:string, provider:'claude'|'codex', floorNo:number, design:string, title:string, autoTitle:string, folder:string, status:'busy'|'waiting'|'leaving',
 *             lead:{name:string, role:string, sprite:string, state:string, bubble:string},
 *             board:{title:string, line:string}, reports:number, workflows:number, agents:AgentView[]}} FloorView */
/** @typedef {{floors:FloorView[], now:number}} State */
/** @typedef {{id:string, ts:number, sessionId:string, name:string, role:string, sprite:string, head:string, text:string}} LogEntry */
```

---

### Task 1: 뼈대 · 설정 표 · 개인정보 거르기

**Files:**
- Create: `package.json`, `config.json`, `server/config.mjs`, `server/sanitize.mjs`, `.gitignore`(`data/`, `node_modules/`), `art/snap.py`, `assets/sprites/default.png`, `assets/floors/studio.png`
- Test: `tests/sanitize.test.mjs`, `tests/config.test.mjs`

**Interfaces:**
- Produces: `loadConfig(overrides?: object): Config` — `config.json` 을 읽고 `overrides` 를 깊게 합침. `cfg.claudeHome` = env `AGENT_OFFICE_CLAUDE_HOME` 또는 `path.join(os.homedir(), '.claude')`. `cfg.port` = env `AGENT_OFFICE_PORT` 가 있으면 그 값. `cfg.root` = 프로젝트 루트 절대경로(`import.meta.url` 기준, CWD 무관).
- Produces: `describeTool(name: string, input: object): string`, `clip(s: string, n: number): string`

- [ ] **Step 1: `config.json` 작성 — 아래 값 그대로**

```json
{
  "port": 47800,
  "pollMs": 1500,
  "agentScanEveryTicks": 2,
  "tail": { "startBytes": 262144, "chunkBytes": 65536, "maxLineBytes": 4194304 },
  "log": { "cap": 2000, "backfillMinutes": 30, "mergeWindowMs": 20000, "sendCap": 200 },
  "agent": { "doneLingerMs": 15000, "staleMs": 600000, "bubbleShowMs": 8000 },
  "floor": { "leaveMs": 5000 },
  "ui": { "bubbleMaxChars": 16, "logDomCap": 300 },
  "roles": {
    "__lead":               { "key": "lead",                 "name": "유나", "role": "팀장" },
    "scout":                { "key": "scout",                "name": "다온", "role": "정찰" },
    "worker-low":           { "key": "worker-low",           "name": "소미", "role": "막내" },
    "worker":               { "key": "worker",               "name": "서진", "role": "개발" },
    "worker-high":          { "key": "worker-high",          "name": "하린", "role": "선임" },
    "architect":            { "key": "architect",            "name": "세아", "role": "설계" },
    "architect-high":       { "key": "architect-high",       "name": "은재", "role": "수석" },
    "Explore":              { "key": "explore",              "name": "루아", "role": "탐색" },
    "Plan":                 { "key": "plan",                 "name": "지안", "role": "기획" },
    "code-critic":          { "key": "code-critic",          "name": "시온", "role": "검토" },
    "security-reviewer":    { "key": "security-reviewer",    "name": "보라", "role": "보안" },
    "performance-reviewer": { "key": "performance-reviewer", "name": "예린", "role": "성능" },
    "i18n-reviewer":        { "key": "i18n-reviewer",        "name": "가온", "role": "번역" },
    "a11y-reviewer":        { "key": "a11y-reviewer",        "name": "미루", "role": "접근성" },
    "frontend":             { "key": "frontend",             "name": "채원", "role": "프론트" },
    "backend":              { "key": "backend",              "name": "아린", "role": "백엔드" },
    "app":                  { "key": "app",                  "name": "리아", "role": "앱" },
    "__default":            { "key": "default",              "name": "나래", "role": "지원" }
  },
  "spriteHeight": 64,
  "designOrder": ["studio"],
  "layouts": {
    "studio": {
      "image": "studio.png",
      "size": [768, 512],
      "entrance": [96, 420],
      "lead": [350, 446],
      "tray": [405, 446],
      "sofa": [660, 292],
      "board": [16, 12, 300, 92],
      "desks": [[250,262],[332,262],[415,262],[500,262],[235,362],[327,362],[420,362],[512,362]],
      "aisle": [[290,312],[372,312],[455,312],[540,312],[250,470],[520,470]]
    }
  }
}
```
(`studio` 는 시안 배경 — 좌표는 768×512 기준 발끝 위치의 추정값으로 Task 6 에서 캡처로 보정한다. Task 10 이 넓은 배경 4종을 `layouts` 에 더하고 `designOrder` 를 바꾼다. 층은 생길 때 `designOrder[생성 순번 % 길이]` 로 디자인을 받고 바뀌지 않는다.)

- [ ] **Step 1b: `art/snap.py` 작성** — `python art/snap.py sprite <in> <out> --height 64 --colors 20`(투명 영역 잘라내기 → 상자 평균 축소 → 색 수 제한 → 알파 0/255), `python art/snap.py bg <in> <out> --size WxH`(LANCZOS 축소 후 색 수 제한 없음). 확인: 시안 그림 두 장(`…\scratchpad\art\pixel-sd.png`, `pixel-office.png`)으로 실행해 `assets/sprites/default.png`(높이 64, 모서리 알파 0), `assets/floors/studio.png`(768×512) 생성.

- [ ] **Step 2: 실패하는 시험 작성** — `tests/sanitize.test.mjs`

```js
test('sanitize: bash uses description', () =>
  assert.equal(describeTool('Bash', {command:'npm run build', description:'프론트 빌드 확인'}), '프론트 빌드 확인'));
test('sanitize: bash without description exposes first word only', () => {
  const t = describeTool('Bash', {command:"curl -H 'Authorization: Bearer sk-abc123' https://x.io/a?token=zz"});
  assert.equal(t, 'curl 실행'); assert.ok(!t.includes('sk-abc') && !t.includes('x.io'));
});
test('sanitize: quoted exe path reduces to bare name', () =>
  assert.equal(describeTool('Bash', {command:'"C:/Program Files/nodejs/node.exe" x.mjs'}), 'node 실행'));
test('sanitize: file tools show basename only', () => {
  assert.equal(describeTool('Read', {file_path:'C:\\Users\\gustj\\secret\\PostController.cs'}), 'PostController.cs 읽는 중');
  assert.equal(describeTool('Edit', {file_path:'/a/b/app.js'}), 'app.js 고치는 중');
  assert.equal(describeTool('Write', {file_path:'/a/b/new.md'}), 'new.md 쓰는 중');
});
test('sanitize: search never exposes pattern', () => {
  assert.equal(describeTool('Grep', {pattern:'password=hunter2', path:'/x'}), '검색 중');
  assert.equal(describeTool('Glob', {pattern:'**/*.key'}), '검색 중');
});
test('sanitize: delegation, skill, mcp, unknown', () => {
  assert.equal(describeTool('Agent', {subagent_type:'worker', description:'기록 구조 조사'}), '위임 · 기록 구조 조사');
  assert.equal(describeTool('Skill', {skill:'superpowers:brainstorming'}), '스킬 · superpowers:brainstorming');
  assert.equal(describeTool('Workflow', {script:'...'}), '워크플로 시작');
  assert.equal(describeTool('WebSearch', {query:'q'}), '웹 조사 중');
  assert.equal(describeTool('mcp__notion__API-post-page', {}), 'notion 도구 사용');
  assert.equal(describeTool('FooBar', {}), 'FooBar 사용 중');
});
test('sanitize: output is bounded to 80 chars', () =>
  assert.ok(describeTool('Bash', {description:'가'.repeat(200)}).length <= 80));
```
`tests/config.test.mjs`: `loadConfig()` 이 `port === 47800`, `roles.worker.name === '서진'`, `layouts.studio.desks.length === 8`, `designOrder` 의 모든 값이 `layouts` 에 있음을 돌려주고, env `AGENT_OFFICE_CLAUDE_HOME` 을 주면 `claudeHome` 이 그 값.

- [ ] **Step 3: 실행해 실패 확인** — Run: `node --test tests/` → Expected: FAIL(모듈 없음)
- [ ] **Step 4: `server/config.mjs`, `server/sanitize.mjs` 구현** — Task/TodoWrite 계열은 `할 일 정리`, NotebookEdit·MultiEdit 는 Edit 와 같은 문구, WebFetch 는 `웹 조사 중`. `clip` 은 글자 수(코드포인트) 기준으로 자르고 넘치면 `…`.
- [ ] **Step 5: 통과 확인** — Run: `node --test tests/` → Expected: PASS
- [ ] **Step 6: 커밋(승인 시)** — `git init` 은 이 Task 에서 1회. `git add package.json config.json .gitignore server/config.mjs server/sanitize.mjs tests/` → `git commit -m "feat: config table and privacy-safe tool descriptions"`

---

### Task 2: 기록 줄 해석 · 뒤에 붙은 부분만 읽기

**Files:**
- Create: `server/parse.mjs`, `server/tail.mjs`
- Test: `tests/parse.test.mjs`, `tests/tail.test.mjs`, `tests/fixtures/lines/*.jsonl`(아래 모양을 본뜬 견본 — 실제 기록에서 복사하지 말 것)

**Interfaces:**
- Consumes: `describeTool` (Task 1)
- Produces: `parseLine(text: string): Ev[]`
- Produces: `class FileTail { constructor(path: string, opts: {startBytes?: number, chunkBytes: number, maxLineBytes: number}); poll(): Promise<string[]>; get offset(): number }`

실제 줄 모양(2026-10-28 확인):
- 도구 호출: `{"type":"assistant","timestamp":"2026-10-28T06:48:44.441Z","sessionId":"…","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"toolu_01…","name":"Skill","input":{"skill":"x"}}],"stop_reason":null}}` — 한 줄에 content 블록이 보통 1개지만 배열 전체를 훑는다.
- 생각/답: assistant `message.content[].type` 이 `thinking` 또는 `text`. 끝: `message.stop_reason === "end_turn"`.
- 도구 결과: `{"type":"user","timestamp":…,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01…","content":"…"}]},"toolUseResult":{…}}`
- 워크플로 시작 결과: 위 user 줄의 `toolUseResult` 가 `{"status":"async_launched","taskType":"local_workflow","workflowName":"…","runId":"wf_…","scriptPath":"…"}`
- 제목: `{"type":"ai-title","sessionId":"…","aiTitle":"…"}`(timestamp 없음 → `ts: 0`)

- [ ] **Step 1: 실패하는 시험 작성**
  - `parse: tool_use becomes sanitized tool event` — Bash tool_use 줄 → `[{kind:'tool', toolUseId:'toolu_1', name:'Bash', text:'프론트 빌드 확인', ts: Date.parse('2026-10-28T06:48:44.441Z')}]`
  - `parse: Agent tool_use carries agentType and description` — `{agentType:'worker', description:'기록 조사'}` 포함
  - `parse: tool_result becomes toolDone` / `parse: thinking and text become think` / `parse: end_turn adds end`
  - `parse: workflow launch result` → `{kind:'workflowLaunch', runId:'wf_abc', workflowName:'review-changes', scriptPath:'C:/x/s.js'}`
  - `parse: ai-title` → `{kind:'title', title:'에이전트 사무실', ts:0}`
  - `parse: never leaks content` — 사용자 프롬프트 줄(`type:'user'`, content 가 문자열 「비밀 계획」), `queue-operation` 줄, `attachment` 줄 → `[]`; tool_result 의 `content`「SECRET-RESULT」가 어떤 Ev 의 어떤 필드에도 없음(`JSON.stringify(evs)` 검사)
  - `parse: malformed and unknown lines yield []` — `'{bad'`, `'{"type":"mystery"}'`, `''` → `[]`, throw 없음
  - `tail: reads only appended bytes` — 파일에 2줄 쓰고 poll → 2줄, 1줄 더 쓰고 poll → 그 1줄만
  - `tail: partial line is completed on next poll` — `'{"a":1}\n{"b"'` 쓰고 poll → `['{"a":1}']`, `':2}\n'` 덧붙이고 poll → `['{"b":2}']`
  - `tail: multibyte char split across chunks decodes intact` — `chunkBytes: 4` 로 `'{"t":"가나다"}\n'` → 정확히 그 문자열
  - `tail: startBytes skips the partial first line` — 1000줄 파일, `startBytes: 100` → 첫 반쪽 줄 버리고 완전한 마지막 줄들만
  - `tail: oversized line is skipped, next line parsed` — `maxLineBytes: 50` 에 200바이트 줄 + 정상 줄 → 정상 줄만, 메모리에 200바이트 버퍼를 통째로 쌓지 않음(구현 검토 항목)
  - `tail: truncated file restarts from tail` — 크기가 offset 보다 작아지면 처음 poll 처럼 다시 시작
- [ ] **Step 2: 실패 확인** — `node --test tests/` → FAIL
- [ ] **Step 3: 구현** — `FileTail.poll` 은 `fs.promises.open` + 재사용 버퍼(`chunkBytes`)로 offset~size 만 읽고, 줄바꿈 단위로 Buffer 를 자른 뒤에만 UTF-8 로 바꾼다. 남은 반쪽 줄은 Buffer 로 보관하되 `maxLineBytes` 를 넘으면 버리고 다음 `\n` 까지 건너뛰는 상태로 둔다. `parseLine` 은 `JSON.parse` 실패를 삼키고 `[]`.
- [ ] **Step 4: 통과 확인** — `node --test tests/` → PASS
- [ ] **Step 5: 커밋(승인 시)** — `git commit -m "feat: transcript line parser and incremental tail"`

---

### Task 3: 세션 · 서브에이전트 · 워크플로 찾기

**Files:**
- Create: `server/sessions.mjs`, `server/agents.mjs`, `server/workflows.mjs`
- Test: `tests/discovery.test.mjs` (임시 폴더에 가짜 `~/.claude` 구조를 만들어 시험)

**Interfaces:**
- Produces: `isPidAlive(pid: number): boolean` — `process.kill(pid, 0)`; `EPERM` 이면 살아 있음.
- Produces: `listLiveSessions(claudeHome: string): Promise<Session[]>` — `sessions/*.json` 만(`.key` 등 무시), 깨진 파일 무시, 죽은 pid 제외. `startedAt` 은 숫자(ms).
- Produces: `findSessionPaths(claudeHome: string, sessionId: string): Promise<{transcript: string, sessionDir: string} | null>` — `projects/*/<sid>.jsonl` 을 찾고 결과를 Map 에 기억(없으면 다음 호출 때 다시 찾음).
- Produces: `listAgents(sessionDir: string, cache: Map): Promise<AgentMeta[]>` — `subagents/agent-*.meta.json` 과 `subagents/workflows/wf_*/agent-*.meta.json`. meta 파일 mtime 이 같으면 cache 값 재사용(다시 읽지 않음). 워크플로 에이전트는 `workflow: {runId: 폴더명, phase: meta.workflowPhase ?? '', label: meta.description ?? ''}`. `transcriptPath` 는 같은 이름의 `.jsonl`.
- Produces: `class WorkflowJournal { constructor(runDir: string, tailOpts); poll(): Promise<void>; started: Map<string,{label:string, phase:string}>; finished: Set<string> }` — `journal.jsonl` 의 `started`/`result` 줄(시각 필드 없음).
- Produces: `phasesFromScript(scriptText: string): string[]` — `export const meta = {…}` 의 `phases: [{ title: '…' }, …]` 에서 title 들을 정규식으로 뽑는다(스크립트를 실행하지 않음). 못 찾으면 `[]`.

- [ ] **Step 1: 실패하는 시험 작성**
  - `sessions: live session is listed` — `sessions/<process.pid>.json`(`{"pid":<process.pid>,"sessionId":"s1","cwd":"C:\\Project","status":"busy","name":"x","startedAt":1793170000000}`) → 1개
  - `sessions: dead pid is excluded` — pid `999999` → 0개
  - `sessions: key files and broken json are ignored` — `abc.key`, `bad.json`(`{x`) 가 있어도 throw 없음
  - `sessions: transcript is found across project folders` — `projects/C--Project/s1.jsonl` → 경로 반환
  - `agents: background and workflow agents are listed` — 일반 meta(`{"agentType":"worker","description":"조사","finished":true}`) + `subagents/workflows/wf_r1/agent-a2.meta.json`(`{"agentType":"worker-high","description":"FE stg","workflowPhase":"Promote"}`) → 2개, 두 번째의 `workflow` = `{runId:'wf_r1', phase:'Promote', label:'FE stg'}`
  - `agents: unchanged meta is not re-read` — 같은 cache 로 두 번 부를 때 `fs.readFile` 호출 수가 늘지 않음(읽기 함수를 주입하거나 cache 히트 수를 노출해서 확인)
  - `workflows: journal tracks started and finished` — launched/started×2/result×1 → `started.size === 2`, `finished.has(<그 id>)`
  - `workflows: phases from script` — `export const meta = { name:'x', phases: [{ title: 'Review' }, { title: 'Verify', detail: 'd' }] }` → `['Review','Verify']`; meta 없는 스크립트 → `[]`
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 디렉터리가 없으면 빈 배열(throw 금지).
- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: 커밋(승인 시)** — `git commit -m "feat: discover live sessions, subagents and workflow runs"`

---

### Task 4: 사무실 상태 기계 (이름 · 자리 · 상태 · 기록)

**Files:**
- Create: `server/office.mjs`
- Test: `tests/office.test.mjs`

**Interfaces:**
- Consumes: `Ev`, `Session`, `AgentMeta` 모양, `cfg`(Task 1)
- Produces: `class Office`
  - `constructor(cfg, saved: {hidden: HiddenRec[], names: Record<string,string>})` — `HiddenRec = {sessionId:string, pid:number, startedAt:number}`
  - `syncSessions(live: Session[], now: number): void` — 새 세션 층 생성, 사라진 세션은 `status:'leaving'` → `cfg.floor.leaveMs` 뒤 제거. `busy` 면 `'busy'`, 그 외 값은 `'waiting'`. 숨김 기록 중 같은 `sessionId` 의 살아 있는 세션이 **다른 pid 또는 startedAt** 이면(다시 실행됨) 그 기록을 지운다 → 다시 보임. 같은 sessionId 의 살아 있는 세션이 아예 없으면 그 기록도 지운다.
  - `hide(sessionId: string): boolean` — 지금 살아 있는 그 세션의 pid·startedAt 으로 숨김 기록 추가. 없는 세션이면 false.
  - `rename(sessionId: string, name: string | null): void` — 앞뒤 공백 제거, 제어 문자 제거, 30자(코드포인트)로 자름, 빈 문자열·null 이면 이름 삭제(자동 이름으로).
  - `saved(): {hidden: HiddenRec[], names: Record<string,string>}` — Task 5 가 바뀌었을 때 저장(`savedVersion: number` 를 함께 두어 바뀜 감지)
  - `applySessionEvents(sessionId: string, evs: Ev[], now: number): void` — 팀장(lead)의 상태·말풍선, `title` → 층 제목, `workflowLaunch` → 그 층의 워크플로 기록(이름·scriptPath).
  - `syncAgents(sessionId: string, metas: AgentMeta[], now: number): void` — 새 에이전트 입장(`'enter'`), `finished` 또는 워크플로 일지 결과 → `'done'`(보고 수 +1, `cfg.agent.doneLingerMs` 뒤 제거). 처음 동기화 때 이미 `finished` 인 에이전트는 만들지 않는다.
  - `applyAgentEvents(sessionId: string, agentId: string, evs: Ev[], now: number): void`
  - `setWorkflowProgress(sessionId: string, runId: string, p: {name: string, phases: string[], current: string}): void` — 화이트보드 `line`: phases 가 있으면 `${name} · ${current} ${i}/${n}`, 없으면 `${name} · ${current}`.
  - `tick(now: number): boolean` — 시간 경과 전이(입장→작업, done 제거, stale, leaving 제거). 바뀐 것이 있으면 true.
  - `snapshot(): State` — 숨긴 세션은 **아예 넣지 않는다**. `title` = 바꾼 이름 ?? `aiTitle` ?? 작업 폴더 이름, `autoTitle` = 바꾸지 않았을 때의 이름. 층은 보이는 세션만으로 `startedAt` 오름차순 `floorNo` 1..n, 배열은 **새 층이 앞**(위층).
  - `drainLog(): LogEntry[]` — 지난 drain 뒤 새로 생겼거나 갱신된(같은 id) 항목. 숨긴 세션 항목 제외.
  - `queryLog(f: {sessionId?: string, name?: string, limit?: number}): LogEntry[]` — 최신순, 숨긴 세션 제외, 보관은 `cfg.log.cap` 개.
- 규칙(시험이 고정):
  - 이름: `cfg.roles[agentType] ?? cfg.roles.__default`; 팀장은 `cfg.roles.__lead`. 같은 층에 같은 역할이 이미 있으면 `서진+1`, `서진+2` — 비어 있는 가장 작은 번호부터 재사용.
  - 디자인: 층이 생길 때 `cfg.designOrder[지금까지 만든 층 수 % 길이]`, 이후 고정.
  - 자리: 그 층 디자인의 `cfg.layouts[design].desks` 빈 자리 중 가장 작은 번호 → 다 차면 `.aisle` → 그것도 다 차면 마지막 aisle 자리에 겹쳐 세우고 `slot.i` 에 순번.
  - 상태: tool → `'working'`(말풍선 = Ev.text), toolDone/think → `'thinking'`(말풍선 「생각 중…」), end → 변화 없음(끝은 meta/일지로 판정), 마지막 기록 뒤 `cfg.agent.staleMs` 동안 아무것도 없으면 `'stale'`(말풍선 「응답 없음」). 입장 `'enter'` 는 첫 이벤트에서 working/thinking 으로.
  - 기록 항목: 입장 → `head` = 워크플로면 `${phase} · ${label}`, 아니면 description; `text` = `시작`. Bash·Edit·Write·Agent·Skill·Workflow·mcp 도구 → `text` = Ev.text. Read/Grep/Glob 은 같은 에이전트가 `cfg.log.mergeWindowMs` 안에 이어 하면 **같은 id 항목**을 「파일 N개 살펴봄」으로 갱신. 끝 → `완료 · 보고함에 제출`. 팀장 행동도 같은 규칙.
- [ ] **Step 1: 실패하는 시험 작성** (cfg 는 `loadConfig()` 그대로)
  - `office: new session becomes a floor with lead 유나·팀장`
  - `office: floors ordered newest first with stable floorNo`
  - `office: floor leaves then disappears` — live 에서 빠지면 `leaving`, `leaveMs` 뒤 tick → 사라짐
  - `office: hidden record is dropped when its session ends`
  - `office: worker gets 서진, second worker 서진+1, freed number reused`
  - `office: unknown agentType uses 나래·지원`
  - `office: desks fill first, then aisle, then overflow index`
  - `office: floors get designs in rotation and keep them` — 시험용 cfg 에 디자인 2개 → 층 3개가 a,b,a; 첫 층이 사라져도 나머지 층 디자인 불변
  - `office: tool event sets working with sanitized bubble; toolDone sets thinking`
  - `office: finished agent goes done, reports+1, removed after doneLingerMs`
  - `office: already-finished agents on first sync are not shown`
  - `office: stale after staleMs without events`
  - `office: hidden session is absent from snapshot and log` — 숨긴 뒤 새 에이전트·새 기록이 생겨도 snapshot·drainLog·queryLog 어디에도 없음, 남은 층 floorNo 는 1..n 으로 다시 매겨짐
  - `office: hidden session reappears when re-run` — 같은 sessionId 가 다른 pid 로 syncSessions 에 오면 다시 snapshot 에 나옴; 같은 pid 로 계속 오면 계속 숨김
  - `office: hidden survives restart via saved()` — `new Office(cfg, office.saved())` 에서도 숨김 유지
  - `office: rename sets title everywhere and empty restores auto title` — `rename('s1','  결제 리뷰 \u0007 ')` → title `'결제 리뷰'`, autoTitle 은 그대로; 31자 이름 → 30자; `rename('s1','')` → title = autoTitle
  - `office: consecutive reads merge into one log entry` — Read 3번(10초 간격) → drainLog 항목 id 하나, text 「파일 3개 살펴봄」; mergeWindow 넘긴 뒤 Read → 새 항목
  - `office: workflow board line` — phases `['Review','Verify']`, current `Verify` → `'review-changes · Verify 2/2'`
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 시간은 전부 인자 `now` 로 받는다(내부에서 `Date.now()` 금지 — 시험 가능하게).
- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: 커밋(승인 시)** — `git commit -m "feat: office state machine with names, slots and log"`

---

### Task 5: 서버 — 주기 확인 · HTTP · SSE · 숨김 저장 · 보안

**Files:**
- Create: `server/hidden.mjs`, `server/poller.mjs`, `server/http.mjs`, `server/main.mjs`
- Test: `tests/server.test.mjs`, `tests/poller.test.mjs`

**Interfaces:**
- Consumes: Task 1~4 전부
- Produces: `loadSaved(dir: string): {hidden: HiddenRec[], names: Record<string,string>}`(`<dir>/hidden.json`·`<dir>/names.json`, 없거나 깨졌으면 빈 값), `saveSaved(dir: string, saved): Promise<void>`(임시 파일에 쓰고 rename) — 파일 이름은 `server/hidden.mjs` 그대로 둔다
- Produces: `class Poller { constructor(cfg, office); tick(now: number): Promise<void> }` — 매 tick: 세션 목록 → 세션별 기록 tail → `agentScanEveryTicks` 마다 `listAgents` → 끝나지 않은 에이전트 기록만 tail → 워크플로 일지 poll + `phasesFromScript`(scriptPath 를 run 당 1회만 읽음). 끝난 에이전트·사라진 세션의 FileTail 은 버린다. 첫 tail 은 `cfg.tail.startBytes`, 이벤트 중 `ts < now - backfillMinutes` 인 것은 기록 칸에 넣지 않는다(상태 계산에는 사용).
- Produces: `createServer(cfg, office, {onSavedChange(), onShutdown()}): http.Server`
  - `GET /health` → `200 {"app":"agent-office","pid":<pid>}`
  - `GET /` → `web/index.html`, `GET /log` → `web/log.html`, `GET /web/*`·`/assets/*` → 정적 파일(루트 밖 경로 차단, 알맞은 Content-Type, `Cache-Control: max-age=3600` — 그림만)
  - `GET /api/state` → `office.snapshot()`
  - `GET /api/ui` → 화면이 쓰는 설정만: `{spriteHeight, layouts, ui, bubbleShowMs: agent.bubbleShowMs, roles: {<key>: {name, role}}}`
  - `GET /api/events` → SSE: 연결 즉시 `event: state` + `event: log`(`queryLog({limit: cfg.log.sendCap})` 를 오래된 것부터), 이후 바뀔 때만 `state`, 새 항목 `log`, 25초마다 `: ping`
  - `POST /api/hide` `{"sessionId":"…"}` → `office.hide` true 면 저장 후 `204`, 없는 세션이면 `404`. 되돌리는 API 는 없다(강제 숨김).
  - `POST /api/rename` `{"sessionId":"…","name":"…"}` → `office.rename` 후 저장, `204`. 본문 1KB 초과·JSON 아님 → `400`.
  - `POST /api/shutdown` → `204` 후 서버 닫고 종료
  - 모든 요청: `Host` 가 `127.0.0.1:<port>` 또는 `localhost:<port>` 가 아니면 `403`. POST 는 `Origin` 이 같은 두 값 중 하나가 아니면 `403`. CORS 헤더를 붙이지 않는다.
- `main.mjs`: `loadConfig()` → `Office(cfg, loadSaved(<root>/data))` → 서버 `listen(cfg.port, '127.0.0.1')` → `setTimeout` 사슬로 `pollMs` 마다 tick(겹쳐 돌지 않게) → tick 뒤 `office.tick(now)` 가 true 이거나 새 기록이 있으면 SSE 로 방송. `office.savedVersion` 이 바뀌었으면 `saveSaved`(세션 종료로 숨김 기록이 지워진 경우 포함). `EADDRINUSE` 면 「포트 47800 을 다른 프로그램이 쓰고 있습니다」 출력 후 exit 2. `--open` 이면 listen 뒤 `spawn('cmd', ['/c','start','',url], {detached:true, stdio:'ignore'}).unref()`.

- [ ] **Step 1: 실패하는 시험 작성**
  - `server: health` / `server: wrong Host is 403` (`Host: evil.example`) / `server: cross-origin POST is 403` (`Origin: http://evil.example`) / `server: no CORS header on any response`
  - `server: hide and rename persist across restart` — POST hide·rename → 시험용 임시 data 폴더의 파일에 기록 → 새 `loadSaved` + 새 Office 에서 숨김·이름 유지
  - `server: hide of unknown session is 404; rename with oversized body is 400`
  - `server: static path traversal is blocked` — `GET /web/../config.json` → 404
  - `server: SSE sends state then log on connect`
  - `poller: end to end on fake claude home` — 임시 폴더에 `sessions/<process.pid>.json`, `projects/P/s1.jsonl`(Bash tool_use 1줄), `projects/P/s1/subagents/agent-a1.meta.json`(worker, finished 없음) + `agent-a1.jsonl`(Read tool_use 1줄) → tick 2번 → 층 1개, 팀장 말풍선 = 그 Bash description, 에이전트 `서진` 의 말풍선 `x.cs 읽는 중`; meta 에 `finished:true` 쓰고 tick → `done`
  - `poller: idle tick reads nothing new` — 변화 없이 tick 하면 FileTail 이 0바이트 읽음(읽은 바이트 수를 노출해 확인)
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** → `node --test tests/` PASS
- [ ] **Step 5: 실제 데이터로 수동 확인** — `node server/main.mjs` 실행 → `curl http://127.0.0.1:47800/api/state` 에 지금 살아 있는 세션 수만큼 층, 응답 안에 사용자 메시지 문장이 없음(이 세션에서 보낸 문장 하나로 grep). 끝나면 **자기가 띄운 PID** 로만 종료.
- [ ] **Step 6: 커밋(승인 시)** — `git commit -m "feat: poller, http server with SSE, hide persistence and host checks"`

---

### Task 6: 화면 — 건물 · 층 · 캐릭터 · 기록 칸 (+ 그림 정리 도구 · 시연기)

**Files:**
- Create: `web/index.html`, `web/style.css`, `web/app.js`, `scripts/demo-feed.mjs`
- Modify: `config.json`(`layouts.studio` 좌표 보정만)

**Interfaces:**
- Consumes: `State`, `LogEntry`, `/api/events`, `/api/hide`, `/api/shutdown` (Task 5)
- Consumes: `GET /api/ui` (Task 5), `assets/floors/*.png`, `assets/sprites/*.png`
- Produces: `node scripts/demo-feed.mjs <tmpHome>` — 가짜 `~/.claude` 를 만들고(세션 2개, 자기 pid 사용) 2초마다 도구 줄·새 서브에이전트·finished 를 번갈아 붙인다. 서버는 `AGENT_OFFICE_CLAUDE_HOME=<tmpHome> AGENT_OFFICE_PORT=47811 node server/main.mjs` 로 붙인다.

화면 규칙:
- 층 배경 = 그 층 `design` 의 `assets/floors/<layouts[design].image>` 를 `layouts[design].size` 1배로, 캐릭터 64px 높이를 1배로(`image-rendering: pixelated`). 디자인마다 크기가 달라도 층 너비가 맞게 가운데 정렬. (설계서 §6.2 의 「얼굴이 읽히는 64px」을 점 크기 맞추기보다 우선한 판단)
- 층 = `<section class="floor" data-sid>` 안에 배경 + 화이트보드 카드(`layouts[design].board` 위치: 세션 제목 · `board.line`) + 층 표지(`3F · 제목 · 폴더 · 작업 중/입력 대기`) + 보고함 배지.
- 캐릭터 DOM 3겹: 위치(`transform: translate`, transition) / 방향(`scaleX(±1)`) / 몸짓(상태별 keyframes). 상태 → 몸짓: working 빠른 통통, thinking 느린 숨쉬기 + 「생각 중…」, enter·이동 깡총 + 이동 방향이 왼쪽이면 뒤집기, done 보고함까지 걸어간 뒤 웅크렸다 점프 → 흐려짐, stale 흐림 + `zZ`, 팀장 waiting 숨쉬기.
- 말풍선: 행동이 바뀐 뒤 `cfg.agent.bubbleShowMs` 동안 글자, 그 뒤 작은 `…` 점으로 접힘. 이웃 책상과 겹치지 않게 홀수 자리 말풍선을 16px 높게. 글자는 `ui.bubbleMaxChars` 로 자름. 이름표 = `이름`(역할은 title 속성).
- 오른쪽 칸: 세션 목록(층 색 점·제목·「서브 n · 워크플로 m」·✎ 이름 바꾸기·숨김 단추. 숨김은 「이 세션을 다시 실행할 때까지 안 보입니다」 확인 후 POST, 숨긴 세션은 목록에도 없음). 이름 바꾸기: ✎ 또는 층 표지 더블클릭 → 그 자리 입력칸(최대 30자), Enter 저장·Esc 취소·비우면 자동 이름(placeholder 로 `autoTitle` 표시). 이름 등 서버에서 온 문자열은 전부 `textContent` 로만 넣는다(innerHTML 금지). + 기록 칸(참고 화면 형식: 아이콘·**이름**·시각 HH:MM:SS·`head · text`, 같은 id 는 그 자리 갱신, DOM 은 `ui.logDomCap` 줄까지) + 「전체 기록 ↗」(`/log`) + 「끄기」.
- DOM 은 key 로 재사용(통째 다시 그리기 금지 — 애니메이션이 끊김).
- 캐릭터 그림은 `/assets/sprites/<sprite>.png`, 없으면(`onerror`) `default.png` — Task 9 그림이 들어오기 전에도 동작.
- `visibilitychange` 로 가려지면 `EventSource.close()` + `body.paused`(`animation-play-state: paused`, transition 없음), 다시 보이면 `/api/state` 새로 받고 재연결.
- 모든 사용자 글은 한국어, 외부 리소스 0.

- [ ] **Step 1: (Task 1 에서 만든 `assets/floors/studio.png`·`assets/sprites/default.png` 가 있는지 확인)**
- [ ] **Step 2: `web/index.html`·`style.css`·`app.js`·`scripts/demo-feed.mjs` 구현** — 함수 이름: `connect()`, `render(state)`, `renderFloor(floorView, el)`, `renderAgent(agentView, floorEl)`, `walkTo(el, x, y)`, `appendLog(entries)`, `setHidden(sessionId, hidden)`, `pause()`/`resume()`.
- [ ] **Step 3: 시연기로 화면 확인** — 시연기 + 서버(47811) 띄우고 크롬 헤드리스로 3초·15초 두 장 캡처(`--virtual-time-budget`, `--window-size=1400,1100`). 확인 항목: 층 2개가 위아래로, 캐릭터가 책상 위치에 서 있음(배경 의자와 어긋나면 `config.json` desks/aisle/lead/tray 좌표 보정 후 재캡처), 말풍선끼리 겹치지 않음, 기록 칸 형식이 참고 화면과 같음, 실제 `POST /api/hide` 뒤 캡처에서 그 층·목록 줄·기록이 사라짐, `POST /api/rename` 뒤 층 표지·화이트보드·목록에 새 이름. 시연기는 세션 하나를 「다시 실행」(같은 sessionId, 새 자식 프로세스 pid)하는 동작도 넣어, 숨긴 층이 다시 나타나는지 캡처로 확인. 캡처 경로를 보고에 남긴다.
- [ ] **Step 4: 일시정지 확인** — 헤드리스에서 `document.dispatchEvent(new Event('visibilitychange'))` 를 `document.hidden` 이 true 인 상태로 흉내 내기 어렵다면, `pause()` 를 직접 불러 `getComputedStyle(agentEl).animationPlayState === 'paused'` 와 EventSource `readyState === 2` 를 확인하는 작은 시험 페이지 스크립트로 대신한다.
- [ ] **Step 5: 끄기** — 시연기·서버를 각자 PID 로 종료.
- [ ] **Step 6: 커밋(승인 시)** — `git commit -m "feat: building view with floors, characters, log panel and hide"`

---

### Task 7: 전체 기록 페이지

**Files:**
- Create: `web/log.html`, `web/log.js`
- Modify: `server/http.mjs` — `GET /api/log?session=<sid>&name=<이름>&limit=<n>` → `office.queryLog(...)`(limit 기본 500, 최대 `cfg.log.cap`)
- Test: `tests/server.test.mjs` 에 `server: /api/log filters by session and excludes hidden` 추가

**Interfaces:**
- Consumes: `Office.queryLog`(Task 4), `createServer`(Task 5)

- [ ] **Step 1: 실패하는 시험 추가** → FAIL 확인
- [ ] **Step 2: 구현** — 페이지: 위쪽 세션·이름 고르기(살아 있는 세션 + 기록에 나온 이름), 목록은 메인 화면 기록 칸과 같은 모양, 「새로 고침」 단추(자동 갱신 없음 — 자원 절약).
- [ ] **Step 3: 통과 확인 + 헤드리스 캡처 1장**
- [ ] **Step 4: 커밋(승인 시)** — `git commit -m "feat: full log page with filters"`

---

### Task 8: 런처 · 바로가기 · 실데이터 확인 · 자원 측정

**Files:**
- Create: `agent-office.cmd`, `server/launch.mjs`, `scripts/make-shortcut.ps1`, `README.md`

**Interfaces:**
- Consumes: `/health`, `main.mjs --open`
- `agent-office.cmd`: `@echo off` → `chcp 65001 >nul` → `node "%~dp0server\launch.mjs"`; node 가 없으면 「Node.js 가 필요합니다」 출력 후 `pause`.
- `launch.mjs`: `/health` 가 `app === 'agent-office'` 면 브라우저만 연다. 응답이 없으면 `cmd /c start "에이전트 사무실 서버" /min node "<root>\server\main.mjs" --open` 으로 띄우고 끝. 응답은 있는데 우리 앱이 아니면 「포트 47800 을 다른 프로그램이 쓰고 있습니다 — config.json 의 port 를 바꾸세요」 출력.
- `make-shortcut.ps1`: 바탕화면에 `에이전트 사무실.lnk`(대상 `agent-office.cmd`, 창 최소화, 아이콘 `assets\icon.ico` 가 있으면 사용).

- [ ] **Step 1: 런처·바로가기·README 작성** — README: 켜기(더블클릭), 끄기(화면 「끄기」 또는 서버 창 닫기), 숨기기, 이름 바꾸기(`config.json` roles), 그림 다시 뽑기(Task 9 방법), 문제 해결(포트).
- [ ] **Step 2: 런처 확인** — `agent-office.cmd` 두 번 실행: 첫 번째에 서버 창(최소화) 1개 + 브라우저, 두 번째엔 서버 창이 늘지 않음(`/health` 의 pid 가 같음).
- [ ] **Step 3: 실데이터 확인(설계서 §10)** — 실제 `~/.claude` 로 켠 상태에서 이 세션이 서브에이전트 하나(아무 짧은 scout 조회)를 띄워, 2초 안팎에 그 층에 캐릭터가 들어오고 끝나면 보고함으로 가는지 캡처 2장. 숨김 → 서버 재시작 → 여전히 숨김(목록에도 없음). 이름 바꾸기 → 서버 재시작 → 이름 유지.
- [ ] **Step 4: 자원 측정** — 서버 PID 의 CPU 시간·메모리를 60초 동안 5초 간격으로 기록(PowerShell `Get-Process -Id <pid>` 의 `CPU`, `WorkingSet64`). 기준: 평균 CPU ≤ 1~2%(코어 1개 기준 환산), WorkingSet ≤ 100MB. 표로 보고. 넘으면 원인(어느 파일을 몇 바이트 읽는지)을 찾아 고친 뒤 다시 측정.
- [ ] **Step 5: 개인정보 확인** — 실데이터로 켠 상태에서 `/api/state`·`/api/log?limit=2000` 응답 전체를 파일로 받아, 이 대화에서 사용자가 보낸 문장 3개와 `toolu_`·`sk-`·`Bearer` 문자열이 없는지 grep. 결과 보고.
- [ ] **Step 6: 정리** — 자기가 띄운 서버만 `/api/shutdown` 또는 PID 로 종료.
- [ ] **Step 7: 커밋(승인 시)** — `git commit -m "feat: launcher, desktop shortcut and README"`

---

### Task 9: 역할별 캐릭터 그림 18장 (Task 1 끝난 뒤 Task 2~8 과 병렬)

**Files:**
- Create: `art/prompts.json`, `assets/sprites/<roleKey>.png` ×17(+ default 는 Task 6), `assets/icon.ico`, `art/contact-sheet.png`

**Interfaces:**
- Consumes: `art/snap.py`(Task 1), roleKey 목록(`config.json` roles 의 `key`)
- Produces: `assets/sprites/{lead,scout,worker-low,worker,worker-high,architect,architect-high,explore,plan,code-critic,security-reviewer,performance-reviewer,i18n-reviewer,a11y-reviewer,frontend,backend,app}.png`

- [ ] **Step 1: `art/prompts.json`** — 공통 스타일 블록(시안에서 통한 문구: 「true pixel art sprite, 16-bit era RPG, about 64 pixels tall, strict pixel grid, 1-pixel dark outline, ~16 colors, flat 2-3 tone shading, no anti-aliasing; anime bishoujo, SD chibi 2.5–3 heads; full body, 3/4 view facing right; fully transparent background, no glow, no shadow; no text」) + 역할별 구별 요소(머리색·머리 모양·옷·소품이 서로 겹치지 않게. 예: 팀장 = 카디건 + 클립보드, 정찰 = 돋보기, 설계 = 설계도 두루마리, 수석 = 안경 + 태블릿, 검토 계열 = 빨간 펜, 보안 = 방패 배지, 번역 = 사전, 접근성 = 큰 글씨 카드, 프론트 = 태블릿, 백엔드 = 서버 랙 미니어처, 앱 = 스마트폰, 막내 = 커피 두 잔).
- [ ] **Step 2: 역할마다 `codex exec --skip-git-repo-check -s workspace-write -C <임시폴더> "<프롬프트> … copy the final PNG here as <roleKey>.png"`** — 한 번에 하나씩(동시 2개까지). 「Selected model is at capacity」 등으로 복사가 안 되면 `~/.codex/generated_images/` 에서 그 실행 시각 직후 생긴 PNG 를 가져온다(2026-10-28 실제 발생).
- [ ] **Step 3: 격자 정리** — `python art/snap.py sprite <원본> assets/sprites/<roleKey>.png --height 64 --colors 20`
- [ ] **Step 4: 한눈에 보기** — 18장을 6×3 으로 4배 확대해 이름(config roles 의 name·role)과 함께 `art/contact-sheet.png` 로. 확인: 18장 모두 높이 64, 모서리 알파 0, 얼굴이 읽힘, 서로 구별됨(머리색이 같은 쌍이 없음). 실패한 장은 그 역할만 다시 뽑는다.
- [ ] **Step 5: 아이콘** — `lead.png` 로 `assets/icon.ico`(16·32·48·256).
- [ ] **Step 6: 커밋(승인 시)** — `git commit -m "art: role sprites and app icon"`

---

### Task 10: 넓고 다양한 층 배경 4종 + 자리 좌표 표 (Task 1 끝난 뒤 병렬)

**Files:**
- Create: `art/floors.json`, `assets/floors/<design>.png` ×4, `art/floors-check/<design>.png`(좌표 점 찍은 확인 그림)
- Modify: `config.json` — `layouts` 에 4종 추가, `designOrder` 를 4종으로(`studio` 는 `layouts` 에 남겨 둠)

**Interfaces:**
- Consumes: `art/snap.py bg`(Task 1), `layouts` 모양(Task 1 config)
- Produces: `layouts.<design> = {image, size, entrance, lead, tray, sofa, board, desks: 10~12개, aisle: 6개 이상}` — Task 4·6 이 그대로 쓴다.

- [ ] **Step 1: `art/floors.json`** — 공통 블록(시안 배경에서 통한 문구: 「isometric 2:1, true pixel art 16-bit cozy game, strict pixel grid, clean 1-pixel outlines, flat 2-3 tone shading, no anti-aliasing; room EMPTY of people; no text」) + 공통 요구: 가로로 넓은 방(가로:세로 약 16:9 느낌, 시안보다 넓게), 비어 있는 책상+모니터+의자 10~12개를 통로가 넉넉하게 두 줄 이상, 앞쪽 가운데 보고함이 놓인 작은 탁자(팀장 자리), 문(입구), 화이트보드, 소파 구역, 시안보다 많은 소품(조명·러그·책장·화분·창밖 풍경·벽 장식). 디자인 4종: `studio2`(밝은 나무 개발실), `lounge`(카페형 라운지, 원목+테라코타, 바 테이블), `library`(서재형, 짙은 원목 책장 벽, 스탠드 조명), `greenhouse`(유리 천장 온실형, 식물 많음). 바깥 배경은 단색.
- [ ] **Step 2: 생성** — 디자인마다 `codex exec --skip-git-repo-check -s workspace-write -C <임시폴더> "<프롬프트> … landscape, copy as <design>.png"`. 복사 실패 시 `~/.codex/generated_images/` 에서 가져옴. 결과를 보고 사람이 있거나 책상이 10개 미만이면 그 디자인만 다시 뽑는다.
- [ ] **Step 3: 크기 정리** — `python art/snap.py bg <원본> assets/floors/<design>.png --size 1024x<원본 비율에 맞는 높이, 짝수>`. 캐릭터 64px 이 책상 옆에 섰을 때 책상 폭과 비슷한 비율이 되는지 Step 4 확인 그림으로 판단하고, 아니면 너비를 896~1152 사이에서 조정.
- [ ] **Step 4: 좌표 표** — 각 배경에서 책상 앞 의자 자리(발끝), 통로 자리, 입구, 팀장 자리, 보고함, 소파, 화이트보드 글자 카드를 놓을 빈 칸을 재서 `config.json` `layouts.<design>` 에 적는다. 확인 그림: 배경 위에 desks=초록 점·aisle=파랑·lead/tray=빨강·entrance=검정을 찍고 `default.png` 캐릭터를 desks 전부에 세운 `art/floors-check/<design>.png`. 기준: 캐릭터가 의자·책상과 자연스럽게 겹치고 벽·가구 속에 박히지 않음.
- [ ] **Step 5: `node --test tests/`** — config 시험(`designOrder` 값이 모두 `layouts` 에 있음)이 통과.
- [ ] **Step 6: 커밋** — `git add art/floors.json assets/floors/ art/floors-check/ config.json` → `git commit -m "art: four wide floor designs with seat layouts"`

---

### Task 11: Codex 대응 (Task 5 뒤)

**Files:**
- Create: `server/codex.mjs`, `tests/codex.test.mjs`, `tests/fixtures/codex/*.jsonl`(아래 모양을 본뜬 견본 — 실제 롤아웃 복사 금지)
- Modify: `server/poller.mjs`(Claude·Codex 세션을 합쳐 `office.syncSessions` 한 번), `server/office.mjs`(provider 별 팀장·기본 역할), `config.json`(`codex` 블록 + Codex 역할), `server/config.mjs`(env `AGENT_OFFICE_CODEX_HOME`)

**Interfaces:**
- Consumes: `FileTail`(Task 2), `Office`(Task 4), `Poller`(Task 5), `clip`(Task 1)
- Produces: `parseCodexMeta(line: string): null | {id:string, cwd:string, kind:'exec'|'interactive'|'subagent', parentId:string|null, agentRole:string|null, taskName:string, startedAt:number}` — `session_meta` 줄에서 이 필드만 꺼낸다(`creator_user_id`·`creator_account_id`·instructions 등은 절대 담지 않음).
- Produces: `parseCodexLine(line: string): Ev[]` — Task 2 와 같은 `Ev` 모양.
- Produces: `class CodexSource { constructor(cfg); poll(now: number): Promise<{sessions: Session[], sessionEvents: Map<string, Ev[]>, agents: Map<string, AgentMeta[]>, agentEvents: Map<string, Ev[]>}> }` — `agentEvents` 키는 `${parentId}/${childId}`.

Codex 기록 사실(2026-10-28 조사, codex-cli 0.164.0):
- 롤아웃: `<codexHome>/sessions/YYYY/MM/DD/rollout-<시각>-<uuid>.jsonl`(10-15 이전은 `.jsonl.zst` — 지금 활동이 아니므로 무시). 줄 = `{"timestamp","type","payload":{…}}`, 첫 줄 `type:"session_meta"`(약 22KB).
- 세션 종류: `payload.originator`·`payload.source` — exec 는 `originator:"codex_exec"`/`source:"exec"`, 대화형은 `source:"cli"`/`"vscode"`, 하위 에이전트는 `source` 가 객체 `{"subagent":{"thread_spawn":{"parent_thread_id","depth","agent_path":"/root/<task_name>","agent_nickname","agent_role"}}}`. 하위 에이전트의 `parent_thread_id` = 부모 `session_meta.payload.id`.
- 도구 시작: `response_item` + `payload.type:"custom_tool_call"`(name `exec`, `input` 은 `await tools.exec_command({cmd:"…"})` 같은 JS 문자열, `call_id`) / `payload.type:"function_call"`(name `spawn_agent`·`wait_agent`·`list_agents`·`send_message`·`followup_task`, `arguments` JSON 문자열, `call_id`).
- 도구 끝: `custom_tool_call_output`·`function_call_output`(`call_id`). 그리고 `event_msg` + `payload.type:"item_completed"` 의 `payload.item.type`: `CommandExecution`(`parsed_cmd[0].cmd`, `status`), `Extension`(`kind`: `image_gen.generation`·`web.search`), `McpToolCall`(`server`, `tool`).
- 생각/답: `response_item` 의 `reasoning`·`message` → think(내용은 암호화되었거나 본문이라 쓰지 않음).
- 턴: `event_msg` `task_started` → 작업 시작, `task_complete` → 턴 끝.
- 제목 이벤트 없음 → 층 이름 = 작업 폴더 이름(`cwd` 끝), exec 는 `codex exec · <폴더>`.
- PID 레지스트리 없음, 파일 mtime 은 실제보다 늦게 바뀜 → 활동 판단은 **파일 크기 변화와 줄의 `timestamp`** 로만.

규칙:
- 지켜볼 파일: 오늘·어제(로컬 날짜) 폴더의 `rollout-*.jsonl` — 폴더 목록은 `agentScanEveryTicks` 마다, 파일은 크기만 매 tick. 첫 발견 때 앞부분에서 `session_meta` 한 줄만 읽고(`codex.headBytes` 안에서 첫 `\n` 까지), 나머지는 FileTail(`cfg.tail.startBytes`).
- 세션 살아 있음 판정: 마지막 이벤트가 `task_started` 뒤 `task_complete` 전이면 `status:'busy'`. 턴이 끝났으면 `'waiting'` 으로 두되 마지막 이벤트 뒤 대화형은 `codex.idleKeepMs`, exec 는 `codex.execKeepMs` 가 지나면 목록에서 뺀다(→ Office 가 층 퇴근 처리, 숨김 기록도 지워져 「다시 실행」 하면 다시 보임). `Session` = `{provider:'codex', pid:0, sessionId:<payload.id>, cwd, status, name:'', startedAt:<이번 활동 시작 ts>}`.
- 하위 에이전트: 부모 층의 캐릭터. `agentType` = `'codex:' + (agent_role ?? '__default')`, `description` = `task_name` 의 `_` 를 공백으로, `finished` = 자기 롤아웃 마지막 이벤트가 `task_complete`.
- 말풍선·기록 문구(개인정보 규칙 그대로): exec 시작 → `input` 에서 `cmd:"` 뒤 첫 단어만 정규식으로 꺼내 `clip` 후 `「<단어> 실행」`(못 꺼내면 「명령 실행」, PowerShell 조각처럼 글자·숫자·`-`·`.` 이외로 시작하면 「명령 실행」); `CommandExecution` 완료 → 같은 규칙으로 `parsed_cmd[0].cmd` 첫 단어; `spawn_agent` → `위임 · <task_name>`; `wait_agent` → 「동료 기다리는 중」; 그 밖의 협업 함수 → 「동료와 협업」; `image_gen.generation` → 「그림 그리는 중」; `web.search` → 「웹 조사 중」; `McpToolCall` → `<server> 도구 사용`. 절대 쓰지 않음: 명령 전체, `arguments`·`message`·`input` 본문, `revisedPrompt`, `savedPath`, `arguments.code`, 메시지 본문, 계정 id.
- 역할 표(`config.json` roles 에 추가 — 그림은 같은 등급의 Claude 캐릭터 그림을 같이 쓴다): `codex:__lead` → `{key:'lead', name:'하나', role:'팀장'}`, `codex:scout` → `{key:'scout', name:'별이', role:'정찰'}`, `codex:worker_low` → `{key:'worker-low', name:'보미', role:'막내'}`, `codex:worker` → `{key:'worker', name:'도담', role:'개발'}`, `codex:worker_high` → `{key:'worker-high', name:'한결', role:'선임'}`, `codex:architect` → `{key:'architect', name:'라온', role:'설계'}`, `codex:architect_high` → `{key:'architect-high', name:'새봄', role:'수석'}`, `codex:__default` → `{key:'default', name:'누리', role:'지원'}`. Office 는 `provider === 'codex'` 인 층의 팀장에 `codex:__lead`, 모르는 Codex 역할에 `codex:__default` 를 쓴다.
- `config.json` `codex`: `{"enabled": true, "headBytes": 262144, "idleKeepMs": 1800000, "execKeepMs": 60000}`. `cfg.codexHome` = env `AGENT_OFFICE_CODEX_HOME` 또는 `~/.codex`. 폴더가 없으면 조용히 건너뜀.
- 화면: 층 표지에 `provider` 배지(「Claude」/「Codex」) — Task 6 이 FloorView.provider 로 그린다.

- [ ] **Step 1: 실패하는 시험 작성**
  - `codex: meta of exec, interactive and subagent` — 세 견본 `session_meta` → kind 와 parentId·agentRole·taskName(`/root/billing_config_review` → `billing config review`)
  - `codex: meta never carries account ids` — 견본에 `creator_user_id:"U-SECRET"` 를 넣고 `JSON.stringify(parseCodexMeta(...))` 에 `U-SECRET` 없음
  - `codex: exec tool start exposes first word only` — `input: 'await tools.exec_command({cmd:"git push https://token@x"})'` → text `'git 실행'`, `token` 미포함; `cmd:"@'` 로 시작 → `'명령 실행'`
  - `codex: call output and item_completed end the tool` → `toolDone`(같은 call_id)
  - `codex: spawn, image_gen, web.search, mcp labels` — 위 문구 그대로
  - `codex: reasoning and message become think without text` — 결과 Ev 에 본문 문자열 없음
  - `codex: source lists busy session and its subagent` — 임시 codexHome 에 오늘 폴더 + 부모 롤아웃(task_started 만) + 자식 롤아웃(scout) → sessions 1개(`status:'busy'`), agents 에 `codex:scout` 1개
  - `codex: finished exec session drops after execKeepMs` — task_complete 뒤 `now` 를 `execKeepMs+1` 만큼 넘기면 sessions 에서 빠짐
  - `office: codex floor uses 하나·팀장 and 도담 for worker`
  - `poller: claude and codex sessions merge into one sync` — 두 provider 층이 함께 snapshot 에
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** → `node --test tests/` PASS
- [ ] **Step 5: 실데이터 확인** — 서버를 실제 홈으로 켠 채 짧은 `codex exec --skip-git-repo-check -s read-only "Reply with OK."` 를 한 번 돌려, 실행 중 Codex 층이 생기고 끝난 뒤 `execKeepMs` 안에 사라지는지 `/api/state` 로 확인(파일 크기가 실행 중 커지는지도 기록 — 조사에서 확인 못 한 항목). 자기가 띄운 프로세스만 정리.
- [ ] **Step 6: 커밋** — `git commit -m "feat: show Codex sessions and sub-agents"`

---

### Task 12: 원격 저장소 연결 (마지막, push 는 매번 사용자 확인)

**Files:**
- Modify: `.git/config`(이 저장소 로컬 설정만)

- [ ] **Step 1: 확인 받기** — 사용자에게 「`kkp8121-rgb/agent-office` 비공개 저장소를 만들고 push 할까요?」 를 묻는다(저장소 이름·공개 여부 포함). 답 전에는 아무것도 하지 않는다.
- [ ] **Step 2: 저장소 만들기** — `gh repo create kkp8121-rgb/agent-office --private --source . --remote origin`(gh 의 활성 계정을 바꾸지 말고 `GH_TOKEN=$(gh auth token -u kkp8121-rgb)` 로 그 호출에만 토큰을 준다).
- [ ] **Step 3: 이 저장소 전용 인증** — 로컬 설정에 `credential.https://github.com.helper` 를 비우고 `!gh auth token -u kkp8121-rgb` 를 돌려주는 헬퍼를 추가(전역 설정은 건드리지 않음). `git config --local --list` 로 확인.
- [ ] **Step 4: push** — `git push -u origin main`. 결과(원격 URL, 커밋 수)를 보고.
