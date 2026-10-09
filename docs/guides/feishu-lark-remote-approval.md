# Feishu / Lark Remote Approval

[Back to setup guide](setup-guide.md)

Feishu / Lark approval is an optional remote approval path for existing Clawd
permission bubbles. When a supported agent asks for tool permission, Clawd keeps
the local desktop bubble and also sends an interactive card to your Feishu or
Lark self-built app. The first explicit Allow or Deny decision resolves the same
pending permission, and the card updates to show how it was handled.

This is approval-only. It does not create a chat bridge, remote shell, or
prompt-submission path.

## Choosing Feishu or Lark

Feishu (飞书, China) and Lark (International) are separate deployments of the
same product. They have separate open platforms, separate apps, and separate API
hosts — an app created on one **cannot** be used on the other, and the
credentials are not interchangeable.

Clawd ships a single approval channel for both. Pick your platform in
**Settings → Remote Approval → Feishu / Lark → step 1**:

| | Feishu (China) | Lark (International) |
|---|---|---|
| Open platform | <https://open.feishu.cn/app> | <https://open.larksuite.com/app> |
| API host | `open.feishu.cn` | `open.larksuite.com` |

Both the REST calls (sending and updating cards) and the WebSocket long
connection (receiving button presses) follow this setting. They are always on the
same platform — if only one of them were switched, cards would send fine while
button presses never came back.

Notes:

- **Existing Feishu users:** the platform defaults to Feishu, so an upgrade needs
  no action. Your saved App ID / App Secret keep working and do not need to be
  re-entered.
- **No custom domains.** Only the two official platforms above can be selected.
  Your App Secret travels on these requests, so Clawd will not send it to a host
  you type in.
- **No auto-detection.** Self-built App IDs start with `cli_` on *both*
  platforms, so credentials alone cannot identify the platform. Trying each in
  turn would mean sending your App Secret to a platform you do not use, so Clawd
  asks instead of guessing.
- If you pick the wrong platform, the long connection fails to establish and the
  card reports it — re-check step 1 before touching your credentials.

## Setup

The settings card walks through four steps in order. Each step is gated until the
previous one is saved, so **Enable** and **Send test** stay disabled until the
platform, credentials, and approver are in place.

1. **Step 1 — Platform & App Credentials.** Choose Feishu or Lark, then create a
   self-built app on that platform's open platform (linked above) and paste its
   **App ID** and **App Secret**. Verification Token and Encrypt Key are optional
   — fill them in only if you enabled them in your app's event settings.

   Credentials are stored outside `clawd-prefs.json`, in `feishu-approval.env`
   in Clawd's user-data directory, with `0600` permissions where the OS supports
   it.

2. **Step 2 — Approver.** Enter the user id that will receive and approve cards,
   and choose its id type (see [Approver id types](#approver-id-types) below).

3. **Step 3 — Enable.** Flip the switch. This opens the long connection. Do this
   *before* step 4: the platform only lets you save the long-connection
   subscription while a long connection is actually online.

4. **Step 4 — Event Subscription & Test.** Subscribe the card callback, then send
   a test card.

## Required app configuration

In your app's open-platform console:

- Enable the **bot** capability.
- Set the event subscription method to **long connection** (WebSocket).
- Add the **`card.action.trigger`** callback. Do **not** pick the legacy
  `card.action.trigger_v1` — it cannot use long connections.
- Add the approver to the app's **availability scope**.
- **Publish a version** of the app if the platform asks for one. An unpublished
  app will not deliver callbacks.

## Permissions

> **Status: not yet verified end-to-end.** The list below is the starting point
> derived from Clawd's actual API calls and the official docs — it has **not**
> been confirmed against a clean app on real Feishu or Lark tenants yet. Treat it
> as a first-round starting point, not a verified minimum. When it is verified,
> replace this note with the result (including any error codes seen).

Start from:

- `im:message:send_as_bot` — application-identity permission for sending the card.

Clawd does **not** call CardKit entity, card template, message-read, or
message-recall APIs, so do **not** add these:

- `cardkit:card:read`, `cardkit:card:write`, `cardkit:template:read`
- `im:app_feed_card:write`
- `im:message.p2p_msg:readonly`
- `im:message:recall`

Real verification must cover both **sending a card** and **updating the original
card after a decision**. If updating fails with only `im:message:send_as_bot`,
add `im:message:update` and record the platform's error code and the final
conclusion here. Do not widen permissions on a guess.

Verify on a clean app (or one with other permissions removed first) — an app that
already has broad permissions cannot tell you what the minimum is.

## Approver id types

The id type must match what your app receives in card action callbacks,
otherwise the approver will not match and the button press is ignored.

| Id type | Extra permission needed | Notes |
|---|---|---|
| `open_id` | None | **Default and recommended.** Right choice for a normal bot-to-user card. |
| `union_id` | None | Supported for both sending and callback matching. Official docs do not require an extra user-ID permission. |
| `user_id` | **Yes** — "Get user user ID" | Only this option costs an extra scope. The settings page shows a note when you select it. |

## Card language

Cards follow Clawd's current language setting (English, 简体中文, 繁體中文,
한국어, 日本語, Português (Brasil), Español) — titles, field labels, buttons, question steps, result status,
and the source label. Switching Clawd's language affects cards sent afterwards
and does not drop the long connection.

The source label shows the platform you selected: a Lark card is labelled as a
Lark card, never as a Feishu card.

## Behavior notes

- The desktop bubble stays available. Whichever side decides first wins, and the
  other side's card updates to show where the decision came from.
- If the card cannot be sent, the approval falls back to the local desktop bubble
  rather than blocking.
- DND does not auto-decide. See the DND behavior described in
  [telegram-approval.md](telegram-approval.md) — the same principle applies:
  Clawd never makes the permission decision for you.
- Long connection timeout is configurable in step 3. Reaching the timeout marks
  the connection failed in the UI; the SDK may still keep reconnecting in the
  background.

## Troubleshooting

- **Card sends, but pressing a button does nothing.** The `card.action.trigger`
  callback is almost certainly not subscribed, or `_v1` was subscribed instead.
  Re-check step 4. This was the original report in
  [#493](https://github.com/rullerzhou-afk/clawd-on-desk/issues/493).
- **Long connection never establishes.** Check that the platform in step 1
  matches where your app actually lives, then the App ID / App Secret, then your
  network.
- **Sending the test card fails.** Check the approver user id and that its id
  type matches your app's callbacks, and that the bot has messaging permission.
