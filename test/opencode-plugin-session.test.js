const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("node:url");

async function loadSessionIdModule() {
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-plugin", "session-ids.mjs");
  return import(pathToFileURL(modulePath).href);
}

async function loadPluginModule() {
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-plugin", "index.mjs");
  return import(pathToFileURL(modulePath).href);
}

describe("opencode plugin session ids", () => {
  it("namespaces raw opencode session ids before sending them to Clawd", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.normalizeOpencodeSessionId("ses_123"), "opencode:ses_123");
    assert.strictEqual(mod.normalizeOpencodeSessionId("  ses_123  "), "opencode:ses_123");
    assert.strictEqual(mod.normalizeOpencodeSessionId("opencode:ses_123"), "opencode:ses_123");
    assert.strictEqual(mod.normalizeOpencodeSessionId(""), null);
  });

  it("falls back to the latest opencode session instead of bare default", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.resolveOpencodeSessionId(null, "ses_latest"), "opencode:ses_latest");
    assert.strictEqual(mod.resolveOpencodeSessionId(null, "opencode:ses_latest"), "opencode:ses_latest");
    assert.strictEqual(mod.resolveOpencodeSessionId(null, null), "opencode:default");
  });

  it("extracts event.properties.sessionID and top-level event.sessionID", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.getEventSessionId({ properties: { sessionID: " ses_abc " } }), "ses_abc");
    assert.strictEqual(mod.getEventSessionId({ sessionID: " top_level " }), "top_level");
    assert.strictEqual(mod.getEventSessionId({ properties: { sessionID: "" } }), null);
    assert.strictEqual(mod.getEventSessionId({ properties: {} }), null);
    assert.strictEqual(mod.getEventSessionId(null), null);
  });

  it("drops SessionEnd mappings that have no raw opencode session id", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(
      mod.shouldDropMappedEventWithoutSessionId(
        { type: "session.deleted", properties: {} },
        { state: "sleeping", event: "SessionEnd" }
      ),
      true
    );
    assert.strictEqual(
      mod.shouldDropMappedEventWithoutSessionId(
        { type: "session.deleted", properties: { sessionID: "ses_abc" } },
        { state: "sleeping", event: "SessionEnd" }
      ),
      false
    );
    assert.strictEqual(
      mod.shouldDropMappedEventWithoutSessionId(
        { type: "session.idle", properties: {} },
        { state: "attention", event: "Stop" }
      ),
      false
    );
  });

  it("wires session start and end events to the same namespaced Clawd session id", async () => {
    const mod = await loadPluginModule();
    const start = { type: "session.created", properties: { sessionID: "ses_same" } };
    const end = { type: "session.deleted", properties: { sessionID: "ses_same" } };

    const startMapped = mod.default.__test.translateEvent(start);
    const endMapped = mod.default.__test.translateEvent(end);
    const startBody = mod.default.__test.buildStateBody(startMapped.state, startMapped.event, "ses_same");
    const endBody = mod.default.__test.buildStateBody(endMapped.state, endMapped.event, "ses_same");

    assert.strictEqual(startBody.session_id, "opencode:ses_same");
    assert.strictEqual(endBody.session_id, "opencode:ses_same");
    assert.strictEqual(startBody.event, "SessionStart");
    assert.strictEqual(endBody.event, "SessionEnd");
  });
});

describe("opencode plugin module shape (#413 regression guard)", () => {
  it("exposes exactly one export: the default plugin function", async () => {
    const mod = await loadPluginModule();
    // opencode's getLegacyPlugins() iterates Object.values(mod) and throws
    // "Plugin export is not a function" on any non-function export. Any extra
    // named export (a test helper, a constant, anything) silently kills the
    // whole plugin — that was #413. Test internals must ride on the default
    // function (mod.default.__test), never as a separate module export.
    assert.deepStrictEqual(Object.keys(mod), ["default"]);
    assert.strictEqual(typeof mod.default, "function");
    assert.deepStrictEqual(Object.values(mod).map((v) => typeof v), ["function"]);
  });
});

describe("opencode plugin headless (parentID-based child detection)", () => {
  let pluginMod;

  beforeEach(async () => {
    pluginMod = await loadPluginModule();
    pluginMod.default.__test._sessionParentById.clear();
    pluginMod.default.__test._rootSessionId = null;
  });

  // Use case 1: getEventParentSessionId extracts parentID from event.properties.info
  it("extracts parentID from event.properties.info.parentID", async () => {
    const mod = await loadSessionIdModule();

    // Child session with parentID
    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_child", info: { parentID: "ses_root" } },
      }),
      "ses_root"
    );

    // Root session — no parentID
    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_root", info: {} },
      }),
      null
    );

    // Missing info entirely
    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_root" },
      }),
      null
    );

    // Empty string parentID
    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_root", info: { parentID: "" } },
      }),
      null
    );

    // Whitespace-only parentID
    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_root", info: { parentID: "  " } },
      }),
      null
    );

    // null event
    assert.strictEqual(mod.getEventParentSessionId(null), null);
  });

  // Use case 2: isChildSessionId normalizes sessionId before lookup
  it("isChildSessionId normalizes sessionId before checking the parent map", async () => {
    const mod = await loadSessionIdModule();
    // Map stores normalized keys (as the event handler does)
    const parentMap = new Map();
    parentMap.set("opencode:ses_child", "opencode:ses_root");

    // Raw id is normalized internally → matches
    assert.strictEqual(mod.isChildSessionId("ses_child", parentMap), true);
    // Already-prefixed id is also normalized → matches
    assert.strictEqual(mod.isChildSessionId("opencode:ses_child", parentMap), true);
    // Root session is not in the map
    assert.strictEqual(mod.isChildSessionId("ses_root", parentMap), false);
    assert.strictEqual(mod.isChildSessionId("opencode:ses_root", parentMap), false);
    // Unknown session
    assert.strictEqual(mod.isChildSessionId("ses_other", parentMap), false);
    // Edge cases
    assert.strictEqual(mod.isChildSessionId(null, parentMap), false);
    assert.strictEqual(mod.isChildSessionId("ses_child", null), false);
    assert.strictEqual(mod.isChildSessionId("ses_child", new Map()), false);
  });

  // Use case 3: buildStateBody adds headless: true for child sessions
  // (both raw and prefixed sessionId forms)
  it("buildStateBody adds headless: true for child sessions (raw and prefixed id)", async () => {
    // Simulate what the event handler does: store normalized keys
    pluginMod.default.__test._sessionParentById.set("opencode:ses_child", "opencode:ses_root");

    // Raw id passed to buildStateBody → isChildSessionId normalizes → match
    const bodyRaw = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_child");
    assert.strictEqual(bodyRaw.headless, true);
    assert.strictEqual(bodyRaw.session_id, "opencode:ses_child");

    // Prefixed id passed to buildStateBody → isChildSessionId normalizes → match
    const bodyPrefixed = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "opencode:ses_child");
    assert.strictEqual(bodyPrefixed.headless, true);
    assert.strictEqual(bodyPrefixed.session_id, "opencode:ses_child");
  });

  // Use case 4: buildStateBody does NOT add headless for root sessions
  it("buildStateBody does not add headless for root sessions", async () => {
    const body = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_root");
    assert.strictEqual(body.headless, undefined);
    assert.strictEqual(body.session_id, "opencode:ses_root");
  });

  // Use case 5: standalone session (not in _sessionParentById, not root)
  // must NOT be marked headless — no heuristic fallback
  it("buildStateBody does not add headless for standalone sessions without parentID", async () => {
    pluginMod.default.__test._rootSessionId = "opencode:ses_root";

    // ses_other is not in _sessionParentById → NOT headless (no heuristic)
    const body = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_other");
    assert.strictEqual(body.headless, undefined);
    assert.strictEqual(body.session_id, "opencode:ses_other");
  });

  // Use case 6: translateEvent maps child session.idle → SessionEnd
  it("translateEvent maps child session.idle to SessionEnd when in _sessionParentById", async () => {
    pluginMod.default.__test._sessionParentById.set("opencode:ses_child", "opencode:ses_root");

    const result = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_child" },
    });
    assert.strictEqual(result.state, "sleeping");
    assert.strictEqual(result.event, "SessionEnd");
  });

  // Use case 7: translateEvent maps root session.idle → Stop (attention)
  it("translateEvent maps root session.idle to Stop (attention)", async () => {
    const result = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    assert.strictEqual(result.state, "attention");
    assert.strictEqual(result.event, "Stop");
  });

  // Use case 8: standalone session.idle (not in map) → Stop, NOT SessionEnd
  it("translateEvent maps standalone session.idle to Stop (no heuristic fallback)", async () => {
    pluginMod.default.__test._rootSessionId = "opencode:ses_root";

    // ses_other is not in _sessionParentById → Stop (not SessionEnd)
    const result = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_other" },
    });
    assert.strictEqual(result.state, "attention");
    assert.strictEqual(result.event, "Stop");
  });

  // Use case 9: cleanupSessionParentMap clears entire map on server.instance.disposed
  // even when the event has no sessionID
  it("cleanupSessionParentMap clears entire map on server.instance.disposed (no sessionID)", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("opencode:ses_child1", "opencode:ses_root");
    parentMap.set("opencode:ses_child2", "opencode:ses_root");

    // server.instance.disposed with no sessionID — must still clear the map
    mod.cleanupSessionParentMap(
      { type: "server.instance.disposed", properties: {} },
      parentMap
    );
    assert.strictEqual(parentMap.size, 0);
  });

  // Use case 10: cleanupSessionParentMap removes single entry on session.deleted
  it("cleanupSessionParentMap removes single entry on session.deleted", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("opencode:ses_child1", "opencode:ses_root");
    parentMap.set("opencode:ses_child2", "opencode:ses_root");

    mod.cleanupSessionParentMap(
      { type: "session.deleted", properties: { sessionID: "ses_child1" } },
      parentMap
    );
    assert.strictEqual(parentMap.has("opencode:ses_child1"), false);
    assert.strictEqual(parentMap.has("opencode:ses_child2"), true);
    assert.strictEqual(parentMap.size, 1);
  });

  // Use case 11: cleanupSessionParentMap is a no-op for non-cleanup events
  it("cleanupSessionParentMap is a no-op for non-cleanup events", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("opencode:ses_child", "opencode:ses_root");

    mod.cleanupSessionParentMap(
      { type: "session.created", properties: { sessionID: "ses_child" } },
      parentMap
    );
    assert.strictEqual(parentMap.size, 1);

    mod.cleanupSessionParentMap(
      { type: "message.part.updated", properties: {} },
      parentMap
    );
    assert.strictEqual(parentMap.size, 1);
  });

  // Use case 12: cleanupSessionParentMap handles null/missing inputs gracefully
  it("cleanupSessionParentMap handles null/missing inputs gracefully", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("opencode:ses_child", "opencode:ses_root");

    // null event
    mod.cleanupSessionParentMap(null, parentMap);
    assert.strictEqual(parentMap.size, 1);

    // null map
    mod.cleanupSessionParentMap(
      { type: "server.instance.disposed", properties: {} },
      null
    );

    // event without type
    mod.cleanupSessionParentMap({}, parentMap);
    assert.strictEqual(parentMap.size, 1);
  });

  // Use case 13: full flow — session.created with parentID → headless body + SessionEnd idle
  it("full flow: session.created with parentID produces headless body and SessionEnd idle", async () => {
    pluginMod.default.__test._sessionParentById.set("opencode:ses_child", "opencode:ses_root");

    // buildStateBody for child → headless
    const body = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_child");
    assert.strictEqual(body.headless, true);
    assert.strictEqual(body.session_id, "opencode:ses_child");

    // translateEvent for child session.idle → SessionEnd
    const idleResult = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_child" },
    });
    assert.strictEqual(idleResult.state, "sleeping");
    assert.strictEqual(idleResult.event, "SessionEnd");

    // translateEvent for root session.idle → Stop
    const rootIdleResult = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    assert.strictEqual(rootIdleResult.state, "attention");
    assert.strictEqual(rootIdleResult.event, "Stop");
  });
});
