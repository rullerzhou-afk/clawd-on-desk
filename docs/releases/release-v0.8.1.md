## v0.8.1

### Bug Fixes

- **Pi agent restored to state-only mode** (#322) - Pi extension reports lifecycle and tool activity only. Clawd no longer shows Pi permission bubbles, no longer calls Pi terminal confirmation, and preserves Pi's default YOLO execution behavior.
- **Legacy Pi permission hook compatibility** - Older in-memory Pi extension instances that still POST `/permission` now receive an allow response from Clawd, so they do not get blocked by stale bubble logic while the user is upgrading.

### Upgrade Notes

- Existing v0.8.0 profiles with the Pi permission bubble subgate enabled are migrated back to `false` because the subgate no longer has runtime effect.
- Restart already-running Pi agent sessions after upgrading. Until restart, an old in-memory extension may still try the former `/permission` path; Clawd online will allow it, but if Clawd is offline that old extension can still fall back to Pi terminal confirmation.
