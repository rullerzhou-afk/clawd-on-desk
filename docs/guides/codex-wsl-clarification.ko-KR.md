# Codex + WSL 현황 정리

최종 확인 날짜: 2026-04-26

이 문서는 자주 뒤섞여서 전달되는 세 가지 질문을 분리해서 설명합니다.

1. OpenAI 공식 문서 기준으로 Codex가 WSL에서 동작하는가.
2. Codex hooks와 `.codex` 상태가 Windows와 WSL 사이에서 자동으로 공유되는가.
3. Clawd가 현재 WSL의 별도 Linux home 안에 있는 Codex 세션을 자동으로 감지할 수 있는가.

이 세 질문의 답은 서로 다릅니다. 대부분의 혼선은 OpenAI의 공식 지원 범위와 Clawd의 현재 구현 범위를 같은 이야기로 받아들이면서 생깁니다.

## TL;DR

- OpenAI는 Codex의 WSL2 실행을 공식적으로 안내합니다.
- OpenAI의 현재 Hooks 문서는 Codex hooks를 `[features].codex_hooks = true` feature flag로 활성화한다고 설명합니다.
- Clawd는 이제 Codex official hooks를 기본 경로로 사용하고, `~/.codex/sessions` JSONL 폴링을 fallback으로 유지합니다.
- Windows native Codex hooks는 2026-04-26에 로컬에서 검증되었습니다. Windows hook command는 PowerShell의 `&` 호출 연산자를 사용해야 합니다.
- Clawd가 Windows에서 실행되고 Codex가 기본 Linux home을 쓰는 WSL 안에서 실행되면, Clawd는 `/home/<user>/.codex/sessions`를 자동으로 읽지 못합니다.
- 따라서 "Codex가 WSL을 지원하지 않는다"는 표현은 부정확합니다. 더 정확한 표현은 "Codex는 공식적으로 WSL2를 지원하지만, Windows에서 실행되는 Clawd는 WSL의 별도 Linux `~/.codex`를 자동으로 수정하거나 폴링하지 않는다. WSL Codex 세션을 보내려면 WSL 안에서 remote mode hooks를 설치하거나 `CODEX_HOME`을 공유해야 한다"입니다.

## 1. OpenAI 공식 현황

### Codex는 공식적으로 WSL2를 지원합니다

OpenAI의 Codex Windows 문서에는 WSL 전용 섹션이 있으며, WSL2 안에서 Codex CLI를 설치하고 실행하는 절차가 직접 나와 있습니다.

- <https://developers.openai.com/codex/windows>

이 문서에는 다음이 포함됩니다.

- `Windows Subsystem for Linux` 섹션
- `Use Codex CLI with WSL` 섹션
- `wsl --install`, WSL 내부 Node.js 설치, `npm i -g @openai/codex`, `codex` 실행 절차

즉, 제품 차원에서 보면 "Codex는 WSL2를 지원한다"가 맞습니다.

### WSL1은 더 이상 지원되지 않습니다

OpenAI 문서는 다음도 함께 명시합니다.

- WSL1 지원은 Codex `0.114`까지
- Codex `0.115`부터 Linux sandbox가 `bubblewrap`로 바뀌면서 WSL1은 더 이상 지원되지 않음

참고:

- <https://developers.openai.com/codex/windows>
- <https://developers.openai.com/codex/app/windows>

따라서 지금의 정확한 표현은 "WSL2 지원"입니다.

### Codex hooks는 feature flag 뒤에 있습니다

OpenAI의 Hooks 문서는 현재 hooks를 다음 feature flag로 활성화한다고 설명합니다.

```toml
[features]
codex_hooks = true
```

같은 문서는 `hooks.json`, 공통 입력 필드, `PermissionRequest`, `tool_input.description`, 그리고 현재 지원하지 않는 `PermissionRequest` decision 필드가 fail-closed 되는 동작도 설명합니다.

참고:

- <https://developers.openai.com/codex/hooks>

Clawd의 Codex installer는 `~/.codex/hooks.json`를 쓰고, 사용자가 `codex_hooks = false`를 명시하지 않은 경우 이 feature flag를 켭니다. 사용자가 false로 꺼 둔 경우에는 경고만 출력하고 강제로 바꾸지 않습니다.

### WSL과 Windows는 기본적으로 `.codex`를 공유하지 않습니다

OpenAI의 Windows app 문서는 다음도 설명합니다.

- Windows app은 `%USERPROFILE%\.codex`를 사용
- WSL 안의 Codex CLI는 기본적으로 Linux `~/.codex`를 사용
- 그래서 configuration, cached auth, session history가 자동으로 공유되지 않음

OpenAI가 안내하는 공유 방법 중 하나는 다음과 같습니다.

```bash
export CODEX_HOME=/mnt/c/Users/<windows-user>/.codex
```

참고:

- <https://developers.openai.com/codex/app/windows>

즉, 별도 설정이 없다면 WSL 안의 Codex는 Linux home 아래에 로그와 세션 데이터를 쓴다는 뜻입니다.

## 2. Clawd의 현재 구현

### Clawd는 official hooks를 먼저 쓰고 JSONL 폴링을 fallback으로 유지합니다

이 저장소에서 Codex 연동 설정은 [`agents/codex.js`](../../agents/codex.js)에 있습니다.

- `eventSource: "hook+log-poll"`
- `sessionDir: "~/.codex/sessions"`

Official hook 구현은 [`hooks/codex-hook.js`](../../hooks/codex-hook.js)에 있고, fallback monitor는 [`agents/codex-log-monitor.js`](../../agents/codex-log-monitor.js)에 있습니다.

런타임에서는:

- official hooks가 SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop을 처리합니다.
- PermissionRequest는 기본적으로 native 모드입니다. Clawd는 이벤트를 관찰하고 no-decision을 반환해 Codex AutoReview/native prompt가 계속 처리하게 합니다. 사용자가 intercept 모드를 명시적으로 선택한 경우에만 실제 Clawd Allow/Deny bubble을 띄웁니다.
- JSONL 폴링은 hooks가 꺼진 세션과 web search, context compaction, turn aborted처럼 official hooks가 다루지 않는 이벤트를 위해 계속 켜 둡니다.

Fallback monitor에서 `~`는 현재 실행 중인 프로세스의 `os.homedir()`로 확장됩니다. 즉:

- Clawd가 Windows에서 실행되면 `C:\Users\<user>\.codex\sessions`
- Clawd가 Linux에서 실행되면 `/home/<user>/.codex/sessions`

를 읽습니다.

그래서 Windows 호스트에서 실행 중인 Clawd는 WSL Linux home 안의 `/home/<user>/.codex/sessions`를 자동으로 읽지 못합니다.

### 현재 Clawd에는 WSL home에 자동 설치하는 경로가 없습니다

현재 메인 프로세스는 호스트 OS의 home에 Codex official hooks를 동기화하고 fallback monitor를 시작합니다. 사용자 설정 가능한 WSL sessionDir도 없고, 기본적으로 `\\wsl$\...`를 스캔하지 않으며, Windows 앱이 `/home/<user>/.codex/hooks.json`를 자동으로 수정하지도 않습니다.

현재 상태를 정리하면:

- `Windows native Codex + Windows Clawd`: official hooks로 기본 동작하며 JSONL fallback도 유지
- `WSL2 Codex + Windows Clawd + Linux 기본 home`: 기본값으로는 동작하지 않음. WSL 안에서 remote mode hooks를 설치하거나 remote fallback monitor를 실행해야 함
- `WSL2 Codex + Windows .codex 공유`: OpenAI의 `CODEX_HOME` 문서를 기준으로 보면 설정과 session 상태를 공유할 수 있음

마지막 항목은 OpenAI의 공유 방식과 Clawd의 현재 hook 및 fallback 폴링 동작을 조합한 추론입니다.

### 원격/우회 패턴은 이미 있지만 WSL 기본 지원과는 다릅니다

이 저장소에는 [`scripts/remote-deploy.sh`](../../scripts/remote-deploy.sh)가 있으며, Codex hook 파일을 복사하고 원격에서 `node ~/.claude/hooks/codex-install.js --remote`를 실행해 official hooks가 SSH reverse tunnel을 통해 `CLAWD_REMOTE=1`로 로컬 Clawd에 POST하게 합니다.

또한 [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js)도 유지합니다. 반대편 환경에서 `~/.codex/sessions`를 폴링한 뒤 상태를 Windows의 Clawd로 POST할 수 있으며, official hooks가 불가능하거나 꺼진 경우의 fallback입니다.

현재 이 스크립트는 문서상 원격 SSH 시나리오에 맞춰 설명되어 있습니다. 즉, "로그는 다른 쪽에 있고 상태만 돌려보낸다"는 패턴은 이미 있지만, 이것이 곧 "Clawd가 WSL 안의 Codex를 기본값으로 자동 감지한다"는 뜻은 아닙니다.

## 3. 왜 현재 문서가 오해를 만들기 쉬운가

### README의 표현이 실제 경계보다 넓게 읽힐 수 있습니다

현재 README는 다음처럼 보일 수 있습니다.

- `Claude Code와 Codex CLI는 바로 사용할 수 있다`
- setup guide가 `원격 SSH, WSL, 플랫폼별 참고 사항`을 다룬다

참고:

- [`README.ko-KR.md`](../../README.ko-KR.md)

이 표현은 많은 조합에서는 맞지만, 아래 두 경우를 구분해 주지 않습니다.

- Windows 네이티브에서 실행되는 Codex
- 별도 Linux home을 유지하는 WSL2 안에서 실행되는 Codex

### setup guide의 WSL 본문은 주로 Claude Code를 설명합니다

현재 WSL 본문은 [`docs/guides/setup-guide.md`](./setup-guide.md)에 있고, 핵심 내용은 다음입니다.

- WSL 안에서 Claude Code 실행
- WSL로 hooks 파일 복사
- WSL 안에서 Claude hooks 등록

반면 Codex는 주로 원격 SSH 섹션에서 `codex-remote-monitor.js` 형태로 등장합니다.

즉:

- WSL이 아예 문서에 없는 것은 아닙니다.
- 하지만 `Codex + WSL`의 지원 경계는 따로 분명하게 써 두지 않았습니다.

## 4. 현재 가장 정확한 결론

2026-04-26 기준으로 가장 정확한 결론은 다음과 같습니다.

1. OpenAI는 Codex의 WSL2 실행을 공식적으로 지원합니다.
2. OpenAI는 Codex hooks를 `codex_hooks` feature flag로 문서화하고 있습니다.
3. Clawd는 Codex official hooks를 기본 경로로 사용하고 JSONL 폴링을 fallback으로 유지합니다.
4. Clawd는 현재 호스트 머신의 `.codex` home에 hooks를 동기화하고 fallback logs를 폴링합니다.
5. 따라서 Codex가 WSL2 안에서 Linux 기본 `~/.codex`를 사용하면 Windows Clawd는 그 세션을 기본값으로 자동 감지하지 못합니다.
6. 현재 문서의 문제는 "WSL이 전혀 안 적혀 있다"가 아니라 "`Codex + WSL` 경계를 충분히 명시하지 않았다"에 가깝습니다.

## 5. 외부 설명용 권장 문구

이슈나 사용자 답변에 넣을 한 문단이 필요하다면 아래 표현이 가장 안전합니다.

> OpenAI 공식 문서 기준으로 Codex는 WSL2를 지원합니다. Clawd는 Codex official hooks로 통합하며 JSONL 폴링을 fallback으로 유지합니다. Clawd가 Windows에서 실행되고 Codex가 Linux 기본 home을 쓰는 WSL 안에서 실행되면, Clawd는 그 WSL `~/.codex`를 자동으로 수정하거나 폴링하지 않습니다. WSL 안에서 remote mode hooks를 설치하거나, `CODEX_HOME`을 공유하거나, remote fallback monitor를 실행해야 합니다. 현재 문제는 "Codex가 WSL을 지원하지 않는다"기보다 "Clawd의 연동 경계와 문서 설명이 충분히 명확하지 않았다"에 가깝습니다.

## 6. 현재 가능한 경로

지금 목표가 "Windows의 Clawd가 WSL 안의 Codex를 감지하게 만들기"라면 현실적인 경로는 세 가지입니다.

1. OpenAI 문서대로 WSL의 `CODEX_HOME`을 Windows `%USERPROFILE%\.codex`로 맞춘다.
2. WSL 안에서 `node hooks/codex-install.js --remote`를 실행해 Codex official hooks가 WSL localhost forwarding을 통해 Windows Clawd로 POST하게 한다.
3. 이 저장소의 [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js) 패턴을 활용해 WSL 쪽에서 상태를 Windows로 밀어 넣는다.
4. Clawd 자체를 확장해서 `\\wsl$\...` sessionDir를 직접 지원하게 만든다.

이 셋은 의미가 다릅니다.

- 1번은 OpenAI가 공식 문서에서 제시한 공유 방식
- 2번은 Codex hooks가 사용 가능할 때 Clawd에서 지연이 가장 낮은 경로
- 3번은 official hooks가 불가능하거나 꺼진 경우의 fallback
- 4번은 Clawd의 새 기능 추가

## 참고 자료

OpenAI 공식 문서:

- Codex Windows: <https://developers.openai.com/codex/windows>
- Codex Hooks: <https://developers.openai.com/codex/hooks>
- Codex app on Windows: <https://developers.openai.com/codex/app/windows>

저장소 내부 관련 파일:

- [`README.ko-KR.md`](../../README.ko-KR.md)
- [`docs/guides/setup-guide.md`](./setup-guide.md)
- [`agents/codex.js`](../../agents/codex.js)
- [`agents/codex-log-monitor.js`](../../agents/codex-log-monitor.js)
- [`hooks/codex-hook.js`](../../hooks/codex-hook.js)
- [`hooks/codex-install.js`](../../hooks/codex-install.js)
- [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js)
