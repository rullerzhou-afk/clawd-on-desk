# Design: collapse mimocode + opencode into a shared "opencode-family" path

Status: **Implemented — both PRs merged.** PR A landed as #706
(`refactor/opencode-family-core`, 2026-07-17), which introduced
`hooks/opencode-family-plugin/core.mjs`; the rebased #607 followed on 2026-07-18. The
end state matches §10: a 1252-line shared core with `hooks/opencode-plugin/index.mjs`
and `hooks/mimocode-plugin/index.mjs` reduced to 19-line entries that import it.
Deferred hardening from a later review is planned separately in
`plan-opencode-family-state-ordering-and-instance-disposal-hardening.md`.
The design below is kept as the record. (Status refreshed 2026-08-12.)

Design review history: **v4 — final review round absorbed** (codex 2026-07-17, three
rounds: v1 BLOCK 4 blockers → v2; 3 contract gaps → v3; 1 blocker + 2 pinned contracts
→ this v4, reviewer verdict "APPROVE once absorbed". Every finding was verified
against real code before absorbing. Changelog in §11.)
PR shape as planned: **two independent PRs** — PR A (opencode-only refactor, merges
first) + a rebased #607 (mimocode as a thin member). See §10.
Authorship: PR A is maintainer work; the rebased #607 keeps @jiaxuan1101's authorship
with maintainer commits `Co-authored-by`.

---

## 1. Why this exists

PR #607 adds **MiMo Code (mimocode)** as a first-class agent. MiMo Code is an
opencode-derived runtime, so the PR — faithfully — mirrors the entire opencode
integration under new names. Measured with a normalized diff (replace
`opencode`/`mimocode`/`mimo` with one placeholder, then diff):

| file pair (opencode vs mimocode) | non-rename differing lines | nature |
|---|---|---|
| `hooks/*-plugin/index.mjs` (734 lines) | **6** | all comments |
| `hooks/*-plugin/session-ids.mjs` | **1** | the session-id prefix (`"opencode:"` vs `"mimocode:"`) |
| `hooks/*-plugin/package.json` | **0** | pure rename |
| `hooks/*-install.js` (199 lines) | **19** | all the string `.json` → `.jsonc` |
| `agents/*.js` | ~5 | `name`, `processNames`, `pidField`, comments |
| `src/server-route-permission.js` | ~85-line branch | mimocode branch at PR `:526-608` **mirrors** the opencode branch `:420-523` (its own comment says so) |
| `src/permission.js` | 2 flags + 2 reply fns | `isOpencode`/`isMimocode`, `replyOpencodePermission` (`:1690`) / `replyMimocodePermission` (`:1743`, differs in log strings only) |

So the duplication is **two-sided**: ~1000 lines in hooks/ AND a second mirrored
permission path inside the Electron main process. Every future fix (bridge protocol,
session-id edges, DND handling, reply timeouts, `always` semantics) would need
hand-mirroring or the two silently drift — and mimocode won't be the last
opencode-derived vendor CLI.

**Goal:** one shared family core (plugin + installer + agent contract + **server-side
permission path**), with each agent reduced to a declaration in an explicit family
registry. Adding the next opencode-derived CLI ≈ one registry entry + a 5-line plugin
entry + an icon.

**Non-goal:** changing any runtime behavior of the working opencode integration.
PR A is behavior-preserving for opencode, verified by tests + real-machine smoke.

---

## 2. What is actually per-agent (verified)

### 2.1 Four identity parameters — not three

The plugin runtime (`hooks/opencode-plugin/index.mjs`, 734 lines) hardcodes three:

- `index.mjs:42` — log filename (`opencode-plugin.log`)
- `index.mjs:49` — `AGENT_ID` (`"opencode"`)
- `index.mjs:50` — `HOOK_SOURCE` (`"opencode-plugin"`)

…and imports a fourth from `session-ids.mjs:1`:

- `SESSION_ID_PREFIX = "opencode:"` — baked into `normalizeOpencodeSessionId`,
  `DEFAULT_SESSION_ID`, and therefore every `session_id` the plugin reports.

The prefix is **load-bearing**: `src/state.js` keys its sessions map by `session_id`
alone (`sessions.set(sessionId, …)`, `state.js:1455`), with no agent-id namespacing.
If mimocode shipped with the opencode prefix, an opencode `ses_123` and a mimo
`ses_123` would both normalize to `opencode:ses_123` and **overwrite each other's
session state, terminal focus target, and permission context**. (PR #607 got this
right — its copy changes the prefix to `"mimocode:"`; v1 of this plan wrongly called
the copy "rename-only, cosmetic".) The existing test locks the prefixed shape:
`test/opencode-plugin-session.test.js:80` asserts `"opencode:ses_same"`.

So the factory takes **four** params: `{ agentId, hookSource, logFileName,
sessionIdPrefix }`, and `session-ids.mjs` must be parameterized, not moved verbatim
(§3.2).

### 2.2 "Generic" means generic *within the family wire contract*

Everything else in the 734 lines is agent-neutral, but NOT host-neutral. The core
bakes in an opencode-family protocol; any CLI joining the family must satisfy all of:

- event names/shapes: `session.created/status/idle/error/deleted`,
  `message.part.updated` parts (`index.mjs:411-478`)
- `permission.asked` payload: `id`/`permission`/`metadata`/`patterns`/`always`
  (`index.mjs:503-529`)
- reply vocabulary exactly `once | always | reject` (`index.mjs:561-563`)
- the private SDK client shape `ctx.client._client.post()` (`index.mjs:567-582`)
- Bun runtime with `Bun.serve` for the reverse bridge (`index.mjs:609-632`)
- `ctx.serverUrl` / `ctx.client` / `ctx.directory` init contract (`index.mjs:635-643`)
- in-process plugin execution (the tree walk starts at `process.pid`,
  `index.mjs:225,233` — process names are only used to spot terminals/editors/system
  boundaries, never the host itself; correct for any in-process host)

This list is the **membership test** for the family registry (§7). It cannot be
verified from this repo for MiMo — real-mimo smoke is a merge gate (§9).

### 2.3 Packaging: config already covers it; artifact still needs verification

`package.json:135` (`files`) and `:152-158` (`asarUnpack`) both glob `hooks/**/*` and
`agents/**/*`, so a new `hooks/opencode-family-plugin/` ships unpacked with no
packaging change. But the existing test only asserts the glob strings exist
(`test/package-build-config.test.js:47`) — a real packaged build must verify the thin
entry can import the sibling core and that the **registered absolute path is
byte-identical** before/after (§9).

---

## 3. Target architecture

```
agents/
  opencode-family.js               # NEW — THE FAMILY REGISTRY (single source of truth)
  opencode.js                      # thin: spreads registry entry + own processNames
  mimocode.js                      # thin: same shape                     [PR #607]

hooks/
  opencode-family-plugin/          # NEW — shared runtime, imported by entries
    core.mjs                       # the 734 lines as createOpencodeFamilyPlugin(cfg)
    session-ids.mjs                # parameterized by prefix (see below)
    (NO package.json — never registered, only imported; .mjs suffix already = ESM)
  opencode-plugin/
    index.mjs                      # THIN ENTRY (~5 lines)
    package.json                   # KEEP — host resolves package.json "main" to find the entry
  mimocode-plugin/                 # same thin shape                      [PR #607]

  opencode-family-install.js       # NEW — makeFamilyInstaller(cfg)
  opencode-install.js              # thin wrapper; FULL legacy API preserved (§5)
  mimocode-install.js              # thin wrapper, jsonc: true            [PR #607]

src/
  server-route-permission.js       # ONE family branch keyed by registry (§3.5)
  permission.js                    # ONE family entry shape + ONE reply fn (§3.5)
  bubble-renderer.js               # ONE family render branch, neutral payload (§3.5)
  main.js                          # reply-fn destructure + server-ctx wiring (§3.5)
```

### 3.1 Family registry (`agents/opencode-family.js`)

The explicit allowlist that drives everything. Never inferred from
`eventSource: "plugin-event"` (§7).

```js
const OPENCODE_FAMILY = Object.freeze({
  opencode: Object.freeze({
    displayName: "OpenCode",
    sessionIdPrefix: "opencode:",
    hookSource: "opencode-plugin",
    pluginDirName: "opencode-plugin",
    logFileName: "opencode-plugin.log",
    configDirSegments: [".config", "opencode"],
    configFileName: "opencode.json",
    jsonc: false,
    schema: "https://opencode.ai/config.json",
  }),
  mimocode: Object.freeze({ /* mirror fields, jsonc: true */ }),   // [PR #607]
});
const FAMILY_EVENT_MAP = Object.freeze({ SessionStart: "idle", /* …10 entries, today
  identical in agents/opencode.js:14-28 and agents/mimocode.js — shared so they can't drift */ });
const FAMILY_CAPABILITIES = Object.freeze({ httpHook: false, permissionApproval: true,
  sessionEnd: true, subagent: false });
function isOpencodeFamily(agentId) { return Object.hasOwn(OPENCODE_FAMILY, agentId); }
// permission entries keep the PUBLIC `agentId` field (§3.5) — one identity truth:
function isOpencodeFamilyEntry(entry) { return !!entry && isOpencodeFamily(entry.agentId); }
```

`agents/opencode.js` keeps only `id/name/processNames/pidField` + spreads
`FAMILY_EVENT_MAP`/`FAMILY_CAPABILITIES`. Registry (`agents/registry.js`) unchanged in
mechanism.

CJS/ESM note: the registry is CJS (consumed by `src/**` and installers). The plugin
core is ESM under Bun and must NOT import it — entries pass their four params as
literals (duplicated by design, locked by a cross-check test that reads both and
asserts they match the registry).

### 3.2 Shared plugin core + parameterized session-ids

```js
// hooks/opencode-family-plugin/session-ids.mjs (sketch)
//
// Prefix classification (verified against the real file — get it wrong and MiMo
// child sessions break silently):
//   prefix-INDEPENDENT (plain module exports, unchanged):
//     getEventSessionId, getEventParentSessionId,
//     shouldDropMappedEventWithoutSessionId  (+ internal normalizeSessionText)
//   prefix-DEPENDENT (must come from the factory):
//     DEFAULT_SESSION_ID, normalizeSessionId, resolveSessionId,
//     isChildSessionId, cleanupSessionParentMap
// The last two LOOK neutral but call the prefixing normalizer internally
// (session-ids.mjs:54 and :69 today). If they kept an opencode-prefixed
// normalizer, a MiMo child map key `mimocode:ses_child` would be looked up as
// `opencode:ses_child`: child never marked headless, child session.idle
// misroutes to Stop instead of SessionEnd (HUD/menu pollution), and
// session.deleted deletes under the wrong prefix so the parent map leaks for
// the life of the process.
export function createSessionIdHelpers(prefix) {
  const DEFAULT_SESSION_ID = `${prefix}default`;
  const normalizeSessionId = (v) => { /* current logic, prefix param */ };
  const resolveSessionId = (current, fallback) => { /* current logic */ };
  const isChildSessionId = (sessionId, map) => { /* current logic, uses normalizeSessionId */ };
  const cleanupSessionParentMap = (event, map) => { /* current logic, uses normalizeSessionId */ };
  return { DEFAULT_SESSION_ID, normalizeSessionId, resolveSessionId,
           isChildSessionId, cleanupSessionParentMap };
}
export { getEventSessionId, getEventParentSessionId, shouldDropMappedEventWithoutSessionId };
```

```js
// hooks/opencode-family-plugin/core.mjs (sketch)
export function createOpencodeFamilyPlugin({ agentId, hookSource, logFileName, sessionIdPrefix }) {
  const ids = createSessionIdHelpers(sessionIdPrefix);
  // per-process mutable state (_cachedPort, _lastStatePerSession, _sessionParentById,
  // _stablePid, _bridge*, debug buffer…) lives in THIS closure
  const plugin = async (ctx) => { /* body unchanged */ };
  Object.defineProperty(plugin, "__test", { value: { /* live getters into closure state */ } });
  return plugin;
}
```

```js
// hooks/opencode-plugin/index.mjs — ENTIRE file after refactor
import { createOpencodeFamilyPlugin } from "../opencode-family-plugin/core.mjs";
export default createOpencodeFamilyPlugin({
  agentId: "opencode", hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log", sessionIdPrefix: "opencode:",
});
```

**Lifecycle invariant (locked by review):** the factory is called exactly **once per
entry-module evaluation** — "one state instance per entry-module evaluation", NOT per
plugin invocation. Re-creating per call would wipe dedup/parent maps, leak the old
`Bun.serve` bridge (it has no shutdown path by design, `index.mjs:606-632`), and
strand in-flight permission requests holding the old bridge URL/token.

Implementation form — two acceptable shapes, decided at implementation time:
(a) wrap the whole body in the factory (mechanical indent; review with `git diff -w`),
or (b) reviewer-preferred: `createState()` returns the mutable-state bag, pure
functions stay module-level and take `(cfg, state)` explicitly, factory wires them.
(b) has the cleaner dependency story; (a) has the near-zero `-w` diff. Either is fine;
a module-level `configure()` is **rejected** (same-process double-import would be
last-writer-wins).

Migration safety: existing opencode installs keep working with **no config
migration** — the registered path is still `…/hooks/opencode-plugin`, computed by the
same `resolvePluginDir` from the same `hooks/` directory (`opencode-install.js:31-35`,
`json-utils.js:305`). Locked by a byte-identity snapshot test (§9). The shared core
dir must never leak into the registered string.

### 3.3 Shared installer — preserving the FULL legacy surface

`makeFamilyInstaller(cfg)` produces `{ register, unregister, resolvePluginDir,
DEFAULT_PARENT_DIR, DEFAULT_CONFIG_PATH }` with the current logic (idempotency,
stale-path-by-basename update, scoped-package guard, backup/prune) — parameterized by
registry entry + `jsonc` flag (§4).

Each thin wrapper (`opencode-install.js`) must preserve, verified against callers:

1. **Named exports**: `registerOpencodePlugin` (`integration-sync.js:309`),
   `unregisterOpencodePlugin` (`cleanup-integrations.js:18,253`),
   `DEFAULT_PARENT_DIR`/`DEFAULT_CONFIG_PATH` (`agent-descriptors.js:184-185`),
   `resolvePluginDir` (used by tests: `opencode-install.test.js:6,189-194`,
   `cleanup-integrations.test.js:12,64`).
2. **Return-value contract**: `{ added, skipped, created, configPath, pluginDir }` and
   the **`reason: "opencode-not-found"` string** — `integration-sync.js:314` branches
   on it. Unregister's `{ removed, changed, skipped, backupPath? }` likewise
   (`opencode-install.js:173-178`).
3. **The CLI entry**: `require.main === module` + `--uninstall`
   (`opencode-install.js:190-197`). v1 dropped this; wrappers keep it.

(v1 claimed tests also depend on installer `__test.entryIsExactManagedPlugin`/
`normalizePluginEntry` — **wrong**, no test imports them. Keeping `__test` on the
shared installer is optional.)

### 3.4 Doctor — validator shared, but TWO fixes needed

- Descriptor side is fine as in PR #607: mimocode sets `detection: "opencode-plugin"`,
  `marker: "mimocode-plugin"`.
- **False-red (JSONC):** doctor reads configs via its own `readJson` = bare
  `JSON.parse` (`agent-integrations.js:56-64`); parse failure → `config-corrupt`
  warning (`:904-914`). A legal commented `mimocode.jsonc` would be reported corrupt.
  Doctor must read family configs through the same JSONC-aware reader as the
  installer (§4).
- **False-green (missing shared files):** `opencode-entry-validator.js:11-45`
  checks only that the registered dir exists, `index.mjs` exists, and the module
  has no named exports. The dependency chain is now TWO levels —
  `<entry>/index.mjs` → `../opencode-family-plugin/core.mjs` →
  `./session-ids.mjs` — and a one-level import check would still report ok when
  `core.mjs` survives packaging but `session-ids.mjs` doesn't (host then dies with
  `ERR_MODULE_NOT_FOUND`). The graph is fixed, so do NOT write a generic ESM
  resolver: declare the closure explicitly (descriptor/validator lists the required
  files relative to the entry) and check each exists. Regression tests: entry
  missing → red; core missing → red; **core present but session-ids missing →
  red**; packaged-build test additionally imports both entries for real (§9).

### 3.5 Permission path — the second fork, collapsed END-TO-END

The fork is **three segments plus wiring**, not two (v2 missed the renderer):

1. **Route** — `server-route-permission.js:420-523` (opencode) vs `:526-608`
   (mimocode, "mirrors opencode" per its own comment).
2. **Permission core** — `permission.js` carries `isOpencode`/`isMimocode` flags
   (`:869-870,927,1526,1547,2205`) and twin reply fns (`:1690` vs `:1743`,
   log-string diffs only).
3. **Renderer** — PR head `bubble-renderer.js` `show()` branches on
   `data.isOpencode || data.isMimocode` and selects per-agent keys
   (`opencodeAlways`/`mimocodeAlways`, `opencodePatterns`/`mimocodePatterns`) and
   per-agent decide behaviors (`"opencode-always"`/`"mimocode-always"`); the
   blanket-always tooltip hardcodes the product name "opencode" in all five
   languages (main `bubble-renderer.js:68`, `alwaysAllowBlanketTitle`).
4. **Wiring** — `main.js:1408` destructures `replyOpencodePermission` from
   `_perm`; `main.js:1961` injects it into the server context.

Collapse to one path keyed by the registry:

- **Route:** one `if (isOpencodeFamily(agentId))` branch replacing both. Behavior
  identical, parameterized: enabled/DND/headless/bubble-gate checks call the
  existing per-agent settings APIs with `agentId`; log lines use
  `OPENCODE_FAMILY[agentId].displayName`.
- **Entry shape — ONE identity truth, the public `agentId`:** permission entries
  already carry `agentId` today (`server-route-permission.js:487` on main), and
  generic logic consumes it: focus (`permission.js:383`), auto-approve logging
  (`:681`), remote-approval capability (`:955`), and disable-agent bubble sweep
  (`dismissPermissionsByAgent`, `:2250`) — the latter two **fall back to
  `"claude-code"`** when `agentId` is missing, so replacing it with a parallel
  `familyAgentId` would silently break agent-disable cleanup and misroute
  focus/remote policy. Rule: keep `permEntry.agentId` as-is; do NOT introduce
  `permEntry.familyAgentId`; `isOpencodeFamilyEntry(entry)` checks `entry.agentId`
  (§3.1). The only NEW internal fields are the neutral bridge triple
  `familyRequestId`/`familyBridgeUrl`/`familyBridgeToken` (+`familyAlwaysCandidates`/
  `familyPatterns`), replacing the duplicated `opencode*`/`mimocode*` pairs
  (PR head `server-route-permission.js:492-498` vs `:594-600`).
- **Bubble payload:** the renderer runs without registry access, so the payload
  builder maps `familyAgentId: permEntry.agentId` + `familyDisplayName`,
  `familyAlways`, `familyPatterns` — presence of `familyAgentId` selects the family
  render branch. Do NOT keep a compat mapping to the old per-agent payload names —
  that would just move the fork into the payload builder; payload builder and
  renderer switch together in the same commit.
- **Renderer:** one family branch consuming only the neutral fields; the Always
  button emits a single `"family-always"` decide behavior; `handleDecide` handles
  it once and records `familyAlwaysPicked`. The blanket-always tooltip becomes a
  template with the product name substituted from `familyDisplayName` in all five
  languages — MiMo users must not read "opencode" in the warning.
- **Reply:** one `replyOpencodeFamilyPermission({ agentId, bridgeUrl, bridgeToken,
  requestId, reply, toolName })`. `main.js:1408` destructure and `:1961` server-ctx
  wiring migrate in the same commit; keep `replyOpencodePermission` as a thin alias
  only if an external caller audit (beyond main.js) finds users —
  `permission.js:2323-2324` exports both today.
- **Sub-gates stay per-agent**: `isAgentPermissionsEnabled("opencode")` vs
  `("mimocode")` remain distinct user-facing switches — the registry parameterizes
  them, it does not merge them.

Caveat: the opencode side of all four segments is **live code**; this collapse
belongs to PR A (§10) and must be behavior-preserving under the existing opencode
permission tests + new family-parameterized ones, including a payload↔renderer
contract test (neutral fields in, correct pills/buttons/tooltip out, `family-always`
round-trip). PR #607's head has **no route/renderer tests** for the mimocode branch —
the shared path must add them (§9).

### 3.6 Remaining per-agent surface (stays thin, per PR #607)

Registry list entry, icon (`assets/icons/agents/mimocode.png`), i18n labels,
settings/dashboard wiring, `integration-sync` + `cleanup-integrations` entries,
startup process-liveness names, log collection — all declaration-level, driven by
`agents/mimocode.js` + the registry. Kept from the PR as-is.

---

## 4. JSONC — decision: option A (jsonc-parser), applied consistently

**Verified bug in PR #607:** its mimocode installer changed the filename to
`mimocode.jsonc` but still reads via bare `JSON.parse` and writes via
`JSON.stringify` (`json-utils.js:21-23,41-53`). A `mimocode.jsonc` **with comments**
fails at read: register throws at the mirrored `opencode-install.js:83-90` catch;
unregister likewise (`:158-162`). So: commented config → **install/uninstall abort**
(precisely: it fails loudly rather than silently destroying comments; a fresh created
file is comment-free valid JSONC. v1 misstated this). And doctor flags the same file
`config-corrupt` (§3.4).

**Decision (review-concurred): A.** Use `jsonc-parser`'s `modify` + `applyEdits` for
**element-level array edits** — never reserialize the document or reassign the whole
array, so comments inside the array survive. Requirements:

- parse with error collection; a malformed JSONC file → refuse to write (same "don't
  clobber what we can't parse" stance as today's JSON path).
- preserve BOM/CRLF/indent style (derive `FormattingOptions` from the file).
- **unregister removes ALL exact-matched entries, not one.** The live contract is a
  filter (`opencode-install.js:168-171`): duplicates from historical installs are all
  removed in one call and `removed` may be `> 1`. The JSONC editor must find every
  exact-match index and apply removals **highest index → lowest**, recomputing edits
  against the current text each step, preserving neighboring/in-array comments;
  `removed` count and `{ removed, changed, skipped, backupPath? }` semantics stay
  identical. A duplicate-entry test is mandatory (§9).
- the SAME reader backs installer register/unregister and the doctor's config read
  (`agent-integrations.js` `readJson` call sites, e.g. `:906` — NOT
  `opencode-entry-validator.js`, which validates a single plugin-path string and
  never reads the config file). One JSONC abstraction, no second parser.
- backups keep the pre-edit **original bytes** (reuse `createBackup`; write-back goes
  through the existing `writeTextAtomic`, `json-utils.js:277` — no new atomic-write
  code).
- plain-JSON family members (`opencode.json`) keep the existing `json-utils` path
  byte-for-byte (no risk of reformatting existing user configs); `jsonc: true`
  members route through the JSONC editor.

### 4.1 Dependency isolation — jsonc-parser must NOT leak into the remote-deploy closure

`hooks/json-utils.js` is shipped to remote SSH machines **as a bare file with no
node_modules** — it is in both deploy manifests (`scripts/remote-deploy.sh:134`,
`src/remote-ssh-deploy.js:52`). A top-level `require("jsonc-parser")` in
`json-utils.js` would crash every remote hook install (`install.js`,
`codex-install-utils.js`, …) with `Cannot find module` — and the manifest test only
scans **relative** requires (`test/remote-deploy.test.js:17-21`), so nothing would
catch it before a user hits it. Rules:

- the JSONC editor lives in a NEW module `hooks/opencode-family-jsonc.js`, the only
  place that requires `jsonc-parser`; `hooks/json-utils.js` is not touched.
- the shared family installer requires it **lazily, only when `cfg.jsonc` is true**
  (defense in depth: even if a family installer file someday enters a deploy
  manifest, the JSON-only path still runs dep-free).
- `opencode-family-jsonc.js` and the family installers are NOT added to either
  remote-deploy manifest.
- new guard test: every file in the remote-deploy closure (manifest files + their
  transitive relative requires) contains **no bare non-builtin require** — closing
  the gap the relative-only regex leaves.
- dependency itself: runtime `dependencies` already exist (`koffi`, `ws`, … —
  `package.json:181`), so this is not a zero-dep repo; pin a CJS-compatible
  `jsonc-parser` 3.x, Electron side only — the Bun plugin core stays zero-dependency.

Option B (strip comments, write plain JSON) **rejected** — that's the variant that
genuinely destroys user comments. Option C (hand-rolled textual splice) fallback only
if A's dependency is vetoed.

Empirical unknown (real-mimo gate, §9): whether real MiMo installs ship a commented
`mimocode.jsonc` by default. Irrelevant to the decision — users can add comments —
but it calibrates urgency.

---

## 5. Compatibility contract checklist (all preserved by §3.3/§3.5)

- `registerOpencodePlugin({ silent })` + result fields + `reason` string —
  `integration-sync.js:309-316`
- `unregisterOpencodePlugin` + result fields — `cleanup-integrations.js:18,253`
- `DEFAULT_PARENT_DIR` / `DEFAULT_CONFIG_PATH` — `agent-descriptors.js:184-185`
- `resolvePluginDir` — tests above; registered-path byte identity (§3.2)
- installer CLI: `node hooks/opencode-install.js [--uninstall]`
- `permEntry.agentId` — the public identity field stays untouched; generic
  consumers: focus entry (`permission.js:383`), auto-approve logging (`:681`),
  remote-approval capability (`:955`), disable-agent sweep (`:2250`); the latter
  two fall back to `"claude-code"` when absent, so no family entry may omit it
- `permission.js` exports `replyOpencodePermission` (`:2323`) — known callers to
  migrate in the same commit: `main.js:1408` (destructure from `_perm`) and
  `main.js:1961` (server-ctx wiring); audit for others before deciding alias vs
  rename
- bubble payload → renderer contract: neutral `family*` fields and the single
  `"family-always"` decide behavior replace `isOpencode`/`isMimocode`,
  `opencodeAlways`/`mimocodeAlways`, `opencodePatterns`/`mimocodePatterns`,
  `"opencode-always"`/`"mimocode-always"` — payload builder, renderer, and
  `handleDecide` switch together (§3.5); blanket-always tooltip parameterized by
  `familyDisplayName` in all five languages
- state wire format: `agent_id`, `hook_source`, prefixed `session_id`, `source_pid`,
  `pid_chain`, `cwd`, `headless` — unchanged
- mimocode mirror wiring from PR #607 (integration-sync branch, cleanup entry,
  descriptor) — re-expressed through the registry, same observable behavior

## 6. #413 constraint (corrected explanation)

opencode's legacy loader iterates `Object.values(mod)` over the **entry module
namespace** and throws on any non-function export, silently killing the plugin. The
real invariant is therefore: **the entry module has exactly one export, `default`,
and it is a function** — already locked by
`test/opencode-plugin-session.test.js:87-97`; extend the same test to the mimocode
entry. The `__test` bag rides on the default function object (`mod.default.__test`),
which `Object.values(mod)` never sees — its non-enumerability is hygiene, not the
protection (v1 overstated this). `core.mjs` may freely use named exports: it is
imported by entries, never registered as a plugin dir.

## 7. Family boundary

Members: exactly `{ opencode, mimocode }`, by explicit registry (§3.1). Although
three agents declare `eventSource: "plugin-event"`, **openclaw**
(`agent-descriptors.js:205-216`, own `openclaw-plugin` mode, multi-export entry) and
**hermes** (`:217-228`, Python/`plugin.yaml`) are different plugin shapes and stay
independent. Membership additionally requires the full wire contract of §2.2. Never
key family behavior off `eventSource`.

## 8. Decisions (was "open questions" — resolved with review)

1. JSONC → **A** (`jsonc-parser`, element-level edits; B rejected, C fallback). §4
2. Dependency → **allowed** (repo already has runtime deps; Electron-side only,
   pin CJS-compatible 3.x). §4
3. Core shape → **factory**; state-bag-plus-explicit-params acceptable variant;
   module-level `configure()` rejected. §3.2
4. Rollout → **two independent PRs**, not one reshaped #607. §10
5. Boundary → confirmed `{opencode, mimocode}`. §7

## 9. Regression gates

Unit/contract:
- all existing opencode tests green, including the `"opencode:ses_same"` prefix
  assertions and the #413 module-shape guard (both entries)
- factory: two instances (opencode + mimocode) fully isolated — same raw
  `ses_123` yields `opencode:ses_123` vs `mimocode:ses_123`; state maps, bridge
  tokens, log paths independent; `__test` getters read live per-instance state
- session-helper matrix, run for BOTH prefixes: `isChildSessionId` hit on a raw
  child id (`ses_child` vs map key `<prefix>ses_child`) AND on an
  already-prefixed id; `session.deleted` removes exactly its own entry;
  `server.instance.disposed` clears the whole map — proves the §3.2
  prefix-dependent classification
- registry↔entry literal cross-check (§3.1 CJS/ESM note)
- installer wrappers: named exports + return shapes + `reason` strings + CLI
  entry (run the file, assert it registers/uninstalls)
- registered-path byte-identity snapshots: dev mac/linux, Windows, packaged
  `app.asar.unpacked/hooks` (§3.2)
- JSONC matrix: line/block comments, comments inside the `plugin` array, trailing
  commas, CRLF, BOM, malformed input (refuse-to-write), **duplicate managed entries
  (unregister removes all, `removed: 2`, comments intact)** — register/update/
  unregister/doctor over each; the commented-file case **fails against PR #607's
  head** by design (it reproduces the bug)
- remote-deploy closure: manifest files + transitive relative requires contain no
  bare non-builtin require (§4.1) — this test would catch a stray
  `require("jsonc-parser")` in `json-utils.js`
- permission family path: once/always/reject, DND drop, agent-disabled drop,
  headless drop, bubble-creation failure → bridge reject, bad token, bridge
  timeout, port re-discovery after Clawd restart — parameterized over both agents
  (PR head has none of these for mimocode)
- payload↔renderer contract: neutral `family*` payload renders tool pill/detail/
  buttons correctly; Always button emits `"family-always"` and round-trips to a
  bridge `always` reply; blanket tooltip shows `familyDisplayName` (never a
  hardcoded product name) in all five languages
- doctor: commented JSONC not red; fixed two-level closure enforced — missing
  `core.mjs` not green, and **core present but `session-ids.mjs` missing** not
  green (§3.4)
- `permEntry.agentId` retention: disable-agent sweep still clears family bubbles;
  focus/remote-approval never fall back to `"claude-code"` for a family entry

Real-machine (per repo practice — never merge platform behavior on CI alone):
- packaged build: both entries import under Node from `app.asar.unpacked`;
  registered path unchanged for an existing opencode install
- real opencode: install → events flow → permission bubble round-trips (bridge) →
  uninstall clean; confirm no config migration happened
- real mimocode: same loop + commented-`.jsonc` register/unregister survives with
  comments intact; verifies the §2.2 wire-contract assumptions (loader reads
  `package.json` `main`, in-process execution, `_client.post` shape) that cannot be
  confirmed from this repo
- dual-host: opencode + mimo running simultaneously with colliding raw session ids —
  no state/permission cross-talk

## 10. Rollout — two PRs

**PR A — "extract opencode-family core" (maintainer PR, merges first).**
Opencode-only, behavior-preserving, **JSON-only** (no jsonc-parser, no JSONC code —
keeping the highest-risk behavior-preservation review undiluted): core factory +
parameterized session-ids + shared installer (JSON path) + registry (single member)
+ **end-to-end permission-path collapse** (§3.5: route + permission core + renderer
neutral payload/`family-always` + `main.js` wiring + tooltip parameterization) +
gates of §9 that don't need mimo. Merge on green suite + real opencode smoke +
packaged-build check.

**PR #607 rebased — "add mimocode as a family member" (contributor's PR).**
After PR A merges, #607 rebases to: registry entry, `agents/mimocode.js`, thin plugin
entry + `package.json`, thin installer wrapper (`jsonc: true`), the
`jsonc-parser` dependency + `hooks/opencode-family-jsonc.js` editor + doctor JSONC
read wiring (§4/§4.1), icon/i18n/settings/sync/cleanup/descriptor wiring,
mimocode-parameterized tests + the JSONC matrix + remote-closure guard test,
real-mimo smoke.
@jiaxuan1101's authorship preserved; our commits `Co-authored-by`. The diff should
shrink from +1823 to roughly the size of the qoderwork-style "add an agent" PRs.

Sequencing note: PR A touches `permission.js`/`server-route-permission.js`, which
recent main work also touches (e.g. #703 kimi changes) — rebase early, keep the
family collapse mechanical.

## 11. v1 → v2 (what the adversarial review changed)

1. **Blocker — session-id prefix:** "3 constants / session-ids moves verbatim" was
   wrong; prefix is the 4th identity param, collision chain verified via
   `server-route-state.js:140` → `state.js:1455`. → §2.1, §3.2.
2. **Blocker — doctor JSONC false-red** (`agent-integrations.js:56,904`): JSONC must
   be fixed in doctor too, one shared reader. → §3.4, §4. Also corrected v1's claim
   that the current PR "destroys comments" — it fails at read; B would destroy.
3. **Blocker — installer contract:** CLI entry (`opencode-install.js:190-197`) and
   return/`reason` contract (`integration-sync.js:314`) preserved; dropped v1's false
   claim that tests use installer `__test`. → §3.3, §5.
4. **Blocker — the second fork:** server-side permission path
   (`server-route-permission.js:420-608`, `permission.js:1522-1786`) folded into the
   family design; "one shared path" now actually means one. → §3.5.
5. #413 explanation corrected (module-namespace, not function-property,
   enumerability). → §6.
6. Factory lifecycle pinned to once-per-entry-module-evaluation; `configure()`
   rejected; state-bag variant recorded. → §3.2.
7. Shared core dir ships **without** `package.json`; entry dirs keep theirs (host
   resolves `main`). → §3.
8. Rollout switched to two independent PRs. → §10.
9. Gates extended: byte-identity path snapshots, dual-host collision, JSONC matrix,
   permission full-path matrix, doctor false-red/false-green, packaged-entry import,
   real-mimo wire-contract verification. → §9.

v2 → v3 (codex round 2, all findings code-verified):

10. **Gap — renderer + wiring were the missing fork segments:** PR-head
    `bubble-renderer.js` branches on `isOpencode || isMimocode` with per-agent
    always/patterns keys and `"<agent>-always"` behaviors; tooltip hardcodes
    "opencode" in five languages (`bubble-renderer.js:68`); `main.js:1408,1961`
    wire `replyOpencodePermission`. Permission collapse is now end-to-end with a
    neutral payload vocabulary and single `"family-always"`. → §3.5, §5, §9.
11. **Gap — jsonc-parser must not enter the remote-deploy closure:**
    `json-utils.js` ships to remote SSH hosts dependency-free
    (`remote-deploy.sh:134`, `remote-ssh-deploy.js:52`); manifest test only scans
    relative requires. New isolated `hooks/opencode-family-jsonc.js`, lazy require,
    manifest exclusion, closure guard test. → §4.1.
12. **Gap — JSONC unregister must remove ALL exact matches** (live contract is a
    filter, `opencode-install.js:168-171`; `removed` may exceed 1): highest→lowest
    index edits, duplicate-entry test. → §4, §9.
13. Corrections: `isOpencodeFamily(agentId)` vs `isOpencodeFamilyEntry(entry)` split
    (§3.1); doctor's config reader is `agent-integrations.js` `readJson`, not
    `opencode-entry-validator.js` (§4).
14. Rollout: JSONC (dependency + editor + doctor wiring + matrix tests) moved from
    PR A into the rebased #607 — PR A is now strictly JSON-only. → §10.

v3 → v4 (codex round 3, all findings code-verified; reviewer: APPROVE once absorbed):

15. **Blocker — session-helper misclassification:** `isChildSessionId` and
    `cleanupSessionParentMap` internally call the prefixing normalizer
    (`session-ids.mjs:54,69`) — they move into the factory return; only
    `getEventSessionId`/`getEventParentSessionId`/
    `shouldDropMappedEventWithoutSessionId` stay module-level. Failure chain if
    left opencode-prefixed: MiMo children never marked headless, child idle
    misroutes to Stop, HUD/menu pollution, parent-map leak. → §3.2, §9.
16. **Pinned — public `permEntry.agentId` is the single identity truth** (focus
    `permission.js:383`, logging `:681` and remote `:955` both with
    `"claude-code"` fallbacks, disable-sweep `:2250`); no `permEntry.familyAgentId`;
    `familyAgentId` exists only in the bubble-payload mapping. → §3.1, §3.5, §5, §9.
17. **Pinned — doctor validates the fixed two-level dependency closure**
    (entry → core → session-ids) via an explicitly declared file list, no generic
    ESM parser; "core present / session-ids missing" must be red. → §3.4, §9.
