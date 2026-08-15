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
- At least one supported remote agent is installed on the remote: Claude Code, Codex CLI, or Copilot CLI

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
3. If SSH needs first-time host-key confirmation, a passphrase, or an ssh-agent load, click **Authenticate**. Clawd opens your system terminal to run a plain `ssh` once.
4. Click **Deploy / Repair Hooks**, then connect the profile.
   - Clawd creates a dedicated local ingress for this profile and maintains an `ssh -R` reverse tunnel to that ingress
   - It writes a profile identity atomically, pins hooks and the static Claude permission URL to the profile's exact remote port, and never exposes the general local `/state` or `/permission` routes to the tunnel
   - Then it copies hook files from the currently installed Clawd to the resolved remote runtime layout
   - Then it registers Claude Code hooks, Codex official hooks, and Copilot CLI hooks in remote mode when the matching remote agent is installed
   - Connection / deployment logs are shown directly below the profile
5. Start Claude Code, Codex CLI, or Copilot CLI on the remote. The Dashboard will show the session once the first remote hook event arrives.

For remote-only Copilot CLI tracking on a fresh local install, turn on
**Copilot CLI** in **Settings → Agents** so Clawd accepts those remote hook
events. You do not need to click **Install** unless you also want local Copilot
hooks on this machine.

If the profile has **Auto-start Codex fallback monitor on connect** enabled,
Clawd launches `~/.claude/hooks/codex-remote-monitor.js` as connection
maintenance. On a serialized transport it finishes this one-shot maintenance
before starting the persistent reverse tunnel; automatic tunnel reconnects do
not replay the monitor mutation.
The fallback is not needed when Codex official hooks are working.

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

## Key concepts

The `127.0.0.1:<port>` shown in Doctor is normal — it's the Clawd HTTP service
on **your** machine, not an IP on the remote cluster. Remote hooks don't reach
your LAN IP directly either.

The actual chain is:

```
Remote Claude/Codex/Copilot hook
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
- For remote-only Copilot CLI on a fresh local install, local **Settings → Agents → Copilot CLI** is turned on

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

### Can I open the SSH tunnel manually?

Not for the secure Remote SSH transport. The local target is a temporary,
profile-bound ingress rather than Clawd's general HTTP port. Use **Connect**
in the profile so Clawd can create and tear down that ingress together with
the tunnel. A hand-written `ssh -R ...:23333` to the general server port does
not implement the profile binding; secure nonce-bearing requests that arrive
there are rejected with 404.
