<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk</h1>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">中文版</a>
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

Clawd는 당신의 데스크톱 위에서 살며, AI 코딩 에이전트가 지금 무엇을 하고 있는지 실시간으로 반응합니다. 긴 작업을 시작하고, 잠시 자리를 비운 뒤, 크랩이 완료 소식을 전하면 돌아오면 됩니다.

프롬프트를 입력하면 생각하고, 도구가 실행되면 타이핑하고, 서브에이전트가 생기면 저글링하고, 권한 요청이 오면 카드로 알려 주고, 작업이 끝나면 기뻐하고, 자리를 비우면 잠이 듭니다. 기본 테마로 **Clawd**(픽셀 크랩)와 **Calico**(삼색 고양이)가 포함되어 있으며, 커스텀 테마도 완전히 지원합니다.

> Windows 11, macOS, Ubuntu/Linux를 지원합니다. Node.js가 필요합니다. **Claude Code**, **Codex CLI**, **Copilot CLI**, **Gemini CLI**, **Cursor Agent**, **CodeBuddy**, **Kiro CLI**, **Kimi Code CLI (Kimi-CLI)**, **opencode**와 함께 동작합니다.

## 기능

### 멀티 에이전트 지원
- **Claude Code** — command hook + HTTP permission hook을 통한 완전 통합
- **Codex CLI** — `~/.codex/sessions/`의 JSONL 로그를 자동 폴링, 별도 설정 불필요
- **Copilot CLI** — `~/.copilot/hooks/hooks.json`의 command hook 지원
- **Gemini CLI** — `~/.gemini/settings.json`의 command hook 지원 (Clawd 시작 시 자동 등록되며, `npm run install:gemini-hooks`로 수동 설치 가능)
- **Cursor Agent** — `~/.cursor/hooks.json`의 [Cursor IDE hooks](https://cursor.com/docs/agent/hooks) 지원 (Clawd 시작 시 자동 등록되며, `npm run install:cursor-hooks`로 수동 설치 가능)
- **CodeBuddy** — Claude Code 호환 command hook + HTTP permission hook을 `~/.codebuddy/settings.json`에 등록합니다 (Clawd 시작 시 자동 등록되며, `node hooks/codebuddy-install.js`로 수동 설치 가능)
- **Kiro CLI** — `~/.kiro/agents/` 아래 커스텀 agent 설정에 command hook을 주입하고, 추가로 `clawd` agent를 자동 생성합니다. Clawd가 시작될 때마다 Kiro 기본 `kiro_default`에서 다시 동기화되므로 `kiro-cli --agent clawd` 또는 `/agent swap clawd`로 비교적 원본 동작을 유지한 채 hook을 켤 수 있습니다. 상태 hook은 macOS와 Windows에서 검증되었습니다.
- **Kimi Code CLI (Kimi-CLI)** — `~/.kimi/config.toml`의 command hook(`[[hooks]]` 항목)을 사용합니다. Clawd 시작 시 자동 등록되며, `npm run install:kimi-hooks`로 수동 설치할 수도 있습니다.
- **opencode** — `~/.config/opencode/opencode.json`의 [플러그인 연동](https://opencode.ai/docs/plugins) 지원 (Clawd 시작 시 자동 등록). 지연 없는 이벤트 스트리밍, 허용/항상 허용/거부 권한 말풍선, `task` 도구로 병렬 서브에이전트를 띄울 때의 building 애니메이션까지 포함합니다.
- **멀티 에이전트 공존** — 여러 에이전트를 동시에 실행할 수 있으며, Clawd는 각 세션을 독립적으로 추적합니다.

### 애니메이션과 상호작용
- **실시간 상태 인식** — 에이전트 hook과 로그 폴링이 자동으로 Clawd 애니메이션을 구동합니다.
- **12개 애니메이션 상태** — 대기, 생각, 타이핑, 건설, 저글링, 지휘, 오류, 기쁨, 알림, 청소, 운반, 수면
- **시선 추적** — 대기 상태에서 Clawd가 커서를 따라보고, 몸 기울기와 그림자까지 반응합니다.
- **수면 시퀀스** — 60초 동안 대기 상태면 하품 → 졸기 → 쓰러짐 → 수면 상태로 전환되고, 마우스를 움직이면 깜짝 놀라며 깨어납니다.
- **클릭 반응** — 더블클릭하면 poke, 네 번 클릭하면 flail 애니메이션이 나옵니다.
- **아무 상태에서나 드래그 가능** — 언제든 Clawd를 잡아 옮길 수 있고, 놓으면 원래 상태로 돌아갑니다. Pointer Capture를 써서 빠르게 흔들어도 놓치지 않습니다.
- **미니 모드** — 화면 오른쪽 끝으로 드래그하거나 우클릭 후 `Mini Mode`를 선택하면 화면 가장자리에 숨어 있다가 마우스를 올리면 살짝 튀어나옵니다. 미니 알림/축하 애니메이션과 포물선 점프 전환도 지원합니다.

### 권한 말풍선
- **앱 내 권한 검토** — Claude Code, CodeBuddy, opencode가 도구 권한을 요청하면 터미널을 기다리는 대신 Clawd가 떠 있는 카드 형태의 말풍선을 띄웁니다.
- **Allow / Deny / 에이전트별 추가 동작** — 한 번의 클릭으로 승인/거절할 수 있고, 에이전트가 지원하면 권한 규칙이나 `Always` 같은 추가 동작도 표시됩니다.
- **전역 단축키** — 최신 권한 말풍선에 대해 `Ctrl+Shift+Y`로 허용, `Ctrl+Shift+N`으로 거부할 수 있습니다. 단, 말풍선이 보일 때만 등록됩니다.
- **스택 레이아웃** — 여러 권한 요청이 화면 오른쪽 아래에서 위로 차곡차곡 쌓입니다.
- **자동 닫힘** — 터미널에서 먼저 응답하면 말풍선은 자동으로 사라집니다.
- **에이전트별 끄기** — `Settings…` → `Agents`에서 해당 에이전트를 선택한 뒤 `Show pop-up bubbles`를 끄면, 권한 프롬프트가 그 에이전트 자체 터미널/TUI로 돌아갑니다.

### 세션 인텔리전스
- **멀티 세션 추적** — 모든 에이전트 세션 상태를 모아 가장 우선순위가 높은 상태를 반영합니다.
- **서브에이전트 인식** — 서브에이전트가 1개면 저글링, 2개 이상이면 지휘 상태가 됩니다.
- **세션 Dashboard + HUD** — 우클릭 또는 트레이 메뉴의 `Open Dashboard`에서 라이브 세션, 최근 이벤트, 별칭을 확인하고 터미널로 이동할 수 있습니다. Clawd 근처의 작은 HUD도 현재 라이브 세션을 계속 보여줍니다.
- **터미널 포커스** — Dashboard/HUD 동작으로 특정 세션의 터미널 창으로 바로 이동할 수 있으며, notification/attention 상태에서는 관련 터미널이 자동으로 포커스됩니다.
- **프로세스 생존 감지** — 지원되는 에이전트 프로세스가 종료되거나 크래시하면 orphan 세션을 정리합니다.
- **시작 복구** — Clawd가 실행 중인 에이전트 세션 도중 재시작되어도 곧바로 잠들지 않고 깨어 있는 상태를 유지합니다.

### 시스템
- **클릭 스루** — 투명한 부분은 아래 창으로 클릭이 통과되며, Clawd 몸체만 상호작용됩니다.
- **위치 기억** — 재시작 후에도 마지막 위치를 기억합니다. 미니 모드 위치도 포함됩니다.
- **단일 인스턴스 잠금** — Clawd 창이 중복 실행되지 않도록 막습니다.
- **자동 시작** — Claude Code의 SessionStart hook이 Clawd가 실행 중이 아니어도 자동으로 켤 수 있습니다.
- **방해 금지 모드** — 우클릭 또는 트레이 메뉴로 sleep 모드에 들어가면, 깰 때까지 모든 hook 이벤트가 음소거됩니다. DND 동안에는 권한 말풍선이 뜨지 않으며, opencode는 기본 TUI 프롬프트로 돌아가고 Claude Code와 CodeBuddy는 자체 권한 확인 흐름으로 되돌아갑니다.
- **효과음** — 작업 완료나 권한 요청 시 짧은 오디오 알림이 재생됩니다. 우클릭 메뉴에서 켜고 끌 수 있으며, 10초 쿨다운이 있고 DND에서는 자동 음소거됩니다.
- **시스템 트레이** — 크기 조절(S/M/L), DND, 언어 전환, 자동 시작, 업데이트 확인 등을 지원합니다.
- **i18n** — 영어, 중국어, 한국어 UI를 지원하며, 우클릭 메뉴나 트레이에서 전환할 수 있습니다.
- **자동 업데이트** — GitHub release를 확인하고, Windows는 종료 시 NSIS 업데이트를 설치하며, macOS/Linux는 clone한 저장소에서 실행 중일 때 `git pull` + 재시작으로 업데이트합니다.

## 애니메이션

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>대기</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>생각</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>타이핑</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>건설</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>저글링</sub></td>
    <td align="center"><img src="assets/gif/clawd-conducting.gif" width="100"><br><sub>지휘</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/clawd-error.gif" width="100"><br><sub>오류</sub></td>
    <td align="center"><img src="assets/gif/clawd-happy.gif" width="100"><br><sub>기쁨</sub></td>
    <td align="center"><img src="assets/gif/clawd-notification.gif" width="100"><br><sub>알림</sub></td>
    <td align="center"><img src="assets/gif/clawd-sweeping.gif" width="100"><br><sub>청소</sub></td>
    <td align="center"><img src="assets/gif/clawd-carrying.gif" width="100"><br><sub>운반</sub></td>
    <td align="center"><img src="assets/gif/clawd-sleeping.gif" width="100"><br><sub>수면</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>Calico 대기</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>Calico 생각</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>Calico 타이핑</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>Calico 건설</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>Calico 저글링</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>Calico 지휘</sub></td>
  </tr>
</table>

전체 이벤트-상태 매핑, 미니 모드, 클릭 반응은 **[docs/guides/state-mapping.md](docs/guides/state-mapping.md)** 에서 확인할 수 있습니다.

## 멀티 디스플레이

Clawd는 멀티 모니터 환경에 맞춰 동작합니다: 실행된 디스플레이에 비례한 크기 조정, 세로 모니터에서는 너무 작아 보이지 않도록 크기 보정, 디스플레이 간 드래그 이동을 지원합니다.

<p align="center">
  <video src="https://github.com/user-attachments/assets/dc5041a8-a952-4f97-b78d-c7f82b863b23" width="480" controls muted playsinline></video>
</p>
<p align="center"><sub>데모 영상은 <a href="https://github.com/rullerzhou-afk/clawd-on-desk/pull/103">PR #103</a> 와 함께 기여되었습니다.</sub></p>

## 빠른 시작

```bash
# 저장소 복제
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 의존성 설치
npm install

# Clawd 시작 (실행 시 Claude Code hooks 자동 등록)
npm start
```

**Claude Code**와 **Codex CLI**는 바로 사용할 수 있습니다. **Gemini CLI**, **Cursor Agent**, **CodeBuddy**, **Kiro CLI**, **Kimi Code CLI (Kimi-CLI)**, **opencode**는 설치되어 있다면 Clawd 시작 시 자동 등록되며, **Copilot CLI**만 1회 hook 설정이 필요합니다. 원격 SSH, WSL, 플랫폼별 참고 사항(macOS / Linux)까지 포함된 가이드는 **[docs/guides/setup-guide.md](docs/guides/setup-guide.md)** 를 참고하세요.

`Codex + WSL`의 공식 현황, Clawd의 현재 구현 경계, 그리고 왜 이 부분이 오해되기 쉬운지는 **[docs/guides/codex-wsl-clarification.ko-KR.md](docs/guides/codex-wsl-clarification.ko-KR.md)** 를 참고하세요.

## 알려진 제한 사항

일부 에이전트는 기능 차이가 있습니다. 예를 들어 권한 말풍선이 없거나, 폴링 지연이 있거나, 터미널 포커스를 지원하지 않을 수 있습니다. 전체 표는 **[docs/guides/known-limitations.md](docs/guides/known-limitations.md)** 에 있습니다.

## 커스텀 테마

Clawd는 커스텀 테마를 지원합니다. 기본 크랩 대신 원하는 캐릭터와 애니메이션으로 바꿀 수 있습니다.

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

전체 제작 가이드는 [docs/guides/guide-theme-creation.md](docs/guides/guide-theme-creation.md) 에 있습니다. 입문/중급/고급 경로, `theme.json` 필드 설명, 에셋 가이드라인까지 포함합니다.

> 서드파티 SVG 파일은 보안을 위해 자동으로 sanitize 됩니다.

### 로드맵

앞으로 탐색해 보고 싶은 것들:

- `codex.exe` PID에서 프로세스 트리를 역추적하는 Codex 터미널 포커스
- Claude Code처럼 Copilot CLI hooks 자동 등록
- 테마 레지스트리와 앱 내 다운로드
- 앱 제거를 위한 hook uninstall 스크립트

## 기여하기

Clawd on Desk는 커뮤니티 주도 프로젝트입니다. 버그 리포트, 기능 아이디어, PR 모두 환영합니다. [issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues)를 열어 논의하거나 바로 PR을 보내 주세요.

### 기여자

Clawd를 더 좋게 만드는 데 도움을 준 모든 분들께 감사합니다:

<table>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /><br /><sub>PixelCookie-zyf</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /><br /><sub>yujiachen-y</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /><br /><sub>AooooooZzzz</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /><br /><sub>purefkh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /><br /><sub>Tobeabellwether</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /><br /><sub>Jasonhonghh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /><br /><sub>crashchen</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /><br /><sub>hongbigtou</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /><br /><sub>InTimmyDate</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /><br /><sub>NeizhiTouhu</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /><br /><sub>xu3stones-cmd</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /><br /><sub>androidZzT</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /><br /><sub>Ye-0413</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /><br /><sub>WanfengzzZ</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /><br /><sub>TaoXieSZ</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /><br /><sub>ssly</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /><br /><sub>stickycandy</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /><br /><sub>Rladmsrl</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /><br /><sub>YOIMIYA66</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /><br /><sub>Kevin7Qi</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /><br /><sub>sefuzhou770801-hub</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /><br /><sub>Tonic-Jin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /><br /><sub>seoki180</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /><br /><sub>sophie-haynes</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /><br /><sub>PeterShanxin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /><br /><sub>CHIANGANGSTER</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /><br /><sub>JaeHyeon-KAIST</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /><br /><sub>hhhzxyhhh</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /><br /><sub>TVpoet</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /><br /><sub>zeus6768</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /><br /><sub>anhtrinh919</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /><br /><sub>tomaioo</sub></a></td>
  </tr>
</table>

## 감사의 말

- Clawd 픽셀 아트 참고: [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- [LINUX DO](https://linux.do/) 커뮤니티에서 공유됨

## 라이선스

소스 코드는 [GNU Affero General Public License v3.0](LICENSE)(AGPL-3.0)로 배포됩니다.

**아트워크(`assets/`)는 AGPL-3.0 라이선스 대상이 아닙니다.** 각 저작권자의 권리가 유지되며 자세한 내용은 [assets/LICENSE](assets/LICENSE)를 참고하세요.

- **Clawd** 캐릭터는 [Anthropic](https://www.anthropic.com)의 자산입니다. 이 프로젝트는 비공식 팬 프로젝트이며 Anthropic과 제휴하거나 승인받지 않았습니다.
- **Calico cat (삼색 고양이)** 아트워크는 鹿鹿([@rullerzhou-afk](https://github.com/rullerzhou-afk))의 작품이며, 모든 권리를 보유합니다.
- **서드파티 기여물**: 저작권은 각 아티스트에게 유지됩니다.
