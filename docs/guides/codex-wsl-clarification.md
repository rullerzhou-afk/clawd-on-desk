# Codex + WSL Clarification

Last verified: April 26, 2026

This note separates three questions that are easy to conflate:

1. Whether OpenAI officially supports running Codex in WSL.
2. Whether Codex hooks and `.codex` state are shared between Windows and WSL.
3. Whether Clawd can currently auto-detect Codex sessions that live inside WSL's separate Linux home.

Those answers are not the same. Most confusion comes from mixing the official Codex product support story with Clawd's current integration boundaries.

## TL;DR

- OpenAI officially supports running Codex in WSL2.
- OpenAI's current Hooks documentation describes Codex hooks as feature-flagged via `[features].codex_hooks = true`.
- Clawd now uses Codex official hooks as the primary integration and keeps `~/.codex/sessions` JSONL polling as fallback.
- Windows native Codex hooks were verified locally on April 26, 2026; hook commands on Windows must use PowerShell's `&` call operator.
- When Clawd runs on Windows while Codex runs inside WSL with the default Linux home directory, Clawd does not automatically see `/home/<user>/.codex/sessions`.
- So "Codex does not support WSL" is inaccurate. The more accurate statement is: "Codex officially supports WSL2, but Windows Clawd does not automatically modify or poll WSL's separate Linux `~/.codex`; install hooks in WSL remote mode or share `CODEX_HOME` when you want WSL Codex sessions to report back."

## 1. OpenAI's current official position

### Codex officially supports WSL2

OpenAI's Windows documentation for Codex includes a dedicated WSL section and explicit instructions for installing and running Codex CLI inside WSL2:

- <https://developers.openai.com/codex/windows>

That page includes:

- a `Windows Subsystem for Linux` section
- a `Use Codex CLI with WSL` section
- explicit steps for `wsl --install`, installing Node.js inside WSL, `npm i -g @openai/codex`, and then running `codex`

At the product level, this means "Codex supports WSL2" is true.

### WSL1 is no longer supported

OpenAI's Windows documentation also states:

- WSL1 was supported through Codex `0.114`
- starting in Codex `0.115`, the Linux sandbox moved to `bubblewrap`, so WSL1 is no longer supported

References:

- <https://developers.openai.com/codex/windows>
- <https://developers.openai.com/codex/app/windows>

So the precise statement is "supports WSL2", not just "supports WSL".

### Codex hooks are feature-flagged

OpenAI's Hooks documentation currently says hooks are enabled through:

```toml
[features]
codex_hooks = true
```

It also documents `hooks.json`, common input fields, `PermissionRequest`, `tool_input.description`, and the current fail-closed behavior for unsupported PermissionRequest decision fields.

Reference:

- <https://developers.openai.com/codex/hooks>

Clawd's Codex installer writes `~/.codex/hooks.json` and enables this feature flag unless the user explicitly set `codex_hooks = false`, which Clawd preserves with a warning.

### WSL and Windows do not share `.codex` by default

OpenAI's Windows app documentation also explains that:

- the Windows app uses `%USERPROFILE%\.codex`
- Codex CLI inside WSL uses Linux `~/.codex` by default
- as a result, configuration, cached auth, and session history are not shared automatically

OpenAI documents this sharing option:

```bash
export CODEX_HOME=/mnt/c/Users/<windows-user>/.codex
```

Reference:

- <https://developers.openai.com/codex/app/windows>

That matters because it confirms that a default WSL Codex session writes into Linux home unless the user explicitly changes `CODEX_HOME`.

## 2. Clawd's current implementation

### Clawd uses official hooks first, with JSONL polling as fallback

In this repository, Codex integration is configured in [`agents/codex.js`](../../agents/codex.js):

- `eventSource: "hook+log-poll"`
- `sessionDir: "~/.codex/sessions"`

The official hook implementation is in [`hooks/codex-hook.js`](../../hooks/codex-hook.js), and the fallback monitor is in [`agents/codex-log-monitor.js`](../../agents/codex-log-monitor.js).

At runtime:

- official hooks handle SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, and Stop
- PermissionRequest defaults to native mode: Clawd observes the event and returns no-decision so Codex AutoReview/native prompts stay in charge. Opt-in intercept mode can still produce a real Clawd Allow/Deny bubble.
- JSONL polling remains active for hook-disabled sessions and events official hooks do not cover, such as web search, compaction, and abort

The fallback monitor expands `~` using the current process's own `os.homedir()`. In practice:

- if Clawd runs on Windows, it polls `C:\Users\<user>\.codex\sessions`
- if Clawd runs on Linux, it polls `/home/<user>/.codex/sessions`

So a Windows-hosted Clawd does not automatically poll `/home/<user>/.codex/sessions` inside WSL.

### Clawd currently has no automatic "install into WSL home" path

The current main process starts the Codex official-hook sync and fallback monitor for the host OS's own home directory. There is no user-facing WSL session directory setting, no default `\\wsl$\...` path scan, and no automatic edit of `/home/<user>/.codex/hooks.json` from the Windows app.

That means:

- `Codex native on Windows + Clawd on Windows`: works out of the box through official hooks, with JSONL fallback
- `Codex in WSL2 + Clawd on Windows + default Linux home`: does not work by default unless hooks are installed inside WSL in remote mode or a remote-side monitor is started
- `Codex in WSL2 + shared Windows Codex home via CODEX_HOME`: inferred to be workable for shared config/session state, because both sides would then point at the same `.codex` directory

The last point is an inference from OpenAI's documented `CODEX_HOME` sharing flow plus Clawd's current hook and fallback polling behavior.

### Clawd has remote-side hooks and a monitor fallback, but not WSL auto-discovery

This repo includes remote deployment through [`scripts/remote-deploy.sh`](../../scripts/remote-deploy.sh). It copies Codex hook files, runs `node ~/.claude/hooks/codex-install.js --remote`, and registers official Codex hooks that POST back through an SSH reverse tunnel with `CLAWD_REMOTE=1`.

It also ships [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js), which can poll `~/.codex/sessions` on the other side and POST state changes back when official hooks are unavailable or disabled.

So the repo already contains "state lives somewhere else, send events back" patterns, but that is not the same as automatic WSL discovery in the desktop app.

## 3. Why the current docs are easy to misread

### The README wording is broader than the current Codex-on-WSL reality

The current README says:

- `Claude Code and Codex CLI work out of the box`
- the setup guide also covers `remote SSH, WSL, and platform-specific notes`

Reference:

- [`README.md`](../../README.md)

That wording is reasonable for many cases, but it does not distinguish between:

- Codex running natively on Windows
- Codex running inside WSL2 while keeping a separate Linux home

### The WSL section in the setup guide mainly discusses Claude Code

The existing WSL section in [`docs/guides/setup-guide.md`](./setup-guide.md) primarily explains:

- running Claude Code inside WSL
- copying hook files into WSL
- registering Claude hooks inside WSL

Codex now appears in the remote SSH section through official hooks first and `codex-remote-monitor.js` as fallback.

So the docs do mention WSL, but they do not clearly spell out the support boundary for `Codex + WSL`.

## 4. The most accurate current conclusion

As of April 26, 2026:

1. OpenAI officially supports Codex in WSL2.
2. OpenAI documents Codex hooks behind the `codex_hooks` feature flag.
3. Clawd uses official Codex hooks as primary integration and JSONL polling as fallback.
4. Clawd currently syncs hooks and polls fallback logs in the host machine's own `.codex` home.
5. So if Codex runs inside WSL2 and still uses Linux `~/.codex`, Windows Clawd does not auto-detect those sessions by default.
6. The current documentation problem is not "WSL is never mentioned". The problem is that `Codex + WSL` boundaries were not explained explicitly enough.

## 5. Suggested external wording

If you need one concise explanation for users or issue threads, this is the safest wording:

> OpenAI officially supports running Codex in WSL2. Clawd integrates with Codex through official hooks, with JSONL polling kept as fallback. If Clawd runs on Windows while Codex runs in WSL with Linux's default home directory, Clawd will not automatically modify or poll that WSL `~/.codex`; install hooks in WSL remote mode, share `CODEX_HOME`, or run the remote fallback monitor. The current issue is better described as a Clawd integration and documentation boundary, not as OpenAI failing to support Codex on WSL.

## 6. Current workable paths

If the goal is "make Windows Clawd react to Codex running in WSL", the realistic paths today are:

1. Use OpenAI's documented sharing approach and point WSL `CODEX_HOME` at the Windows `%USERPROFILE%\.codex`.
2. Install Codex official hooks inside WSL with `node hooks/codex-install.js --remote`, so WSL Codex POSTs back to Windows Clawd through WSL localhost forwarding.
3. Reuse the repo's fallback remote-side monitor from [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js) and actively send state back to the Windows host.
4. Extend Clawd itself to support an explicit `\\wsl$\...` session directory.

Those options are not equivalent:

- option 1 is an OpenAI-documented sharing flow
- option 2 is the lowest-latency Clawd path when Codex hooks are available inside WSL
- option 3 is the fallback for hook-disabled Codex sessions
- option 4 would be a new Clawd feature, not current default behavior

## References

OpenAI documentation:

- Codex Windows: <https://developers.openai.com/codex/windows>
- Codex Hooks: <https://developers.openai.com/codex/hooks>
- Codex app on Windows: <https://developers.openai.com/codex/app/windows>

Repo files:

- [`README.md`](../../README.md)
- [`docs/guides/setup-guide.md`](./setup-guide.md)
- [`agents/codex.js`](../../agents/codex.js)
- [`agents/codex-log-monitor.js`](../../agents/codex-log-monitor.js)
- [`hooks/codex-hook.js`](../../hooks/codex-hook.js)
- [`hooks/codex-install.js`](../../hooks/codex-install.js)
- [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js)
