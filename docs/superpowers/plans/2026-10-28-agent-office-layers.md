# 에이전트 사무실 — 오브젝트 레이어 · 내비메시 · 생활 움직임 · 앉은 자세 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 빌드 워크플로가 Task 를 **번호로** 나눠 맡기므로 Task 번호·구조를 바꾸지 않는다.

**Goal:** 층 배경을 「그림 한 장」 에서 「빈 방 껍데기 + 오브젝트 레이어 + 장면 데이터」 로 바꿔 캐릭터가 가구와 앞뒤가 맞게 그려지고 가구를 돌아 걷게 하며, 자리에서는 앉아 일하고 가끔 몸짓을 하거나 방 안의 활동 지점에 다녀오게 한다.

**Architecture:** 장면 데이터(`assets/scenes/<design>/scene.json`)를 서버가 시작할 때 형식 검사해 `/api/ui` 로 넘긴다. 브라우저·Node 시험·검증기가 **같은 순수 모듈**(`web/scene.mjs`·`web/nav.mjs`·`web/depth.mjs`·`web/ambient.mjs`)을 쓴다: 장면 풀기, 격자 굽기 + A* + 경로 다듬기 + 캐시, 깊이(z) 계산과 걷기 선분 자르기, 생활 움직임 결정. 화면(`web/app.js`, 모듈로 전환)은 오브젝트를 정적 노드로 한 번 그리고, 걷기는 선분마다 CSS `transform` 트랜지션을 이어 붙이며, 층마다 `setTimeout` 사슬 하나로 몸짓·나들이를 돌린다. 서버는 자리 배정만 장면에서 하고 길찾기는 하지 않는다. 장면이 없는 디자인은 옛 `layouts` + 직선 걷기로 계속 동작한다(방 단위 이전).

**Tech Stack:** Node.js v24 (npm 의존성 0, ES modules, `node:test`), 바닐라 HTML/CSS/JS, Python 3.12 + Pillow(그림 후처리·점검표), Codex CLI `codex exec` + 내장 imagegen(그림), 크롬 헤드리스 + CDP(화면 캡처·CPU 측정).

**Spec (구속):** `C:\Users\gustj\agent-office\docs\superpowers\specs\2026-10-28-agent-office-layers-navmesh-design.md`(이하 「설계서」, §16 생활 움직임 · §17 앉은 자세 포함) + 본 설계서 `…\specs\2026-10-28-agent-office-design.md`. 실행자는 계획과 설계서를 함께 읽는다. 겹치면 설계서가 이긴다.

**순서:** Task 1 → Task 2 → (Task 3 · 4 · 5 · 6 병렬) → Task 7.

## Global Constraints

- 저장소 `C:\Users\gustj\agent-office`(브랜치 `main`). 원격 `origin` 이 있으나 **push 금지**. 셸 명령은 `cd C:/Users/gustj/agent-office && …` 로 시작하고 경로는 절대경로.
- npm 의존성 0. 순수 HTML/CSS/JS. `requestAnimationFrame`·캔버스·`element.animate()` 금지 — 움직임은 CSS `transform` 트랜지션·키프레임만. 탭이 가려지면 멈춤.
- 기획 수치는 `config.json` 또는 코드가 참조하는 장면 데이터에. 연출값(걷는 속도·찌그러짐 시간)은 지금 관례대로 `app.js`/`style.css` 상수.
- 사용자에게 보이는 글은 한국어. 코드 식별자·주석은 영어. UTF-8 BOM 없음, LF. 주변 코드 스타일을 따른다(2칸 들여쓰기, 작은따옴표, 세미콜론).
- 화면을 띄우지 않는다: `--open`·`start <url>`·`cmd /c start`·`-WindowStyle Hidden` 없는 `Start-Process` 금지. 화면 확인은 헤드리스 크롬 CDP `Page.captureScreenshot` 만(복사해 쓸 도우미: `C:\Users\gustj\AppData\Local\Temp\claude\C--Project\6106276a-a6e5-4468-8650-198bebbf83af\scratchpad\t8b\persist\cdpcap.mjs`). PNG 는 Read 도구로 본다.
- 포트 47800 사용 금지. 띄우는 서버는 **47869**, `AGENT_OFFICE_DATA_DIR` = `C:\Users\gustj\AppData\Local\Temp\claude\C--Project\6106276a-a6e5-4468-8650-198bebbf83af\scratchpad\layers\data-47869\<task>`, `AGENT_OFFICE_CLAUDE_HOME`·`AGENT_OFFICE_CODEX_HOME` 는 가짜 홈(`scripts/demo-feed.mjs`) — Task 7 의 CPU 측정만 실제 홈. 자기가 띄운 PID 만 끈다. **Task 3~6 은 서버를 띄우지 않는다**(병렬 실행 중 포트 충돌).
- 개인정보: 대화 본문·명령 전체·검색어·계정 id·토큰을 출력·저장하지 않는다. `~/.claude/sessions/*.key`·`.env`·`~/.codex/auth.json`·`config.toml`·`history.jsonl`·`logs/`·`threads/` 를 열지 않는다. 실제 홈으로 띄운 화면은 캡처하지 않는다(숫자만).
- Codex 그림: `codex exec --skip-git-repo-check -s workspace-write -C <작업 폴더> -i <참고.png> -- "<프롬프트>"`(`--` 필수, 헤드리스). 작업 폴더·원본은 저장소 밖 `…\scratchpad\layers\<room>\`. 호출마다 `C:\Users\gustj\AppData\Local\Temp\claude\C--Project\6106276a-a6e5-4468-8650-198bebbf83af\scratchpad\layers\codex-calls.log` 에 한 줄 `<ISO 시각> <room> <목적> <초>`. 상한: studio2 6 · library 8 · greenhouse 8 · lounge 8(방 합계 30) · 앉은 자세 10. 넘기지 않는다. 「모델 혼잡」 오류면 `~/.codex/generated_images/<세션>/` 에서만 가져온다.
- 커밋: 각 Task 끝에서 `git -C C:/Users/gustj/agent-office add <명시 경로>`(`-A`·`.`·`-f` 금지, 자기가 만든 파일만). `index.lock` 이면 몇 초 뒤 다시. 메시지는 파일로 `git -C C:/Users/gustj/agent-office commit -F <파일>`, 끝은 빈 줄 + 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 옛 `assets/floors/*.png` 와 `config.json` 의 `layouts.studio` 는 사용자가 정할 때까지 그대로 둔다.

## Review Focus

1. 깊이 순서가 틀리면 「책상 위에 선 캐릭터」 가 되살아난다 — 책상 뒤 캐릭터(선·앉은) z < 책상 z, 의자 z < 앉은 캐릭터 z, 화분 앞 캐릭터 z > 화분 z, 대각선 띠 양 끝. → Task 1 `depth: …` 시험, 검증기 5·9단계.
2. 걷기 이어 붙이기가 멈추거나 꼬임 — 1px 미만 선분, 이전 세대 `transitionend`, 탭 가림 중 걷기, 걷는 중 목표 바뀜. → Task 1 `depth: split drops sub-pixel pieces`, `walk: …` 헤드리스 확인.
3. 생활 움직임이 서버 움직임을 이기거나 타이머가 늘어남 — 나들이 중 완료·자리 바뀜·working 전환, 층당 타이머 1개, 가림 시 0개. → Task 1 `ambient: …` 시험.
4. 출하 장면에서 어떤 점이라도 문·자리에서 걸어갈 수 없음 → 검증기 2·8단계가 `npm test` 안에서 실패해야 한다.
5. 장면 없는 디자인(이전 기간)이 깨짐 → Task 1 의 옛 배치 시험이 그대로 통과.
6. 키잉 잔여 테두리·크기 어긋남 → Task 2~6 점검표 확대 확인.

---

## File Structure

```
config.json                     + scenesDir, nav, depth, sitHeight, ui.ambient (Task 1) · 옛 숫자 정리 (Task 7)
server/
  config.mjs                    loadConfig 가 cfg.scenes 를 채움, AGENT_OFFICE_SCENES_DIR (Task 1)
  scenes.mjs                    새: 장면 읽기·형식 검사·PNG 크기 (Task 1)
  scene-check.mjs               새: 검증기 1~9단계 (Task 1)
  office.mjs                    #allocSlot 장면 분기 (Task 1)
  http.mjs                      /api/ui scenes·sitSprites, /scenes/ 정적 (Task 1)
web/
  scene.mjs  nav.mjs  depth.mjs  ambient.mjs    새 순수 모듈 (Task 1)
  app.js                        모듈 전환·오브젝트 그리기·경로 걷기·앉기·생활 움직임 (Task 1)
  style.css  index.html         (Task 1)
scripts/check-scenes.mjs        검증기 CLI (Task 1)
tests/
  scene.test.mjs  nav.test.mjs  depth.test.mjs  ambient.test.mjs  scenes-shipped.test.mjs  office-scene.test.mjs (Task 1)
  helpers/png.mjs               의존성 없는 PNG 쓰기(zlib) (Task 1)
  fixtures/scenes/studio2/      합성 장면(사각 방 + 책상 몇 개) (Task 1)
art/
  snap.py                       + shell · sheet · obj 모드 (Task 2)
  atlas.py  front.py  scene_sheet.py   (Task 2)
  scenes/<design>.json          방별 프롬프트·목표 크기 (Task 2~5, 방마다 자기 파일)
  scenes-check/<design>.png     방별 점검표 (Task 2~5)
  sit/                          앉은 자세 프롬프트·점검표 (Task 6)
assets/
  scenes/<design>/scene.json shell.png front.png objects.png   (Task 2~5, 방마다 자기 폴더)
  sprites/<key>-sit.png         (Task 6)
```

## Shared types (모든 Task 공통 — 이름 그대로 쓴다)

```js
// web/scene.mjs
/** @typedef {[number, number]} Pt */
/** @typedef {'left'|'right'} Face */
/** @typedef {{id:string, kind:'coffee'|'water'|'window'|'shelf'|'plant'|'sofa'|'whiteboard'|'other', at:Pt, face:Face, pair:Pt|null}} Spot */
/** @typedef {{i:number, deskId:string, at:Pt, sitAt:Pt, approach:Pt, visit:Pt|null, face:Face}} Seat */
/** @typedef {{id:string, kind:string, at:Pt, flipX:boolean, rect:[number,number,number,number], anchor:Pt,
 *             footprint:Pt[], blocks:boolean, depth:'auto'|'overhead'|'floor'}} Placed   // footprint in absolute room px */
/** @typedef {{design:string, size:Pt, shell:string, front:string|null, atlas:string, board:number[], reports:Pt, sign:Pt|null,
 *             walkable:Pt[][], blocked:Pt[][], frontMask:Pt[][], door:{at:Pt, face:Face}, objects:Placed[], seats:Seat[],
 *             lead:{deskId:string, at:Pt, sitAt:Pt, approach:Pt, face:Face}, tray:{objectId:string, at:Pt, queue:Pt[]},
 *             idle:{at:Pt, face:Face}[], overflow:{at:Pt, face:Face}[], spots:Spot[]}} Resolved */
// web/nav.mjs
/** @typedef {{cols:number, rows:number, cellPx:number, open:Uint8Array}} Grid */
// web/depth.mjs
/** @typedef {{id:string, objId:string, x:number, y:number, w:number, h:number, bgX:number, bgY:number, flipX:boolean,
 *             depthY:number, z:number}} ObjNode   // one DOM node; a strip of a sliced object has id `${objId}#${k}` */
/** @typedef {{from:Pt, to:Pt, z:number}} Piece */
// server/office.mjs — snapshot agents[].slot
/** @typedef {{i:number, kind:'seat'|'idle'|'overflow', ref:string, x:number, y:number, approach:Pt|null, sit:Pt|null, face:Face, ring:number}} SceneSlot */
/** @typedef {{x:number, y:number, i:number}} LegacySlot   // designs without a scene (unchanged) */
// /api/ui 에 더해지는 것
/** @typedef {{scenes:Record<string, object & {url:string}>, sitSprites:string[], sitHeight:number,
 *             nav:object, depth:object}} UiAdd   // scenes 값 = raw scene.json + url; ui.ambient 은 기존 ui 블록으로 감 */
```

`config.json` 에 더할 블록(Task 1, 설계서 §4.8·§16.5·§17.4 값 그대로):

```json
"scenesDir": "assets/scenes",
"sitHeight": 50,
"nav":   { "cellPx": 8, "inflatePx": 12, "snapRadiusCells": 6, "pathCache": 256, "overflowRing": 28, "trayRowPx": 28 },
"depth": { "sliceTolerancePx": 6, "sliceWidthPx": 16, "sliceOverlapPx": 1, "pickMarginPx": 22, "zBase": 1000, "frontZ": 7000, "faceTopPx": 24, "seatShowPx": 28 },
"ui": { "...기존...": "", "ambient": {
  "enabled": true, "tickMinMs": 1000, "firstDelayMs": [3000, 20000],
  "fidgetEveryMs": [8000, 40000], "fidgetMs": 1200,
  "fidgets": { "seated": ["look", "lean", "stretch"], "standing": ["look", "lean", "stretch", "hop"] },
  "tripEveryMs": { "working": [240000, 600000], "thinking": [30000, 90000], "idle": [45000, 150000], "stale": [60000, 180000] },
  "leadTourEveryMs": [40000, 120000], "leadTourDesks": 3,
  "stayMs": [4000, 12000], "maxAway": 2, "chatChance": 0.5 } }
```

`scene.json` 에 설계서 §4 위에 더해지는 필드: `spots`(§16.4), `kinds.<desk>.seat.sitAt`·`seat.visit`(§16.4·§17.4), `lead.sitAt`.

---

### Task 1: 엔진 — 장면 · 길찾기 · 깊이 · 경로 걷기 · 앉기 · 생활 움직임 · 서버 · 검증기

진짜 그림 없이 **합성 장면**으로 끝까지 동작해야 한다. 장면이 없는 디자인은 옛 경로 그대로.

**Files:**
- Create: `web/scene.mjs`, `web/nav.mjs`, `web/depth.mjs`, `web/ambient.mjs`, `server/scenes.mjs`, `server/scene-check.mjs`, `scripts/check-scenes.mjs`, `tests/helpers/png.mjs`, `tests/fixtures/scenes/studio2/{scene.json,shell.png,objects.png,front.png}`, `tests/scene.test.mjs`, `tests/nav.test.mjs`, `tests/depth.test.mjs`, `tests/ambient.test.mjs`, `tests/office-scene.test.mjs`, `tests/scenes-shipped.test.mjs`
- Modify: `config.json`, `server/config.mjs`, `server/office.mjs`, `server/http.mjs`, `web/app.js`, `web/style.css`, `web/index.html`, `tests/server.test.mjs`(`/api/ui` 단언 추가만)
- 옛 배치에 묶인 시험(`tests/config.test.mjs`, `tests/office.test.mjs:101-130`, `tests/office-fixes.test.mjs:220`, `tests/round2-web.test.mjs:64-95`, `tests/web-fixes.test.mjs:46`)은 **고치지 않는다** — 옛 경로가 그대로이므로 통과해야 한다. 이들은 Task 7 이 장면 시험으로 옮긴다.

**Interfaces:**
- Consumes: 설계서 §4~§8, §10, §16, §17. 기존 `loadConfig`, `Office`, `createServer`, `app.js` 의 `createChar`·`walkTo`·`renderAgent`·`createFloor`·`pause`·`resume`.
- Produces (`web/scene.mjs`, DOM 없음):
  - `checkSceneFormat(raw: object, opts: {atlasSize: Pt|null, inflatePx: number, minSeats?: number}): string[]` — 설계서 §10.1 1단계 + `spots` 형식(4~8개, kind 목록, id 유일) + `seat.sitAt`/`visit`·`lead.sitAt` 형식. 빈 배열 = 통과. 오류 문자열은 `"<필드 경로>: <이유>"`. `minSeats` 기본 12(합성 고정물은 4 를 넘김).
  - `resolveScene(raw: object): Resolved` — 종류 펼치기, `flipX` 시 footprint·seat dx 뒤집기, 오브젝트 덮어쓰기, `sitAt` 없으면 `at`, `visit` 없으면 `null`, `pair` 없으면 `null`.
  - `pointInPolys(pt: Pt, polys: Pt[][]): boolean`, `distToPolyEdge(pt: Pt, poly: Pt[]): number`
  - `trayPoint(r: Resolved, i: number, trayRowPx: number): Pt` — 설계서 §4.5 (붙이기 전 값).
  - `overflowPoint(r: Resolved, k: number, ringPx: number): {at: Pt, ring: number}` — 설계서 §4.6 (방 중심 → 점 방향으로 `ring·ringPx` 비킴, 붙이기 전).
- Produces (`web/nav.mjs`):
  - `bakeGrid(r: Resolved, nav: {cellPx, inflatePx}): Grid`
  - `isOpen(g: Grid, p: Pt): boolean`, `snapOpen(g: Grid, p: Pt, radiusCells: number): Pt | null`(BFS, 칸 중심 반환), `lineOfSight(g: Grid, a: Pt, b: Pt): boolean`(슈퍼커버)
  - `findPath(g: Grid, from: Pt, to: Pt, opts: {snapRadiusCells}): Pt[] | null` — 8방향 A*(대각 √2, 옥타일, 모서리 스치기 금지) → 끌어당기기 다듬기 → 같은 방향 합치기. 결과 첫 점 = `from`, 끝 점 = `to`(막혔으면 붙인 점). 길 없으면 `null`.
  - `createNav(scenes: Map<string, Resolved>, nav: object): {grid(design): Grid, path(design, from: Pt, to: Pt): Pt[] | null, snap(design, p: Pt): Pt | null, stats(): {bakes: number, hits: number, misses: number}}` — 격자는 처음 쓸 때 굽고 재사용, 경로 LRU `pathCache` 개(키 `design|fromCell|toCell`).
- Produces (`web/depth.mjs`):
  - `objectNodes(r: Resolved, depth: object): ObjNode[]` — 설계서 §5.2 띠 자르기(오른쪽으로 `sliceOverlapPx` 겹침, `flipX` 는 화면 x 기준), `floor` = `zBase - 1`, `overhead` = `frontZ - 1`, 그 밖 `zBase + 2·round(depthY)`.
  - `charZ(footY: number, depth: object): number` = `zBase + 2·round(footY) + 1`
  - `splitWalk(points: Pt[], nodes: ObjNode[], depth: object): Piece[]` — 깊이선에서 자르기(x 범위 ±`pickMarginPx`), 조각 z = 조각 가운데 y 의 `charZ`, 길이 < 1px 조각 버림.
- Produces (`web/ambient.mjs`):
  - `rngFor(seed: string): () => number` — FNV-1a 해시 → mulberry32. 같은 seed 같은 수열.
  - `between(rng, [a, b]: Pt): number`
  - `tripRange(amb: object, who: {isLead: boolean, state: string, floorStatus: string}): Pt | null` — 팀장 + `floorStatus === 'waiting'` → `leadTourEveryMs`; 팀장 그 밖 → `null`; 서브에이전트 `enter`(도착 뒤) → `idle` 범위; `done` → `null`; 그 밖 `tripEveryMs[state]`.
  - `chooseSpot(rng, spots: Spot[], taken: Map<string, number>, chatChance: number): {spot: Spot, slot: 'at'|'pair'} | null` — `taken` = 지점 id → 머무는 인원.
  - `chooseFidget(rng, seated: boolean, amb: object): string`
  - `createFloorClock({amb, now: () => number, timers: {setTimeout, clearTimeout}, members: () => Member[], act: {fidget(m), trip(m), tripEnd(m)}, awayCount: () => number}): {start(): void, stop(): void, kick(): void}` — `Member = {id, nextFidgetAt, nextTripAt, returnAt}`(시각은 `act` 가 갱신). 깰 때마다 때가 된 것만 처리, `awayCount() >= maxAway` 면 나들이 건너뜀, 다음 깨기 = 가장 이른 예정 시각(최소 `tickMinMs`). 타이머는 항상 많아야 1개.
- Produces (서버):
  - `server/scenes.mjs`: `readPngSize(file: string): Pt | null`(IHDR 24바이트), `loadScenes(cfg): Record<string, {raw: object, url: string}>` — `designOrder` 마다 `<scenesDir>/<design>/scene.json` 이 있으면 형식 검사, 실패하면 `cfg.layouts[design]` 이 있으면 경고 한 줄 후 옛 배치, 없으면 `throw new Error('장면 검사 실패: <design>: <첫 오류>')`. 장면 폴더가 없으면 조용히 옛 배치. `url` = `/scenes/<design>/`.
  - `server/config.mjs`: `loadConfig` 끝에 `cfg.scenesDir` 를 env `AGENT_OFFICE_SCENES_DIR`(있으면) 또는 `config.json` 값의 절대경로로 바꾸고 `cfg.scenes = loadScenes(cfg)`.
  - `server/scene-check.mjs`: `checkScene(raw: object, opts: {atlasSize: Pt|null, cfg}): {errors: string[], warnings: string[], grid: Grid, resolved: Resolved}` — 설계서 §10.1 1~9단계(6 은 경고).
  - `server/office.mjs`: 장면이 있는 디자인의 `#allocSlot` → `SceneSlot`(`seats` → `idle` → `overflow`, 넘침 고리 `ring = floor(k / overflow.length)`, 붙이기는 화면 몫이므로 서버는 `overflowPoint` 의 붙이기 전 값). 장면 없는 디자인은 지금 코드 그대로 `LegacySlot`.
  - `server/http.mjs`: `uiConfig()` 에 `scenes`(raw + url), `sitSprites`(시작 때 `assets/sprites/*-sit.png` 에서 키 목록), `sitHeight`, `nav`, `depth` 추가. `layouts`·`ui`(→ `ui.ambient`) 는 그대로. 새 경로 `/scenes/<design>/<file>` = `cfg.scenesDir` 에서 지금 `sendStatic` 과 같은 경로 이탈 검사·그림 캐시 머리로 제공.
- Produces (CLI): `node scripts/check-scenes.mjs [--dir <scenesDir>] [--json <design>] [design…]` — 디자인마다 `OK <design>` / `FAIL <design>: <단계> <내용>` / `WARN <design>: …` 출력, 하나라도 FAIL 이면 exit 1. `--json` 은 Task 2 점검표용으로 `{resolved, grid: {cols, rows, cellPx, open: "<0/1 문자열>"}, nodes, warnings}` 를 stdout 에 낸다.
- Produces (화면, `web/app.js` — 모듈로 전환해 위 모듈을 import): `sceneOf(design)`, `walkPath(rec, frec, points: Pt[], onArrive?: () => void)`, `retarget(rec, frec, target)`, `setPose(rec, seated: boolean, animate: boolean)`, `startAmbient(frec)`, `stopAmbient(frec)`. URL `?debug=nav`(설계서 §8.2 겹침), `?debug=ambient`(생활 움직임 범위를 모두 0.1배 + `window.__ambient = { timers: () => <대기 중 층 타이머 수>, away: () => <나가 있는 캐릭터 수> }` — 캡처·측정용, 없으면 아무것도 만들지 않음).

- [ ] **Step 1: 합성 장면 고정물** — `tests/helpers/png.mjs`: `writePng(file, w, h, pixel: (x, y) => [r, g, b, a])`(`zlib.deflateSync` + `zlib.crc32`, 의존성 0). 이것으로 `tests/fixtures/scenes/studio2/` 에 1024×512 껍데기(단색 바닥 + 벽 띠), 아틀라스(단색 사각형: 책상 80×56, 의자 32×44, 큰 화분 44×70, 대각선 장 120×60, 팀장 탁자 96×56), `front.png`(앞 가장자리 띠) 를 만들고 PNG 는 커밋한다(만드는 코드는 `tests/helpers/make-fixture.mjs`, 한 번 실행). `scene.json`: 바닥 다각형 1개, 책상 4개(줄 간격 ≥ 90px) + 의자 4개, 화분 1개, 대각선 장 1개(footprint 앞선이 좌→우 30px 내려감), 팀장 탁자 + 의자, 보고함 줄 12점, 대기점 6, 넘침 8, `spots` 4개(그중 1개 `pair`), `seat.visit`·`sitAt`, `lead.sitAt`. 이 고정물은 `minSeats: 4` 로 검사한다.
- [ ] **Step 2: 실패하는 시험 작성** (모두 `node:test` + `assert/strict`)
  - `tests/scene.test.mjs`
    - `scene: fixture passes format check` — `checkSceneFormat(raw, {atlasSize: readPngSize(...objects.png), inflatePx: 12, minSeats: 4})` → `[]`
    - `scene: format errors name the field` — `seats` 가 없는 책상 id → `/^seats\[0\]/`; `rect` 가 아틀라스 밖 → `/rect/`; `spots` 3개 → `/spots/`; 중복 id → `/id/`; `door.at` 이 경계에서 5px → `/door/`
    - `scene: resolve flips footprint and seat for flipX` — 같은 종류 `flipX` 오브젝트의 footprint x 가 `at.x` 기준 좌우 반전, `seat.at` dx 부호 반전
    - `scene: sitAt defaults to at, visit/pair default to null`
    - `scene: tray queue lifts rows past n` — `trayPoint(r, 12, 28)` = `queue[0]` 에서 y − 28, `trayPoint(r, 25, 28)` = `queue[1]` 에서 y − 56
    - `scene: overflow ring pushes away from room centre` — `overflowPoint(r, 8, 28)` 이 `overflow[0].at` 보다 중심에서 28px 멀고 `ring === 1`
  - `tests/nav.test.mjs`
    - `nav: bake blocks inflate radius around a box` — 상자 경계에서 12px 안 칸 닫힘, 20px 밖 칸 열림, 바닥 다각형 경계 12px 안 닫힘
    - `nav: path goes around the box` — 상자 왼쪽 → 오른쪽 경로가 `null` 아님, 모든 이웃 점 쌍이 `lineOfSight` 참, 어떤 점도 닫힌 칸 아님
    - `nav: no diagonal corner cutting` — 닫힌 칸 두 개가 대각선으로 맞닿은 격자에서 그 사이를 지나는 경로 없음
    - `nav: smoothing merges collinear runs` — 빈 방 대각선 경로가 정확히 2점
    - `nav: blocked goal snaps to nearest open cell`, `nav: unreachable returns null`(닫힌 고리 안 목표)
    - `nav: cache hits on repeat and bakes once` — 같은 경로 두 번 → `stats()` 의 `bakes === 1`, `hits === 1`
    - `nav: fixture bakes under 50 ms` — 1024×512, `cellPx` 8 굽기 시간 측정
  - `tests/depth.test.mjs`
    - `depth: frontal desk is one node`, `depth: diagonal cabinet is sliced` — 노드 ≥ 2, 띠마다 `depthY` 단조 증가, 이웃 띠 `x + w - sliceOverlapPx === 다음 x`
    - `depth: flipped diagonal slices mirror depth` — `flipX` 면 띠 깊이 순서가 반대
    - `depth: seated character sits between chair and desk` — `charZ(sitAt.y) > 의자 노드 z` 이고 `< 책상 노드 z`; 선 자세 `at` 도 `< 책상 z`
    - `depth: character in front of the plant draws over it`, `depth: floor kind is below every character`, `depth: overhead is below the front overlay` (`overhead z === frontZ - 1 < frontZ`)
    - `depth: split cuts at a depth line and sets piece z` — 화분 깊이선을 위→아래로 가로지르는 선분이 2조각, 둘째 조각 z > 화분 z
    - `depth: pick margin catches edge grazing` — 화분 x 범위 바깥 20px 를 지나는 선분도 잘림, 30px 밖은 안 잘림
    - `depth: split drops sub-pixel pieces` — 0.5px 선분 → `[]`
  - `tests/ambient.test.mjs` (`mock.timers.enable({ apis: ['setTimeout', 'Date'] })`)
    - `ambient: same seed same rhythm, different seeds differ` — `rngFor('a1')` 두 번 첫 5개 같음, `'a2'` 와 다름
    - `ambient: trip range by state` — working 범위 최소 > thinking 범위 최대, 팀장은 `waiting` 일 때만 범위, `done` → `null`
    - `ambient: one timer per floor` — 멤버 20명 `createFloorClock` 시작 뒤 대기 타이머 1개(가짜 `timers` 로 센다), `stop()` 뒤 0개
    - `ambient: tick fires only due members and reschedules to the earliest` — 예정 시각 3개 중 지난 1개만 `act.fidget` 호출, 다음 타이머 지연 = 남은 최소(≥ `tickMinMs`)
    - `ambient: maxAway caps concurrent trips` — `awayCount()` 가 2 면 `act.trip` 호출 0
    - `ambient: spot taken by one offers pair only by chance` — `pair` 있는 지점 1명: rng < `chatChance` → `{slot: 'pair'}`, 아니면 다른 빈 지점; `pair` 없는 지점은 1명 차면 제외
    - `ambient: seated fidget never hops` — 1000번 `chooseFidget(rng, true, amb)` 에 `hop` 없음
    - `ambient: disabled does nothing` — `enabled: false` 면 `start()` 뒤 타이머 0
  - `tests/office-scene.test.mjs` (`loadConfig({ scenesDir: <fixture 폴더 절대경로>, designOrder: ['studio2'] })`)
    - `office-scene: seats, then idle, then overflow` — 4 + 6 + 8 + 2명 → `kind` 순서 `seat×4, idle×6, overflow×8, overflow×2`, 마지막 둘 `ring === 1`
    - `office-scene: seat slot carries approach, sit and face` — 첫 자리 `slot.sit` = 고정물 `seats[0].sitAt`, `approach`·`face`·`ref === 'desk-1'`
    - `office-scene: freed seat is reused` (지금 `office.test` 의 재사용 흐름과 같게)
    - `office-scene: design without scene keeps legacy slot shape` — `designOrder: ['lounge']` 이고 장면 폴더 없음 → `slot` 키가 정확히 `['i', 'x', 'y']`
    - `office-scene: broken scene with legacy layout falls back, without layout refuses start` — 형식 오류 고정물 사본(임시 폴더) + `layouts.studio2` 있음 → `cfg.scenes.studio2` 없음; `layouts: {}` 이면 `loadConfig` 가 `/장면 검사 실패/` 로 throw
  - `tests/scenes-shipped.test.mjs`
    - `scenes: fixture passes stages 1-9` — `checkScene` 의 `errors` `[]`
    - `scenes: every shipped scene passes` — `assets/scenes/*/scene.json` 마다(없으면 0개 — 통과) `errors` `[]`, `warnings` 는 `t.diagnostic` 으로만
    - `scenes: validator catches an unreachable seat` — 고정물 사본에 책상 하나를 막힌 상자로 감싸면 `errors` 에 `/도달|reach/` 와 그 책상 id
    - `scenes: validator catches a hidden seated head` — `sitAt` dy 를 책상 쪽으로 20px 옮기면 9단계 오류
    - `scenes: CLI exits 1 on failure` — `spawnSync(process.execPath, ['scripts/check-scenes.mjs', '--dir', <망가진 사본>])` 의 `status === 1`, stdout 에 `FAIL`
  - `tests/server.test.mjs` 에 더함: `/api/ui` 의 `scenes`(장면 있는 디자인만, `url` 이 `/scenes/<design>/`), `sitSprites` 가 배열, `sitHeight === 50`; `GET /scenes/studio2/shell.png` 200 + 그림 캐시 머리; `GET /scenes/..%2Fconfig.json` 404.
  - 정적 단언(어느 시험 파일이든): `web/*.js`·`web/*.mjs` 에 `requestAnimationFrame`·`getContext(`·`.animate(` 가 없다.
- [ ] **Step 3: 실패 확인** — Run: `cd C:/Users/gustj/agent-office && npm test` → Expected: 새 시험 FAIL(모듈 없음), 기존 시험 PASS.
- [ ] **Step 4: 순수 모듈 구현** — `web/scene.mjs` → `web/nav.mjs` → `web/depth.mjs` → `web/ambient.mjs`. DOM·`process` 를 쓰지 않는다(브라우저·Node 공용). 숫자는 인자로 받은 `nav`/`depth`/`amb` 블록에서만.
- [ ] **Step 5: 서버 구현** — `config.json` 블록 추가, `server/scenes.mjs`, `server/config.mjs`, `server/scene-check.mjs`, `scripts/check-scenes.mjs`, `server/office.mjs` 장면 분기, `server/http.mjs`. 서버 시작 때는 1단계(형식)만, 무거운 2~9단계는 검증기·시험만.
- [ ] **Step 6: 화면 구현** (`web/index.html` 은 `<script type="module" src="/web/app.js">`; `logrow.js` 는 그대로 일반 스크립트)
  - 그리기(설계서 §8.1): 장면 있는 층 = 껍데기 배경 + `objectNodes` 마다 `div.obj`(아틀라스 `background-position`, `image-rendering: pixelated`, `flipX` 는 `scaleX(-1)`) + `div.front`(z `frontZ`) + `.stage { contain: layout paint }`. 화이트보드·보고 배지·표지 좌표는 장면에서. 말풍선은 `.agt` 층(z 8000)으로 옮긴다(설계서 §5.4) — 옛 디자인도 같이.
  - 걷기(설계서 §6.4~6.6): `walkPath` = `splitWalk` 조각마다 트랜지션 하나, `transitionend` 에서 다음 조각, 조각 시작 때 z·뒤집기 설정, 세대 번호로 옛 이벤트 무시, 마지막 조각 끝에 `onArrive`. 자리에 붙은 점에서 떠날 때 `sitAt → at → approach` 직선 뒤 경로, 돌아올 때 `approach → at → sitAt`. 첫 그리기는 걷지 않고 놓는다(넘침 점이 있을 때만 격자 굽기). 길 없음 → 흐려졌다 나타나기 + `console.warn` 한 번.
  - 목표 바뀜: `retarget` 이 `getComputedStyle(el).transform` 을 한 번 읽어 지금 위치에서 새 경로. 탭 가림: 걷는 캐릭터·나가 있는 캐릭터를 모두 서버 목표로 바로 옮기고(앉을 자리면 앉힘) 이어 붙이기를 끊는다. 다시 보임: 남은 걷기를 되살리지 않는다.
  - 앉기(설계서 §17): `.spr` 안에 `img.stand` + `img.sit`(`sitSprites` 에 없는 키는 `img.sit` 을 만들지 않고 선 그림 유지). `.ag.sitting` 클래스로 보이기만 바꿈, 앉은 그림 높이 `sitHeight`. 자기 자리(`slot.kind === 'seat'` 또는 팀장 자리)에 도착해 있으면 앉음, 걷기·지점·보고함 줄·대기점·넘침·등장·퇴장은 섬. 바뀔 때 `.body` 에 `squash` 키프레임(약 200ms, `animationend` 에서 클래스 제거). 옛 디자인은 앉지 않는다.
  - 생활 움직임(설계서 §16): 장면 층마다 `createFloorClock` 하나(`startAmbient`/`stopAmbient` — 층 제거·`pause` 때 stop, `resume` 때 예정 시각을 새로 뽑아 start). 몸짓 = `.body`·`.flip` 에 `fid-<name>` 클래스, `animationend` 에서 제거(타이머 없음). 나들이 = 일어서기 → `chooseSpot`(팀장 투어는 자리 찬 책상 `visit` 점 `leadTourDesks` 곳 또는 화이트보드 지점) → `walkPath` → `returnAt` 까지 머묾(둘이면 서로 마주 봄) → 자리로 걸어와 앉기. 서버 움직임(`renderAgent` 의 목표 바뀜, `done`, 퇴장, 나가 있는 동안 `working`)이 오면 나들이를 끊고 `retarget`. 옛 디자인은 몸짓만.
  - `?debug=nav`: 층마다 SVG 하나를 한 번(열린/막힌 칸, 다각형, 깊이선·id, 자리 `at`●·`approach`○·`sitAt`◆, 지점·`visit`·`pair`, 문·줄·대기·넘침 번호, 캐릭터마다 마지막 경로, 순간이동 빨간 표시). 없으면 관련 노드 0개.
- [ ] **Step 7: 통과 확인** — Run: `cd C:/Users/gustj/agent-office && npm test` → Expected: 전부 PASS(기존 옛 배치 시험 포함). Run: `node scripts/check-scenes.mjs --dir tests/fixtures/scenes` → `OK studio2`, exit 0.
- [ ] **Step 8: 헤드리스 확인(합성 장면)** — `node scripts/demo-feed.mjs <가짜 홈>` + `AGENT_OFFICE_SCENES_DIR=C:/Users/gustj/agent-office/tests/fixtures/scenes AGENT_OFFICE_PORT=47869 AGENT_OFFICE_DATA_DIR=…\layers\data-47869\task1 AGENT_OFFICE_CLAUDE_HOME=<가짜 홈> AGENT_OFFICE_CODEX_HOME=<빈 폴더> node server/main.mjs`(백그라운드, PID 기록). `cdpcap.mjs` 사본을 `…\scratchpad\layers\task1\` 에 두고 포트를 47869 로 바꿔 캡처: (a) 기본 화면 — 합성 studio2 층(사각형 가구, 앉은 캐릭터는 선 그림 대체)과 옛 그림 층이 함께 보임, (b) `?debug=nav`, (c) `?debug=ambient` 로 20초 뒤 — 몸짓·나들이 중인 캐릭터, (d) 새 캐릭터가 걷는 도중(가구를 돌아감·책상 뒤 다리 가림). Read 로 보고 확인. 콘솔 오류 0(`Runtime.consoleAPICalled`/`Runtime.exceptionThrown` 수집). 띄운 PID 둘(서버·시연기)과 크롬을 PID 로 끈다.
- [ ] **Step 9: 커밋** — `git add` 위 Files 의 경로를 하나씩 → 메시지 `feat(scenes): layered scene engine, navmesh walking, seated pose and ambient life`.

---

### Task 2: 그림 도구 + studio2 방 (Codex 상한 6)

**Files:**
- Modify: `art/snap.py`(모드 `shell`·`sheet`·`obj` 추가 — 기존 `sprite`·`bg` 는 그대로)
- Create: `art/atlas.py`, `art/front.py`, `art/scene_sheet.py`, `art/scenes/studio2.json`, `assets/scenes/studio2/{scene.json,shell.png,front.png?,objects.png}`, `art/scenes-check/studio2.png`
- Modify: `README.md` 「그림 다시 뽑기」(설계서 §9 순서로 갱신 — 설계서 §1.3 「빌더가 첫 방을 넘길 때」)
- 읽기 전용: 그림 시험 산출물 `C:\Users\gustj\AppData\Local\Temp\claude\C--Project\6106276a-a6e5-4468-8650-198bebbf83af\scratchpad\layers-spike\`(`shell.png`·`sheet.png`·`proc.py` — 재사용 가능)

**Interfaces:**
- Consumes: Task 1 `scripts/check-scenes.mjs`(`--json` 포함), `scene.json` 형식(설계서 §4 + `spots`·`sitAt`·`visit`), `config.json` `nav`·`depth`·`sitHeight`.
- Produces (모든 방 Task 가 그대로 쓰는 도구, 모두 절대경로 인자, CWD 무관):
  - `python art/snap.py shell <in.png> <out.png> --size WxH` — LANCZOS 축소.
  - `python art/snap.py sheet <sheet.png> <outdir> [--rows N]` — 마젠타 키잉(R>150, B>150, G<R−70, G<B−70) → 1px 깎기 + 분홍 번짐 줄이기 → 빈 열(·행)로 나누기 → 투명 여백 잘라내기 → `<outdir>/piece-<k>.png`(왼→오, 위→아래 순) + `<outdir>/pieces.json`(`[{k, bbox}]`).
  - `python art/snap.py obj <piece.png> <out.png> (--width W | --height H) [--colors 24]` — 프리멀티플라이드 BOX 축소 → 알파 127 임계 → 물건마다 24색 양자화.
  - `python art/atlas.py <design>` — `art/scenes/<design>.json` 의 `kinds: {<kind>: {piece, width|height}}` 대로 `obj` 처리 후 `assets/scenes/<design>/objects.png` 로 묶고 `scene.json` 의 `kinds[*].rect` 만 다시 쓴다(다른 필드 보존).
  - `python art/front.py <design>` — 껍데기에서 `frontMask` 다각형으로 `front.png` 생성(없으면 파일 삭제 대신 생성 안 함).
  - `python art/scene_sheet.py <design>` — `node scripts/check-scenes.mjs --json <design>` 을 읽어 `art/scenes-check/<design>.png` 생성: (1) 합성 장면(깊이 순, 모든 자리에 앉은 그림 — `assets/sprites/default-sit.png` 없으면 선 그림을 `sitHeight` 로 줄여 대신, 팀장 자리·보고함 줄·지점에 선 그림), (2) 겹침판(footprint·격자·깊이선·점 번호·`frontMask`·지점), (3) 깊이 시험판(책상 앞·뒤, 큰 화분 앞·뒤, 대각선 물건 양 끝), (4) 옛 그림/새 장면 위아래 비교판. 헤드리스(창 없음).
  - `art/scenes/<design>.json` 모양: `{ "shellPrompt": "...", "sheets": [{"prompt": "...", "rows": 2, "pieces": ["desk", "chair", …]}], "kinds": {"desk": {"piece": "s1/piece-0", "width": 83}, …} }`

- [ ] **Step 1: 도구 작성 + 그림 시험 산출물로 확인** — 시험의 `sheet.png` 로 `snap.py sheet` → 조각 4개, `obj` 로 책상 폭 83 → 결과 알파가 0/255 만, 테두리에 (R>150, B>150, G<R−70) 픽셀 0개(작은 Pillow 확인 스크립트, 저장소 밖). 확인 숫자를 보고에 적는다.
- [ ] **Step 2: 껍데기(1회)** — 설계서 §9.2 본작업 프롬프트(러그 유지, 벽 책장 유지, 2:1), `-i assets/floors/studio2.png`. `snap.py shell --size 1024x512`. 바닥 윤곽 IoU ≥ 0.9(설계서 §9.5)를 Pillow 로 재서 기록. 시험 껍데기(러그·벽 책장이 지워짐)는 프롬프트가 두 번 실패할 때만 대신 쓴다.
- [ ] **Step 3: 스프라이트 시트(1~2회)** — 「two rows of 3-4 objects」, 같은 `-i`. 종류: 책상(「desk seen from the front, the back of the monitor faces the viewer, no chair」) · 의자(「office chair facing the viewer, its backrest behind a seated person」 — 앉은 캐릭터 뒤에 등받이가 보이게, 설계서 §17.4) · 팀장 탁자(보고함 포함) + 팀장 의자 · 소파 · 낮은 탁자 · 스탠드 조명 · 큰 화분 · 작은 화분 · 창 아래 낮은 장 · 화분 받침 장. 모니터 뒷면이 두 번 안 나오면 시험처럼 앞면 모니터 책상(설계서 §9.2).
- [ ] **Step 4: 장면 데이터** — 설계서 §10.3 순서: `walkable`(옛 그림 바닥 윤곽) · `blocked`(벽 책장 앞 띠) · 종류별 `anchor`·`footprint`·`seat {at, sitAt, approach, visit, face}` · 책상 12개(줄 간격 ≥ 90px) · 팀장(`sitAt` 포함) · 보고함 줄 ≥ 12 · 대기점 ≥ 6 · 넘침 ≥ 8 · `board`·`reports`·`sign` 새 껍데기에서 재기 · **`spots` 4~8개**(예: 창가 2곳 — 하나는 `pair`, 화이트보드, 소파 앞, 큰 화분, 창 아래 장) · `front.png` 필요 여부.
- [ ] **Step 5: 검증 → 점검표 → 고치기 반복** — Run: `node scripts/check-scenes.mjs studio2` → `OK studio2`(경고는 기록). Run: `python C:/Users/gustj/agent-office/art/scene_sheet.py studio2` → Read 로 확인: 키잉 테두리 없음, 크기가 64px 캐릭터와 맞음, 앉은 머리·어깨가 책상 위로 보임, 방이 옛 그림보다 밋밋하지 않음(비교판). 실패 항목만 다시 뽑기(남은 상한 안).
- [ ] **Step 6: 시험·화면** — Run: `npm test` → PASS(`scenes: every shipped scene passes` 가 studio2 를 검사). 헤드리스 캡처 1장(Task 1 Step 8 방식, 가짜 홈, 포트 47869, `AGENT_OFFICE_SCENES_DIR` 없이 실제 `assets/scenes`) — studio2 층이 새 장면으로 보임. 서버·크롬 PID 로 끔.
- [ ] **Step 7: 커밋** — `art/snap.py art/atlas.py art/front.py art/scene_sheet.py art/scenes/studio2.json art/scenes-check/studio2.png assets/scenes/studio2/* README.md` → `feat(art): scene art pipeline and layered studio2 room`. 보고: Codex 호출 수(≤ 6), IoU, 다시 뽑은 항목.

---

### Task 3: library 방 (Codex 상한 8)

**소유 파일(이것만 만들고 고친다):** `assets/scenes/library/*`, `art/scenes/library.json`, `art/scenes-check/library.png`. 원본·작업 폴더는 저장소 밖 `…\scratchpad\layers\library\`. 공유 코드(`web/`·`server/`·`scripts/`·`art/*.py`·`config.json`·`tests/`·`README.md`)는 **고치지 않는다** — 필요한 변경은 보고에 「공유 코드 요청: <파일> <내용> <이유>」 로 적는다. 서버를 띄우지 않는다.

**Interfaces:**
- Consumes: Task 2 도구(`art/snap.py shell|sheet|obj`, `art/atlas.py`, `art/front.py`, `art/scene_sheet.py`), Task 1 `scripts/check-scenes.mjs`, 설계서 §4.7 library 행.
- Produces: 검증을 통과한 `assets/scenes/library/scene.json`(+ `shell.png`, `objects.png`, `front.png`), `spots` 4~8개(예: 벽 책장 앞 2곳 — 하나는 `pair`, 지구본, 붉은 소파 앞, 안락의자 옆, 화이트보드).

- [ ] **Step 1: 껍데기(1회, 16:9)** — 설계서 §9.2 프롬프트, `-i assets/floors/library.png`, 「keep … bookshelves … ladders … drawn as part of the wall」, 러그 유지. `--size 1024x576`, IoU ≥ 0.9(못 미치면 1~2회 다시).
- [ ] **Step 2: 시트(1~2회)** — 초록 스탠드 달린 책상(모니터 뒷면), 의자(보는 사람 쪽), 붉은 소파, 1인 안락의자 + 작은 탁자, 지구본 스탠드, 문 옆 작은 장(조명), 앞 왼쪽 네모 의자, 팀장 탁자 + 의자, 큰·작은 화분, 스탠드 조명.
- [ ] **Step 3: 장면 데이터 + `front.png`(앞 가장자리 턱)** — Task 2 Step 4 와 같은 항목, `spots` 포함.
- [ ] **Step 4: 검증·점검표 반복** — `node scripts/check-scenes.mjs library` → `OK library`; `python C:/Users/gustj/agent-office/art/scene_sheet.py library` → Read 확인(Task 2 Step 5 기준). Run: `node --test tests/scenes-shipped.test.mjs` → PASS.
- [ ] **Step 5: 커밋** — 소유 파일만 → `feat(scenes): layered library room`. 보고: Codex 호출 수(≤ 8), IoU, 공유 코드 요청.

### Task 4: greenhouse 방 (Codex 상한 8)

**소유 파일:** `assets/scenes/greenhouse/*`, `art/scenes/greenhouse.json`, `art/scenes-check/greenhouse.png`. 작업 폴더 `…\scratchpad\layers\greenhouse\`. 공유 코드는 고치지 않고 보고(Task 3 과 같은 규칙). 서버를 띄우지 않는다.

**Interfaces:**
- Consumes: Task 3 과 같음, 설계서 §4.7 greenhouse 행(문틀은 껍데기, `frontMask` 에서 문틈 제외 — 검증기 7단계).
- Produces: 검증 통과 `assets/scenes/greenhouse/`, `spots` 4~8개(예: 유리 난간 앞 2곳 — 하나는 `pair`, 매달린 덩굴 아래 큰 화분, 둥근 탁자 옆, 벽 책장 앞, 물뿌리개 자리 `other`).

- [ ] **Step 1: 껍데기(1회)** — 「keep the door frame」 추가, `-i assets/floors/greenhouse.png`, 16:9, IoU ≥ 0.9.
- [ ] **Step 2: 시트(1~2회)** — 책상(모니터 뒷면), 의자, 둥근 탁자, 큰 화분 여러 종(3~4), 홀로 선 낮은 장, 소파, 팀장 탁자 + 의자, 스탠드 조명.
- [ ] **Step 3: 장면 데이터 + `front.png`(유리 난간 + 화단, 문틈 제외)**.
- [ ] **Step 4: 검증·점검표 반복** — `node scripts/check-scenes.mjs greenhouse` → OK; 점검표 Read 확인; `node --test tests/scenes-shipped.test.mjs` → PASS.
- [ ] **Step 5: 커밋** — 소유 파일만 → `feat(scenes): layered greenhouse room`. 보고: 호출 수(≤ 8), IoU, 공유 코드 요청.

### Task 5: lounge 방 (Codex 상한 8 — 대각선 먼저, 정면 후퇴안 미리 승인)

**소유 파일:** `assets/scenes/lounge/*`, `art/scenes/lounge.json`, `art/scenes-check/lounge.png`. 작업 폴더 `…\scratchpad\layers\lounge\`. 공유 코드는 고치지 않고 보고. 서버를 띄우지 않는다.

**Interfaces:**
- Consumes: Task 3 과 같음, 설계서 §4.7 lounge 행 · §5.2 띠 · §9.6.
- Produces: 검증 통과 `assets/scenes/lounge/`, `spots` 4~8개(예: 커피 머신 — `pair`, 바 테이블, 책장 앞, 창가, 화단 턱 옆), 대각선이 실패했으면 정면 배치 방.

- [ ] **Step 1: 대각선 시험 시트(1회)** — 대각선 아이소 책상·의자 + 커피 머신 장 + 바 테이블. 판정: 책상 앞선이 원본 lounge 책상과 같은 사선(±10°)이고 띠 분할 깊이 시험판(점검표 (3))이 양 끝에서 맞음.
- [ ] **Step 2a (대각선 통과)** — 껍데기 1회(`-i assets/floors/lounge.png`, 벽 책장 유지, 앞쪽 낮은 벽 = `front.png`) + 나머지 시트 1회(바 의자, 화단 턱, 펜던트 조명 `overhead`, 소파, 팀장 탁자 + 의자, 화분).
- [ ] **Step 2b (대각선 실패 — 미리 승인된 후퇴안, 묻지 않는다)** — 설계서 §18 2번 답대로 **벽돌·카페 분위기를 지킨 정면 책상 배치 방**을 새로 뽑는다: 껍데기 프롬프트는 「same brick walls, café mood, warm pendant lights, wood and terracotta tones; desks facing the viewer in straight rows」 로 `-i assets/floors/lounge.png` 편집(바닥 윤곽 IoU 는 이 경우 기준이 아니므로 `walkable` 을 새 껍데기에서 따라 그린다), 시트는 정면 책상·의자·커피 머신·바 테이블. 방식 B(옛 그림 오려 쓰기)는 쓰지 않는다. 보고에 「후퇴안 사용」 과 이유를 적는다.
- [ ] **Step 3: 장면 데이터** — 대각선이면 띠 분할이 자동(`depth: "auto"`)인지 `--json` 의 노드 수로 확인.
- [ ] **Step 4: 검증·점검표 반복** — `node scripts/check-scenes.mjs lounge` → OK; 점검표 Read 확인(대각선 양 끝 앞·뒤); `node --test tests/scenes-shipped.test.mjs` → PASS.
- [ ] **Step 5: 커밋** — 소유 파일만 → `feat(scenes): layered lounge room`. 보고: 호출 수(≤ 8), 대각선/후퇴안, 공유 코드 요청.

---

### Task 6: 앉은 자세 그림 (Codex 상한 10, 방 예산과 별도)

**소유 파일:** `assets/sprites/<key>-sit.png` 18장, `art/sit/prompts.json`, `art/sit/contact-sit.png`(점검표), 필요하면 `art/sit/*.py`(일회성이 아닌 것만). 작업 폴더 `…\scratchpad\layers\sit\`. `art/snap.py` 등 Task 2 도구는 **쓰기만 하고 고치지 않는다**. 선 자세 `assets/sprites/<key>.png` 는 고치지 않는다. 서버를 띄우지 않는다.

**Interfaces:**
- Consumes: `assets/sprites/<key>.png`(높이 64, 오른쪽을 보는 3/4), `art/prompts.json`(역할별 생김새 문장), `config.json` `sitHeight`(50), Task 2 `snap.py sheet`·`snap.py sprite`.
- Produces: 키 18개 = `lead scout worker-low worker worker-high architect architect-high explore plan code-critic security-reviewer performance-reviewer i18n-reviewer a11y-reviewer frontend backend app default` 마다 `assets/sprites/<key>-sit.png` — 높이 정확히 `sitHeight` px, 투명 배경(알파 0/255), 오른쪽을 보는 대각선 정면(3/4 앞), 의자 없이 앉은 자세(엉덩이 아래가 그림 바닥), 같은 사람·같은 점 화풍. Task 1 화면은 `/api/ui` 의 `sitSprites` 로 이 파일들을 자동으로 쓴다.

- [ ] **Step 1: 프롬프트** — `art/sit/prompts.json`: 공통 문장(「same characters as the attached reference sprites, same pixel-art style, palette, outline and pixel size; each one SITTING on an invisible chair, seen from a diagonal-front 3/4 view facing right, hands on an unseen desk/keyboard, no chair, no desk, no shadow; one row of N characters with wide gaps on flat solid #FF00FF magenta; do not use magenta inside the characters」) + 시트별 역할 목록(한 장 4~6명, 왼→오 순서 = 조각 순서) + `art/prompts.json` 의 생김새 문장.
- [ ] **Step 2: 시트 뽑기(4~5회)** — 시트마다 그 역할들의 선 자세 그림을 `-i` 로 하나씩(여러 `-i`). 호출 로그 기록.
- [ ] **Step 3: 후처리** — `python C:/Users/gustj/agent-office/art/snap.py sheet <sheet> <dir>` → 조각 수 = 역할 수 확인 → `python …/art/snap.py sprite <piece> C:/Users/gustj/agent-office/assets/sprites/<key>-sit.png --height 50 --colors 20`.
- [ ] **Step 4: 점검표** — `art/sit/contact-sit.png`: 역할마다 선 그림 | 앉은 그림 | 앉은 그림 뒤집기를 나란히 + 갈색 책상 띠(높이 56)를 앉은 그림 앞에 겹쳐 머리·어깨가 보이는지. Read 로 확인: 같은 사람(머리색·옷), 키잉 테두리 없음, 크기 일관. 실패 역할만 다시(남은 상한 안, 4~6명 시트 단위).
- [ ] **Step 5: 확인** — Pillow 로 18장 모두 높이 50·알파 0/255 를 확인하는 한 줄 검사(저장소 밖 스크립트) 결과를 보고에 적는다. Run: `npm test` → PASS(그림만 늘었으므로 기존 시험 영향 없음).
- [ ] **Step 6: 커밋** — `assets/sprites/*-sit.png`(18개를 이름으로 나열) `art/sit/prompts.json art/sit/contact-sit.png` → `feat(sprites): seated diagonal-front sprites for every role`. 보고: 호출 수(≤ 10), 다시 뽑은 역할.

---

### Task 7: 전환 마무리 · 문서 · 끝에서 끝 캡처 · CPU

**Files:**
- Modify: `config.json`(`layouts` 의 studio2·lounge·library·greenhouse 와 `ui.traySpreadPx`·`ui.trayRowPx`·`ui.overflowShifts`·`ui.overflowMarginPx` 삭제 — `layouts.studio` 는 사용자 결정 전까지 **그대로**), `server/scenes.mjs`·`server/office.mjs`·`server/http.mjs`·`web/app.js`·`web/logrow.js`(옛 배치 분기·`trayPos` 삭제; 장면 없는 디자인은 시작 거부), 옛 배치에 묶인 시험(`tests/config.test.mjs`, `tests/office.test.mjs`, `tests/office-fixes.test.mjs`, `tests/round2-web.test.mjs`, `tests/web-fixes.test.mjs`, `tests/server.test.mjs`)을 합성 고정물 기반 단언으로, `README.md`, 본 설계서 `docs/superpowers/specs/2026-10-28-agent-office-design.md`(§5.1·§5.2·§6.3·§12 에 「→ 보충 설계서 §n 으로 바뀜」 한 줄씩).
- Create: 없음(캡처는 저장소 밖 `…\scratchpad\layers\task7\`).

**Interfaces:**
- Consumes: Task 1~6 결과. 네 방 모두 `node scripts/check-scenes.mjs` 통과가 전제 — 하나라도 없으면 이 Task 는 옛 분기를 지우지 않고 멈춰 보고한다.
- Produces: `designOrder` 네 디자인이 모두 장면으로 그려짐, 옛 분기 코드 0, 시험 전부 통과, 캡처·CPU 숫자.

- [ ] **Step 1: 시험 옮기기** — 옛 단언을 같은 뜻의 장면 단언으로: `config: every design in designOrder has a scene`(`cfg.scenes[d]` 존재), 디자인 회전 시험은 합성 고정물 두 벌(`a`·`b` 이름 사본, 임시 폴더)로, F16a/b 는 「도착점끼리 24px」·「30명이 같은 좌표를 갖지 않음」 을 장면 slot 으로, `/api/ui` 는 `scenes`·`sitSprites` 단언. Run: `npm test` → 옛 분기 삭제 전 PASS.
- [ ] **Step 2: 옛 분기·숫자 삭제** — 위 Files. `loadScenes` 는 장면 없는 디자인이면 `throw`. Run: `npm test` → PASS. Run: `node scripts/check-scenes.mjs` → 네 방 `OK`.
- [ ] **Step 3: 끝에서 끝 캡처**(가짜 홈 + `scripts/demo-feed.mjs`, 포트 47869, 데이터 폴더 `…\layers\data-47869\task7`) — 각 장면을 Read 로 확인:
  - 네 방 각각 기본 화면(앉아서 일하는 캐릭터, 의자 등받이 뒤·책상 앞).
  - 걷는 도중 가림: 새 캐릭터가 책상 줄 사이·화분 앞을 지나는 순간(등장 직후 0.3~1.5초 사이 여러 장).
  - 붐비는 층: 시연기 세션 하나에 서브에이전트 20명 이상(가짜 홈에 meta 를 더 쓰는 작은 저장소 밖 스크립트) — 대기점·넘침 겹침 없음.
  - 보고함 줄: 여러 명 완료 직후 줄 서기.
  - `?debug=ambient`: 몸짓 중(`fid-*` 클래스가 붙은 순간 — `Runtime.evaluate` 로 클래스 확인 뒤 캡처)과 나들이 중(지점에 선 캐릭터, 둘이 마주 본 잡담 한 번 이상).
  - `?debug=nav` 한 방.
  - 콘솔 오류 0. 서버·시연기·크롬 PID 로 끔.
- [ ] **Step 4: CPU(실제 홈, 생활 움직임 켬)** — `AGENT_OFFICE_PORT=47869`, `AGENT_OFFICE_DATA_DIR=…\layers\data-47869\task7-cpu`, 홈 env 없이(실제 홈) 서버를 띄우고 헤드리스 크롬으로 연다(캡처 저장 안 함). CDP `Performance.getMetrics` 의 `TaskDuration` 차이 ÷ 측정 시간(120초) = 렌더러 주 스레드 점유율, 그리고 크롬 프로세스들의 CPU 시간 차이(`Get-Process -Id <PID들>` 의 `CPU`) ÷ 120초. 목표 평균 ≤ 2%(한 코어). 이어서 같은 크롬에 빈 탭을 하나 더 열어 `Page.bringToFront` 로 앞에 두고, 사무실 탭에서 `Runtime.evaluate('document.visibilityState')` 가 `hidden` 인지 확인한 뒤 60초 측정 → 0 근처. 가림 상태에서 `window.__ambient.timers() === 0`(이 측정만 `?debug=ambient` 로 연다). 가림을 만들지 못하면 「가림 측정 못 함」 으로 보고(통과로 적지 않는다). 숫자만 보고. PID 로 끔.
- [ ] **Step 5: 문서** — `README.md`: 층 그림 = 장면(`assets/scenes/<design>/`), `node scripts/check-scenes.mjs`, `?debug=nav`/`?debug=ambient`, 생활 움직임 끄기(`ui.ambient.enabled`), 앉은 그림(`<key>-sit.png`, 없으면 선 그림), 그림 다시 뽑기 순서. 본 설계서 가리킴 줄.
- [ ] **Step 6: 커밋** — 고친 경로를 하나씩 → `feat: switch all rooms to layered scenes`. 보고: 캡처 경로, CPU 숫자, 사용자 결정 대기 목록(옛 `assets/floors/*.png`·`layouts.studio`·`assets/floors/studio.png` 정리 여부).

---

## 검증 명령 모음

```
cd C:/Users/gustj/agent-office && npm test
cd C:/Users/gustj/agent-office && node scripts/check-scenes.mjs
cd C:/Users/gustj/agent-office && node scripts/check-scenes.mjs --dir tests/fixtures/scenes
python C:/Users/gustj/agent-office/art/scene_sheet.py <design>
```
