# Clawd Mobile Protocol v1

## Scope

Mobile v1 is an opt-in, read-only preview for watching Clawd from a phone or
another browser. M2 Slice 2 adds read-only observation of selected permission
requests behind a separate, default-off consent setting.

The permission preview contains only a random request ID, agent ID, tool name,
best-effort-redacted summary, project-folder basename, and the time when the
desktop bubble content was sent. It does not directly serialize raw tool input,
command/query fields, prompts, full cwd paths, suggestions, responses,
transcripts, or tool output. The summary is free text and may paraphrase content
from those fields, so redaction remains best-effort rather than a secrecy
guarantee. A successful content send does not prove that a person saw the
desktop bubble.

Mobile v1 cannot approve or deny a request, answer elicitation, grant session
trust, focus/control a terminal, or otherwise change desktop or agent state.
Existing desktop and remote decision channels remain authoritative.

## Architecture

```text
Clawd Desktop
  state engine          permission owner
       |                       |
       |                 sanitized projection
       +-----------+-----------+
                   v
       LAN WebSocket bridge (0.0.0.0:<port>)
          |-- HTTP static server for /mobile/*
          `-- WebSocket /ws?token=<hex>
                         |
                         v
              read-only PWA renderer
```

Session updates are driven by runtime snapshot broadcasts. Permission updates
are driven synchronously by the permission owner; the bridge does not poll or
inspect raw pending permission entries.

## Security and consent model

- **Consent**: session preview and permission preview are separate settings.
  Permission preview defaults to off and requires an explicit disclosure.
- **Token**: a global 32-character hex token is stored in
  `~/.clawd/mobile-token.json` and is required during WebSocket upgrade.
- **All token holders**: there is no device roster or per-device permission
  entitlement. When permission preview is enabled, every client holding the
  current token can receive the same projection.
- **Transport**: traffic uses plaintext WebSocket with no TLS. Permission
  summaries and the token are not protected against network observation.
- **Binding**: the server listens on `0.0.0.0:<port>`. This makes same-network
  use possible but does not technically enforce LAN isolation. Do not expose
  the port to the Internet or any untrusted network.
- **Redaction**: summary redaction is a best-effort, high-confidence display
  safety net, not a complete secret scanner. Model-written prose can repeat
  sensitive content that a generic redactor does not recognize.
- **Auth failure**: invalid tokens close with WebSocket code 1008.
- **Rate limit**: at most 60 inbound client messages per 60 seconds per client.
- **Max clients**: 10 concurrent WebSocket clients.

Reset-token-and-enable is the recommended permission-preview setup because it
invalidates all previously paired clients. Keeping the token is supported only
as explicit consent for every existing and offline token holder.

When the user enables permission preview while keeping the token, the desktop
closes current sockets with code 4001 and reason
`Permission preview consent changed`. This is a consent-boundary refresh, not
revocation: the PWA marks cached permission cards stale and reconnects with the
unchanged token to receive authoritative snapshots. A reset uses code 1008,
clears permission cards/notifications, stops reconnecting, and requires pairing
with the new token.

## Connection and ordering

```text
Mobile                                      Desktop
  |                                           |
  | 1. Open /mobile/?host=&port=&token=      |
  | 2. WS connect /ws?token=<hex>            |
  |------------------------------------------>|
  |                                           | validate token
  |                                           | reject -> close 1008
  |<------------------------------------------|
  | 3. snapshot                              |
  |<------------------------------------------|
  | 4. permission_snapshot                   |
  |<------------------------------------------|
  | 5. state/session/permission deltas       |
```

For a newly connected socket, the desktop adds the client and then sends
`snapshot` followed immediately by `permission_snapshot` in one synchronous
JavaScript turn. Later deltas on that same WebSocket follow those snapshots.
WebSocket FIFO ordering is relied on only within one live socket; after a
reconnect, the new authoritative snapshots replace the client's old state.

## Message envelope

Every server message is JSON and includes:

| Field | Type | Description |
| --- | --- | --- |
| `version` | string | Always `"v1"` |
| `type` | string | Message type |
| `timestamp` | number | Desktop Unix time in milliseconds |

Unknown message types and additive fields must be ignored by clients.

## Server to client

### `snapshot`

Initial authoritative session snapshot. `features.permissionPreview` lets new
clients distinguish an older desktop from a supported-but-disabled feature.

```json
{
  "version": "v1",
  "type": "snapshot",
  "timestamp": 1717200000000,
  "features": {
    "permissionPreview": {
      "supported": true,
      "enabled": false
    }
  },
  "sessions": {
    "abc123": {
      "sessionId": "abc123",
      "title": "Fix auth bug",
      "basename": "project",
      "state": "working",
      "recentEvents": [
        { "event": "PreToolUse", "at": 1717199990000, "state": "working" }
      ]
    }
  }
}
```

Session preview entries contain `sessionId`, sanitized `title`, cwd basename,
display `state`, and recent `{event, at, state}` metadata. They do not contain
tool input, prompts, full cwd, transcript, or assistant/tool output.

### `state`

Incremental session-preview upsert.

```json
{
  "version": "v1",
  "type": "state",
  "timestamp": 1717200001000,
  "sessionId": "abc123",
  "data": {
    "sessionId": "abc123",
    "title": "Fix auth bug",
    "basename": "project",
    "state": "thinking",
    "recentEvents": []
  }
}
```

### `session_deleted`

Removes one session from the client cache.

```json
{
  "version": "v1",
  "type": "session_deleted",
  "timestamp": 1717200002000,
  "sessionId": "abc123"
}
```

### `permission_snapshot`

An unconditional, authoritative replacement of the complete safe permission
projection. It is sent on every connection, including while disabled or empty,
and is also sent when the feature is enabled, disabled, or rebuilt.

```json
{
  "version": "v1",
  "type": "permission_snapshot",
  "timestamp": 1717200003000,
  "feature": {
    "supported": true,
    "enabled": true
  },
  "permissions": []
}
```

### `permission_request`

Idempotent upsert of one safe permission record.

```json
{
  "version": "v1",
  "type": "permission_request",
  "timestamp": 1717200004000,
  "permission": {
    "requestId": "0123456789abcdef0123456789abcdef",
    "agentId": "claude-code",
    "toolName": "Bash",
    "summary": "Run the project tests",
    "folder": "clawd-on-desk",
    "presentedAt": 1717200003900
  }
}
```

The exact record keys are:

| Field | Type | Description |
| --- | --- | --- |
| `requestId` | string | Random, opaque 32-hex request ID |
| `agentId` | string | Sanitized agent identifier |
| `toolName` | string | Sanitized display tool name |
| `summary` | string | Best-effort-redacted operation summary |
| `folder` | string | Project cwd basename only |
| `presentedAt` | number | Desktop time after bubble content IPC was sent |

The PWA derives waiting age from
`max(0, envelope.timestamp - presentedAt)` plus local monotonic elapsed time.
It does not display a deadline or countdown.

### `permission_dismissed`

Idempotently removes one permission record.

```json
{
  "version": "v1",
  "type": "permission_dismissed",
  "timestamp": 1717200005000,
  "requestId": "0123456789abcdef0123456789abcdef",
  "reason": "resolved",
  "decided": true
}
```

`reason` is one of `resolved`, `timeout`, `agent_gone`,
`handed_to_terminal`, `suppressed`, or `cancelled`. `decided` means Clawd
observed a real decision or submitted one through an existing desktop/remote
path. It is not a transport-delivery acknowledgement.

### `token_rotate`

Automatic token rotation occurs approximately every 24 hours. The server
persists a new token with a five-minute grace window for the previous token and
sends connected or grace-authenticated clients:

```json
{
  "version": "v1",
  "type": "token_rotate",
  "timestamp": 1717200006000,
  "newToken": "fedcba9876543210fedcba9876543210",
  "expiresAt": 1717200306000
}
```

Clients persist `newToken` and reply with `token_rotate_ack`. The server may
retry an unacknowledged rotation and close a client with code 1008 when the
rotation cannot be completed. Explicit regenerate/reset is different: it has no
grace period, immediately invalidates the old token, and closes old clients with
code 1008 so they must pair again.

## Client to server

### `token_rotate_ack`

```json
{ "type": "token_rotate_ack" }
```

This is the only recognized client message and carries no permission decision.
All other messages are rate-limited and ignored. In particular, a well-formed
`permission_response` cannot resolve, mutate, or remove a permission request.

## PWA notifications

While the PWA is not visible, a newly received live `permission_request` may
create a generic notification such as “Clawd has a pending permission request.”
The lock-screen notification does not include summary, folder, cwd, command, or
other free-form model text. Snapshots, reconnects, and duplicate upserts do not
notify. Retraction, authoritative replacement, feature disable, and access reset
close matching notifications when the browser API permits it.

The default pairing URL uses plaintext `http://<lan-ip>:<port>`. That origin is
not a secure context in standards-compliant mobile browsers, so Service Workers
and the Web Notifications API are normally unavailable there. In-page permission
cards remain the supported notification surface for the default LAN transport;
system/lock-screen notifications are only a progressive enhancement when the
browser exposes the required APIs. Enabling notifications for the browser app at
the operating-system level does not grant those APIs to an insecure site.

## Settings connection info

The desktop Settings panel reads connection information through Electron IPC.
Before the bridge finishes listening it reports `status:"starting"`; once
ready it reports LAN IP, port, token, and a pairing URL. The public
`/api/connection-info` endpoint intentionally does not return the token.

## Limitations and future work

- Plaintext WebSocket; no TLS or cryptographic LAN isolation.
- The default plaintext LAN origin cannot rely on Service Workers, offline cache,
  or system notifications; the live in-page card works without those APIs.
- One global token and one global consent setting; no device roster or
  per-device permission-preview access.
- Best-effort redaction can miss sensitive content repeated in model prose.
- Presentation means bubble content IPC was sent, not that a human saw it.
- Maximum 10 concurrent PWA clients.
- Remote approval, elicitation answers, terminal control, transcript sync, and
  secure Internet relay remain out of scope. Any future decision protocol needs
  separate authorization, auditability, and fallback design; it is not implied
  by these additive v1 observation messages.
