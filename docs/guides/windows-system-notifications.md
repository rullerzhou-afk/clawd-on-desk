# Windows system notifications

Windows only. Open **Settings → Notifications → Windows system notifications**
and turn on **Show Windows notifications**. It is off by default. Three switches
choose what is announced, all on by default:

- **Task completed** — an agent finished its turn.
- **Failed or interrupted** — the turn stopped on an error or was cut short.
- **Waiting for you** — an agent is waiting for your approval or your answer.

**Send test notification** works with the master switch on or off, so you can
check delivery first. If nothing appears, allow Clawd under Windows
**Settings → System → Notifications** and check Do Not Disturb.

## What a notification contains

The title is the agent name and the project folder name; the body is one fixed
status line. An approval adds the tool name (for example `Bash`). Nothing else
is sent to Windows: no prompt, session title, command, tool input, model output,
path, environment value or error text. A failure is announced by its kind only
(failed or interrupted, or stopped on an API error). The folder name passes
through the same secret redaction as Slack messages and is truncated.

## When it fires

Clawd adds no hooks and keeps no second state machine for this. Completion and
failure reuse the session snapshot and the same completion rule as the Slack
integration; approvals and questions reuse the point where a request really
starts waiting for a person.

- A request that Clawd resolves by itself (unattended mode, auto-allowed tools,
  session grants, pass-through tools) never notifies. Neither does a request
  that is answered before its card is shown.
- A repeated hook or a second completion event for the same turn notifies once.
  A new turn in the same session notifies again.
- A main session that still has running subagents is announced when the last
  one finishes. Subagents and headless sessions are not announced on their own.
- Sessions that were already finished when Clawd starts (including sessions
  restored after a restart) are not announced again.
- Several requests from one session within a few seconds share one
  notification. When the request is answered, times out or its session ends,
  the notification is withdrawn, also from the notification center.
- Each session has its own notification; parallel sessions do not replace each
  other.

## Clicking a notification

Clicking jumps to that session's terminal with the same mechanism the Dashboard
uses. If the session cannot be located (the terminal is gone, or the agent does
not support focusing) the Dashboard opens instead. The test notification opens
the Dashboard.

This applies to the banner. A finished-task notification that Windows has moved
to the notification center stays there as history, but Clawd no longer follows
it, so clicking it there does not jump to the session.

## What Windows decides

Clawd asks Windows to show the notification and does not work around the answer.
Do Not Disturb, focus sessions, per-app notification settings and banners being
turned off all apply; a notification may go straight to the notification center
or not appear at all. Notifications are silent, because Clawd already has its
own sounds. Clawd's own Do Not Disturb suppresses them and does not replay them
afterwards.

The pet, permission bubbles, Slack, Telegram, Feishu and quota reminders work as
before and are configured separately. If Clawd's permission bubbles are turned
off and no remote channel is configured, requests stay in the agent's own
terminal and Clawd does not announce them.
