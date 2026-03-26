# @clawd/opencode-plugin

Clawd Desktop Pet plugin for OpenCode/Crush coding agents.

## Automatic Installation

Clawd auto-registers this plugin on launch. Just start Clawd and it will detect your OpenCode config file and add the plugin path. Restart OpenCode/Crush after the plugin is registered.

## Manual Installation

If you prefer to configure manually, add to your `opencode.json`:

```json
{
  "plugin": ["file:///path/to/clawd-on-desk/plugins/opencode/clawd-opencode-plugin.js"]
}
```

Or run the installer directly:

```bash
node plugins/opencode/install.cjs
```

### NPM Package (If Published)

```json
{
  "plugin": ["@clawd/opencode-plugin"]
}
```

### Local NPM Link

```bash
cd clawd-on-desk/plugins/opencode
npm link

# In your project
npm link @clawd/opencode-plugin
```

Then add to `opencode.json`:

```json
{
  "plugin": ["@clawd/opencode-plugin"]
}
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWD_HOST` | `127.0.0.1` | Clawd HTTP server host |
| `CLAWD_PORT` | `23333` | Clawd HTTP server port |
| `CLAWD_TIMEOUT` | `500` | HTTP request timeout (ms) |

## Events Supported

| OpenCode Event | Clawd State |
|----------------|-------------|
| `session.created` | `idle` |
| `session.deleted` | `sleeping` |
| `session.error` | `error` |
| `chat.message` | `thinking` |
| `tool.execute.before` | `working`/`thinking` |
| `tool.execute.after` | `working`/`error` |
| `command.execute.before` | `working`/`thinking` |
| `experimental.session.compacting` | `sweeping` |
| `permission.ask` | `attention` |

## How It Works

The plugin subscribes to OpenCode's event system and sends state updates to Clawd's HTTP server. Clawd then animates the desktop pet based on the current state.

The plugin reuses the same process tree walking logic from `hooks/clawd-hook.js` to:
- Find the stable terminal PID for window focus
- Detect the editor (VS Code / Cursor) for tab focus
- Track the OpenCode process for liveness detection

## Requirements

- OpenCode or Crush CLI installed
- Clawd Desktop Pet running
- Node.js 18+
