# 기능

[README로 돌아가기](../../README.ko-KR.md)

## 애니메이션과 상호작용

- **실시간 상태 인식** — 에이전트 hook과 로그 폴링이 자동으로 Clawd 애니메이션을 구동합니다.
- **12개 애니메이션 상태** — 대기, 생각, 타이핑, 건설, 헤드폰 그루브, 다중 서브에이전트 저글링, 오류, 기쁨, 알림, 청소, 운반, 수면
- **Codex Pet 가져오기** — `Settings…` → `Theme`에서 Codex Pet zip 패키지를 가져오면 Clawd가 atlas 애니메이션을 관리형 테마로 변환합니다.
- **시선 추적** — 대기 상태에서 Clawd가 커서를 따라보고, 몸 기울기와 그림자까지 반응합니다.
- **수면 시퀀스** — 60초 동안 대기 상태면 하품 → 졸기 → 쓰러짐 → 수면 상태로 전환되고, 마우스를 움직이면 깜짝 놀라며 깨어납니다.
- **클릭 반응** — 더블클릭하면 poke, 네 번 클릭하면 flail 애니메이션이 나옵니다.
- **아무 상태에서나 드래그 가능** — 언제든 Clawd를 잡아 옮길 수 있고, 놓으면 원래 상태로 돌아갑니다. Pointer Capture를 써서 빠르게 흔들어도 놓치지 않습니다.
- **미니 모드** — 화면 오른쪽 끝으로 드래그하거나 우클릭 후 `Mini Mode`를 선택하면 화면 가장자리에 숨어 있다가 마우스를 올리면 살짝 튀어나옵니다. 미니 알림/축하 애니메이션과 포물선 점프 전환도 지원합니다.

## 권한 말풍선

- **앱 내 권한 검토** — Claude Code, Codex CLI, CodeBuddy, opencode, MiMo Code가 도구 권한을 요청하면 터미널을 기다리는 대신 Clawd가 떠 있는 카드 형태의 말풍선을 띄웁니다.
- **Allow / Deny / 에이전트별 추가 동작** — 한 번의 클릭으로 승인/거절할 수 있고, 에이전트가 지원하면 권한 규칙이나 `Always` 같은 추가 동작도 표시됩니다.
- **전역 단축키** — 최신 권한 말풍선에 대해 `Ctrl+Shift+Y`로 허용, `Ctrl+Shift+N`으로 거부할 수 있습니다. 단, 말풍선이 보일 때만 등록됩니다.
- **스택 레이아웃** — 여러 권한 요청이 화면 오른쪽 아래에서 위로 차곡차곡 쌓입니다.
- **자동 닫힘** — 터미널에서 먼저 응답하면 말풍선은 자동으로 사라집니다.
- **에이전트별 끄기** — `Settings…` → `AI 코딩 도구`에서 해당 에이전트를 선택한 뒤 `Show pop-up bubbles`를 끄면, 권한 프롬프트가 그 에이전트 자체 터미널/TUI로 돌아갑니다.

## 원격 알림

- **Telegram / Feishu (Lark)** — 대화형 원격 승인: 권한 요청을 휴대폰으로 전달하고 데스크톱으로 돌아가지 않고 Allow / Deny 할 수 있습니다.
- **Slack** — **알림 전용**: Slack Incoming Webhook(또는 선택적 `xoxb-` Bot Token + channel id)을 통해 작업 **완료**, **오류**, **권한 요청**을 Block Kit 카드로 보냅니다. 이 버전에서는 Slack에서 Allow / Deny 할 수 없습니다. 권한 메시지는 알림일 뿐이며 결정은 데스크톱 앱에서 합니다. Telegram / Feishu와 같은 원격 승인 설정에서 구성하며 secret은 prefs 밖의 로컬 env 파일에 저장됩니다(macOS / Linux는 `0600`, Windows는 AppData ACL 사용). 미설정 또는 오프라인 상태에서는 안전하게 fallback합니다. 메시지에 session title, folder, host name이 포함될 수 있으므로 private channel을 권장합니다. 자세한 내용은 [Slack 알림 가이드](slack-notifications.md)를 참고하세요.

## 세션 인텔리전스

- **멀티 세션 추적** — 모든 에이전트 세션 상태를 모아 가장 우선순위가 높은 상태를 반영합니다.
- **서브에이전트 인식** — 서브에이전트가 1개면 헤드폰 그루브, 2개 이상이면 세 개 공 저글링 상태가 됩니다.
- **세션 Dashboard + HUD** — 우클릭 또는 트레이 메뉴의 `Open Dashboard`에서 라이브 세션, 최근 이벤트, 별칭을 확인하고 터미널로 이동할 수 있습니다. Clawd 근처의 작은 HUD도 현재 라이브 세션을 계속 보여줍니다.
- **터미널 포커스** — Dashboard/HUD 동작으로 특정 세션의 터미널 창으로 바로 이동할 수 있으며, notification/attention 상태에서는 관련 터미널이 자동으로 포커스됩니다.
- **프로세스 생존 감지** — 지원되는 에이전트 프로세스가 종료되거나 크래시하면 orphan 세션을 정리합니다.
- **시작 복구** — Clawd가 실행 중인 에이전트 세션 도중 재시작되어도 곧바로 잠들지 않고 깨어 있는 상태를 유지합니다.

## 모바일 컴패니언 (PWA)

- **휴대폰 실시간 미러** — `Settings…` → `Mobile / PWA`를 켜고 휴대폰에서 페어링 URL을 열면, Clawd Mobile 웹 앱이 에이전트 세션과 라이브 상태를 실시간으로 보여줍니다.
- **읽기 전용 설계** — LAN 브리지는 상태만 브로드캐스트하며, 휴대폰에서 PC를 조작할 수 없습니다. (원격 승인은 로드맵에 있습니다.)
- **LAN 전용 + 토큰 보호** — 페어링에는 토큰이 필요하고, 토큰은 유예 기간과 함께 자동으로 회전하며, 클릭 한 번으로 재생성하거나 초기화할 수 있습니다.
- **설치 가능** — PWA이므로 홈 화면에 추가하면 앱처럼 사용할 수 있습니다.
> 모바일 컴패니언 라인은 첫 프로토타입부터 토큰 회전까지 코어 컨트리뷰터 [@Bynlk](https://github.com/Bynlk)가 만들고 이끌고 있으며, 네이티브 Android 앱을 갖춘 자매 프로젝트 [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile)도 함께 유지보수하고 있습니다.

## 시스템

- **클릭 스루** — 투명한 부분은 아래 창으로 클릭이 통과되며, Clawd 몸체만 상호작용됩니다.
- **위치 기억** — 재시작 후에도 마지막 위치를 기억합니다. 미니 모드 위치도 포함됩니다.
- **단일 인스턴스 잠금** — Clawd 창이 중복 실행되지 않도록 막습니다.
- **자동 시작** — Claude Code의 SessionStart hook이 Clawd가 실행 중이 아니어도 자동으로 켤 수 있습니다.
- **방해 금지 모드** — 우클릭 또는 트레이 메뉴로 sleep 모드에 들어가면, 깰 때까지 모든 hook 이벤트가 음소거됩니다. DND 동안에는 권한 말풍선이 뜨지 않으며, Codex, opencode, MiMo Code는 기본 프롬프트로 돌아가고, Claude Code와 CodeBuddy는 자체 권한 확인 흐름으로 되돌아갑니다. Antigravity와 Pi는 상태만 동기화합니다.
- **효과음** — 작업 완료나 권한 요청 시 짧은 오디오 알림이 재생됩니다. 시스템 트레이 또는 설정에서 켜고 끌 수 있으며, 10초 쿨다운이 있고 DND에서는 자동 음소거됩니다.
- **시스템 트레이** — DND, 자동 시작, 업데이트 확인 등을 지원합니다.
- **i18n** — 영어, 중국어 간체, 중국어 번체, 한국어, 일본어, Português (Brasil), Español UI를 지원하며, 설정 → 일반에서 전환할 수 있습니다.
- **자동 업데이트** — GitHub release를 확인하고, Windows는 종료 시 NSIS 업데이트를 설치하며, macOS/Linux는 clone한 저장소에서 실행 중일 때 `git pull` + 재시작으로 업데이트합니다.

## 멀티 디스플레이

Clawd는 멀티 모니터 환경에 맞춰 동작합니다: 실행된 디스플레이에 비례한 크기로의 조정, 세로 모니터에서는 너무 작아 보이지 않도록 크기 보정, 디스플레이 간 드래그 이동을 지원합니다.

<p align="center"><sub>실제 멀티 모니터 동작은 <a href="../../assets/videos/clawd-multi-monitor-demo.mp4">이 저장소의 데모 영상</a>에서 확인할 수 있습니다.</sub></p>

## 커스텀 테마

Clawd는 커스텀 테마를 지원합니다. 기본 크랩 대신 원하는 캐릭터와 애니메이션으로 바꿀 수 있습니다. 이미 Codex Pet 패키지가 있다면 `Settings…` → `Theme` → `Import pet zip`에서 가져오세요. Clawd가 atlas를 관리형 테마로 자동 변환합니다.

**빠른 시작:**
1. 먼저 테마 스캐폴드를 생성합니다.
   ```bash
   node scripts/create-theme.js my-theme
   # 또는
   npm run create-theme -- my-theme
   ```
   인자를 주지 않아도 사용자 테마 디렉터리에 다음 사용 가능한 `my-theme` 스캐폴드가 생성됩니다.
2. `theme.json`을 수정하고 에셋(SVG, GIF, APNG, WebP, PNG, JPG, JPEG)을 만듭니다.
3. Clawd를 재시작하거나 `Settings…` → `Theme`에서 테마를 선택합니다.

**최소 동작 테마:** 1개의 SVG(idle + 시선 추적)와 7개의 GIF/APNG(thinking, working, error, happy, notification, sleeping, waking)만 있어도 됩니다. 시선 추적을 끄면 모든 상태를 아무 형식으로나 만들어도 됩니다.

배포 전에 테마를 검증하세요:
```bash
node scripts/validate-theme.js path/to/your-theme
```

`Settings…` → `Theme`의 테마 카드에는 `Tracked idle`, `Static theme`, `Mini`, `Direct sleep`, `No reactions` 같은 능력 배지가 표시되어 전환 전에 테마 특성을 확인할 수 있습니다.

전체 제작 가이드는 [docs/guides/guide-theme-creation.md](guide-theme-creation.md) 에 있습니다. 입문/중급/고급 경로, `theme.json` 필드 설명, 에셋 가이드라인까지 포함합니다.

> 서드파티 SVG 파일은 보안을 위해 자동으로 sanitize 됩니다.

## 로드맵

앞으로 탐색해 보고 싶은 것들:

- `codex.exe` PID에서 프로세스 트리를 역추적하는 Codex 터미널 포커스
- 앱 제거를 위한 hook uninstall 스크립트
- 모바일 컴패니언: 휴대폰에서의 원격 권한 승인 ([@Bynlk](https://github.com/Bynlk) 주도로 진행 중)
