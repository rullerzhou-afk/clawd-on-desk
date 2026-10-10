# Answer agent questions in Clawd

Clawd can display supported questions with selectable options and a custom answer field. Every question keeps a **Go to Terminal** action, and the agent's native question UI remains available while the Clawd card is open.

Claude Code's `AskUserQuestion` and Hermes clarification already use their existing answer adapters. The native question adapter additionally supports:

| Agent | Runtime generation | Question contract |
| --- | --- | --- |
| OpenCode | v1, 1.18.31 or later within 1.x | `question.asked`, `question.replied`, `question.rejected`; native `/question/{requestID}/reply` |
| MiMo Code | 0.1.15 or later within 0.1.x | The same independently verified native question events and response route |

The adapter checks the running host's health/version and exact pending native question before showing a card, then checks it again before returning answers. Each request stays bound to its original plugin instance, SDK client, directory, session, request ID, and tool message/call IDs. It does not infer eligibility from general permission support.

Install or repair the relevant integration through **Settings → Agents**, then reload or restart the agent so it loads the current plugin. The agent, the global permission bubble switch, and that agent's permission bubble switch must be enabled. Turning off notification bubbles alone does not hide these question cards. DND, a disabled agent, or either permission bubble switch being off leaves the question in the agent's native interface.

## Question behavior

Single-choice questions show radio buttons. Questions with native `multiple: true` show checkboxes and preserve every selected label as a separate answer, including labels containing commas. Native `custom: false` suppresses the Other field. Custom answers are supported when the native request permits them. All questions must have a nonempty answer before submission.

A native answer or rejection removes the matching pending Clawd card. Selecting an answer first enters a submitting state: it is not delivery confirmation. OpenCode v1's native reply RPC returns `true` after delivery, so that response confirms submission; HTTP 404 means the request was resolved elsewhere. Its replied event can arrive after the RPC without changing the result. MiMo's route also returns `true` for an absent request, so MiMo requires the native API response and the native replied event to match the exact answer arrays. A fresh request-bound receipt token ties the result back to the original card. Failed/uncertain delivery, or a missing receipt after 12 seconds, shows an explicit unconfirmed native-fallback card with no resubmit action. The original native question remains authoritative.

An unconfirmed card intentionally stays until the user returns to the agent/dismisses it or normal session/agent cleanup runs. Once that failed attempt has retired its plugin target, a later native replied event does not clear the card or make it resubmittable. Check the native agent to resolve an uncertain delivery; Clawd does not retry it.

Duplicate events/clicks cannot create a second native answer. Returning to the terminal, closing a card, agent/plugin disposal, an unavailable Clawd server, malformed input, and an unsupported shape never generate an approval, rejection, or invented answer. The adapter never automatically retries an answer whose delivery is uncertain. A native result resolved elsewhere clears the card without claiming Clawd's answer won.

The current adapter accepts up to five questions with up to five options each, bounded text/body sizes, unique unmodified option labels, and an explicit tool message/call identity. Requests with unsupported localization/extended schema fields or ambiguous values remain native. This is a complete-request fallback: no question or option is silently dropped to make a request actionable.

## Runtime boundaries

OpenCode 2.x uses a different plugin API and does not use this v1 adapter. Its native question UI remains the answer surface. Codex questions continue to use the existing read-only reminder and **Go to Codex**. Other agents remain native unless their own question-answer contract has been verified; a permission bubble, notification, plugin, or Claude-compatible hook alone does not prove support for answers.

This channel is local. Child-session/subagent questions stay in the native agent interface. It is not added to Remote SSH deployment or remote approval mirrors. WorkBuddy, QwenWork, Grok Build, MiniMax, Pi, registered custom HTTP agents, and other state-only integrations keep their existing boundaries. DeepSeek Harness's native question provider remains the question owner.

## Protocol evidence and validation

The implementation follows pinned public source: [OpenCode v1.18.31 question schema](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/schema/src/v1/question.ts), [OpenCode question routes](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/server/routes/instance/httpapi/groups/question.ts), [MiMo v0.1.15 questions](https://github.com/XiaomiMiMo/MiMo-Code/blob/14dfe68a1c121f859544ba810b3c308e8501bfb2/packages/opencode/src/question/index.ts), and [MiMo question routes](https://github.com/XiaomiMiMo/MiMo-Code/blob/14dfe68a1c121f859544ba810b3c308e8501bfb2/packages/opencode/src/server/routes/instance/httpapi/question.ts). The OpenCode RPC completion/NotFound contract was also checked against [v1.18.35 question service](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/opencode/src/question/index.ts) and [reply handler](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts); the reviewed v1 shape and the 1.18.31 minimum remain unchanged.

Tests exercise the real local HTTP ingress and plugin answer flow against synthetic native HTTP question endpoints, with mocked Electron. They cover exact multiple/custom answers, duplicate submission, native answer/cancel, changed native questions, separate plugin clients/directories, canonical existing-session focus/cleanup, disposal, strict version bounds, browser-origin/Host/media-type guards, and payload budgets. Gate tests cover notification bubbles being off without hiding questions, and global/per-agent permission bubbles being off with native fallback. Receipt tests cover forged/stale confirmation, a changed original host version, missing confirmation, native API failure, OpenCode replied events arriving after RPC completion, and MiMo success responses without matching events. The native replied event must not abort its own in-flight committing RPC.

An additional smoke used the official OpenCode 1.18.31 Windows x64 CLI, a localhost mock model, and the actual Clawd owner/route modules with mocked Electron selection/rendering. One native question call contained two prompts; exact native replied answers, one accepted receipt, pending-request retirement, and the real tool result delivered to the second model exchange were verified. Native question endpoints/events were not mocked. MiMo validation is pinned-source and synthetic native HTTP transport coverage. Native TUI/GUI, real providers, and other operating systems remain unverified by this change.
