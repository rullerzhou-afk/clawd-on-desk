const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("node:url");

async function loadSessionIdModule() {
  const modulePath = path.join(__dirname, "..", "hooks", "mimocode-plugin", "session-ids.mjs");
  return import(pathToFileURL(modulePath).href);
}

async function loadPluginModule() {
  const modulePath = path.join(__dirname, "..", "hooks", "mimocode-plugin", "index.mjs");
  return import(pathToFileURL(modulePath).href);
}

describe("mimocode plugin session ids", () => {
  it("namespaces raw mimocode session ids before sending them to Clawd", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.normalizeMimocodeSessionId("ses_123"), "mimocode:ses_123");
    assert.strictEqual(mod.normalizeMimocodeSessionId("  ses_123  "), "mimocode:ses_123");
    assert.strictEqual(mod.normalizeMimocodeSessionId("mimocode:ses_123"), "mimocode:ses_123");
    assert.strictEqual(mod.normalizeMimocodeSessionId(""), null);
  });

  it("falls back to the latest mimocode session instead of bare default", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.resolveMimocodeSessionId(null, "ses_latest"), "mimocode:ses_latest");
    assert.strictEqual(mod.resolveMimocodeSessionId(null, "mimocode:ses_latest"), "mimocode:ses_latest");
    assert.strictEqual(mod.resolveMimocodeSessionId(null, null), "mimocode:default");
  });

  it("extracts event.properties.sessionID and top-level event.sessionID", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(mod.getEventSessionId({ properties: { sessionID: " ses_abc " } }), "ses_abc");
    assert.strictEqual(mod.getEventSessionId({ sessionID: " top_level " }), "top_level");
    assert.strictEqual(mod.getEventSessionId({ properties: { sessionID: "" } }), null);
    assert.strictEqual(mod.getEventSessionId({ properties: {} }), null);
    assert.strictEqual(mod.getEventSessionId(null), null);
  });

  it("drops SessionEnd mappings that have no raw mimocode session id", async () => {
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

    assert.strictEqual(startBody.session_id, "mimocode:ses_same");
    assert.strictEqual(endBody.session_id, "mimocode:ses_same");
    assert.strictEqual(startBody.event, "SessionStart");
    assert.strictEqual(endBody.event, "SessionEnd");
  });
});

describe("mimocode plugin module shape (#413 regression guard)", () => {
  it("exposes exactly one export: the default plugin function", async () => {
    const mod = await loadPluginModule();
    assert.deepStrictEqual(Object.keys(mod), ["default"]);
    assert.strictEqual(typeof mod.default, "function");
    assert.deepStrictEqual(Object.values(mod).map((v) => typeof v), ["function"]);
  });
});

describe("mimocode plugin headless (parentID-based child detection)", () => {
  let pluginMod;

  beforeEach(async () => {
    pluginMod = await loadPluginModule();
    pluginMod.default.__test._sessionParentById.clear();
    pluginMod.default.__test._rootSessionId = null;
  });

  it("extracts parentID from event.properties.info.parentID", async () => {
    const mod = await loadSessionIdModule();

    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_child", info: { parentID: "ses_root" } },
      }),
      "ses_root"
    );
    assert.strictEqual(
      mod.getEventParentSessionId({
        type: "session.created",
        properties: { sessionID: "ses_root", info: {} },
      }),
      null
    );
    assert.strictEqual(mod.getEventParentSessionId(null), null);
  });

  it("isChildSessionId normalizes sessionId before checking the parent map", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("mimocode:ses_child", "mimocode:ses_root");

    assert.strictEqual(mod.isChildSessionId("ses_child", parentMap), true);
    assert.strictEqual(mod.isChildSessionId("mimocode:ses_child", parentMap), true);
    assert.strictEqual(mod.isChildSessionId("ses_root", parentMap), false);
    assert.strictEqual(mod.isChildSessionId("ses_other", parentMap), false);
    assert.strictEqual(mod.isChildSessionId(null, parentMap), false);
    assert.strictEqual(mod.isChildSessionId("ses_child", null), false);
  });

  it("buildStateBody adds headless: true for child sessions (raw and prefixed id)", async () => {
    pluginMod.default.__test._sessionParentById.set("mimocode:ses_child", "mimocode:ses_root");

    const bodyRaw = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_child");
    assert.strictEqual(bodyRaw.headless, true);
    assert.strictEqual(bodyRaw.session_id, "mimocode:ses_child");

    const bodyPrefixed = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "mimocode:ses_child");
    assert.strictEqual(bodyPrefixed.headless, true);
    assert.strictEqual(bodyPrefixed.session_id, "mimocode:ses_child");
  });

  it("buildStateBody does not add headless for root sessions", async () => {
    const body = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_root");
    assert.strictEqual(body.headless, undefined);
    assert.strictEqual(body.session_id, "mimocode:ses_root");
  });

  it("buildStateBody does not add headless for standalone sessions without parentID", async () => {
    pluginMod.default.__test._rootSessionId = "mimocode:ses_root";

    const body = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_other");
    assert.strictEqual(body.headless, undefined);
    assert.strictEqual(body.session_id, "mimocode:ses_other");
  });

  it("translateEvent maps child session.idle to SessionEnd when in _sessionParentById", async () => {
    pluginMod.default.__test._sessionParentById.set("mimocode:ses_child", "mimocode:ses_root");

    const result = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_child" },
    });
    assert.strictEqual(result.state, "sleeping");
    assert.strictEqual(result.event, "SessionEnd");
  });

  it("translateEvent maps root session.idle to Stop (attention)", async () => {
    const result = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    assert.strictEqual(result.state, "attention");
    assert.strictEqual(result.event, "Stop");
  });

  it("cleanupSessionParentMap clears entire map on server.instance.disposed (no sessionID)", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("mimocode:ses_child1", "mimocode:ses_root");
    parentMap.set("mimocode:ses_child2", "mimocode:ses_root");

    mod.cleanupSessionParentMap(
      { type: "server.instance.disposed", properties: {} },
      parentMap
    );
    assert.strictEqual(parentMap.size, 0);
  });

  it("cleanupSessionParentMap removes single entry on session.deleted", async () => {
    const mod = await loadSessionIdModule();
    const parentMap = new Map();
    parentMap.set("mimocode:ses_child1", "mimocode:ses_root");
    parentMap.set("mimocode:ses_child2", "mimocode:ses_root");

    mod.cleanupSessionParentMap(
      { type: "session.deleted", properties: { sessionID: "ses_child1" } },
      parentMap
    );
    assert.strictEqual(parentMap.has("mimocode:ses_child1"), false);
    assert.strictEqual(parentMap.has("mimocode:ses_child2"), true);
    assert.strictEqual(parentMap.size, 1);
  });

  it("full flow: session.created with parentID produces headless body and SessionEnd idle", async () => {
    pluginMod.default.__test._sessionParentById.set("mimocode:ses_child", "mimocode:ses_root");

    const body = pluginMod.default.__test.buildStateBody("working", "PreToolUse", "ses_child");
    assert.strictEqual(body.headless, true);
    assert.strictEqual(body.session_id, "mimocode:ses_child");

    const idleResult = pluginMod.default.__test.translateEvent({
      type: "session.idle",
      properties: { sessionID: "ses_child" },
    });
    assert.strictEqual(idleResult.state, "sleeping");
    assert.strictEqual(idleResult.event, "SessionEnd");
  });
});
