# 에이전트 사무실

이 PC 에서 돌아가는 Claude Code · Codex 세션을 픽셀 사무실의 층으로 보여 주는 로컬 화면입니다.
세션 하나가 한 층, 서브에이전트·워크플로는 그 층의 캐릭터입니다. 서버는 `127.0.0.1` 에서만 열리고, 외부 패키지 설치는 필요 없습니다(Node.js 만).

## 켜기

- `agent-office.cmd` 를 더블클릭합니다. 서버가 없으면 최소화된 서버 창을 띄우고 브라우저를 엽니다. 이미 떠 있으면 브라우저 화면만 엽니다(서버 중복 실행 없음).
- 바탕화면 바로가기 만들기(한 번만):
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1`
  다른 폴더에 만들려면 `-Destination <폴더>` 를 붙입니다.

## 작은 창(PiP)

화면 오른쪽 아래 「작은 창」 단추를 누르면 층만 보이는 항상 위 작은 창이 뜹니다(크롬·엣지 116 이상만, 다른 브라우저에서는 단추가 안 보입니다). 크기는 `config.json` 의 `ui.pip`. 원래 탭을 닫으면 작은 창도 닫히고, 작은 창을 닫거나 단추를 다시 누르면 층이 탭으로 돌아옵니다.

## 끄기

화면의 「끄기」 단추를 누르거나, 최소화된 서버 창(제목 「에이전트 사무실 서버」)을 닫습니다.

## 숨기기

세션 목록에서 숨기면 그 세션의 층, 캐릭터, 목록 줄, 기록이 모두 사라집니다. 다시 보이기 단추는 없습니다.

- Claude: 그 세션을 다시 실행할 때(껐다 켜기, 이어서 실행)까지 안 보입니다.
- Codex: 쉬고 있던 세션이 다시 활동을 시작할 때까지 안 보입니다.
- 사무실을 껐다 켜도 숨김은 유지됩니다(`data\` 폴더에 저장).

## 이름 바꾸기

세션 목록의 ✎ 단추 또는 층 표지 더블클릭 → Enter 저장, Esc 취소. 비우면 자동 이름(세션 제목, 없으면 작업 폴더 이름)으로 돌아갑니다. 최대 30자이고, 사무실을 다시 켜도 유지됩니다.

## 캐릭터 이름 · 역할 바꾸기

`config.json` 의 `roles` 표에서 `name`(이름)과 `role`(역할)을 고치고 사무실을 다시 켭니다.

- 팀장(층마다 한 명)은 `leads` 표의 5명(유나·하나·수아·윤슬·다인)이 돌아가며 맡습니다. 지금 화면에 있는 층에서 가장 적게 쓰인 팀장이 새 층에 배정되고, 숨기거나 떠난 층의 팀장은 곧 풀립니다. 그림은 `assets\sprites\<key>.png`, 앉은 그림은 `<key>-sit.png` 입니다.
- `roles` 표에 없는 종류의 서브에이전트(예: `general-purpose`)는 그 층에서 가장 적게 쓰인 캐릭터를 받고, 역할 칸에는 종류 이름(없으면 `지원`)이 표시됩니다.

## 그림 다시 뽑기

Codex 의 imagegen 으로 그림을 만든 뒤 `art\snap.py` 로 격자에 맞춥니다. 프롬프트는 `art\prompts.json`(캐릭터), `art\scenes\<방>.json`(방), `art\sit\prompts.json`(앉은 자세)에 있습니다. 결과는 `assets\` 아래에 둡니다. 옛 한 장짜리 배경 `art\floors\*.png` 는 방을 다시 뽑을 때 쓰는 참고 그림이고 화면에는 쓰지 않습니다.

### 방(장면) 그림 — 껍데기 + 오브젝트

층 그림은 모두 장면입니다. `designOrder` 의 방마다 `assets\scenes\<방>\scene.json` 이 있어야 하고, 없거나 형식이 틀리면 서버가 시작하지 않습니다. 방(`assets\scenes\<방>\`)은 한 장짜리 배경이 아니라 빈 방 껍데기(`shell.png`), 가구 모음(`objects.png`), 필요하면 앞 덮개(`front.png`), 배치 데이터(`scene.json`)로 이루어집니다. 프롬프트와 목표 크기는 방마다 `art\scenes\<방>.json` 에 있습니다. 원본(Codex 결과)은 저장소 밖 작업 폴더에 두고 `--work` 또는 환경변수 `AGENT_OFFICE_ART_WORK` 로 알려 줍니다.

1. 껍데기: `codex exec` 로 `art\floors\<방>.png` 를 편집해 가구만 지운 방을 받고(러그·벽에 붙은 책장은 유지), `python art\snap.py shell <입력> assets\scenes\<방>\shell.png --size 1024x512` 로 줄입니다.
2. 가구 시트: 마젠타(`#FF00FF`) 배경에 물건 6개 안팎을 두 줄로 뽑고, `python art\snap.py sheet <시트.png> <작업폴더>\s1 --rows 2` 로 조각(`piece-<번호>.png`)을 나눕니다.
3. 아틀라스: `art\scenes\<방>.json` 의 `kinds` 에 조각과 목표 폭·높이를 적고 `python art\atlas.py <방>` 을 실행하면 `objects.png` 가 만들어지고 `scene.json` 의 `kinds[*].rect` 만 갱신됩니다.
4. 앞 덮개가 필요하면 `scene.json` 의 `frontMask` 를 적고 `python art\front.py <방>` 을 실행합니다.
5. 배치(`anchor`·`footprint`·자리·`spots`)는 `scene.json` 에 직접 적고 `node scripts\check-scenes.mjs <방>` 로 검사한 뒤, `python art\scene_sheet.py <방>` 으로 점검표(`art\scenes-check\<방>.png`)를 만들어 눈으로 확인합니다.
6. 모든 방 검사: `node scripts\check-scenes.mjs`(방 이름을 주면 그 방만). `npm test` 도 출하된 장면을 같은 검사기로 돌립니다.

### 앉은 그림

일할 때 자리에 앉은 캐릭터는 `assets\sprites\<키>-sit.png`(높이 `sitHeight` = 50px, 오른쪽을 보는 대각선 정면)를 씁니다. 파일이 없는 키는 서 있는 그림 그대로 자리에 서서 일합니다. 다시 뽑으려면 `art\sit\prompts.json` 의 시트별 문장으로 Codex 에서 시트를 받고, `python art\snap.py sheet <시트.png> <작업폴더>` 로 조각을 나눈 뒤 `python art\snap.py sprite <조각> assets\sprites\<키>-sit.png --height 50 --colors 20` 로 줄입니다. `art\sit\contact-sit.png` 가 점검표입니다.

## 걷기 · 생활 움직임

캐릭터는 가구를 돌아 걷고(내비 격자 + 최단 경로), 책상·화분 앞뒤에 맞게 그려집니다. 일하는 캐릭터는 가끔 몸짓을 하고, 한가한 캐릭터는 방 안의 지점(창가·커피·책장·소파 등)에 다녀옵니다. 서버가 정한 자리·상태가 언제나 이깁니다.

- 화면 주소 끝에 `?debug=nav` 를 붙이면 층마다 걷기 격자, 오브젝트 윤곽, 모든 자리·지점, 캐릭터가 마지막에 걸은 경로를 겹쳐 그립니다.
- `?debug=ambient` 는 생활 움직임을 10배 빠르게 하고 `window.__ambient.timers()`(층별 타이머 수)를 노출합니다.
- 끄기: `config.json` 의 `ui.ambient.enabled` 를 `false` 로 바꿉니다. 주기·머무는 시간·동시에 나가 있는 최대 인원(`maxAway`)도 같은 블록에서 조절합니다. 걷기·깊이 숫자는 `nav`·`depth` 블록입니다.

## 개인정보

화면과 기록에는 도구 이름, Bash 설명과 명령의 첫 단어, 파일 이름(경로 전체 아님), 에이전트 설명, 세션 제목, 작업 폴더 이름, 시각만 나갑니다. 사용자 메시지, 답변, thinking, 도구 결과, 파일 내용, 명령 전체, 검색어는 읽어도 내보내지 않습니다. 서버는 `127.0.0.1` 에서만 받고, 다른 웹페이지에서 오는 요청은 거절합니다.

## 자원

목표: 한 코어 기준 평균 2% 이하(실측 값이 아니라 목표입니다). 브라우저 탭이 가려지면 애니메이션과 수신이 멈추고, 연결된 화면이 하나도 없으면 서버도 확인 주기를 늘립니다(`config.json` 의 `idlePollMs`). 화면을 다시 열면 바로 확인합니다.

## 알려진 한계

- 이틀 넘게 계속 돌아가는 Codex 세션은 기록 앞부분을 읽지 못해 정보가 일부 비어 있을 수 있습니다.
- 숨긴 Claude 세션이 끝난 뒤 다시 실행되기 전에 서버가 꺼져 있었다면, 다시 실행한 뒤 그 세션의 기록이 최대 `log.backfillMinutes`(30분) 분량 보일 수 있습니다.
- 사무실 서버를 재시작하면, 숨겨 둔 Codex 세션 중 마지막 기록 앞에 긴 침묵이 있던 것이 다시 나타날 수 있습니다.

## 문제 해결

- 「포트 47800 을 다른 프로그램이 쓰고 있습니다」 → `config.json` 의 `port` 를 다른 번호로 바꿉니다(환경변수 `AGENT_OFFICE_PORT` 로 임시 지정도 가능).
- 서버가 멈춘 채 47800 포트를 잡고 있으면: `netstat -ano | findstr 47800` 으로 PID 를 찾고, 그 PID 하나만 종료합니다(프로그램 이름으로 한꺼번에 끄지 마세요).
- 「Node.js 가 필요합니다」 → https://nodejs.org 에서 설치합니다.
- 숨김·이름 기록 폴더(`data\`)는 환경변수 `AGENT_OFFICE_DATA_DIR` 로 다른 곳으로 옮길 수 있습니다. 시험·데모 서버는 꼭 지정해서 실제 기록과 섞이지 않게 하세요.
- 디버깅용: 환경변수 `AGENT_OFFICE_NO_BROWSER=1` 이면 런처가 브라우저를 열지 않습니다.
- 시험: `npm test`
