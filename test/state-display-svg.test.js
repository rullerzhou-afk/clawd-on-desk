const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");

function makeCtx() {
  return {
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    mouseStillSince: Date.now(),
    sendToRenderer() {},
    syncHitWin() {},
    sendToHitWin() {},
    miniPeekIn() {},
    miniPeekOut() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    pendingPermissions: [],
    resolvePermissionEntry() {},
    t: (k) => k,
    showSessionId: false,
    focusTerminalWindow() {},
  };
}

describe("display_svg session hints (updateSession path)", () => {
  let api;
  const pid = process.pid;

  beforeEach(() => {
    api = require("../src/state")(makeCtx());
  });

  it("uses allowlisted display_svg for working state", () => {
    api.updateSession(
      "c1",
      "working",
      "PreToolUse",
      null,
      "/tmp",
      "cursor",
      null,
      pid,
      "cursor-agent",
      null,
      false,
      "clawd-working-building.svg"
    );
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-building.svg");
  });

  it("falls back to getWorkingSvg when no hint", () => {
    api.updateSession("c1", "working", "PreToolUse", null, "/tmp", "cursor", null, pid, "cursor-agent", null, false, undefined);
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("ignores non-allowlisted svg and falls back", () => {
    api.updateSession(
      "c1",
      "working",
      "PreToolUse",
      null,
      "/tmp",
      "cursor",
      null,
      pid,
      "cursor-agent",
      null,
      false,
      "evil.svg"
    );
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("picks the most recently updated session among working sessions", async () => {
    api.updateSession("a", "working", "PreToolUse", null, "/a", "cursor", null, pid, "cursor-agent", null, false, "clawd-working-building.svg");
    await new Promise((r) => setTimeout(r, 5));
    api.updateSession("b", "working", "PostToolUse", null, "/b", "cursor", null, pid, "cursor-agent", null, false, "clawd-idle-reading.svg");
    assert.strictEqual(api.getSvgOverride("working"), "clawd-idle-reading.svg");
  });

  it("clears hint when display_svg is null", () => {
    api.updateSession("c1", "working", "PreToolUse", null, "/tmp", "cursor", null, pid, "cursor-agent", null, false, "clawd-working-building.svg");
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-building.svg");
    api.updateSession("c1", "working", "PostToolUse", null, "/tmp", "cursor", null, pid, "cursor-agent", null, false, null);
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("applies thinking hint for thinking state", () => {
    api.updateSession(
      "c1",
      "thinking",
      "AfterAgentThought",
      null,
      "/tmp",
      "cursor",
      null,
      pid,
      "cursor-agent",
      null,
      false,
      "clawd-working-thinking.svg"
    );
    assert.strictEqual(api.getSvgOverride("thinking"), "clawd-working-thinking.svg");
  });
});
