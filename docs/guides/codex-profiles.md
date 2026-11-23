# Multiple local Codex profiles

The default profile monitors `$CODEX_HOME/sessions` when `CODEX_HOME` resolves to an absolute local path, and `~/.codex/sessions` otherwise. This applies even with a single profile. To monitor other local Codex homes at the same time, create `~/.clawd/codex-profiles.json` (on Windows, use `%USERPROFILE%\.clawd\codex-profiles.json`) and list the additional profiles:

```json
{
  "profiles": [
    {
      "id": "company",
      "label": "Company",
      "home": "~/.codex-work"
    }
  ]
}
```

Each profile needs a stable `id`, a unique display `label`, and a local Codex home path. Paths may use `~/...` or be absolute. Keep the homes and their `sessions` and `archived_sessions` directories separate, including those of the default profile. Use actual directories for `sessions` and `archived_sessions`. The archive watcher skips a linked archive root. Clawd checks for duplicate or nested paths after following directory links. You can add up to four profiles. Restart Clawd after editing the file.

Clawd installs Codex hooks only in the default home. Additional profiles get their state, completion, and question reminders from their session logs. Interactive approvals for those profiles stay in Codex. Manually installing Clawd's hooks in an additional home is unsupported. Events from such an installation without a transcript path appear under the default profile.

The Dashboard, Session HUD, and completion notifications show the profile label. Clawd keeps session state and archive tracking separate even when profiles reuse a session ID. Open additional-profile sessions from Codex itself. A deep link follows the account currently active in Codex, so Clawd disables its focus action for those sessions.

The Dashboard shows labeled quota for each additional profile that reports usage. Extra local profiles stay separate when quota sources are merged across machines. The quota ring can draw a separate coin for each eligible provider and source, up to three coins. Ring visibility is set per provider. In Remaining mode the readout shows the mode label in the space used by the profile label.

The file contains only profile IDs, display labels, and paths. Do not add credentials. Clawd does not read Codex authentication files for this feature. If the file is missing, Clawd keeps the default single-profile behavior. An invalid file is ignored as a whole and Clawd uses only the default profile.
