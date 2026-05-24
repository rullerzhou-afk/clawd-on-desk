# Telegram Approval

[Back to setup guide](setup-guide.md)

Telegram Approval is an optional remote approval path for existing Clawd
permission bubbles. When a supported agent asks for tool permission, Clawd keeps
the local desktop bubble and also sends an approval card to your Telegram bot.
The first explicit Allow or Deny decision resolves the same pending permission.

This is approval-only. It does not create a Telegram chat bridge, remote shell,
or prompt-submission path.

## Supported Paths

- Claude Code and CodeBuddy normal permission requests.
- Codex CLI official `PermissionRequest` hooks when Codex permission handling is
  in intercept mode.

Telegram cards are not sent for DND/native-fallback cases, disabled agents,
hidden permission bubbles, opencode, elicitation prompts, passive notifications,
or headless sessions.

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

3. **Step 3 — Enable & Test.** Flip **Enable Telegram approval**, then click
   **Send test**.

   The test sends a standalone approval card. Tap either Allow or Deny in
   Telegram within 60 seconds. It is not attached to any agent permission
   request. The status card at the top of the tab shows live sidecar state
   (Setup incomplete / Ready / Starting / Running / Failed) and surfaces any
   sidecar error message in plain text.

## Runtime Behavior

- The desktop permission bubble remains the local fallback.
- Telegram timeout or network failure does not deny the tool. The local bubble
  stays usable and the agent's existing fallback behavior remains unchanged.
- If the desktop bubble resolves first, Clawd aborts the in-flight Telegram
  approval request.
- Repeated Telegram taps after a request is already handled do not resolve the
  permission twice.
- Sidecar logs and Clawd logs redact Telegram tokens, chat ids, and token-like
  values.

## Release Notes

Packaged builds ship the pinned `cc-connect-clawd` sidecar binary from
`bin/cc-connect-clawd/`. Source runs use the same directory layout, or the
`CLAWD_CC_CONNECT_CLAWD_PATH` override for development.

Before release, verify sidecar binaries with:

```bash
node scripts/verify-sidecar-binaries.js prebuild:all
```
