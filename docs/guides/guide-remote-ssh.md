# Remote SSH Guide

The only supported entry point for Remote SSH deployment is **Settings →
Remote SSH** inside the Clawd app. `scripts/remote-deploy.sh` is intentionally
disabled: a standalone shell script cannot create the profile-bound local
ingress, installation identity, durable deployment transaction, and
ownership-fenced cleanup required by the secure transport.

## Prerequisites

- A local Clawd instance is running
- Your machine can reach the remote host via the system `ssh`
- Node.js is installed on the remote
- For Windows 10/11 remote hosts, enable the built-in OpenSSH Server and put
  Node.js 14+ on PATH. The default shell can be cmd, PowerShell, or Git Bash;
  no shell change is needed
- At least one supported remote agent is installed on the remote: Claude Code, Codex CLI, Copilot CLI, or Hermes Agent
- For Hermes Agent, Hermes is already installed on the remote and its CLI is
  reachable as `<home>/hermes-agent/venv/bin/hermes`, as `~/.local/bin/hermes`
  (git-based installs), or as `hermes` on the non-login `PATH`. The plugin runs
  under Hermes' own virtualenv Python;
  the Node.js requirement above is unchanged

Clawd does not store SSH passwords or private-key passphrases. First-time host
key confirmation, passphrase entry, and ssh-agent loading are all handled by
the system `ssh` and your system terminal.

## In-app flow

1. Open **Settings → Remote SSH**.
2. Click **Add profile** and fill in:
   - **Host**: `user@remote-host`, or a Host alias defined in your `~/.ssh/config`
   - **SSH port**: defaults to `22`
   - **Private key file**: optional; leave blank to use ssh-agent or `~/.ssh/config`
   - **SSH transport compatibility**: leave **Automatic** for normal hosts and GitHub Codespaces. Use **Force single SSH session** only for another ProxyCommand transport that cannot tolerate overlapping SSH sessions
   - **Remote forward port**: defaults to `23333`; only change to `23334-23337` when you run multiple profiles against the same remote
   - **Host prefix**: optional, used in Sessions / Dashboard to disambiguate the remote
3. If SSH needs first-time host-key confirmation, a passphrase, or an ssh-agent load, click **Authenticate**. Clawd opens a terminal to run a plain `ssh` once. On Windows, **Authenticate / Open Terminal** use a separate Windows Console Host window so Windows Terminal's administrator-profile settings cannot interrupt the session. After SSH exits, the local command prompt stays open so you can read errors; type `exit` to close it.
4. Click **Deploy / Repair Hooks**, then connect the profile.
   - Clawd creates a dedicated local ingress for this profile and maintains an `ssh -R` reverse tunnel to that ingress
   - It writes a profile identity atomically, pins hooks and the static Claude permission URL to the profile's exact remote port, and never exposes the general local `/state` or `/permission` routes to the tunnel
   - Then it copies hook files from the currently installed Clawd to the resolved remote runtime layout
   - Then it registers Claude Code hooks, Codex official hooks, and Copilot CLI hooks in remote mode when the matching remote agent is installed
   - Then, when Hermes is detected on the remote, it uploads Clawd's Hermes plugin to a separate staging directory and registers it into the Hermes home and its profile homes
   - Connection / deployment logs are shown directly below the profile
5. Start Claude Code, Codex CLI, Copilot CLI, or a Hermes session on the remote. The Dashboard will show the session once the first remote hook event arrives.

For remote-only Copilot CLI tracking on a fresh local install, turn on
**Copilot CLI** in **Settings → AI Coding Tools** so Clawd accepts those remote hook
events. You do not need to click **Install** unless you also want local Copilot
hooks on this machine.

For remote-only Hermes Agent tracking, Clawd turns on **Hermes Agent** in
**Settings → AI Coding Tools** by itself once the Remote SSH deployment is fully
verified, so those remote hook events are accepted right away. You do not need
to click **Install** unless you also want the local Hermes plugin on this
machine: a remote deployment installs nothing locally and does not set the
local integration as installed.

If the profile has **Auto-start Codex fallback monitor on connect** enabled,
Clawd launches `~/.claude/hooks/codex-remote-monitor.js` as connection
maintenance. On a serialized transport it finishes this one-shot maintenance
before starting the persistent reverse tunnel; automatic tunnel reconnects do
not replay the monitor mutation.
The fallback is not needed when Codex official hooks are working. It is not
available on Windows remote hosts; Clawd skips it even if this option is enabled.

### Hermes Agent scope and activation

Phase 1 covers the default `account-default` Remote SSH layout with a standard
Hermes installation: the `~/.hermes` home plus the profile homes under
`~/.hermes/profiles/*`, driven by the default and ordinary named-profile
gateways. Clawd installs its managed plugin into the root home and each
discovered profile home, then enables it through the remote `hermes` CLI.

A custom `HERMES_HOME`, a multiplexed gateway, and the experimental
`profile-isolated` runtime are **not supported and not verified** in Phase 1.

Enabling the plugin takes effect in the **next** Hermes session. If the deploy
replaced a managed plugin file that a running gateway has already loaded, that
gateway needs a **manual** restart before it emits events from the new module.
Clawd never restarts a Hermes gateway for you. The deploy progress line reports
which of the two applies; a `systemctl --user is-active` reading is only a
best-effort hint, not proof that a gateway is running the new module.

### GitHub Codespaces and single-session transports

Clawd inspects the effective local SSH configuration with `ssh -G` before it
connects. A `ProxyCommand` using exact `gh cs ssh ... --stdio` or
`gh codespace ssh ... --stdio` is automatically put in serialized mode. In
that mode Clawd never overlaps its own SSH/SCP children for the same
Codespace: Node discovery and monitor maintenance close first, while tunnel
readiness runs inside the one persistent `ssh -R` session.

Deploy / Repair, Disconnect, cleanup, and identity/runtime changes ask the
persistent remote readiness process to stop through stdin EOF and wait for the
top-level child's `close` before starting another SSH operation. If that drain
cannot be proven, Clawd stops and reports a recovery error instead of retrying
an unknown remote mutation. A second profile for the same Codespace and the
interactive **Authenticate / Open Terminal** actions remain blocked until the
managed serialized transport is fully idle.

The explicit single-session override is intentionally conservative and keyed
to the effective destination. Change it only while Disconnected. Standard
SSH targets retain the existing parallel-capable behavior.

## Windows remote hosts

Windows remote deployment supports **Claude Code, Copilot CLI, Codex CLI
official hooks, and DeepSeek Harness desktop** in `account-default` mode. Hermes Agent, `profile-isolated`
mode, the Claude quota ring, and the Codex fallback monitor are not supported
on Windows remote hosts. Deployment skips the unsupported agents and leaves
any existing Claude statusLine unchanged. Only the Codex CLI is covered;
Codex Desktop is not verified.

Choose between remote deployment and running Clawd locally on that Windows
computer. Deployment is refused while its local Clawd is running, or when its
runtime record cannot establish that it has stopped. Quit that Clawd before
clicking **Deploy / Repair Hooks**. Remote deployment also removes Clawd's
Claude auto-start hook, so starting Claude does not launch the local desktop.

Starting local Clawd later takes the hooks back for local use. The next
**Connect** or reconnect checks the components installed by this deployment
and reports that the remote hooks need repair if they were taken over.
Takeover is not checked continuously after a successful connection. If local
Clawd has **Launch at login** enabled, restarting Windows can automatically
start it and take the hooks back. Quit it, then deploy again to return to
remote use. Upgrading that computer's local Clawd from v1.5.0 also removes the
remote hooks once, because the old uninstaller runs during the upgrade; deploy
again afterwards.

File permissions rely on the Windows user profile directory's inherited ACLs;
this does not isolate deployments that share the same Windows account.
Copilot ignores a `hooks.json` containing a UTF-8 BOM. Clawd removes that BOM
automatically during deployment and verifies the result.

Codex uses its official hooks under `~\.codex`. After deployment, run
`/hooks` in the remote Codex TUI to trust the new entries. Removing this
deployment shifts the group indexes of later third-party hooks, so those may
need another `/hooks` review too. `hooks.json` must not contain a UTF-8 BOM;
Clawd repairs it automatically. Deployment only manages `~\.codex` and does
not follow a custom `CODEX_HOME`. If `~\.codex`, its `hooks.json`, or its
`config.toml` is a link, deployment is refused. Deployment is also refused
when `~\.codex\hooks.json` contains a Clawd entry whose ownership cannot be
confirmed; resolve or remove that entry, then deploy again. When
`[features].hooks` is explicitly `false` in the remote `config.toml`,
deployment is refused before any hook or config write; enable it and deploy
again.

### DeepSeek Harness desktop

On a Windows remote host, Clawd can show DeepSeek Harness desktop session
state, tool activity and completion, and let you answer its approval requests
on your Mac. Clicking a session cannot jump to the remote DSH window.

Install DeepSeek Harness desktop on the remote computer and open it at least
once to create its desktop settings. The supported versions are the same as
for the [local DSH integration](dsh-setup.md): the `0.2` family from
`0.2.0-rc.2`, and the `0.1` family from `0.1.0-rc.6`. Sign in to that Windows
desktop before deploying. If SSH uses an administrator account, Clawd uses a
one-time scheduled task to install the DSH plugin with your ordinary user
permissions in that desktop session, then deletes the task. After deployment,
**restart DeepSeek Harness desktop on the remote computer** for the new
connection to take effect. A verified deployment also enables DeepSeek Harness
in the Mac's Clawd settings.

Choose either the remote connection or that computer's local Clawd for DSH.
If local Clawd already connects to DSH, deployment asks for confirmation
before switching it to remote use. Starting local Clawd later does not take
the DSH connection back automatically. To switch back, open Clawd on that
computer and repair its DeepSeek Harness integration in Settings. Other
agents' hooks still follow the local takeover behavior described above.

DSH remote support does not cover the web version (`dsh web`), headless use,
Linux or macOS remote hosts, or `profile-isolated` mode. A host without DSH
desktop keeps the existing deployment behavior for other agents, including
when its unused DSH data folder is a link.

The deployment log's DSH messages mean:

| Reason | What to do |
| --- | --- |
| `dsh_asset_upload_failed` | Connection files could not be uploaded. Check SSH and remote folder permissions, then run **Deploy / Repair Hooks** again. |
| `bridge-ownership-conflict` | An existing DSH plugin could not be confirmed as Clawd's. Check it on the remote computer before deploying again. |
| `dsh_desktop_ambiguous` | More than one desktop installation was found. Keep the one you want to use, then deploy again. |
| `dsh_desktop_unreadable` | The desktop installation could not be checked. Check access to its installation folder, then deploy again. |
| `dsh_home_ambiguous` | More than one possible data folder was found. Check `DSH_HOME` and the default `~\.dsh` folder, then deploy again. |
| `dsh-home-changed` | The data folder differs from the previous deployment. Restore the previous folder, or clean up that deployment before deploying to the new folder. |
| `inspection-required` | The previous installation needs manual checking. Check the remote integration, lift the pause as described below, then run **Deploy / Repair Hooks**. |
| `dsh_install_failed` | The DSH connection could not be installed. Check the deployment log and remote file permissions, then deploy again. |
| `installer_result_unknown` | Installation did not return a confirmed result. Check the remote integration before retrying; lift any installation pause only after checking it. |
| `dsh_local_migration_required` | Local Clawd already connects to DSH. Confirm to switch to remote use; to switch back later, repair the DSH integration in that computer's local Clawd settings. |
| `dsh_profile_unreadable` | Desktop settings could not be read. Check the contents and access permissions of `package.json` under the desktop data folder, then deploy again. |
| `dsh_readback_failed` | Installation finished, but the connection could not be verified. Check the remote integration, then deploy again. |
| `version-unsupported` | Use a DSH version supported by the local integration, then deploy again. |
| `windows_dsh_cleanup_incomplete` | Plugin files or references in DSH settings remain, or could not be checked. Run **Deploy / Repair Hooks** first, then try cleanup again. |
| `windows_dsh_desktop_session_required` | Sign in to the remote Windows desktop, then deploy again so the plugin can be installed with ordinary user permissions. |
| `dsh_discovery_incomplete` | This is a warning: other integrations were deployed, but DSH was skipped because its installation could not be fully checked. Check DSH on the remote computer and deploy again if needed. |

If an installed desktop app's DSH data or remote connection folders contain
links, deployment reports `path_link`. Check those folders before retrying;
this check does not block computers without DSH desktop.

To lift an installation pause **after manually checking the remote DSH
integration**, run the following in PowerShell on that computer. Replace the
placeholder with this deployment's 64-character folder name under
`~\.clawd\remote-integrations\deepseek-harness`; check its `deployment.json`
to identify the correct deployment. This only lifts the pause; it does not
repair or approve the integration. Then run **Deploy / Repair Hooks** on your Mac.

```powershell
node "$env:USERPROFILE\.claude\hooks\dsh-install.js" --remote-clear-latch --profile desktop --remote-root "$env:USERPROFILE\.clawd\remote-integrations\deepseek-harness" --install-id '<deployment install ID>'
```

## Key concepts

The `127.0.0.1:<port>` shown in Doctor is normal — it's the Clawd HTTP service
on **your** machine, not an IP on the remote cluster. Remote hooks don't reach
your LAN IP directly either.

The actual chain is:

```
Remote Claude/Codex/Copilot/Hermes hook
  -> POST http://127.0.0.1:<remote forward port>
  -> SSH reverse tunnel
  -> Profile-bound local ingress (routing nonce verified)
  -> Local Clawd state / permission handlers (canonical profile session ID)
  -> Dashboard / Session HUD / pet state
```

So "Connected" only means the tunnel is up. For a remote session to actually
appear in the Dashboard, you still need:

- Remote hooks deployed successfully
- The remote agent started, with at least one hook event emitted
- For Codex, the remote Codex TUI has reviewed the hooks via `/hooks` if your version requires it
- For remote-only Copilot CLI on a fresh local install, local **Settings → AI Coding Tools → Copilot CLI** is turned on
- For remote-only Hermes Agent, local **Settings → AI Coding Tools → Hermes Agent** is still turned on (a fully verified deploy enables it automatically), and the remote gateway has been restarted manually if the deploy log asked for it

## Shared-server isolation and upgrade boundary

Each connected profile has its own local ingress and routing nonce. Secure
remote hooks use one pinned port and never scan `23333-23337`. The receiver
also validates the nonce before state or permission data reaches Clawd.
Sessions are keyed by profile internally, so equal raw session IDs cannot
overwrite one another.

For **different Unix accounts on the same server**, this fixes the cross-user
route after every participating desktop has upgraded and successfully run
**Deploy / Repair Hooks**. Installing only the new app is not enough: an old
remote hook can still scan into another old receiver. During migration,
prefer a dropped event over delivery to the wrong desktop.

The default `account-default` mode does **not** support two profiles sharing
the same Unix account. If Clawd finds an owner conflict, an ownerless legacy
deployment, or a live remote Clawd using that account's default config, it
stops before mutation. Ownerless legacy traces always require explicit
confirmation; a local “deployed before” timestamp is not ownership proof.

An experimental `profile-isolated` runtime exists for validation builds only
and is hidden unless
`CLAWD_ENABLE_EXPERIMENTAL_REMOTE_ISOLATION=1` is set. It gives each profile
separate Claude/Codex/Copilot user config roots, sessions, Clawd files, and
wrapper commands. It is not released as supported shared-account isolation
until the real SSH/CLI matrix passes. It does not virtualize all of `HOME`:
the same Unix UID can read every profile, project-local config and some
caches remain shared, and Claude subscription auth on macOS remains shared
through Keychain. Only sessions launched through the displayed profile
wrapper are covered; bare `claude`, `codex`, or `copilot` keeps using the
account-default roots.

## Doctor vs. remote boundary

Doctor's **Agent integration** check only diagnoses local config — e.g. the
hook path in your local `~/.claude/settings.json`. It does **not** SSH into the
remote to inspect the remote's `~/.claude/settings.json`, `~/.codex/hooks.json`,
or `~/.copilot/hooks/hooks.json`.

So a local `broken path` only means your local Claude hook path is off; it
does not imply the remote SSH deployment failed. Check the **Hook status** and
deployment log inside the Remote SSH profile for the remote-side state.
Doctor also reports rejected Remote SSH ingress events and makes the
experimental isolation boundary visible, including inactive wrappers and an
interrupted runtime-mode transaction. It still does not treat local checks as
proof of a real remote CLI run.

## Troubleshooting

### No remote session shows up in Dashboard

Check the Remote SSH profile first:

- If Hook status is "Never deployed", click **Deploy / Repair Hooks**
- If status is "Connected" but Dashboard is empty, send a message in the remote agent to trigger a hook
- For Codex, the remote Codex may still need `/hooks` review

### Remote port conflict

After a healthy tunnel drops, the previous remote SSH session may still be
releasing its listening port. Clawd keeps the same port and retries a bounded
four times (about three minutes with the current backoff). You do not need to
change the profile while it says **Reconnecting**.

On a first connection, or if the port is still unavailable after that bounded
recovery, the conflict may be persistent. Try again later, or choose an unused
**Remote forward port** from `23333-23337`. If you change the port, run
**Deploy / Repair Hooks** before **Connect**: the secure identity, hook target,
permission URL, and health probe are pinned to one exact port. Clawd blocks an
ordinary Connect until the edited target has been deployed.

An older deployment record is cleanup history, not another active port slot.
Changing `23333 → 23334 → 23333` still requires deployment for the current
target; Clawd does not revive historical routing identity automatically.

### Remote has no Node.js

Deployment fails at the `check-node` step. Install Node.js on the remote first,
then redeploy. The security boundary comes from the pinned identity and
dedicated ingress, not from port secrecy.

Hermes does not change this: its deployment phase also runs through the remote
Node runtime, while the installed plugin itself runs under Hermes' own
virtualenv Python. If the Hermes phase fails because the `hermes` CLI cannot be
resolved, make it reachable as `<home>/hermes-agent/venv/bin/hermes`, as
`~/.local/bin/hermes`, or as `hermes` on the non-login `PATH`, then redeploy.

### Remote has no Node.js (Windows)

Install Node.js 14+ on the Windows remote and make `node` available on PATH to
the OpenSSH session, then run **Deploy / Repair Hooks** again. A Node version
manager available only in an interactive shell is not enough. If the Node
executable on PATH changes after deployment, deploy again to verify its new
path. Changing the OpenSSH default shell is not required.

### Remote hooks were taken over by local Clawd

Quit Clawd on the Windows remote, then run **Deploy / Repair Hooks**. Local
Clawd restores local hooks when it starts, including after Windows restarts
if **Launch at login** is enabled. This applies to Claude Code, Copilot CLI,
and Codex CLI hooks. The warning appears on the next connection or reconnect,
rather than during an already healthy connection. If Clawd cannot read or
parse the hook configuration, it reports that verification failed; check file
access and JSON before reconnecting or redeploying. For Codex, a missing or
BOM-prefixed `~\.codex\hooks.json` also requires a fresh deployment and
`/hooks` review.

### Can I open the SSH tunnel manually?

Not for the secure Remote SSH transport. The local target is a temporary,
profile-bound ingress rather than Clawd's general HTTP port. Use **Connect**
in the profile so Clawd can create and tear down that ingress together with
the tunnel. A hand-written `ssh -R ...:23333` to the general server port does
not implement the profile binding; secure nonce-bearing requests that arrive
there are rejected with 404.
