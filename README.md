<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk</h1>
<p align="center">
  <a href="README.zh-CN.md">中文版</a>
</p>

A desktop pet that reacts to your AI coding agent sessions in real-time. Clawd lives on your screen — thinking when you prompt, typing when tools run, juggling subagents, reviewing permissions, celebrating when tasks complete, and sleeping when you're away. Ships with two built-in themes: **Clawd** (pixel crab) and **Calico** (三花猫), with full support for custom themes.

> Supports Windows 11, macOS, and Ubuntu/Linux. Requires Node.js. Works with **Claude Code**, **Codex CLI**, **Copilot CLI**, **Gemini CLI**, **Cursor Agent**, **Kiro CLI**, and **opencode**.

## Features

### Multi-Agent Support
- **Claude Code** — full integration via command hooks + HTTP permission hooks
- **Codex CLI** — automatic JSONL log polling (`~/.codex/sessions/`), no configuration needed
- **Copilot CLI** — command hooks via `~/.copilot/hooks/hooks.json`
- **Gemini CLI** — command hooks via `~/.gemini/settings.json` (registered automatically when Clawd starts, or run `npm run install:gemini-hooks`)
- **Cursor Agent** — [Cursor IDE hooks](https://cursor.com/docs/agent/hooks) in `~/.cursor/hooks.json` (registered automatically when Clawd starts, or run `npm run install:cursor-hooks`)
- **Kiro CLI** — command hooks injected into custom agent configs under `~/.kiro/agents/`, plus an auto-created `clawd` agent that is re-synced from Kiro's built-in `kiro_default` whenever Clawd starts, so you can opt into hooks with minimal behavior drift via `kiro-cli --agent clawd` or `/agent swap clawd` (registered automatically when Clawd starts, or run `npm run install:kiro-hooks`). State hooks have been verified on macOS.
- **opencode** — [plugin integration](https://opencode.ai/docs/plugins) via `~/.config/opencode/opencode.json` (registered automatically when Clawd starts); zero-latency event streaming, permission bubbles with Allow/Always/Deny, and building animations when parallel subagents are spawned via the `task` tool
- **Multi-agent coexistence** — run all agents simultaneously; Clawd tracks each session independently

### Animations & Interaction
- **Real-time state awareness** — agent hooks and log polling drive Clawd's animations automatically
- **12 animated states** — idle, thinking, typing, building, juggling, conducting, error, happy, notification, sweeping, carrying, sleeping
- **Eye tracking** — Clawd follows your cursor in idle state, with body lean and shadow stretch
- **Sleep sequence** — yawning, dozing, collapsing, sleeping after 60s idle; mouse movement triggers a startled wake-up animation
- **Click reactions** — double-click for a poke, 4 clicks for a flail
- **Drag from any state** — grab Clawd anytime (Pointer Capture prevents fast-flick drops), release to resume
- **Mini mode** — drag to right edge or right-click "Mini Mode"; Clawd hides at screen edge with peek-on-hover, mini alerts/celebrations, and parabolic jump transitions

### Permission Bubble
- **In-app permission review** — when Claude Code requests tool permissions, Clawd pops a floating bubble card instead of waiting in the terminal
- **Allow / Deny / Suggestions** — one-click approve, reject, or apply permission rules (e.g. "Always allow Read")
- **Global hotkeys** — `Ctrl+Shift+Y` to Allow, `Ctrl+Shift+N` to Deny the latest permission bubble (only registered while bubbles are visible)
- **Stacking layout** — multiple permission requests stack upward from the bottom-right corner
- **Auto-dismiss** — if you answer in the terminal first, the bubble disappears automatically

### Session Intelligence
- **Multi-session tracking** — sessions across all agents resolve to the highest-priority state
- **Subagent awareness** — juggling for 1 subagent, conducting for 2+
- **Terminal focus** — right-click Clawd → Sessions menu to jump to a specific session's terminal window; notification/attention states auto-focus the relevant terminal
- **Process liveness detection** — detects crashed/exited agent processes (Claude Code, Codex, Copilot) and cleans up orphan sessions
- **Startup recovery** — if Clawd restarts while any agent is running, it stays awake instead of falling asleep

### System
- **Click-through** — transparent areas pass clicks to windows below; only Clawd's body is interactive
- **Position memory** — Clawd remembers where you left it across restarts (including mini mode)
- **Single instance lock** — prevents duplicate Clawd windows
- **Auto-start** — Claude Code's SessionStart hook can launch Clawd automatically if it's not running
- **Do Not Disturb** — right-click or tray menu to enter sleep mode; all hook events are silenced until you wake Clawd. Permission bubbles are suppressed during DND — opencode falls back to its built-in TUI prompt, and Claude Code will handle permissions automatically
- **Sound effects** — short audio cues on task completion and permission requests (toggle via right-click menu; 10s cooldown, auto-muted during DND)
- **System tray** — resize (S/M/L), DND mode, language switch, auto-start, check for updates
- **i18n** — English and Chinese UI; switch via right-click menu or tray
- **Auto-update** — checks GitHub releases; Windows installs NSIS updates on quit, macOS/Linux `git pull` + restart when running from a cloned repo

## Animations

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>Idle</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>Thinking</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>Typing</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>Building</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>Juggling</sub></td>
    <td align="center"><img src="assets/gif/clawd-conducting.gif" width="100"><br><sub>Conducting</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/clawd-error.gif" width="100"><br><sub>Error</sub></td>
    <td align="center"><img src="assets/gif/clawd-happy.gif" width="100"><br><sub>Happy</sub></td>
    <td align="center"><img src="assets/gif/clawd-notification.gif" width="100"><br><sub>Notification</sub></td>
    <td align="center"><img src="assets/gif/clawd-sweeping.gif" width="100"><br><sub>Sweeping</sub></td>
    <td align="center"><img src="assets/gif/clawd-carrying.gif" width="100"><br><sub>Carrying</sub></td>
    <td align="center"><img src="assets/gif/clawd-sleeping.gif" width="100"><br><sub>Sleeping</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>Calico Idle</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>Calico Thinking</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>Calico Typing</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>Calico Building</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>Calico Juggling</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>Calico Conducting</sub></td>
  </tr>
</table>

Full event-to-state mapping, mini mode, and click reactions: **[docs/state-mapping.md](docs/state-mapping.md)**

## Quick Start

```bash
# Clone the repo
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Install dependencies
npm install

# Start Clawd in foreground (auto-registers Claude Code hooks on launch)
npm start

# Start Clawd in background and release the terminal
npm run start:daemon
```

If you do not want a terminal window involved at all, build the macOS app with
`npm run build:mac` and launch the generated `.app` normally. The tray menu
also exposes `Open at Login`, which writes the OS login item / autostart entry.

**Claude Code** and **Codex CLI** work out of the box. Other agents (Copilot, Kiro, etc.) need one-time setup. Also covers remote SSH, WSL, and platform-specific notes (macOS / Linux): **[docs/setup-guide.md](docs/setup-guide.md)**

## Known Limitations

Some agents have feature gaps (no permission bubble, polling latency, no terminal focus). See the full table: **[docs/known-limitations.md](docs/known-limitations.md)**

## Custom Themes

Clawd supports custom themes — replace the default crab with your own character and animations.

**Quick start:**
1. Copy `themes/template/` to your themes directory:
   - Windows: `%APPDATA%/clawd-on-desk/themes/my-theme/`
   - macOS: `~/Library/Application Support/clawd-on-desk/themes/my-theme/`
   - Linux: `~/.config/clawd-on-desk/themes/my-theme/`
2. Edit `theme.json` and create your assets (SVG, GIF, APNG, or WebP)
3. Right-click Clawd → Theme → select your theme

**Minimum viable theme:** 1 SVG (idle with eye tracking) + 7 GIF/APNG files (thinking, working, error, happy, notification, sleeping, waking). Eye tracking can be disabled to use any format for all states.

Validate your theme before distributing:
```bash
node scripts/validate-theme.js path/to/your-theme
```

See [docs/guide-theme-creation.md](docs/guide-theme-creation.md) for the full creation guide with tiered paths (beginner → advanced), `theme.json` field reference, and asset guidelines.

> Third-party SVG files are automatically sanitized for security.

### Roadmap

Some things we'd like to explore in the future:

- Codex terminal focus via process tree lookup from `codex.exe` PID
- Auto-registration of Copilot CLI hooks (like we do for Claude Code)
- Theme registry and in-app download
- Hook uninstall script for clean app removal

## Contributing

Clawd on Desk is a community-driven project. Bug reports, feature ideas, and pull requests are all welcome — open an [issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues) to discuss or submit a PR directly.

### Contributors

Thanks to everyone who has helped make Clawd better:

<table>
  <tr>
    <td align="center"><a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /><br /><sub>PixelCookie-zyf</sub></a></td>
    <td align="center"><a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /><br /><sub>yujiachen-y</sub></a></td>
    <td align="center"><a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /><br /><sub>AooooooZzzz</sub></a></td>
    <td align="center"><a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /><br /><sub>purefkh</sub></a></td>
    <td align="center"><a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /><br /><sub>Tobeabellwether</sub></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /><br /><sub>Jasonhonghh</sub></a></td>
    <td align="center"><a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /><br /><sub>crashchen</sub></a></td>
    <td align="center"><a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /><br /><sub>hongbigtou</sub></a></td>
    <td align="center"><a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /><br /><sub>InTimmyDate</sub></a></td>
    <td align="center"><a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /><br /><sub>NeizhiTouhu</sub></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /><br /><sub>xu3stones-cmd</sub></a></td>
    <td align="center"><a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /><br /><sub>androidZzT</sub></a></td>
    <td align="center"><a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /><br /><sub>Ye-0413</sub></a></td>
    <td align="center"><a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /><br /><sub>WanfengzzZ</sub></a></td>
    <td align="center"><a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /><br /><sub>TaoXieSZ</sub></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /><br /><sub>ssly</sub></a></td>
    <td align="center"><a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /><br /><sub>stickycandy</sub></a></td>
    <td align="center"><a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /><br /><sub>Rladmsrl</sub></a></td>
    <td align="center"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /><br /><sub>YOIMIYA66</sub></a></td>
    <td align="center"><a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /><br /><sub>Kevin7Qi</sub></a></td>
  </tr>
</table>

## Acknowledgments

- Clawd pixel art reference from [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- Shared on [LINUX DO](https://linux.do/) community

## License

Source code is licensed under the [MIT License](LICENSE).

**Artwork (assets/) is NOT covered by MIT.** All rights reserved by their respective copyright holders. See [assets/LICENSE](assets/LICENSE) for details.

- **Clawd** character is the property of [Anthropic](https://www.anthropic.com). This is an unofficial fan project, not affiliated with or endorsed by Anthropic.
- **Calico cat (三花猫)** artwork by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). All rights reserved.
- **Third-party contributions**: copyright retained by respective artists.
