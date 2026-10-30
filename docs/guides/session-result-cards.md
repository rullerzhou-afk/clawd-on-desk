# Session result cards

Enable **Settings → Notifications → Keep session result cards** to leave a white result card beside Clawd after a supported local session finishes. This setting is off by default and only shows newly accepted results.

| Integration | Completion cards | Failure cards |
| --- | --- | --- |
| Claude Code | Confirmed main-session completion | Explicit failed turn, including the existing API-error fallback |
| Codex | Confirmed main-session completion with actual work/output | Not available |
| Kimi Code | Main-session completion | Explicit failed turn |
| Grok Build | Confirmed main-session completion | Explicit failed turn |

Other integrations, custom HTTP agents, Remote SSH, WSL and headless/subagent sessions are outside this first version. A tool error, retry, user cancellation, long silence or disappearing process does not by itself count as a failed turn. If background subagents are still running, Clawd does not issue a persistent failure card.

Each session has at most one unread card. New accepted work clears its previous result. Closing a card affects only that reminder; it does not hide the Dashboard row or change permissions. Grok's accepted completion cancellation retracts its completion card.

**View session** uses the current local navigation target. A confirmed handoff clears the card; a failed or unconfirmed attempt retains it. Codex Desktop waits for the operating system to accept its validated conversation link. Windows terminal navigation waits for the existing window-focus confirmation. macOS/Linux terminal navigation currently only confirms that a request was submitted, so its card stays until manually closed. These signals do not prove that you read the result or that every terminal's tab was selected correctly.

When Clawd cannot navigate, the button is disabled and the card asks you to use the original application. This also applies to Grok, which currently has no terminal-navigation integration. Removed sessions never reuse an old terminal PID; validated Codex Desktop conversation links can remain usable.

Cards survive session-row cleanup and Dashboard hiding, but live only in memory for this Clawd run. The most recent 100 unread sessions are retained; there is no timed expiry. Restarting Clawd, disabling this feature, or disabling an integration clears its applicable cards. Re-enabling does not backfill earlier results.

DND, hiding the pet, fullscreen suppression and mini-mode transitions temporarily hide the window without discarding results. **Hide bubbles** and notification auto-close timers do not affect result cards. Cards use the existing bubble placement preferences and avoid permission surfaces, update bubbles and the HUD. If no safe space is available, the window waits until space returns; its records remain unread.

The cards contain a fixed result message, agent name, session display title and time. No new error-text collection, result archive, network request or permission decision is added. A third-party Stop hook that continues a turn can briefly leave a completion card until the next accepted work event clears it.
