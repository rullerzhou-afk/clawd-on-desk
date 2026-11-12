# Third-party quota coins (DeepSeek / Cursor / Grok Bot)

The quota ring can show three additional account-wide providers. They are
collected by Clawd's main process only; no agent CLI change, no hook change and
no external plugin is required.

| Coin | Source | Window |
|---|---|---|
| `deepseekQuota` | DSH desktop loopback balance route, else the official `GET https://api.deepseek.com/user/balance` | none (prepaid balance against a configurable reference) |
| `cursorQuota` | Cursor desktop `state.vscdb` access token → `cursor.com/api/usage-summary` + `api/dashboard/v2/usage-status` | weekly included pool (falls back to the monthly plan when the account is not on unified billing) |
| `grokBotQuota` | same Cursor account session → `POST cursor.com/api/dashboard/get-sand-usage-status` | 7 days |

## Data sources

### DeepSeek

1. `GET http://127.0.0.1:<port>/api/dsh-balance/balance` — the route the DSH
   desktop app serves for its own balance widget. The port is discovered from
   the OS listener table (`netstat` on Windows, `lsof` on macOS, `ss`/`lsof` on
   Linux) and cached in `~/.clawd/dsh-balance-port.json`.
2. If that route is unavailable, the official DeepSeek balance endpoint is
   used. This path does **not** need DSH or its balance-widget plugin to be
   installed/running; only a DeepSeek API key is needed. The key is resolved,
   in order, from: the `DEEPSEEK_API_KEY` environment variable, then
   `<DSH_HOME or ~/.dsh>/.credentials.yaml` (`refs.DEEPSEEK_API_KEY`, only when
   the stored value is a plain `sk-…` secret). The key is read into memory only
   and never written to Clawd's data directory or logs.
3. The ring maps the balance against the **DSH balance baseline** pref
   (`deepseekQuotaBaselineCny`, default 50): `usedPercent = 1 − balance / baseline`.
   A prepaid balance has no reset window, so quota reminders do not fire for it.

The official fallback is opt-in at the module boundary: `main.js` passes
`enableOfficialApi: true` to `createDshBalanceRuntime`; library consumers (and
the test suite) never touch the network or the credential store by default.

### Cursor and Grok Bot

- Credential: `cursorAuth/accessToken` from
  `<Cursor config>/User/globalStorage/state.vscdb`, opened read-only. On macOS
  Cursor 3.27+ may store the token as a `cursor-safe-storage:v1:` envelope;
  `src/chromium-safe-storage.js` implements Chromium's OSCrypt scheme
  (Keychain `Cursor Safe Storage` → PBKDF2-HMAC-SHA1/saltysalt/1003/16B →
  AES-128-CBC with a 16×0x20 IV) and only reads the Keychain when the runtime is
  explicitly asked to decrypt.
- Request auth: the access token is presented as
  `Cookie: WorkosCursorSessionToken=<userID>::<token>` with `Origin`/`Referer`
  set to `https://cursor.com`.
- Cursor's dashboard shows the **shared weekly included usage** for unified
  accounts; that is what `cursorQuota` reports (e.g. `$5.50 / $46.15 = 12%`,
  reset weekly). `grokBotQuota` uses the Grok Bot endpoint's `usagePercent`,
  which is the same shared weekly pool.
- The two Cursor/Grok Bot coins force `displayMode: "used"` so their readout
  matches the product pages ("12% used") even when the global ring preference is
  "remaining". Other providers keep the global preference.
- The runtime fails soft: no token / expired JWT / HTTP error leaves the last
  known value in place; diagnostics (endpoint status, field names, numbers only)
  go to `~/.clawd/third-party-quota-status.json` and
  `~/.clawd/deepseek-quota-status.json`. Tokens/cookies are never logged.

## Verification marker

`~/.clawd/deepseek-quota-force-api` makes the DeepSeek runtime try the official
API before the loopback route; it falls back to the route if the API is
unreachable. Useful to verify the plugin-free path while DSH is still running.
`~/.clawd/cursor-quota-dump` writes the raw Cursor/Grok Bot response bodies (no
tokens) to `~/.clawd/cursor-quota-dump.json` on the next poll for field mapping.

## Ring behaviour and limitations

- `RING_MAX_COINS` is 6; providers beyond it collapse into the `+N` pill and
  open the Dashboard.
- Mini mode hides the HUD and the quota ring entirely (pre-existing Clawd
  behaviour); the ring also auto-hides until the pet is hovered/clicked.
- The Dashboard quota section still lists only the upstream providers; the
  three new coins are ring-only for now.
- No Settings switch/key field yet: the runtimes are enabled by default. The
  DeepSeek baseline pref is reused from the balance coin.
- macOS support for the Cursor token path is implemented but needs a real-device
  check; the port discovery uses `lsof` there. `today-cost` is out of scope (it
  requires parsing DSH sessions and its peak/off-peak price table).

## Tests

- `test/thirdparty-quota.test.js` — DeepSeek payload/key resolution/port
  parsing, macOS OSCrypt roundtrip, Cursor JWT/cookie/response parsing and both
  runtimes' commit behaviour.
- `test/dsh-balance-runtime.test.js` — updated for the optional official
  fallback, injected listener source and cache-path override.
- `test/quota-ring-geometry.test.js`, `test/quota-ring-renderer.test.js`,
  `test/session-hud-style.test.js`, `test/quota-palette.test.js` and
  `test/state.test.js` — pinned provider lists, identity colours, glyph zooms and
  snapshot icon keys for the two new coins.
