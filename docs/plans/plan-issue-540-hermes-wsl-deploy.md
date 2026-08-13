# Plan: fix Hermes installation in WSL (#540)

> Status: **Implemented; automated, isolated, and active-home real-WSL verification complete**
> Date: 2026-08-09
> Origin: GitHub issue #540, “hermes在wsl下无法安装”
> Scope: Hermes-specific WSL detection, Pair/Unpair deployment, agent gating, installer symmetry, packaging, and regression coverage
> Verification: `npm test` — 7,198 passed, 0 failed, 31 skipped; Ubuntu WSL isolated Pair → detector → Unpair passed without warnings, and active-home Pair → real Hermes lifecycle → Unpair → repeated Pair upgraded `0.1.0` to `0.2.0`, reached the production Clawd state route, preserved sibling configuration, and left no staging directory.

---

## 1. Decision summary

Yes, #540 is fixable in Clawd. The failure is deterministic rather than an unconfirmed environment problem.

`src/wsl-deploy.js` deliberately omits `hermes` because the current WSL deployer copies only flat `hooks/*.js` files. The Hermes installer also needs `hooks/hermes-plugin/plugin.yaml` and `hooks/hermes-plugin/__init__.py`, so Settings rejects Pair before touching WSL:

```text
WSL deploy is not supported for hermes
```

The reviewed solution is:

1. add Hermes to WSL support with an explicit, complete six-file payload;
2. upload that payload through the existing `wsl.exe` stdin boundary into a unique private temporary directory, preserving validated relative paths;
3. run the existing Hermes installer and connectivity probe from that temporary directory, then always clean it up;
4. resolve and detect Hermes from WSL-native paths rather than rebasing a Windows `%LOCALAPPDATA%` path;
5. make Hermes profile uninstall symmetric with profile install;
6. propagate structured install/uninstall warnings and failures to Settings;
7. after a successful WSL Pair, enable the Hermes event gate while leaving local `integrationInstalled` unchanged;
8. send Hermes loopback `/state` and `/permission` requests through an explicit no-proxy opener, because a real WSL shell proxy returned 502 for `127.0.0.1` even though the Node connectivity probe succeeded.

This is preferable to tar, `/mnt/<drive>` access, Remote SSH reuse, or a recursive directory copy. It also avoids rewriting the shared live `~/.claude/hooks` tree for an integration that does not need persistent command-hook scripts.

## 2. Reproduction and verified cause

### 2.1 Underlying action call chain

The current renderer does not expose a Hermes WSL Pair button because `refreshWslDetection()` filters out agents with no WSL install-script mapping. The unsupported result below is therefore reproduced by invoking the same Settings action dependency directly; after Hermes is added to the supported map, this becomes the production button path.

```text
Settings action `deployToWsl`
  → `src/settings-actions-agents.js::deployToWsl()`
  → main-process `deployHooksToWsl`
  → `src/wsl-deploy.js::deployToWsl()`
  → install-script lookup returns null
  → `step: "unsupported"`
```

On the inspected Ubuntu WSL2 instance, the Settings chain returned:

```json
{"status":"error","message":"WSL deploy is not supported for hermes"}
```

A direct `deployToWsl("Ubuntu", { agentId: "hermes" })` call returned the same unsupported result.

### 2.2 Hermes itself works in WSL

The distro has a normal Hermes installation under `~/.hermes`, including `config.yaml` and `~/.hermes/hermes-agent/venv/bin/hermes`. A manually staged Clawd plugin is recognized by `hermes plugins list`. That copy is plugin version `0.1.0`, while the checked-in source is `0.2.0`, so the existing installer also has a real upgrade to perform once Settings can deliver its source assets.

The current focused tests pass because `test/wsl-deploy.test.js` explicitly asserts that Hermes is unsupported. That assertion protects the bug and must become a support regression test.

### 2.3 Additional blockers found during review

Supporting the two nested files alone would still leave three user-visible failures:

- fresh preferences have `agents.hermes.enabled=false`; WSL Pair currently returns no settings commit, and `/state` drops disabled Hermes events with HTTP 204, so Pair could appear successful while the pet never reacts;
- the Windows Hermes descriptor can resolve to `%LOCALAPPDATA%\hermes` or host `HERMES_HOME`; rebasing that path does not locate WSL `~/.hermes`, so the Hermes WSL row can remain hidden;
- `registerHermesPlugin()` installs into the primary home and every discovered Hermes profile, while `unregisterHermesPlugin()` currently removes only the primary copy.

The implementation must address these blockers as part of #540 rather than documenting a false success.

## 3. Required behavior

The fix is complete only when all of the following hold:

1. A Hermes installation in a selected WSL distro produces a Hermes WSL row even when Windows Hermes uses `%LOCALAPPDATA%` or a different host `HERMES_HOME`. Under the current cross-agent categorization, a WSL-only Hermes card remains in the **Unavailable** collapsible section; this issue does not redefine section membership.
2. Pair uploads only the audited Hermes deployment payload and never depends on `/mnt/<drive>` or a repo clone inside WSL.
3. Pair runs `hermes-install.js` in the selected distro, installs/upgrades the primary and profile plugin copies, and enables them through the real Hermes CLI without hand-editing YAML.
4. The temporary deployment directory is cleaned after success, failure, timeout, or partial upload; persistent Hermes files remain only under Hermes-managed homes.
5. A successful Pair sets the selected agent's global `enabled=true` but preserves its existing `integrationInstalled` value. In particular, a WSL-only fresh install remains `integrationInstalled=false`, so startup does not install a Windows-local Hermes plugin.
6. Pair failure makes no settings commit. Unpair does not automatically disable the global agent gate because another distro or local source may still use it.
7. Repeating Pair is idempotent and upgrades stale managed files without deleting unrelated plugin files.
8. Unpair re-stages the audited uninstaller payload, then disables/removes Clawd from the primary Hermes home and all discovered profiles; it does not depend on historical `~/.claude/hooks` staging.
9. Missing CLI, primary enable failure, profile partial failure, disable warning, missing packaged asset, upload error, and uninstall error produce distinct, user-visible results rather than a generic success.
10. A successful install with failed WSL-to-Windows reachability keeps the existing actionable connectivity warning.
11. Development and packaged builds use the same manifest and contain every required source file.

## 4. Implementation plan

### 4.1 Add a narrow Hermes WSL deployment option

Keep the existing install-script map and behavior for current hook-based WSL integrations. Add:

- `hermes: "hermes-install.js"` to the supported install-script lookup;
- a frozen Hermes-specific WSL option describing ephemeral staging, structured results, WSL-native detection, and the exact payload.

The payload is:

```text
hermes-install.js
json-utils.js
wsl-connectivity-probe.js
server-config.js
hermes-plugin/plugin.yaml
hermes-plugin/__init__.py
```

The first four entries are the complete local JavaScript closure for install/uninstall plus connectivity probing; the last two are exactly `MANAGED_PLUGIN_FILES` under the source directory expected by `hermes-install.js`.

Do not move CodeBuddy arguments or Claude's uninstall override merely to make a larger generic spec. Preserve those existing code paths. Do not enable OpenCode, MiMo Code, Pi, OpenClaw, or WorkBuddy as a side effect: nested-file transport is not proof that their WSL runtime contracts are valid.

Do not couple this option to `src/remote-ssh-deploy.js`. Remote SSH uses SCP plus identity, lease, fencing, ownership, and secure-layout rules that do not belong in local WSL deployment.

### 4.2 Preflight and validate the exact payload

Add a collector such as `collectAgentWslFiles(hooksDir, agentId)` which returns normalized `relativePath`, absolute source path, and a `Buffer` for each entry.

Before starting or mutating WSL, it must:

- find every manifest entry, including the install script and nested plugin assets;
- reject an empty or absolute relative path, `..`, backslashes, NUL, duplicate normalized destinations, and any resolved source outside `hooksDir`;
- reject directories, symlinks, or other non-regular source entries;
- read bytes as `Buffer` rather than converting them to UTF-8 strings;
- report the exact missing/invalid relative path through `step: "verify-files"`.

Add a manifest-consistency test asserting that the basenames under `hermes-plugin/` exactly equal the exported `MANAGED_PLUGIN_FILES`. If the Hermes installer later manages another asset, WSL support must fail CI until its explicit payload is updated.

Also reuse the repository's Remote SSH manifest-test pattern to audit the JavaScript closure transitively: every relative `require()` reached from the listed JavaScript entries must resolve to another listed payload entry, and every bare import must be a Node builtin. This must catch future dependencies as well as the current `wsl-connectivity-probe.js → server-config.js` edge.

Existing agents may continue using the current top-level JavaScript collector in this issue. Hermes must use its exact manifest and must not overwrite all shared top-level scripts merely because older integrations do.

### 4.3 Upload into a private ephemeral directory

Create a unique WSL directory with restrictive permissions using the explicit template `mktemp -d /tmp/clawd-hermes-XXXXXXXX`. Do not honor `TMPDIR` for this operation. The expected parent is therefore exactly `/tmp`; parse and validate the returned absolute POSIX path and `clawd-hermes-` basename before using it or attempting cleanup.

Refactor `pipeFileToWsl()` (or add a narrowly named equivalent) so it:

- accepts only a previously validated POSIX relative destination;
- creates nested parents under the private staging root;
- uses the existing `wsl.exe -d <distro> -- bash -c` stdin boundary;
- passes a `Buffer` to `stdin.end()` without an encoding argument;
- retains `windowsHide`, timeout handling, `close`-based completion, stderr capture, and the stdin `EPIPE` listener;
- never follows a destination outside the validated staging root;
- reports nested relative paths in copy errors.

No consumer reads this private directory before all uploads succeed, so a partial upload cannot truncate another agent's live hook script or create a cross-version shared payload. If any upload fails, skip the installer and clean the temporary directory in `finally`.

Use one exact, validated cleanup target. Never run recursive removal against `$HOME`, `~`, `/tmp`, an empty string, a glob, or unvalidated command output.

Accept a temp path only when it has exactly one non-empty output marker, its parent is exactly `/tmp`, and its basename has the generated `clawd-hermes-` prefix and expected random suffix. Empty, multi-line, polluted, wrong-parent, wrong-prefix, `$HOME`, and `/` results must abort without cleanup. Cleanup is part of the operation result: if install/uninstall succeeded but cleanup returns non-zero or times out, downgrade the response to success-with-warning; if the primary operation already failed, preserve that error and attach a secondary cleanup warning. Never claim that no staging remains when cleanup was unverified.

### 4.4 Run install, probe, and uninstall from fresh staging

For Pair, run from the private directory with the existing login/interactive shell behavior so Node and Hermes environment managers resolve:

```text
CLAWD_WSL_DISTRO='<distro>' node hermes-install.js --json
node wsl-connectivity-probe.js
```

Hermes does not currently consume `CLAWD_WSL_DISTRO`; a shared command builder may retain it for consistency, but neither correctness nor tests may depend on it. It may be omitted from a Hermes-specific command.

The staged sibling layout lets `hermes-install.js` resolve `json-utils.js` and `hermes-plugin/` unchanged. The connectivity probe resolves `server-config.js` unchanged.

For Unpair:

1. resolve the packaged/development hooks source exactly as Pair does;
2. preflight and upload the same audited payload to a new private directory;
3. run `node hermes-install.js --uninstall --json` in the selected distro;
4. parse the result and clean staging in `finally`.

Update `src/main.js` so the remove dependency passes `isPackaged: app.isPackaged`; otherwise packaged Unpair cannot re-stage its installer.

This makes Unpair work after a normal Pair, after an older/manual install, and after the previous staging directory has disappeared. Existing hook-based agent removal can retain its shared-staging behavior.

### 4.5 Add a stable structured Hermes CLI result

Add a `--json` mode to `hooks/hermes-install.js`. Normal local CLI output remains unchanged. In JSON mode, suppress human progress output and print one versioned sentinel line containing a bounded JSON result. A sentinel is required because an interactive login shell may add unrelated stdout/stderr.

The result contract must distinguish:

- `ok`: primary and profiles installed/removed cleanly;
- `warning`: primary succeeded but one or more profiles failed to enable, or files were removed but a CLI disable step failed;
- `error`: the primary plugin could not be enabled, a managed directory could not be removed, required source files were absent, or the installer itself failed.

Include only bounded fields needed by Settings: schema version, operation, status, message, reason, and counts of profile warnings/errors. Do not expose arbitrary config content or unbounded CLI output.

`src/wsl-deploy.js` must require and parse the sentinel for the fresh Hermes payload. Process exit status remains authoritative for hard failure, while the sentinel carries warning detail. Do not treat arbitrary login-shell stderr as a Hermes warning.

Propagate the normalized warning/error through `src/settings-actions-agents.js` into `src/settings-tab-agents.js` so the user receives a warning toast or an error toast. The current `onProgress` emitter is not wired by the production Settings dependency and is not sufficient.

At the Settings command boundary, success-with-warning must still use top-level `status: "ok"` plus a structured warning field; the controller applies commits only for `status: "ok"`. Do not map an installer warning to top-level `status: "warning"`, or the required `enabled=true` commit will be silently skipped.

### 4.6 Make Hermes uninstall symmetric across profiles

Refactor `unregisterHermesPlugin()` to enumerate the union of:

- the primary Hermes home;
- every config-bearing home returned by `hermesHomesForSync()`;
- every profile home that still contains at least one Clawd managed plugin file, even if that profile's `config.yaml` has since been deleted.

Then:

- resolve the primary Hermes CLI once;
- for each target that still has `config.yaml`, reuse that command with target-specific `HERMES_HOME` and run `plugins disable clawd-on-desk`;
- for a configless residual profile, skip the CLI so cleanup cannot create a new config, and remove only Clawd's owned plugin directory;
- remove only that target's `plugins/clawd-on-desk` directory;
- aggregate per-home results into the structured result;
- treat CLI disable failures as warnings when managed files were still removed;
- treat a managed-directory removal failure as an error.

Preserve `pluginDir` and `syncProfiles:false` test overrides. Do not remove sibling plugins or manually rewrite `config.yaml`. Hermes CLI may semantically change Clawd's own enabled entry; all unrelated YAML keys and plugin entries must remain intact.

While touching managed-file copying, harden the final destination rather than relying on private source staging alone: reject an existing `plugins/clawd-on-desk` leaf that is a symlink, reject a managed destination that is a symlink or non-regular file, and update each managed file through a unique same-directory temporary file plus atomic rename with best-effort temp cleanup. This prevents an interrupted update from truncating the active Python plugin or following a managed leaf outside the intended directory. Preserve legitimate parent-home layouts and test the supported Windows/POSIX behavior.

### 4.7 Resolve Hermes from WSL-native state

Do not derive the WSL Hermes directory from the Windows descriptor's already-resolved `parentDir` or `configPath`. On Windows those frozen, module-load-time values may point to `%LOCALAPPDATA%\hermes` or a host-only custom location. The Hermes branch in `refreshWslDetection()` must bypass the existing `rebaseHomePathPosix(descriptor.parentDir, ...)` path completely.

For each scanned distro that supports Hermes:

1. resolve the ordinary WSL home as today;
2. resolve `${HERMES_HOME:-$HOME/.hermes}` inside that distro using the same bounded login-shell environment used by installation and a unique sentinel line;
3. validate that the result is an absolute POSIX path with no NUL/newline; if custom resolution fails, fall back only to the known `${wslHome}/.hermes` default and record that custom-home detection is unknown;
4. use that WSL-native path for Hermes parent detection and UI detail.

The normal case must never contain a Windows drive, backslash, `%LOCALAPPDATA%`, or host home suffix. Add an explicit regression where Windows Hermes resolves under LocalAppData while WSL Hermes exists at `/home/tester/.hermes`.

### 4.8 Add per-agent cleanup evidence without claiming enabled truth

The existing `hooksFilesPresent` and `hooksDeployed` fields are distro/Claude staging signals. They are not Hermes pairing truth and can make a Hermes row show Unpair or “Deployed” merely because Claude was paired.

For Hermes, extend the batched WSL detector with one indexed tri-state field:

```text
integrationFilesPresent: true | false | null
```

`true` means at least one Clawd managed file exists in the primary Hermes plugin directory or any discovered `profiles/*/plugins/clawd-on-desk` directory. `false` means the scan completed and found none. `null` means the check was unavailable or incomplete. This is cleanup evidence, not proof that `plugins.enabled` contains Clawd.

Parser requirements:

- require exactly one unambiguous indexed marker for every expected check;
- treat missing, duplicate, conflicting, or truncated markers as an untrustworthy distro scan and preserve the previous committed cache;
- keep the current generation/commit arbitration and stopped-distro behavior.

Renderer rules:

- for entries with per-agent evidence, show Unpair only when `integrationFilesPresent === true`;
- on a fresh scan with `integrationFilesPresent === null`, conservatively hide Unpair and keep Pair available; do not fall back to Claude's shared marker;
- use the legacy `hooksFilesPresent` fallback only when per-agent evidence is not applicable, not when Hermes explicitly reports `false`;
- do not show the Claude `hooksDeployed` badge on Hermes rows;
- keep Pair available as repair/upgrade;
- refresh WSL hints after both successful and failed Pair/Unpair attempts, so a partial installer result exposes a cleanup path.

Do not parse Hermes YAML or run `hermes plugins list` during every scan merely to manufacture an enabled badge. Per-agent enabled-state truth is a separate design problem.

### 4.9 Open the runtime gate without claiming a local install

On successful WSL Pair, `_wslCommand()` must return a settings commit built from the existing agent entry with only:

```js
{ enabled: true }
```

The merge must preserve `integrationInstalled` and every other flag. In a fresh WSL-only setup, `integrationInstalled` therefore remains `false`, satisfying the repository rule that WSL registration must not trigger Windows-local automatic synchronization.

On Pair failure, return no commit. On Unpair, do not set `enabled=false` and do not clear `integrationInstalled`; the gate is global while Pair/Unpair targets one distro, and other Hermes sources may still be active.

For #540, apply this success-gate rule only to Hermes. Existing non-default WSL agents may have the same latent gate problem, but changing all of them requires a separate compatibility audit and follow-up. No local installer side effect is authorized by the Hermes commit.

### 4.10 Documentation

Update `docs/guides/setup-guide.md`:

- Hermes must already be installed in the target distro;
- under the current UI, open the Connected section to run WSL Scan, then open the **Unavailable** collapsible section to find the WSL-only Hermes card and its Pair row;
- Clawd installs/enables only its plugin and does not install Hermes itself;
- Pair opens the Clawd event gate but does not mark or install a Windows-local integration;
- Unpair removes Clawd from the primary Hermes home and discovered profiles without disabling other Hermes sources globally;
- the distro must reach Windows Clawd on `127.0.0.1:23333-23337`.

While editing the WSL section, remove the existing localhost contradiction: one paragraph says WSL2 shares localhost by default, while the later networking section correctly explains that default NAT normally requires mirrored networking for this loopback-only server. Keep one accurate statement plus the existing connectivity-warning behavior.

## 5. Automated test plan

### 5.1 Payload and transport

Extend `test/wsl-deploy.test.js` or add one focused companion file:

1. Hermes maps to `hermes-install.js`; its uninstall command is `hermes-install.js --uninstall`.
2. The Hermes payload contains exactly the six listed relative files.
3. Its plugin asset basenames exactly match `MANAGED_PLUGIN_FILES`.
4. A missing asset fails before WSL home lookup, temp creation, upload, or any other WSL mutation.
5. Nested upload creates parents and sends byte-identical `Buffer` data.
6. Empty, absolute, traversal, backslash, NUL, duplicate, symlink, non-file, and hooks-root escape entries are rejected.
7. Upload failure prevents install and still cleans the exact temp directory.
8. Pair runs install before connectivity probe and removes staging on success, installer failure, probe failure, timeout, and thrown error.
9. Unpair resolves the packaged/development source, creates fresh staging, runs `--uninstall --json`, and cleans up.
10. Hermes Pair/Unpair never writes or removes the persistent shared `~/.claude/hooks` directory.
11. Empty, multi-line, polluted, `/`, `$HOME`, wrong-parent, or wrong-prefix temp output is rejected without recursive cleanup.
12. Cleanup non-zero/timeout downgrades success to warning; a pre-existing primary error stays primary and carries a secondary cleanup warning.
13. The relative-require and builtin-only audit proves that the exact payload is transitively closed.

Add narrow dependency-injection seams for `isWindows`, home/temp resolution, WSL execution, upload, and packaged `resourcesPath`, or export pure command builders. The orchestration tests must run identically on Windows, macOS, and Linux without booting a real distro or relying on require-cache mutation.

### 5.2 Hermes installer

Extend `test/hermes-install.test.js`:

1. JSON/sentinel success, warning, and error output is stable and bounded.
2. Primary plus multiple profiles install and uninstall symmetrically.
3. The primary CLI is reused with the correct `HERMES_HOME` for every profile.
4. A profile enable failure returns success-with-warning when primary succeeds.
5. A profile disable failure removes managed files and returns warning.
6. A managed-directory removal failure returns error.
7. A configless profile containing only one residual managed file is cleaned without invoking the CLI or creating `config.yaml`.
8. `syncProfiles:false` and explicit `pluginDir` retain their current single-target behavior.
9. Unrelated plugin directories and unrelated config semantics survive install/uninstall.
10. A symlinked plugin leaf or managed destination is rejected, and an injected write/rename failure preserves the previous complete file while cleaning the owned temp file.

Keep the existing missing-CLI, timeout, idempotence, upgrade, and unmanaged-file tests.

### 5.3 Detection and renderer

Extend `test/agent-installation-detector-wsl-refresh.test.js` and `test/settings-renderer-browser-env.test.js`:

1. Hermes is not filtered out of WSL results.
2. Host `%LOCALAPPDATA%\hermes` or host `HERMES_HOME` cannot redirect WSL detection away from `~/.hermes`.
3. A valid WSL `HERMES_HOME` sentinel is honored; invalid/failed custom resolution follows the documented fallback.
4. Managed files in the primary home or only in a profile produce `integrationFilesPresent: true`.
5. No managed files produce `false`; malformed/missing/conflicting markers preserve previous cache rather than silently producing false.
6. Claude deployed plus Hermes never paired does not show a Hermes badge or Unpair.
7. Hermes evidence true shows Unpair even without shared Claude staging.
8. A failed Pair that left managed files triggers a hint refresh and exposes Unpair.
9. A configless profile-only residual produces evidence true; after Unpair the next scan produces false.
10. A fresh `integrationFilesPresent: null` hides Unpair, keeps Pair, and never falls back to Claude's `hooksFilesPresent`.

### 5.4 Settings action and gate

Extend `test/settings-actions-agents.test.js` and route/gate coverage:

1. successful Hermes Pair commits `enabled=true`;
2. the commit preserves fresh `integrationInstalled=false` and preserves `true` if a local installation already exists;
3. Pair warning still commits enabled and returns the warning;
4. Pair failure returns no commit;
5. Unpair never disables the global gate;
6. structured install/uninstall warnings reach the renderer toast;
7. after Pair, a Hermes `/state` event is accepted instead of dropped by the disabled-agent gate.

### 5.5 Packaging

Keep the existing `hooks/**/*` `files` and `asarUnpack` assertions. Add a temporary packaged-layout test under `app.asar.unpacked/hooks` and run the real packaged resolver plus Hermes manifest collector against it. The release gate must also inspect or smoke a real Windows artifact; checking `package.json` globs alone is not enough.

### 5.6 Commands

Run the focused suite first:

```powershell
node --test test/wsl-deploy.test.js test/hermes-install.test.js test/agent-installation-detector-wsl-refresh.test.js test/settings-actions-agents.test.js test/settings-renderer-browser-env.test.js test/package-build-config.test.js
```

Then run:

```powershell
npm test
```

## 6. Real WSL acceptance smoke

Use a disposable distro/user or a separately backed-up Hermes test home. Do not mutate the developer's active `~/.hermes` during automated work.

1. Install a supported Hermes CLI in Ubuntu WSL2 and record the WSL, Hermes, Node, and Clawd versions plus networking mode.
2. Test the standard `~/.hermes` layout, then repeat with a disposable custom WSL `HERMES_HOME` resolved through the login shell.
3. Start Windows Clawd from the same development revision. Run WSL Scan from the Connected section, then open the Unavailable collapsible section and confirm the WSL-only Hermes card contains the expected distro row even if Windows Hermes exists under LocalAppData.
4. Pair and confirm no Hermes staging remains afterward and the shared `~/.claude/hooks` tree is unchanged.
5. Verify the current managed files exist in the primary home and every config-bearing profile; verify `hermes plugins list` reports Clawd enabled for each applicable home.
6. Verify Settings enabled Hermes without changing its local `integrationInstalled` value.
7. Run a real Hermes prompt/tool lifecycle and verify Clawd accepts a Hermes `/state` event and animates.
8. Repeat Pair and verify idempotence. Put an old `0.1.0` fixture only in the disposable target plugin directory, Pair, and verify it upgrades to `0.2.0` without deleting an unrelated file.
9. Force one profile enable failure and confirm Pair reports a warning while the primary integration remains usable and cleanup remains available.
10. Unpair and confirm primary/profile Clawd plugin directories are removed, the Clawd enabled entry is disabled where the CLI succeeds, unrelated YAML semantics and sibling plugins remain, and the global Hermes gate stays enabled.
11. Test the mirrored/reachable path and the NAT/unreachable warning path where practical.
12. Repeat Pair and Unpair from a packaged Windows artifact, not only the source tree.

Attach the sanitized Settings result, plugin-list output, relevant managed-file hashes, and before/after semantic config checks to the PR or issue comment.

Executed on the active Ubuntu WSL home on 2026-08-09:

- production Pair upgraded the installed Clawd plugin from `0.1.0` to `0.2.0`; a second Pair returned `Hermes plugin already installed`;
- a real Hermes CLI session produced `SessionStart → idle` and `UserPromptSubmit → thinking` through the production `src/server.js` route, and the deployed plugin's `pre_tool_call` produced `PreToolUse → working`;
- the first real lifecycle exposed inherited proxy variables sending Python `urllib` loopback traffic to a proxy and returning HTTP 502; the explicit no-proxy opener fixed that path, and a regression test now runs with every proxy variable pointed at a failing endpoint;
- production Unpair disabled Clawd through Hermes and removed only `plugins/clawd-on-desk`; the CLI's `plugins.disabled` history entry is intentionally left to Hermes rather than rewriting user YAML directly;
- final state is `clawd-on-desk enabled 0.2.0`; deployed managed-file hashes match the repository, the Windows runtime remains on port 23333, and private staging/backup directories were removed.

The existing desktop process was intentionally not restarted during this smoke. Production route events were captured directly; visual animation in the already-running GUI was not claimed because that process had loaded the pre-change disabled Hermes gate.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Windows-local paths hide the WSL installation | Resolve Hermes home inside WSL; test LocalAppData/host-HERMES_HOME isolation |
| Pair succeeds but runtime drops events | Commit only `enabled=true` after success; route-level regression test |
| WSL Pair accidentally triggers Windows-local install | Preserve `integrationInstalled`; do not call local sync |
| Nested path escapes the staging root | Explicit manifest, POSIX normalization, containment checks, and adversarial tests |
| Partial upload corrupts another integration | Private ephemeral staging; install only after all uploads; exact cleanup in `finally` |
| Package omits a required file | Manifest/managed-file consistency, packaged-layout test, real artifact smoke |
| A future helper is omitted from the exact payload | Transitive relative-require and builtin-only manifest audit |
| Profiles remain active after Unpair | Symmetric root/profile enumeration and removal tests |
| Settings reports false success or hides warnings | Versioned installer sentinel propagated through deploy, action, and renderer |
| Claude pairing makes Hermes look paired | Per-agent Hermes evidence overrides legacy distro-level hook markers |
| WSL plugin installs but cannot reach Windows | Preserve connectivity probe/warning, bypass inherited proxies for loopback `/state` and `/permission`, test hostile proxy env, and document mirrored networking |
| Cleanup removes too broad a target or silently fails | Strict temp marker/prefix/parent validation, exact quoted target, structured cleanup warning |
| Managed plugin update follows a symlink or is interrupted | Reject symlinked managed leaves; same-directory temporary write plus atomic rename |

## 8. Non-goals

- Installing or upgrading Hermes itself.
- Enabling WSL support for OpenCode, MiMo Code, Pi, OpenClaw, or WorkBuddy.
- Refactoring existing persistent hook-based WSL deployments into ephemeral staging.
- Reusing or changing Remote SSH deployment.
- Parsing Hermes YAML on every Settings scan or claiming verified enabled-state truth from file presence.
- Redesigning WSL networking, port discovery, Hermes permissions, session source labels, or terminal focus.
- Broad hardening of all existing installer destination writes or all shared WSL hook uploads; those should receive separate threat-modelled changes.
- Moving WSL-only agents into the Connected section or otherwise redesigning Settings agent categorization; record that cross-agent UX issue as a follow-up.

If real smoke proves Hermes events arrive but lack useful WSL source/focus metadata, record that as a separate follow-up rather than expanding #540 without a concrete acceptance requirement.

## 9. Rollback

The feature is additive. If release smoke uncovers a regression:

1. remove the Hermes WSL support option and its detector/UI evidence path;
2. retain independently correct Hermes profile-uninstall and structured-result fixes;
3. leave local Hermes integration behavior intact;
4. use the audited Hermes uninstaller in the affected disposable/user-approved WSL home.

No migration or direct user-YAML rewrite is introduced, and no persistent staging directory needs rollback.

## 10. Independent review outcome

Three read-only sub-agent reviews covered implementation correctness, safety/testing, and alternative architectures. Their shared conclusions were incorporated:

- explicit file allowlisting is better than tar here;
- WSL-native Hermes path resolution, runtime gate activation, and profile-symmetric cleanup are required;
- the original shared-staging/Claude-marker plan was too weak for Hermes and could create false success or false UI state;
- structured results and cross-platform orchestration seams are necessary for reliable tests.

A subsequent independent Claude review also found no blocker. It prompted the final specification closures: the current Unavailable-section location for WSL-only Hermes, fixed `/tmp` staging parent, conservative `integrationFilesPresent: null` UI behavior, packaged `resourcesPath` injection, and the resolved decisions in §11.

Rejected alternatives:

- **tar stream:** unnecessary dependency and archive-extraction attack surface for six small files;
- **Remote SSH reuse:** wrong transport and security lifecycle;
- **`/mnt` source execution:** depends on drvfs/automount, `wslpath`, drive letters, and packaged paths with spaces;
- **recursive plugin copy:** silently widens the managed asset boundary;
- **Hermes-only control-flow `if` statements without data:** cheap initially but harder to audit and extend than one narrow option/manifest.

## 11. Resolved implementation decisions

External review raised five final design questions. They are closed as follows so implementation has no optional branch:

1. Use private ephemeral staging for Hermes and future asset-backed integrations only when they do not need persistent command-hook files.
2. Resolve custom WSL `HERMES_HOME` through the same bounded login/interactive shell used by installation, with sentinel parsing and the explicit `~/.hermes` fallback. Correct path agreement takes priority over the extra scan latency.
3. Use the versioned Hermes sentinel directly in v1. Extract a shared installer-result helper only when a second integration needs the contract.
4. Enable only Hermes after successful Pair in #540. Audit other non-default WSL agents in a separate follow-up.
5. Use `integrationFilesPresent` only as cleanup evidence. Enabled-state truth remains explicitly deferred and must not be inferred from managed files.
