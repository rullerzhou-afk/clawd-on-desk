# DeepSeek Harness Integration

[Back to the setup guide](setup-guide.md)

Clawd's first DeepSeek Harness (DSH) integration is experimental and supports the
DSH `web` profile. A Clawd-managed plugin runs inside DSH and uses public APIs
for both state observation and ordinary blocking approvals. Clawd does not read
DSH's projection files and does not install a second monitor.

The compatibility gate is intentionally narrow while DSH remains a developer
preview: this release supports the published artifact
`@deepseek-ai/dsh@0.1.0-rc.6` (npm integrity
`sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`).
The public seams were first audited against upstream commit `47f9438`, then
rechecked in the compiled rc.6 artifact; that commit is a source baseline, not a
claimed rc.6 tag mapping. Other versions fail before Clawd changes the DSH profile.

## Behavior

The plugin observes `session/created`, `session/event`, and `session/disposed`.
It sends a minimal allowlisted payload to Clawd's dynamically discovered local
port; prompts, reasoning, tool arguments, tool results, environment variables,
and credentials are never forwarded. Per-session FIFO delivery plus DSH's
persistent event sequence prevents a late tool event from reviving a disposed
session.

| DSH public event | Clawd event / state |
| --- | --- |
| session created | `SessionStart` / `idle` |
| turn started | `UserPromptSubmit` / `thinking` |
| tool call | `PreToolUse` / `working` |
| successful tool result | `PostToolUse` / `working` |
| failed tool result | `PostToolUseFailure` / `error` |
| turn ended | `Stop` / `attention` (or `StopFailure` / `error`) |
| session disposed | `SessionEnd` / `sleeping` |

For ordinary `approval/request`, the plugin prepends a blocking listener:

- Clawd **Allow** returns DSH `allowed-once`.
- Clawd **Deny** returns DSH `rejected`.
- HTTP 204, timeout, invalid response, DND, disabled integration, or unavailable
  Clawd calls `next()` so DSH's native web answerer remains authoritative.
- DSH cancellation aborts the pending HTTP request.
- `policy="never"` is enforced by DSH before listener dispatch and cannot be
  overridden by Clawd.

`ask_user_question` stays entirely in DSH's native provider. Clawd does not
replace private provider state, create a second question bubble, or auto-answer
questions. DSH approvals also remain manual when Clawd auto-tools or unattended
mode is enabled; per-session grants are not offered in this experimental release.

## Requirements

- DSH `0.1.0-rc.6` on the same machine.
- The `web` profile.
- `pnpm`, because the official DSH plugin command delegates profile mutation to
  pnpm.
- Preferably a global `dsh` CLI on `PATH` for automatic install, repair, and
  uninstall.

`DSH_HOME` is honored when it is a trimmed non-empty value; otherwise Clawd uses
`~/.dsh`.

## Install and repair

Open **Settings → Agents**, find **DeepSeek Harness (web, experimental)**, and
click **Install**. Install succeeds only after Clawd has:

1. copied the packaged bridge into an immutable hash generation under
   `~/.clawd/integrations/deepseek-harness/homes/<dsh-home-hash>/generations/`;
2. called `dsh plugin --profile web add <generation>`;
3. verified both DSH profile rows, the final profile-local package resolution,
   the Clawd ownership marker, protocol, compatibility range, and bundle hash.

The same operation is available for development:

```bash
npm run install:dsh
node hooks/dsh-install.js --repair
```

The `<dsh-home-hash>` namespace is derived from the canonical `DSH_HOME` path.
Separate DSH homes therefore never share a generation that one home's uninstall
or cleanup could delete.

If DSH is only used through `npx`, Clawd does not download it automatically.
Settings returns an exact manual `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin ... add`
command pointing at the staged managed generation and explicitly setting the
canonical target `DSH_HOME` (PowerShell on Windows, POSIX environment-prefix
syntax elsewhere). This keeps an alternate home from accidentally mutating the
default `~/.dsh` when the command is pasted into a fresh terminal. After that command succeeds,
Install can verify the existing marker-owned plugin without requiring a global
CLI. The generation is protected by a Clawd-owned manual reference until it is
verified, replaced, or explicitly uninstalled; its marker records that the DSH
version was assumed at staging because no CLI version probe was available. A
malformed, foreign, or concurrently replaced reference fails closed, reports its
exact path, and retains managed generations for manual inspection.

Startup sync repairs only an already opted-in, installed-and-enabled integration.
It never initializes a missing DSH profile. Settings Install or explicit Doctor
Repair may allow the official CLI to initialize that profile. A running `dsh web`
process may need a restart after install or repair.

### Mutation lock recovery

Install, Repair, Uninstall, and cleanup share a per-`DSH_HOME` mutation lock.
Clawd automatically recovers a stranded lock only when its owner metadata is
valid, it is older than twice the operation timeout recorded by that owner, and
an OS PID probe returns `ESRCH` (the recorded process definitely no longer exists). A live
PID, `EPERM`, an unknown liveness result, or malformed/foreign owner metadata is
never taken over.

Lock errors include the exact `mutation.lock` path. If automatic recovery refuses
the lock, close every Clawd instance using that DSH home, verify the reported PID
is no longer running, and inspect `owner.json` at that exact path. Do not delete a
lock owned by a live or unknown process. Preserve malformed or foreign contents
for inspection; Clawd never recursively removes a canonical lock during owner
write failure or release, and only removes the exact isolated owner file plus an
empty lock directory.

## Uninstall and ownership safety

Use Settings → Agents → Uninstall, or:

```bash
npm run uninstall:dsh
```

Clawd verifies ownership before it calls the official remove command. A user
package or fork with the same package name is reported as a conflict and is never
overwritten or removed. Settings commits the uninstalled preference only after
the dependency row, bundle row, and resolved Clawd package are all gone.

`$DSH_HOME/profiles/node_modules` is DSH/pnpm's shared dependency fallback, not a
Clawd ownership anchor or cleanup target. Clawd may report what resolves there,
but it never rewrites or deletes that tree; pnpm owns any fallback-link cleanup.

Doctor reports DSH host detection separately from managed plugin disk health.
Disk health cannot prove that an already-running DSH process loaded the new
generation, so restart guidance remains conservative.

The installer and Doctor accept only the pinned DSH version before changing the
profile. DSH does not currently expose a public host-version/activation seam to
external plugins, so an already-installed bridge cannot reliably disable itself
before listener registration if DSH is upgraded in place. This is an explicit
experimental limitation: restart after changes, heed Doctor compatibility
warnings, and rely on DSH's native web flow whenever Clawd yields no decision.

## Scope and fallback

- Windows x64 native DSH web is the first target. Real rc.6 install, config
  composition, web boot, uninstall, and packaged-app source loading were verified
  on 2026-08-14; API-backed session and approval decisions remain pending and are
  not yet described as Windows-verified. macOS, Linux, WSL, remote SSH, non-web
  profiles, and ARM64 packaging are also unverified.
- There is no terminal-focus action because DSH web is a browser surface.
- Closing the local bubble does not deny the request. If a configured Telegram
  or Feishu/Lark remote channel takes it, that channel may decide; otherwise DSH
  receives no Clawd decision and continues its native flow.
- Hiding the pet is not DND, so a new approval may still show a bubble. DND
  returns control to DSH without deciding.
