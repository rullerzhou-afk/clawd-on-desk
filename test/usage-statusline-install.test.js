"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  isOurStatusLine,
  extractChainedCommand,
  buildTapCommand,
  planRegister,
  planUnregister,
  registerStatuslineTap,
  unregisterStatuslineTap,
  MARKER,
} = require("../hooks/statusline-install");

const NODE = "/usr/bin/node";
const SCRIPT = "/app/hooks/clawd-statusline-tap.js";

test("isOurStatusLine detects the marker", () => {
  assert.ok(isOurStatusLine({ type: "command", command: `node ${SCRIPT}` }));
  assert.ok(!isOurStatusLine({ type: "command", command: "node other.js" }));
  assert.ok(!isOurStatusLine(null));
});

test("extractChainedCommand recovers the wrapped command", () => {
  const cmd = `"${NODE}" "${SCRIPT}" --chain "node hud.js"`;
  assert.strictEqual(extractChainedCommand(cmd), "node hud.js");
  assert.strictEqual(extractChainedCommand(`x --chain 'node hud.js'`), "node hud.js");
  assert.strictEqual(extractChainedCommand(`"${NODE}" "${SCRIPT}"`), null);
  // escaped quotes inside the chained command round-trip
  const esc = buildTapCommand(NODE, SCRIPT, 'node a.js --flag "x"').command;
  assert.strictEqual(extractChainedCommand(esc), 'node a.js --flag "x"');
});

test("planRegister installs bare when no statusLine exists", () => {
  const spec = planRegister(undefined, NODE, SCRIPT);
  assert.strictEqual(spec.type, "command");
  assert.ok(spec.command.includes(MARKER));
  assert.ok(!spec.command.includes("--chain"));
});

test("planRegister wraps a user's existing statusLine via --chain", () => {
  const existing = { type: "command", command: "node /home/u/hud.js" };
  const spec = planRegister(existing, NODE, SCRIPT);
  assert.ok(spec.command.includes(MARKER));
  assert.strictEqual(extractChainedCommand(spec.command), "node /home/u/hud.js");
});

test("planRegister refreshes ours in place and preserves the chained command", () => {
  const ours = { type: "command", command: `"/old/node" "/old/${MARKER}" --chain "node hud.js"` };
  const spec = planRegister(ours, NODE, SCRIPT);
  assert.ok(spec.command.includes(SCRIPT));
  assert.ok(spec.command.includes(NODE));
  assert.strictEqual(extractChainedCommand(spec.command), "node hud.js");
});

test("planUnregister restores the chained original", () => {
  const ours = { type: "command", command: `"${NODE}" "${SCRIPT}" --chain "node hud.js"` };
  const plan = planUnregister(ours);
  assert.strictEqual(plan.keep, false);
  assert.deepStrictEqual(plan.statusLine, { type: "command", command: "node hud.js" });
});

test("planUnregister drops the entry when there was no chained original", () => {
  const ours = { type: "command", command: `"${NODE}" "${SCRIPT}"` };
  const plan = planUnregister(ours);
  assert.strictEqual(plan.keep, false);
  assert.strictEqual(plan.statusLine, null);
});

test("planUnregister leaves a statusLine that isn't ours untouched", () => {
  const theirs = { type: "command", command: "node hud.js" };
  const plan = planUnregister(theirs);
  assert.strictEqual(plan.keep, true);
  assert.strictEqual(plan.statusLine, theirs);
});

test("registerStatuslineTap writes a wrapped command and is idempotent", () => {
  let stored = JSON.stringify({ statusLine: { type: "command", command: "node hud.js" } });
  const io = {
    settingsPath: "/x/settings.json",
    scriptPath: SCRIPT,
    nodeBin: NODE,
    readFileSync: () => stored,
    writeJsonAtomic: (_p, data) => { stored = JSON.stringify(data); },
  };

  const first = registerStatuslineTap(io);
  assert.strictEqual(first.changed, true);
  assert.strictEqual(extractChainedCommand(first.statusLine.command), "node hud.js");

  // Running again must not change anything (already ours, same chain).
  const second = registerStatuslineTap(io);
  assert.strictEqual(second.changed, false);
});

test("register then unregister restores the user's original statusLine", () => {
  let stored = JSON.stringify({ statusLine: { type: "command", command: "node hud.js" }, model: "opus" });
  const io = {
    settingsPath: "/x/settings.json",
    scriptPath: SCRIPT,
    nodeBin: NODE,
    readFileSync: () => stored,
    writeJsonAtomic: (_p, data) => { stored = JSON.stringify(data); },
  };

  registerStatuslineTap(io);
  unregisterStatuslineTap(io);

  const final = JSON.parse(stored);
  assert.deepStrictEqual(final.statusLine, { type: "command", command: "node hud.js" });
  assert.strictEqual(final.model, "opus", "unrelated settings are preserved");
});
