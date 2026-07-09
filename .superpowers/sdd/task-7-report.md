## What I implemented

- Preserved `opts.wavepet` in `src/state.js` session records without changing display or priority resolution.
- Normalized WavePet diagnostics to JSON-safe objects before storing them and exposed the normalized payload on session snapshots.
- Extended snapshot change detection so a WavePet-only diagnostic update still refreshes the broadcast snapshot.
- Normalized `data.wavepet` in `src/server-route-state.js` and forwarded valid object payloads to `ctx.updateSession(...)`.
- Added focused regression coverage for session storage, snapshot propagation, route forwarding, and invalid route payload rejection.

## What I tested and results

- `node --test test/state.test.js` -> PASS (`239` tests, `0` failures)
- `node --test test/server-route-state.test.js` -> PASS (`32` tests, `0` failures)

## TDD Evidence

### RED

Command:

```bash
node --test test/state.test.js
```

Observed failing output:

```text
✖ stores wavepet diagnostics and uses display hint for working session
TypeError: Cannot read properties of undefined (reading 'state')
```

Why expected:

- `updateSession(...)` was not persisting `wavepet`, so `session.wavepet` was `undefined`.

Command:

```bash
node --test test/server-route-state.test.js
```

Observed failing output:

```text
✖ passes normalized metadata to updateSession
✖ drops non-object wavepet payloads before updateSession
```

Why expected:

- `/state` POST handling was not normalizing or forwarding `wavepet`, so valid payloads were dropped and invalid payloads were left undefined.

### GREEN

Commands:

```bash
node --test test/state.test.js
node --test test/server-route-state.test.js
```

Observed passing output:

```text
state.test.js: 239 pass, 0 fail
server-route-state.test.js: 32 pass, 0 fail
```

## Files changed

- `src/state.js`
- `src/server-route-state.js`
- `test/state.test.js`
- `test/server-route-state.test.js`
- `.superpowers/sdd/task-7-report.md`

## Self-review findings

- `wavepet` is stored as normalized JSON data only; arrays and non-objects are rejected at the route layer and non-serializable values collapse to `null` in state storage.
- Existing `displayHint` handling is unchanged.
- No `wavepet` data is used in display-state or priority resolution.

## Any concerns

- None.
