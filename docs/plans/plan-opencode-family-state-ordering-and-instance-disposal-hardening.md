# Plan: OpenCode-family state ordering and instance-disposal hardening

> Status: **Implemented.** Both problems were fixed by PR #855
> (`fix(opencode): serialize state delivery and scope disposal`, merged 2026-08-11),
> with follow-up regression coverage in #858. Written as a deferred follow-up that was
> explicitly not a merge requirement for PR #841.
> Date: 2026-08-09 (status refreshed 2026-08-12)
> Origin: Review of https://github.com/rullerzhou-afk/clawd-on-desk/pull/841
> Scope: The shared OpenCode/MiMo plugin core in `hooks/opencode-family-plugin/`

---

## 1. Decision summary

PR #841 should remain focused on forwarding, normalizing, and safely applying session-title updates. Two verified hardening problems are intentionally deferred:

1. `/state` requests for one session are fire-and-forget and have no causal ordering. An older lifecycle request can arrive after a newer metadata-only rename and restore the older title.
2. `server.instance.disposed` is directory-scoped, but the shared plugin factory currently clears process-wide session maps. Disposing one directory can remove cached ownership data for sessions in another directory.

These problems are real, but neither needs to expand PR #841 into a transport/ownership refactor. They should be implemented and reviewed together with their own failure-injection tests.

## 2. Verified current behavior

### 2.1 Same-session requests can complete out of order

`postToClawd()` starts an independent asynchronous port-discovery loop for every request and returns immediately. A normal lifecycle body and a metadata-only title body therefore have no ordering relationship.

A reproducible sequence is:

1. lifecycle request `L` captures title `A` and waits on a stale cached port;
2. another request discovers the live port and refreshes the shared port cache;
3. rename request `M` captures title `B`, uses the refreshed port, and applies `B`;
4. `L` falls through to the live port and applies its older title `A`;
5. if no later lifecycle event arrives, the HUD/Dashboard remains on `A`.

The next lifecycle event normally self-heals because new bodies use the latest title map. That reduces frequency and persistence; it does not establish causal correctness.

### 2.2 Disposal is scoped more narrowly than the maps

One entry-module factory can return handlers for several directory instances. Those handlers share closure state, including:

- `_sessionDirectoryById`;
- `_sessionTitleById` after PR #841;
- `_sessionParentById`;
- `_lastStatePerSession` and root/latest-session fallback state.

OpenCode's `server.instance.disposed` event identifies one directory through `event.properties.directory`. Existing cleanup treats it as process-wide and clears maps that can also contain sessions owned by other active directories.

The directory clear predates PR #841. PR #841 only makes the same ownership assumption for the title map, so the complete fix belongs in this follow-up rather than a title-only patch.

## 3. Workstream A: per-session FIFO for `/state`

### 3.1 Required contract

1. `/state` deliveries for the same canonical `session_id` settle in enqueue order.
2. Lifecycle and metadata-only state updates share the same per-session queue.
3. Different sessions remain concurrent; one slow session must not block another.
4. `/permission` must not enter the state queue or wait behind state retries.
5. A failed or exhausted request must not poison the queue; the next queued state must still run.
6. Completed queue tails must be removed so the map cannot grow for the lifetime of the host.
7. The event hook remains non-blocking from the host's perspective.

### 3.2 Implementation constraints

- Key the queue by the already canonicalized `body.session_id` so OpenCode and MiMo namespaces remain isolated.
- Make the state delivery primitive return a promise representing the complete cached-port/runtime-port/fallback scan.
- Chain each state delivery behind the prior tail for that session, swallowing the prior failure before starting the next delivery.
- Delete a tail only if it is still the current tail for that session; an older completion must not delete a newer queued tail.
- Snapshot and serialize mutable request data at enqueue time. In particular, `SessionEnd` must retain its title and directory even if session maps are cleaned before the queued network delivery begins.
- Keep shared port-cache self-healing. FIFO governs state causality, not global port discovery.
- Do not serialize every agent/session behind one global chain.

### 3.3 Required tests

Use a temp HOME, fake Bun bridge, and controllable fake fetch/server model.

1. Delay a placeholder `SessionStart`, enqueue a real-title metadata update, and assert the final server title is real.
2. Delay rename/lifecycle body `A`, enqueue rename `B`, and assert the final title is `B`.
3. Exhaust all ports for one queued request and assert the next request for that session still executes.
4. Block session A and assert session B can deliver concurrently.
5. Block a state request and assert `/permission` is sent immediately through its independent path.
6. Assert `session.deleted` serializes `SessionEnd` with its final title/directory, cleans ownership only after capture, and leaves no queue tail after settlement.
7. Assert the queue-tail map returns to its baseline size after success and failure.

## 4. Workstream B: directory-scoped disposal

### 4.1 Required contract

1. When `event.properties.directory` is present and valid, dispose only sessions owned by that directory.
2. Preserve directory, title, parent, dedup, and fallback state belonging to every other active directory handler from the same factory.
3. A legacy disposal event with no usable directory may retain a documented conservative fallback, but the fallback must be tested explicitly.
4. Single-session `session.deleted` behavior remains unchanged: serialize the final `SessionEnd` first, then remove that session's ownership state.
5. Cleanup must not synthesize an anonymous `SessionEnd` for another session.

### 4.2 Ownership design

Before mutating any map, derive the disposed session set from the authoritative directory ownership data. Normalize the directory using the same platform/path semantics used when it was captured; do not compare unrelated raw spellings ad hoc.

For every disposed session ID, audit and clean all session-scoped state, not only the map that exposed the bug:

- directory and title caches;
- child-to-parent entries whose child is disposed;
- child-to-parent entries whose parent is disposed, if their lifecycle contract does not outlive the parent;
- per-session state dedup;
- per-session FIFO tail once Workstream A exists, without interrupting an already serialized final body;
- root/latest-session fallback pointers when they reference a disposed session.

If the existing maps are insufficient to identify ownership safely, introduce one bounded `sessionId -> directory` ownership index rather than giving each map a separate disposal heuristic.

### 4.3 Required tests

Use the production shape: one factory product invoked as `plugin(ctxA)` and `plugin(ctxB)`. OpenCode and MiMo factory products are not a substitute for this test because they do not share closure state.

1. Create sessions A and B in different directories, dispose A, and assert B keeps its directory, title, parent/headless classification, and dedup state.
2. Assert B's next state body still contains B's directory and title.
3. Assert every session owned by A is removed, including relevant child/parent entries.
4. Assert a later title update for B is still detected and delivered normally.
5. Cover Windows-equivalent directory spelling/case behavior and the applicable POSIX behavior.
6. Cover the documented missing-directory fallback without silently treating a directory-scoped event as global in the normal case.

## 5. Non-goals

- Do not redesign the server's general last-writer-wins lifecycle model.
- Do not put blocking permission approval behind the state queue.
- Do not combine this work with title normalization, title-log privacy, or `metadataUpdatedAt`; those are PR #841 concerns.
- Do not add metadata owner validation only for titles. If the localhost metadata trust boundary is hardened later, apply one consistent owner contract to context and title metadata.
- Do not change OpenCode/MiMo session-ID namespaces.

## 6. Completion gate

This follow-up is complete only when delayed/failing transport tests prove per-session ordering, same-factory multi-directory tests prove selective disposal, and all fixtures remain hermetic: no real HOME, runtime file, localhost Clawd, or production plugin log may be touched.
