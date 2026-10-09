# Quota reminders

Open **Settings → General → Session management → Quota ring** and enable quota
reminders. **When to remind** offers four presets — 10% remaining, 20% and 10%
(Default), 30% / 20% / 10%, and 50% / 20% / 10%. Combinations saved by older
versions that don't match a preset keep working and appear as a **Custom** entry
until you pick a preset.
The reminder rows stay hidden while the master switch is off, and chosen levels
apply immediately. Recovery reminders are optional. The ring's Used/Remaining
preference does not change reminder semantics, and reminders can remain enabled
when the visible ring is hidden. If a **Test notification** does not appear,
allow Clawd in your system notification settings.

Reminders consume the existing account reports separately for each provider,
local/remote source and window. They do not enable usage collection or make
additional API requests. Where collection needs an opt-in, such as Claude
statusline or Kimi, configure that existing integration on its Agents card.

Only confirmed, recent, unexpired reports qualify. Startup disk snapshots alone
cannot trigger reminders; minute-quantized timestamps may delay the first
qualifying confirmation by about a minute. A jump straight to 9% produces only
the 10% reminder, rather than another 20% notification. Recovery requires a
newer report above the highest threshold; reaching the reset time is insufficient.

Do Not Disturb suppresses reminders without consuming eligibility. Notifications
respect the app's mute setting and operating-system notification settings.
Use **Test notification** to check delivery without changing quota or history.
Native delivery is recorded only after the system's show acknowledgement;
failure/timeouts remain eligible for later observation. Windows tray balloons
are a best-effort fallback when native notifications are unavailable. The test
also respects Do Not Disturb.

Deduplication history is stored in quota-alert-history.json in Electron's
user-data directory, with at most 256 records and 60 days of retention. It contains
hashed source/window keys and numeric metadata, without credentials, prompts,
commands or project paths. Quiet-hour scheduling and project launching are not
part of this feature.
