# Telegram Approval

[Back to setup guide](setup-guide.md)

Telegram integration provides remote approval, completion notifications, and an
optional reply path for live local sessions. When a supported agent asks for
tool permission, Clawd keeps the local desktop bubble and also sends an approval
card to your Telegram bot. The first explicit Allow or Deny decision resolves
the same pending permission.

The approval path does not create a remote shell or silently submit prompts.
Completion notifications and **Reply to completion notifications** are separate
opt-in Telegram features; their formatting does not change the approval decision
policy described here.

When **Reply to completion notifications** is enabled, replying directly to a
completion notification selects the exact session that produced that message.
This is a bounded prompt-delivery path, not a general Telegram chat bridge or
remote shell.

## Supported Paths

- Claude Code and CodeBuddy normal permission requests.
- Codex CLI official `PermissionRequest` hooks when Codex permission handling is
  in intercept mode.
- AskUserQuestion elicitation prompts (beta) — rendered as an interactive card
  with option buttons and a quote-safe Other reply.

Telegram cards are not sent for DND/native-fallback cases, disabled agents,
hidden permission bubbles, opencode, passive notifications, or headless
sessions.

## Setup

The Settings tab walks you through three steps in order. Each step is gated
until the previous one is saved, so the **Enable** switch and **Send test**
button stay disabled until token and recipient are in place.

1. **Step 1 — Bot Token.** Create a dedicated bot with
   [@BotFather](https://t.me/botfather) using `/newbot`. Open Clawd Settings →
   **Remote Approval** → expand the **Telegram** card and paste the token into
   step 1.

   Do not reuse the token from an existing Telegram bridge. Telegram allows
   only one active `getUpdates` owner per bot token, so sharing a token can
   make one integration miss updates.

   The token is stored outside `clawd-prefs.json` in Clawd's user-data
   `telegram-approval.env` file. After saving, the input collapses to a masked
   preview (`<bot_id>:<first4>……<last4>`) so you can tell two saved tokens
   apart without seeing the raw secret. The raw token never crosses the IPC
   boundary back to the UI.

2. **Step 2 — Recipient.** Open [@userinfobot](https://t.me/userinfobot) in
   Telegram and send `/start` to get your numeric user id. Paste that number
   into step 2 and save.

   Clawd uses this one number both as the allowed approver (only this user can
   tap Allow/Deny) and as the chat to deliver approval cards (private chat
   `chat_id` is the same as the user's id). Before testing, send `/start` to
   your own bot at least once so it can initiate the private chat.

3. **Step 3 — Enable & Verify.** Flip **Enable Telegram approval**.

   Clawd sends a standalone verification card. Tap either Allow or Deny in
   Telegram within 60 seconds. It is not attached to any agent permission
   request. A successful callback activates the native Telegram transport.
   After activation, **Send test** remains available for an ordinary
   connectivity check.

### Verification failures

For a new or currently disabled setup, a failed verification returns the
Enable switch to off and leaves an actionable red status on the Telegram card.
Legacy-upgrade users instead remain on the migration-required panel described
below. Neither path silently enables Telegram or revives the retired transport.

Use the status message to choose the next check:

- `401`: re-check or replace the bot token.
- `403`: send `/start` to the bot from the configured user, make sure the bot
  is not blocked, and re-check the recipient.
- `400` or a missing chat: use the numeric Telegram user id and start a private
  chat with the bot before retrying.
- `409`: remove an existing webhook or stop the process on another machine,
  another Clawd profile, or another bot integration that polls the same token.
  A dedicated bot avoids both conflicts.
- `429`: wait before retrying.
- Network failure: check Telegram reachability, the system proxy, and any
  `CLAWD_TG_PROXY` override.
- Timeout: tap the standalone verification card within 60 seconds. If it was
  already tapped, also check the network or proxy because Clawd may not have
  received the callback.

`telegram proxy resolved` in `permission-debug.log` only records the selected
proxy route before the Bot API request. It does not prove that Telegram accepted
the token or request. Terminal verification failures are logged with allowlisted
outcome and error-class fields; those terminal lines do not include tokens, chat
ids, proxy addresses, or Telegram response bodies.

4. **Enable replies (optional).** Native Telegram must be active. Turn on
   **Reply to completion notifications** in step 3. Recent completion
   notifications from the current Clawd run can be used as reply targets.

   Upgrading from the earlier paste-only Direct Send beta turns this setting
   off once because replies now include Enter and submit automatically. Review
   the new delivery behavior below before enabling it again.

   In Telegram, use the normal **Reply** action on the relevant completion
   notification and send one line of text. Clawd uses Telegram's
   `reply_to_message.message_id` to resolve the full session id, so concurrent
   Codex or other agent sessions do not rely on titles or shortened ids.

## Reply Delivery

- The reply mapping is created only after Telegram confirms the completion
  notification was sent. Clawd keeps at most 1,000 mappings in memory for up to
  24 hours, so notifications from before a Clawd restart are no longer reply
  targets. A confirmed or indeterminate automatic submission retires every
  older notification for that session; a completion notification created after
  that submission remains replyable. Changing the bot token, recipient, or
  resolved chat also clears existing mappings.
- For an eligible local Windows session, Clawd uses the session's agent PID to
  attach to its Windows Console/ConPTY input and writes the single-line Unicode
  reply followed by Enter. Successful delivery does not switch the foreground
  window and does not read or write the system clipboard. Reply deliveries are
  serialized so concurrent Telegram messages cannot interleave.
- Codex Desktop sessions use Codex's thread queue instead of the shared
  app-server Console. Clawd extracts the exact thread UUID or saved thread name
  from the mapped completion session and runs
  `codex queue --thread <THREAD> --message <TEXT>`; the reply is then picked up
  by that Desktop conversation without depending on which app-server PID is
  shared by other sessions. Ordinary Codex CLI sessions continue to use their
  own local Console/ConPTY input.
- Terminal tabs or panes backed by independent ConPTY instances have separate
  consoles and can be targeted independently. If another live Clawd session
  shares the same Console as the target, Clawd treats the target as ambiguous,
  skips automatic submission, and copies the reply to the clipboard for manual
  paste. Text already present in the target terminal composer, or typed locally
  at the same time, may be combined with the injected reply before Enter.
- WSL, remote, headless, and non-Windows sessions use clipboard fallback, as do
  sessions without a usable agent PID and replies containing multiple lines.
  Clipboard fallback never injects paste or Enter.
- Before writing input, Clawd rechecks that the mapped session is still the same
  live, completed local session and is not waiting for an interactive permission
  decision. A reused session id or changed session state is not submitted to a
  newer run.
- Only the single configured Telegram user in the configured chat is accepted;
  multi-user and multi-chat routing are not configured separately. A plain
  message that is not a reply to a mapped completion notification is not routed
  to any session.
- Reply to a newly delivered completion notification from the current Clawd
  run. A Clawd restart, bot token/recipient change, polling restart, or Direct
  Send toggle change clears the in-memory mapping, so an older Telegram card
  may still look like a completion notification while no longer selecting a
  session.

## Runtime Behavior

- The desktop permission bubble remains the local fallback.
- Telegram timeout or network failure does not deny the tool. The local bubble
  stays usable and the agent's existing fallback behavior remains unchanged.
- If the desktop bubble resolves first, Clawd aborts the in-flight Telegram
  approval request.
- Repeated Telegram taps after a request is already handled do not resolve the
  permission twice.
- Clawd logs redact Telegram tokens, chat ids, and token-like values.

## Message Formatting

- Completion notifications render Assistant output through a conservative
  Markdown subset using Telegram-safe HTML. Clawd metadata such as the session
  title, agent, folder, and host is escaped as plain dynamic text rather than
  interpreted as Markdown.
- Approval, session-trust, and AskUserQuestion cards use Clawd-owned structure.
  Agent/tool/question values are redacted and escaped; they cannot add Telegram
  tags, links, mentions, or status lines.
- Secret redaction runs before Markdown parsing. Unsupported HTML, unsafe link
  schemes, credentialed links, and image syntax degrade to visible text; Clawd
  does not fetch or embed the referenced media.
- Username-like agent prose outside code uses a full-width `＠` to avoid an
  unintended Telegram mention. Code keeps ASCII `@` for copy fidelity.
- If Telegram rejects the generated HTML as an entity-parse error, Clawd retries
  the already-rendered plain version once without a parse mode. Other Telegram
  errors keep their existing retry/fallback behavior.
- Formatting is the default transport correction and has no Settings toggle.
  It does not split long messages, upload documents, or use Rich Messages.

## Legacy Upgrade (v0.14.0)

The old Go sidecar transport is retired in v0.14.0. It is no longer started,
shipped, or offered as a fallback. Existing users whose preferences still
select the old transport see a blocking **Legacy Telegram mode was retired**
panel in Settings.

Choose **Verify native and switch**. Clawd reuses the existing bot token,
allowed user id, and target chat; no Telegram fields need to be entered again.
The token stays in the same `telegram-approval.env` file and the migration does
not rewrite or delete it. Only the real nonce callback from the configured
Telegram user completes the switch.

If verification fails or times out, Clawd remains in the migration-required
state and does not revive the retired runtime. **Turn off Telegram approval**
is available when you do not want to migrate yet. Users already on verified
native transport continue without interruption.

If verification reports a Telegram `409` conflict, another process is polling
the same bot token. Fully exit the integration on the other machine or in the
other independent Clawd profile, wait a few seconds for Telegram to release
`getUpdates`, then retry. One bot token can have only one active poller.

## Release Verification

Packaged builds must contain neither the retired executable nor its runtime
source modules. Inspect each unpacked target with:

```bash
node scripts/assert-no-retired-telegram-sidecar.js \
  --resources-root <unpacked-resources-directory>
```
