# Productivity tools

Open **Settings → Productivity** (Chinese: **设置 → 效率工具**).
These features are opt-in: quota reminders and quiet hours start disabled, and
project bookmarks start empty. Preferences use the existing Settings controller
and `clawd-prefs.json`; no account credentials are added to preferences.

## Quota reminders

Enable reminders, choose 1–5 remaining-percentage thresholds from 1 to 99, then
click Save. Defaults are **20% and 10% remaining**. Recovery reminders are optional.
The percentage ring's Used/Remaining preference does not change alert semantics.

Alerts consume existing account quota reports, separately for each provider,
local/remote source and quota window. They do not enable usage collection or make
new API requests. Where a provider needs a collection opt-in (such as Claude
statusline or Kimi), configure that existing integration first.

Only confirmed, recent, unexpired reports qualify. Startup disk snapshots alone
cannot trigger reminders; minute-quantized report timestamps may delay the first
qualifying confirmation by about a minute. Source replay protection remains the
responsibility of the existing accepted quota ingestion path.

If remaining quota drops straight to 9%, only the 10% reminder is sent. Subsequent
observations do not repeat it. Recovery requires a newer report showing remaining
quota above the highest threshold; reaching the reset time alone is insufficient.
Quiet hours suppress reminders without consuming them. Notifications are best
effort and respect the app's mute setting; operating-system notification settings
may also prevent display.

Use **Test notification** to check the notification channel without changing quota
data or reminder history. Native sends are recorded as delivered only after the
system's show acknowledgement; failures/timeouts remain eligible for a later
observation. Windows tray balloons are a best-effort fallback when native
notifications are unavailable. The test is also suppressed during Do Not Disturb.

Deduplication history lives in `quota-alert-history.json` in Electron's user-data
directory. It stores hashed source/window keys and numeric alert metadata, with
at most 256 records and 60 days of retention. It stores no credentials, prompts,
commands or project paths.

## Scheduled quiet hours

Choose start days, start/end times, optionally Hide pet, then Save. Times use the
computer's local timezone. A Friday 22:00–08:00 interval includes Saturday morning.
Start and end must differ; the end is exclusive. Clock changes and system resume
are reconciled against current local time, without replaying missed intervals.

The schedule uses Clawd's existing Do Not Disturb behavior. Permission requests
return to the agent's native interface; the schedule never approves or denies
them. At the end it restores only the sleep/visibility changes it owns, preserving
manual sleep and the independent fullscreen auto-hide layer.

Manually showing/hiding the pet, moving it to the primary display, or choosing
Sleep/Wake pauses the current interval. The next interval or a schedule edit can
activate it again. Configuration changes take effect immediately; ordinary time
boundaries are checked every 30 seconds and after resume.

## Project bookmarks

Add a project, choose a local directory and an opening mode, then Save. Open uses
the saved directory only after you click it. Up to 32 bookmarks are supported;
names and directories must be unique. Removing a bookmark never removes its files.

- **File manager** opens the saved directory.
- **Terminal** opens a supported terminal at that directory.
- **Claude Code** starts the installed CLI in normal mode with existing approvals.
- **Codex CLI** starts the installed CLI without extra arguments or prompts.

Bookmarks cannot contain custom commands, permission flags or automatic startup.
Missing directories or CLIs return an error; the app does not install or log in
to them. A successful terminal launch confirms only the terminal opened, not that
the agent authenticated or created a session. Closing Settings or changing/removing
a bookmark during an asynchronous launch check cancels the launch.

Only local absolute paths are supported; UNC and remote directories are excluded.
On Windows, batch CLI executable paths containing `%` or `!` are rejected to avoid
cmd expansion. These restrictions apply to CLI executable paths, not ordinary
project directory names. macOS/Linux terminal GUI behavior still needs real-machine
verification for this local development build.
