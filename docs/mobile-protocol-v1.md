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
- **Token**: every paired device has its own token. Device state is stored in
  `~/.clawd/mobile-devices.json`; tokens are hashed except the staged next token.
  Files and same-directory atomic-write temporary files use mode 0600 on POSIX;
  writes are fsynced before rename (process-crash recovery, not a power-loss guarantee).
- **Authorized devices**: all paired devices (including pending first connections)
  and devices still holding the old shared token receive the same projection when
  permission preview is enabled. There is no per-device permission entitlement.
- **Legacy compatibility**: the old shared token in `~/.clawd/mobile-token.json`
  stops rotating and remains valid until explicitly revoked. The previous token
  still in grace at upgrade is retained indefinitely after its hash is persisted.
  Old JavaScript does not send `proto=2`, never receives rotation messages or 4002,
  and continues using the shared token. New JavaScript migrates using a saved cid.
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

Reset-access-and-enable is the recommended permission-preview setup. Keeping
access explicitly authorizes all paired devices, including those awaiting their
first connection, and devices still holding the old shared token. Keeping access
closes both data and pairing sockets with code 4001 and reason
`Permission preview consent changed`; clients reconnect for fresh snapshots.
Cached permission cards become stale while disconnected.

### Revocation and reset

Settings → Permissions → LAN approval → Paired devices lists pending and active
devices, with actions to revoke one device or the old shared token.

These are synchronous desktop operations. Removing one device persists its
removal before closing its connections with 1008 `device-revoked`. A migrated
device may still hold the shared token (`mayHoldLegacy: true`), so revoke that
shared token as well to fully cut off access.

Revoking the shared token first overwrites `mobile-token.json` with an unheld
random placeholder, then immediately invalidates legacy connections, then writes
its dead hash and an empty grace list to the device file. Device tokens remain
valid. Reset phone access uses the same first step, then writes an empty device
list and a new pairing code, and only after that succeeds closes device/pairing
connections with 1008 `access-reset`. Both files must be written successfully for
reset to succeed. A failure in the first write leaves all credentials unchanged;
a failure in the device-file write reports `partialReset: true`: the shared token
is already invalid but device tokens remain valid. Permission preview is not
enabled on a failed reset. If reset succeeds and saving preferences then fails,
`tokenReset` / `rePairRequired` tell the UI that re-pairing is already necessary.

Legacy validity is reconstructed from `mobile-token.json` on every startup; stale
device-file grace hashes cannot resurrect a token removed from that file. A
failed bookkeeping write may leave the unheld placeholder accepted after restart,
but nobody was issued it. Downgrading to a desktop that still rotates the shared
token and upgrading again recognizes that file's current token and eligible
previous token.

## Connection and ordering

Pair from `http://<lan-ip>:<port>/mobile/?pair=CODE`, or enter the displayed code
in the PWA. The target is the page's own hostname and port; old `host` / `port`
query parameters cannot redirect it. Old bookmarked `?token=` links still migrate.

| WebSocket parameter | Meaning |
| --- | --- |
| `token` | Device current/staged token or old shared token |
| `proto=2` | Client supports device-token rotation; envelope stays `"v1"` |
| `cid` | Installation ID matching `^c_[A-Za-z0-9_-]{22}$`, not a credential |
| `pair` | Pairing code; requires `proto=2` and valid cid |

A data connection authenticates, joins the broadcast set, then receives
`snapshot` followed by `permission_snapshot` synchronously in one JavaScript
turn, before deltas or any needed `token_rotate`. Reconnect snapshots replace
cached state. Same-device connections can coexist; no connection replaces another
merely for sharing a token. Ten data connections may be online concurrently.

### Pairing

Codes are eight Crockford base32 characters (40 bits), displayed as `K7Q2-9MXA`;
input is case insensitive and ignores hyphens. Display codes expire after ten
minutes, and refresh on claim, expiry or the desktop refresh button. A claim
atomically creates a pending device with staged B and changes the display code.
The claimed code remains bound to the original cid until B first authenticates,
so a dropped reply or a storage failure can retry the same code and receive the
same B even after ten minutes or a desktop restart. Other cids get 4004.
Promotion clears the claimed code permanently. Pending devices do not expire or
automatically evict; twenty devices including pending is the limit. At capacity,
a bound pending claim can still retry; a new claim gets 4005 without consuming its
code. Re-pairing an active cid creates a new device and does not delete the old one.

Pairing sockets only receive `token_rotate`, never session or permission data.
They use a separate four-socket limit and close after sixty seconds. Per IP,
twenty failed pairing attempts in a rolling ten-minute window are allowed; the
21st is rejected before checking the code. Guessing probability per IP per code
window is approximately 20 / 2^40; plaintext network observers can see codes and
tokens directly.

### Client persistence

New JavaScript uses `clawd-cid-v2` and
`clawd-cred-v2 = {host, port, deviceId, gen, token, prevToken}`. It saves and
reads back credentials before changing memory or acknowledging. Generation is
compared only within the same device. Legacy migration writes only into empty
credential storage; explicit pairing may replace another device. Delayed old
device messages cannot overwrite a new pairing. First migration/pairing sets
`prevToken: null`. A later device rotation saves only that device's previous token.

A successful first write also attempts `clawd-v2-migrated = "1"`. Once present,
old `clawd-history` is never read again; new JavaScript never writes it. Startup
repairs a missing marker when credentials exist. Before re-pairing deletes
credentials it must save and verify the marker, or leave credentials intact and
report a storage error. Without working cid storage a legacy connection omits
`proto=2`; pairing cannot start.

On 1008, reread storage and retry a different latest token (at most three
consecutive switches); a device may then try its own prevToken once. Only that
attempt's snapshot may restore unchanged saved credentials to gen 0, with
prevToken cleared, after a verified write. Otherwise show the pairing input;
a spare URL pairing code can automatically re-pair. A storage event can recover
an auth-failed tab. Connection status and retry-backoff reset happen on snapshot,
not WebSocket open. Only a snapshot authenticated with the matching locally saved
device token clears the URL. Legacy snapshots preserve the URL until migration
completes. Pairing sockets never receive snapshots.

### Close codes

| Code | Reason | Client behavior |
| --- | --- | --- |
| 1008 | `invalid-token`, `device-revoked`, `legacy-revoked`, `access-reset` | Reread saved credentials, try own previous token once, then re-pair |
| 1013 | `server-busy` | Data connection limit; backoff/retry |
| 4001 | `Permission preview consent changed` | Reconnect for fresh consent-bound snapshots |
| 4002 | `token-rotated` | Only proto2 device sockets still on the old token after promotion; reread/reconnect immediately |
| 4003 | `retry-later`, `rate-limit` | Write failure, pairing/IP capacity, or >60 messages/minute; backoff/retry |
| 4004 | `pair-rejected` | Invalid/expired/claimed code or missing pair parameters; input required, no automatic retry |
| 4005 | `device-limit` | Twenty devices; clean up on desktop, no automatic retry |

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

A proto2 device is eligible for rotation 24 hours after its current token was
first promoted. The server persists staged B before sending it; A and B both
remain valid until B first authenticates. Reconnects resend the same B and gen;
new staged generations increment once per device. Each live socket receives the
same staged generation at most once. Old JavaScript never receives this message.

```json
{
  "version": "v1",
  "type": "token_rotate",
  "timestamp": 1717200006000,
  "deviceId": "d_8f3a123456789abc",
  "gen": 2,
  "newToken": "fedcba9876543210fedcba9876543210"
}
```

The client saves and verifies B, acknowledges, and reconnects with B. Only that
authentication promotes B, sets its issue time to the promotion time, and closes
proto2 sockets of that device still on A with 4002. ACK is informational logging
only: it neither promotes B nor revokes A. There is no grace deadline or
unacknowledged-message eviction. If staging fails, the existing socket stays
connected and a later heartbeat can retry; promotion failure uses 4003.

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
ready it reports `{status, port, lanIp, pairUrl, pairCode, pairExpiresAt}` with no
token. The visible pairing area refreshes every five seconds. Refresh pairing
code and reset phone access are separate commands. The public
`/api/connection-info` returns only status, port and LAN IP, never tokens or codes.

HTML uses versioned JS/CSS URLs. The new service worker uses network-first
navigation and JS/CSS with cache fallback; navigation cache keys are always
`/mobile/`, never URLs containing token or pair parameters. An already-installed
old cache-first worker can still initially serve old JavaScript. Updates converge
after the new worker activates and subsequent online loads; offline starts may
take longer. A frozen old page remains compatible on its unrotated shared token.

Safari home-screen applications do not copy/share Safari localStorage, so adding
the PWA to the home screen creates a client needing pairing again. Safari's
script-writable-storage eviction rule counts seven days of Safari use without
site interaction, rather than seven calendar days; eviction requires re-pairing.
Home-screen apps have separate storage, and WebKit's current tracking-prevention
policy exempts their first-party domains from this limit.

## Limitations and future work

- Plaintext WebSocket; no TLS or cryptographic LAN isolation.
- The default plaintext LAN origin cannot rely on Service Workers, offline cache,
  or system notifications; the live in-page card works without those APIs.
- One global consent setting; no per-device permission-preview entitlement.
- PR A and the PR B device-list UI must ship in the same release. PR A alone does
  not finish #487. No QR code or device-list UI is included in PR A.
- The old shared token stops rotating and remains usable until revoked. Holders
  can register again after an individual device is revoked.
- Cross-tab localStorage read/write is not atomic. A controlled interleaving can
  temporarily overwrite a newer generation, requiring reconnect or re-pairing;
  it does not expand authorization.
- Two tabs generating cid simultaneously can leave an extra pending device.
  Clearing browser storage or replacing a device while re-pairing can also leave
  device records requiring manual revocation. Pending devices are never evicted.
- If every device-file write fails during the first upgrade run and the app then
  restarts after the old grace deadline, its unpersisted previous token expires.
- A corrupt device file is renamed and preserved; device credentials require
  re-pairing. If preservation fails, device features pause, legacy access remains,
  and the original file is not overwritten.
- Best-effort redaction can miss sensitive content repeated in model prose.
- Presentation means bubble content IPC was sent, not that a human saw it.
- Maximum twenty devices including pending and ten concurrent data sockets.
  Background frozen iOS pages can still pong and occupy all ten slots; the 11th
  keeps receiving 1013 until a slot frees. This is unchanged from the old bridge.
- Remote approval, elicitation answers, terminal control, transcript sync, and
  secure Internet relay remain out of scope. Any future decision protocol needs
  separate authorization, auditability, and fallback design; it is not implied
  by these additive v1 observation messages.
