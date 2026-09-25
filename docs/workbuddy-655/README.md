# WorkBuddy / #655 review bundle

This directory contains the locally preserved WorkBuddy integration patch and
the smallest runtime evidence available for issue #655. The branch is based on
the current `origin/main` at `9367b8c3` (including #1014).

## Included material

- `workbuddy-support.zip` contains the original local fusion patch. It is
  supplied for review as-is; it was created against an older WorkBuddy
  integration baseline and is not claimed to apply cleanly without review.
- `reproduction.log` contains the exact Clawd debug lines from the earlier
  `workbuddy-ui-smoke-*` hook smoke. That session was injected by local test
  automation, not typed by a user in WorkBuddy. It proves event delivery and
  the current deletion path, but it is not a claim about a real user turn.

## Version boundaries

The earlier fusion package and automation used the locally preserved 0.13
test package/older snapshots. They must not be used as v1.0 UI validation.
The current installed Clawd instance was separately verified as official
1.0.0 (app.asar, registry, and running owner), and the window-title check was
performed after all old Clawd processes were closed.

The WorkBuddy executable present during the smoke was the local Windows
WorkBuddy installation. Its exact application build was not captured in the
smoke log, so this bundle does not invent a WorkBuddy version number.

## Scope requested for review

The fusion patch is offered to restore WorkBuddy visibility and state/event
synchronisation. It does not intentionally carry over the public #648 rules
that hide idle/done sessions or keep only the newest session per process.
Those rules conflict with #655's requirement to keep completed sessions until
reliable archive/delete evidence exists. Completion retention and archive/delete
semantics should therefore be reviewed as a separate lifecycle change.
