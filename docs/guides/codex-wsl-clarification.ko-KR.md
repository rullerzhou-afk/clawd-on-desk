# Codex + WSL: 경로, Node, 페어링

공식 자료 확인일: **2026-09-05**. Clawd 소스 기준: **`7383e8b80b8c0f05bd1dc53cb9e51fb96558a2ed`**. 영어 원문과 번역 동기화: **2026-09-05**. 이 날짜는 문서와 소스 확인일이며, 새로운 실제 기기 검증일이 아닙니다.

## 현재 지원 범위

OpenAI는 **WSL2**에서 Codex 실행을 지원합니다. Codex 0.115부터 WSL1은 지원하지 않습니다. 현재 Codex hooks는 기본으로 활성화되며, 표준 feature key는 `hooks`, `codex_hooks`는 폐기 예정인 별칭입니다. 정책으로 관리되지 않는 hooks는 Codex의 `/hooks` 절차를 통해 검토하고 신뢰해야 합니다. 공식 [WSL 가이드](https://learn.chatgpt.com/docs/windows/wsl)와 [hooks 가이드](https://learn.chatgpt.com/docs/hooks#turn-hooks-off)를 참고하세요.

Windows Clawd에는 사용자가 직접 실행하는 **WSL Scan → Pair** 흐름이 있습니다. 시작 시 모든 배포판에 몰래 설치하거나 별도의 Linux home에 있는 세션을 자동으로 폴링하지는 않습니다. Clawd는 Codex official hooks를 기본 통합 경로로 사용하고, 설정된 세션 소스의 JSONL 폴링을 fallback으로 유지합니다. Codex의 WSL 지원과 Clawd의 특정 home 접근 가능 여부는 서로 다른 문제입니다.

## 설정 및 실행 경로

Windows와 WSL은 기본적으로 별도의 Codex home을 사용합니다. WSL에서 `CODEX_HOME=/mnt/c/Users/<windows-user>/.codex`를 설정하면 Windows의 설정, 인증, 세션을 명시적으로 공유할 수 있습니다. OpenAI의 [home 공유 안내](https://learn.chatgpt.com/docs/windows/windows-app#share-config-auth-and-sessions-with-wsl)를 참고하세요. 디렉터리 공유만으로 Clawd hook을 실행할 Node가 결정되지는 않습니다.

| 설정 | Hook 실행 방식 | 네트워크 조건 |
| --- | --- | --- |
| 별도의 Linux home(WSL의 `~/.codex`), 해당 배포판에 통합 설치 | Linux Node | Linux에서 Windows Clawd의 루프백 서비스에 접근해야 합니다. WSL2에서는 보통 mirrored networking이 필요합니다. |
| Windows `CODEX_HOME` 공유, Windows가 생성한 POSIX interop launcher | WSL interop을 통해 Windows `node.exe` 실행 | Windows 루프백을 사용하므로 NAT에서도 이 전송 경로는 mirrored networking을 요구하지 않습니다. |
| Windows `CODEX_HOME` 공유, WSL/Linux 설치 프로그램이 소유한 기존 native POSIX launcher | Linux Node 사용. Windows 동기화는 해당 launcher를 보존합니다. | 여전히 Linux 네트워크 경로를 사용합니다. home 공유 자체가 Windows interop을 뜻하지는 않습니다. |

두 번째와 세 번째 행은 [codex-install-utils.js](../../hooks/codex-install-utils.js)의 서로 다른 소유권 분기이며, [codex-install.test.js](../../test/codex-install.test.js)에서 다룹니다. 네트워크를 진단하기 전에 등록된 launcher와 실제 Node 실행 대상을 확인하세요. `CODEX_HOME` 값만으로는 충분하지 않습니다. 이 소스/테스트 근거가 모든 공유 home 조합의 실제 기기 검증을 의미하지는 않습니다.

## 권장 절차: 별도 home + Pair

1. 대상 WSL2 배포판에 Codex와 Linux Node를 설치하고, 그 안에서 Codex를 실행해 자체 home을 만듭니다.
2. Windows Clawd를 시작합니다. **Settings → Agents → Connected → WSL Scan**에서 Codex의 해당 배포판을 찾아 **Pair**를 선택합니다. Windows에 Codex가 없으면 해당 행이 **Unavailable**에 있을 수 있습니다.
3. Clawd에서 Codex가 **활성화**되어 있는지 확인합니다. WSL 페어링은 Windows 로컬 통합 설치와 별개이며, 일반적으로 비활성화된 agent를 자동으로 켜지 않습니다.
4. 설치 결과와 연결 결과를 각각 확인하고, 필요한 경우 Codex에서 hooks를 검토하고 신뢰합니다. 새 세션을 시작해 Clawd에 나타나는지 확인하세요. 연결 탐지 실패나 알 수 없음은 연결 성공이 아닙니다.

전체 저장소를 이용한 수동 설치, 모든 hook 파일 복사, 네트워크 문제 해결은 [WSL 설치 가이드(영문)](setup-guide.md#wsl-windows-subsystem-for-linux)를 참고하세요. `hooks/*.js`에서 파일을 임의로 골라 복사하지 마세요.

Linux Node는 Windows Clawd의 `127.0.0.1:23333-23337` 서비스에 접근해야 합니다. WSL2 기본 NAT는 Windows 루프백 서비스를 Linux에 노출하지 않습니다. mirrored networking에는 Windows 11 22H2 이상이 필요합니다. [Microsoft 네트워크 가이드](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)를 참고하세요. WSL1의 루프백 공유는 일반적인 네트워크 특성이지, 최신 Codex의 WSL1 지원을 뜻하지 않습니다. 연결 탐지만으로 모든 agent의 권한 승인 경로가 검증되는 것도 아닙니다. 설치 가이드에는 설치 시 고정되는 Claude 권한 URL의 별도 제한이 설명되어 있습니다.

## 세션 탐지와 검증의 한계

Pair는 선택한 배포판에 hooks를 설치합니다. Windows의 JSONL fallback이 모든 `/home/<user>/.codex/sessions`를 폴링하게 만들지는 **않습니다**. `CODEX_HOME`을 공유하면 공유된 세션 파일에 접근할 수 있지만, 다른 Linux home을 마운트하거나 발견하지는 않습니다. 설정된 로컬 통합의 시작 시 동기화와 사용자가 직접 실행하는 WSL 페어링은 다른 작업입니다.

원격 Codex monitor는 관리되는 Remote SSH의 아키텍처 fallback이며, 일반 WSL 사용자를 위한 새로운 수동 scanner 절차가 아닙니다. secure Remote SSH에는 배포된 identity와 고정된 전송 대상이 필요합니다. 해당 레이아웃과 분리된 scanner 대신 [Settings → Remote SSH](guide-remote-ssh.md)를 사용하세요.

소스 근거: [WSL 배포](../../src/wsl-deploy.js), [agent 설정 작업](../../src/settings-actions-agents.js), [통합 동기화](../../src/integration-sync.js), [Codex JSONL monitor](../../agents/codex-log-monitor.js).

이번 개정은 공식 문서와 Clawd 소스 동작을 대조한 것으로, **새로운 Windows/WSL 실제 기기 검증 결과를 추가하지 않습니다**. 설치 프로그램 테스트, 연결 탐지, 실제 Codex 세션, 공유 home interop 검증은 서로 다른 근거입니다. 기기별 실행에서 플랫폼, 버전, 설정, 결과를 각각 기록해야 하며, 문서 상단의 날짜는 이를 대신하지 않습니다.
