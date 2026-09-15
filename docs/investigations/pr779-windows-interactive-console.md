# PR #779: Windows interactive SSH console

Validated on 2026-09-11. Based on main `3d6a052d`, with Von's original
`998e26e4` commit retained as `95b89636` on the maintainer branch.

## Problem and chosen behavior

[PR #779](https://github.com/rullerzhou-afk/clawd-on-desk/pull/779) removed the
`wt.exe -- ssh ...` launch. A successful `wt.exe` spawn does not establish
that its requested terminal session opened. The July 30 native review also
found a blank, non-interactive terminal after the PR's direct `cmd.exe`
launch when Windows Terminal was the default host with globally elevated
profiles.

Both Authenticate and Open Terminal now open a separate Windows Console Host
window, at the caller's privilege level. This intentionally changes these
Windows actions from Terminal tabs to classic console windows.

- A hidden, detached `cmd /c start` launches `conhost.exe cmd.exe /k` with
  fresh console handles. The IPC result waits for the starter to complete.
- Explicit conhost avoids default-terminal delegation. Microsoft documents
  this per-launch behavior in the
  [default-terminal design](https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md).
- The SSH command is quoted with the existing `quoteForCmd`, placed in a
  child-only environment variable, and expanded once by the inner cmd.
  This avoids conhost parsing and rebuilding the caret-escaped command.
- `/d` disables cmd AutoRun, `/v:off` disables delayed expansion, and `/k`
  leaves SSH errors and the local prompt visible. `exit` closes the window.

Directly spawning conhost with Node's ignored stdio did not run the probe in
the native experiment. `START` supplied working console input/output instead.
No Terminal-settings detection, registry mutation, elevation request, native
dependency, or additional SSH connection is part of the implementation.

## Automated regression checks

```powershell
node --test test/remote-ssh-ipc.test.js test/remote-ssh-quote.test.js test/remote-ssh-runtime.test.js test/remote-ssh-transport.test.js test/remote-ssh-transport-coordinator.test.js test/remote-ssh-profile.test.js
```

Result: **375 passed, 1 existing POSIX-only test skipped, 0 failed**.

Checks include both interactive entry points, launcher completion/failures,
`BatchMode=no` with no `-T` or imposed connection timeout, real cmd argument
round trips through the deferred environment expansion, and serialized
transport admission. Argument cases cover spaces, Chinese, empty strings,
parentheses, quotes, trailing backslashes, shell metacharacters, and literal
percent/delayed-expansion variables with an injection-shaped environment value.

## Native Windows loopback checks

Environment: Windows 11 x64 build 26200, Electron 41.10.4, Node 24.12.0,
Windows Terminal Stable 1.24.11911.0, Windows OpenSSH client.

An isolated Electron main process invoked the registered production IPC
handlers. A loopback-only ssh2 fixture supplied synthetic credentials and
host keys. Fixture-only SSH options used a separate known-hosts file and
disabled the user's SSH config/agent. An auxiliary process inside each
test-owned console read its screen buffer and supplied console input. No
renderer clicks or user SSH hosts were involved.

| Scenario | Console Host default | Terminal default, `profiles.defaults.elevate=true` |
| --- | --- | --- |
| Authenticate: host-key confirmation, password, remote input | Passed | Passed |
| Open Terminal: host-key confirmation, encrypted-key passphrase, remote input | Passed | Passed |
| DNS failure remains visible; local prompt accepts an echo command | Passed | Passed |
| Visible console, stdin/stdout TTY, unelevated token | Passed | Passed |
| Close each test console using its own `exit` command | Passed | Passed |

The default-host registry values were checked against the installed Terminal
manifest. Temporary Terminal settings were restored byte-for-byte (SHA-256
verified), and both delegation registry values were restored. No processes
were terminated for test cleanup.

A separate final run exited the Electron launcher immediately after the
Authenticate result. The SSH console survived, displayed the subsequent DNS
error, accepted a local echo command, and exited normally.

Local evidence under `D:\animation\.tmp\pr779-native\`:

- `smoke.cjs`, `matrix.cjs`: isolated native harness and guarded configuration restoration.
- `matrix-1789097898710.json`: final Terminal-default/elevated-profile run and restoration checks.
- `summary-1789097911980.json`: the three final native scenarios.
- `dns-error-1789097923820.json`: terminal survival after Electron exit.
- `focused-tests.tap`: automated regression results.

## Full-app Raspberry Pi GUI follow-up

On the same date, the complete source app at `a5f43c9090b7e67b57797dd3eace141828132293`
was launched with isolated user data and a temporary copy of the configured
Raspberry Pi profile. Both actions were clicked in Settings → Remote SSH.
The target was an actual Raspberry Pi running Debian, `aarch64`, kernel
`6.18.34+rpt-rpi-2712`; the remote shell reported `/dev/pts/0`.

This run used the Console Host default and the existing SSH key, with an
explicit temporary SSH config and a copied known-hosts file. It did not
exercise a new password/host-key prompt or repeat the Terminal-default,
globally elevated profile configuration; those cases belong to the loopback
matrix above. The isolated app did not deploy hooks or change remote config.

| Full-app scenario | Observed result |
| --- | --- |
| Click Authenticate | Visible console logged into the Pi; `hostname`, `uname -m`, `tty`, and a marker command returned expected output. |
| Keyboard events in Authenticate console | System Unicode key events executed `echo PR779_KEYBOARD_OK`; the user confirmed seeing both command-result markers. |
| Click Open Terminal | A second visible console logged into the Pi; ordinary virtual-key events executed `echo pr779vk` and returned `pr779vk`. |
| Quit the test Clawd through its menu | Both SSH sessions remained alive; a subsequent `echo pr779afterquit` returned successfully in the second session. |
| Exit SSH in each console | Both returned to their local cmd prompt, which accepted and echoed `pr779local`. |
| Exit each local cmd | Both test consoles closed normally; the user's original Clawd remained running. |

The user initially reported being unable to type. At their request, a helper
then supplied input only to verified test-owned consoles. Initial commands,
the post-quit command, and cleanup used console input records; keyboard
checks used system key events and required the test console to be foreground.
At this stage the user confirmed visible output, but had not separately
confirmed physical keyboard typing. The manual recheck below subsequently
closed that validation gap. The initial symptom's cause remains unknown;
the observed results do not establish every keyboard/focus configuration.

Console ownership was checked against the exact temporary SSH config before
every input, and the expected remote or local prompt was checked before
commands were sent. Cleanup used session-local `exit` only, with no process
termination. The test app, both SSH/cmd pairs, and their console hosts were
absent in the final process check; the original Clawd was still present.

Additional local evidence under `D:\animation\.tmp\pr779-native\`:

- `pi-gui-1789098447821/launch.json`: tested commit, isolated app, and target.
- `pi-console-inspect-1789098850097.json`: Authenticate results and keyboard marker.
- `pi-console-inspect-1789099071708.json`: Open Terminal virtual-key command result.
- `pi-console-inspect-1789099667768.json`: successful remote command after app exit.
- `pi-console-inspect-1789099697885.json` and `pi-console-inspect-1789099717886.json`: both local prompt checks and final `exit` inputs.
- `pi-gui-1789098447821/cleanup-check.json`: final process inventory.

### Manual keyboard recheck

A fresh isolated full-app run at `581ffe8a911796fd57834694735664cba19c7461`
(documentation-only changes since the tested implementation) opened the Pi
through Settings → Remote SSH → Open Terminal. The console was already at
the remote shell prompt before handoff. The user was asked to click its title
bar, use English input, physically type `echo pr779`, and press Enter.
After the user reported completing this, read-only console inspection showed:

```text
rullerpi@raspberrypi:~$ echo pr779
pr779
rullerpi@raspberrypi:~$
```

The assistant supplied no input between opening the console and this
inspection. This confirms manual keyboard input, command execution, and
output in the full-app Pi session; the previously reported typing symptom
did not recur in this check. Both remote and local shells were then closed
using their own `exit`, and the test Clawd was quit through its menu. The
original Clawd remained running.

Local evidence: `pi-gui-1789099999140/launch.json`,
`pi-console-inspect-1789100064427.json` (prompt before handoff),
`pi-console-inspect-1789100130802.json` (manual command and result), and
`pi-gui-1789099999140/cleanup-check.json` under the same evidence directory.

These checks cover full source-app GUI clicks and interaction with an actual
Pi in addition to the loopback launch matrix. Installed-package launch,
Windows 10/ARM64 clients, and a fresh Codespaces transport matrix were not
exercised; the existing transport gate remains covered by the regression suite.
