# Features

[Back to README](../../README.md)

## Animations & Interaction

- **Real-time state awareness** — agent hooks and log polling drive Clawd's animations automatically
- **12 animated states** — idle, thinking, typing, building, subagent groove, multi-subagent juggling, error, happy, notification, sweeping, carrying, sleeping
- **Codex Pet imports** — import Codex Pet zip packages from `Settings…` → `Theme`; Clawd adapts their atlas animations into managed themes
- **Eye tracking** — Clawd follows your cursor in idle state, with body lean and shadow stretch
- **Sleep sequence** — yawning, dozing, collapsing, sleeping after 60s idle; mouse movement triggers a startled wake-up animation
- **Click reactions** — double-click for a poke, 4 clicks for a flail
- **Drag from any state** — grab Clawd anytime (Pointer Capture prevents fast-flick drops), release to resume
- **Mini mode** — drag to right edge or right-click "Mini Mode"; Clawd hides at screen edge with peek-on-hover, mini alerts/celebrations, and parabolic jump transitions

## Permission Bubble

- **In-app permission review** — when a permission-capable integration sends a supported request, Clawd can pop a floating bubble card instead of waiting in the terminal; state-only agents keep their native permission flow
- **Allow / deny / agent-native extras** — one-click approve or reject, plus permission rules / `Always` actions when the source agent supports them
- **Permission handling modes** — choose **Ask every time**, confirmation-gated **Question prompts only** (tool-shaped requests from explicitly supported agents), or **Auto-approve**. Auto-approve handles every request the adapter marks automation-eligible—including unrecognized non-empty Claude/Qwen request names—but missing names, unsupported decision shapes, and CodeBuddy questions/plans still defer to the native flow. It downgrades after restart, and each eligible live session can independently choose Ask every time or tools-only. See the [setup guide](setup-guide.md#permission-handling-automation)
- **Optional remote approval** — Telegram and Feishu/Lark can mirror eligible pending requests while the local bubble remains available. A channel failure produces no remote decision and never a denial: the desktop request stays pending, while remote-only requests fall back to the agent only after every available client returns no decision
- **Global hotkeys** — `Ctrl+Shift+Y` to Allow, `Ctrl+Shift+N` to Deny the latest permission bubble (only registered while bubbles are visible)
- **Stacking layout** — multiple permission requests stack upward from the bottom-right corner
- **Auto-dismiss** — if you answer in the terminal first, the bubble disappears automatically
- **Per-agent toggle** — open `Settings…` → `AI Coding Tools`, expand an agent card, and turn off `Permission prompts as Clawd bubbles` to keep prompts in that agent's own terminal/TUI

## Remote Notifications

- **Telegram / Feishu (Lark)** — interactive remote approval: route permission requests to your phone and Allow/Deny them without touching the desktop
- **Slack** — **notification-only**: task **done**, **errors**, and **permission requests** are pushed via a Slack Incoming Webhook (or an optional `xoxb-` bot token + channel id) as rich Block Kit cards. Slack cannot Allow or Deny in this version — a permission message is an announcement, and you decide in the desktop app. Configure it next to Telegram/Feishu in the remote approval channels; secrets are stored locally in an env file outside prefs (`0600` on macOS/Linux; Windows relies on the AppData ACL), and everything degrades gracefully when unconfigured or offline. Messages can carry the session title, folder, and host name, so a **private channel is recommended** — see [slack-notifications.md](slack-notifications.md)

## Session Intelligence

- **Multi-session tracking** — sessions across all agents resolve to the highest-priority state
- **Subagent awareness** — headphones groove for 1 subagent, three-ball juggling for 2+
- **Sessions dashboard + HUD** — right-click or tray → `Open Dashboard` to inspect live sessions, recent events, aliases, and jump to a terminal; a compact HUD near Clawd keeps current live sessions visible
- **Private local recap** — `Settings → Recap` (or right-click → `Open Recap`) reviews accepted agent activity by hour/day for today, week, month, or year. It distinguishes unsupported metrics from zero and uncovered time from quiet time, keeps DND activity, stores only minimized local data, and adds no telemetry, export, sharing, token, cost, duration, streak, or productivity score. See the [recap guide](recap.md).
- **Subscription quota at a glance** — optional Orbit rings beside the pet and detailed Dashboard bars show the quota windows reported by supported agents. Local Claude collection is off by default and uses Claude Code's [official status-line `rate_limits` payload](https://code.claude.com/docs/en/statusline); it does not make an additional request to Anthropic. See the [data-flow and ownership notes](setup-guide.md#claude-code-subscription-quota-official-status-line-not-scraping).
- **Terminal focus** — Dashboard/HUD actions jump to a specific session's terminal window; notification/attention states auto-focus the relevant terminal
- **Process liveness detection** — detects crashed/exited supported agent processes and cleans up orphan sessions
- **Startup recovery** — if Clawd restarts while any supported agent is still running, it stays awake instead of falling asleep

## Mobile Companion (PWA)

- **Live mirror on your phone** — enable `Settings…` → `Mobile / PWA` and open the pairing URL on your phone; the Clawd Mobile web app shows your agent sessions and their live states in real time
- **Read-only by design** — the LAN bridge only broadcasts state; nothing in the PWA can touch your machine (LAN PWA approval is on the roadmap; Telegram and Feishu/Lark are separate supported channels)
- **LAN-only + token-gated** — pairing requires a token, tokens rotate automatically with a grace window, and access can be regenerated or reset in one click
- **Installable** — it's a PWA: add it to your home screen for an app-like experience
> The mobile companion line — from the first prototype to token rotation — is built and led by core contributor [@Bynlk](https://github.com/Bynlk), who also maintains [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile), a sister fork with a native Android app.

## System

- **Click-through** — transparent areas pass clicks to windows below; only Clawd's body is interactive
- **Position memory** — Clawd remembers where you left it across restarts (including mini mode)
- **Single instance lock** — prevents duplicate Clawd windows
- **Auto-start** — Claude Code's SessionStart hook can launch Clawd automatically if it's not running
- **Do Not Disturb** — right-click or tray menu to enter sleep mode; the pet stops reacting until you wake Clawd. DND suppresses things that ask you to act, not status: remote **completion** notifications (Telegram/Slack) still arrive, since they are the point of walking away. Permission bubbles are suppressed during DND — Codex, opencode, and MiMo Code fall back to their native prompts, while Claude Code and CodeBuddy fall back to their built-in permission flow. WorkBuddy uses state + Notification only; Antigravity and Pi are state-only integrations.
- **Sound effects** — short audio cues on task completion and permission requests (toggle via the system tray or Settings; 10s cooldown, auto-muted during DND)
- **System tray** — DND mode, auto-start, check for updates
- **i18n** — English, Simplified Chinese, Traditional Chinese, Korean, Japanese, Brazilian Portuguese, and Spanish UI; switch in Settings → General
- **Auto-update** — checks GitHub releases; Windows installs NSIS updates on quit, macOS/Linux `git pull` + restart when running from a cloned repo

## Multi-display

Clawd adapts to multi-monitor setups: proportional sizing uses the display Clawd launches on, portrait monitors get a bounded boost so the pet stays readable on tall narrow screens, and you can drag Clawd across displays.

<p align="center"><sub>Want to see the real multi-monitor behavior? <a href="../../assets/videos/clawd-multi-monitor-demo.mp4">Watch the demo video in this repository</a>.</sub></p>

## Custom Themes

Clawd supports custom themes — replace the default crab with your own character and animations. If you already have a Codex Pet package, import its zip from `Settings…` → `Theme` → `Import pet zip`; Clawd turns the atlas into a managed theme automatically.

**Quick start:**
1. Scaffold a theme:
   ```bash
   node scripts/create-theme.js my-theme
   # or
   npm run create-theme -- my-theme
   ```
   No argument also works: it creates the next available `my-theme` scaffold in your user themes directory.
2. Edit `theme.json` and create your assets (SVG, GIF, APNG, WebP, PNG, JPG, or JPEG)
3. Restart Clawd or open `Settings…` → `Theme` → select your theme

**Minimum viable theme:** 1 SVG (idle with eye tracking) + 7 GIF/APNG files (thinking, working, error, happy, notification, sleeping, waking). Eye tracking can be disabled to use any format for all states.

Validate your theme before distributing:
```bash
node scripts/validate-theme.js path/to/your-theme
```

Theme cards in `Settings…` → `Theme` now expose capability badges such as `Tracked idle`, `Static theme`, `Mini`, `Direct sleep`, and `No reactions`, so users can tell what a theme supports before switching.

See [docs/guides/guide-theme-creation.md](guide-theme-creation.md) for the full creation guide with tiered paths (beginner → advanced), `theme.json` field reference, and asset guidelines.

> Third-party SVG files are automatically sanitized for security.

## Roadmap

Some things we'd like to explore in the future:

- Codex terminal focus via process tree lookup from `codex.exe` PID
- Hook uninstall script for clean app removal
- LAN PWA mobile companion: in-browser permission approval (in progress, led by [@Bynlk](https://github.com/Bynlk)); Telegram and Feishu/Lark approval are separate supported channels
