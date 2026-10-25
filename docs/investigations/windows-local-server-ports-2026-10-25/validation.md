# Windows local-server fallback validation — #1248

Date: 2026-10-25. Baseline: `82cb92637134242f8a7d462f3db6028fccd2dde4`.

## Automated coverage

- Full `npm test`: **13,418 passed, 74 skipped, 0 failed** (13,492 tests, 1,189 suites). The skipped platform/environment tests remain skipped; they are not counted as successful runtime validation.
- `test/local-server-fallback.test.js`: EACCES / EADDRINUSE fallback, initial and later synchronous throws, actual address port, persistent-hint reuse/drift, dynamic publication failure, bounded diagnostics, late-error settlement, local URL ownership and remote-port boundaries.
- `test/local-port-clients.test.js`: actual loopback HTTP delivery from CJS, OpenCode v1/v2, MiMo, OpenClaw, DSH, Pi and OMP, including the first request after a stale cached port. OpenCode strict permission targets retain live-owner checks. Hermes state/permission retry and cache behavior use its actual Python module with a controlled HTTP transport.
- The same JSON value table runs through all deployed JS/TS/Python runtime readers. Malformed values, foreign app markers and noncanonical strings are rejected. Numeric JSON forms with equal parsed values agree across languages.
- Claude and CodeBuddy install/uninstall migrate legacy → dynamic → different dynamic → legacy URLs while preserving a third-party plain dynamic `/permission` endpoint. Remote ingress rejects the local marker even with a valid nonce. Local Origin/Host/Content-Type guards apply to the new path.

## Windows runtime evidence

Windows build **10.0.26200**, Node **24.12.0**. No service, firewall, proxy, port reservation, or network configuration was changed. The test package ran in a dedicated temporary checkout with an isolated HOME / USERPROFILE / APPDATA / LOCALAPPDATA / HOMEDRIVE / HOMEPATH. The process asserted its effective home and runtime path before importing the server. Runtime and hint IO were explicitly injected; startup integration sync was captured, not executed.

The machine's normal Clawd range was not excluded. Read-only `netsh interface ipv4 show excludedportrange protocol=tcp` showed **50060–50159** naturally excluded. The test injected **50060–50064** as the server's candidates, exercising real Windows bind failures without changing system reservations. This is not an exact reproduction of the reporter's 23240–23339 exclusion on build 10.0.26300.

`test/fixtures/windows-local-port-smoke.js` observed:

1. All five injected ports returned **EACCES**, then `listen(0)` bound **59824**.
2. Runtime publication, health response port, Doctor pass and a real state POST succeeded.
3. Normal cleanup removed runtime; the private hint retained 59824. Restart reused **59824**.
4. A test-owned listener occupied 59824. Restart observed **EADDRINUSE**, then bound **50767**.
5. Injected runtime publication failure closed the dynamic listener, returned null and scheduled no integration sync.

The seven cross-language/client tests also passed on this Windows host. Real **PowerShell 5.1.26100.9711** ran the production NSIS fallback script against isolated settings: it removed the two owned URLs and preserved all **nine** foreign variants, including plain dynamic `/permission`, trailing slash, query, fragment, dot segment, doubled slash, case variation and trailing newline/carriage return.

## Remaining acceptance limits

- The reporter's exact machine and excluded default range remain untested.
- Packaged Electron UI and a human clicking a real Claude approval bubble have not been verified for this change. A separate-home real Claude CLI probe was attempted; it did not reach the model or send a hook request. Its login/API result is recorded locally; this is not counted as CLI acceptance.
- In-flight CLI HTTP-hook configuration reload after a forced port change remains unverified. The saved port hint reduces normal restart drift, and the documentation states that an existing CLI session may need reload/restart.
- Separate-home WSL dynamic-port discovery, Mobile Preview fallback and older-version cleanup are explicitly outside this change's supported scope.

Claude reviewed the plan in two rounds. The implementation and test evidence do not replace the remaining real CLI/UI acceptance above. Full review exports and independent adjudications are retained locally; only this bounded validation record is published with the code.
