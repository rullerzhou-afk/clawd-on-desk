# Open a local OpenCode serve session in a new terminal

On Windows, a local OpenCode v1 `serve` session can offer **Open in new terminal** on its Dashboard card. This is a separate action: **Jump to terminal** keeps its existing behavior.

Requirements:
- OpenCode v1 running with the explicit `serve` command and the current Clawd v1 plugin.
- A loopback HTTP(S) listener, an existing local session directory, and a root session.
- Windows Terminal and an OpenCode v1 native executable discoverable through PATH. The official v1 Windows npm installation is supported through its native `opencode-ai/bin/opencode.exe`; `.cmd` shims are never executed by this action.

The new terminal runs `opencode attach` with the session's raw ID and directory. Wildcard IPv4/IPv6 listeners are rewritten to loopback. The action does not send a prompt, make a permission decision, or switch to a new session if attach fails. A successful launch means Windows Terminal started, not that authentication or the attach connection completed successfully.

Ordinary TUI internal URLs, v2 daemon, MiMo, headless child sessions, WSL, Remote SSH, macOS and Linux do not offer this first implementation. LAN-bound non-loopback URLs and URL-embedded credentials are not supported. This action does not copy credentials; servers requiring authentication may still require the native client's normal authentication setup.

## Validation status for the first contribution

- Capability regressions were demonstrated failing before implementation, then passing.
- Focused plugin, target/launcher, routing/state, snapshot, trusted IPC and translation suite: 323 passed, zero failed.
- OpenCode 1.18.31 was installed in an isolated directory. Its native executable and `attach --session --dir` help were checked.
- Real isolated serve smoke on Windows: the actual host ran argv `["bun", "<embedded>.js", "serve", …]` with a wildcard IPv4 listener. The plugin reported `opencode_attach_url: http://127.0.0.1:4616/` (wildcard rewritten) on both SessionStart and the metadata-only title update, scoped to the session's directory. A real `opencode attach` process accepted the emitted session ID (stayed running) and rejected an unknown ID with `Session not found`.
- The exact generated PowerShell command was executed with a directory containing spaces, Chinese characters, `&`, `%`, `'` and `$`; `Set-Location` succeeded and `attach` started without shell re-parsing.
- The real Windows Terminal window launch itself, and clicking the Dashboard action against a live Clawd, were not exercised. The dashboard button was checked in a synthetic-session preview, not against a real session.
- Full-suite result is recorded in the PR; it is not claimed to be green on this Windows host.

