"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecapRuntime } = require("../src/recap-runtime");
const { resolveSessionIdentity } = require("../src/session-key");
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));

for (const producer of ["start", "debounce", "transcript"]) {
  for (const boundary of ["none", "clear", "off-on", "created-off"]) {
    test(`recap ${producer} respects recording boundary: ${boundary}`, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 8, 3, 10) });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recording-boundary-"));
      const transcript = path.join(root, "synthetic.jsonl");
      const recapRoot = path.join(root, "recap");
      const recap = createRecapRuntime({ root: recapRoot, getTimeZone: () => "UTC",
        setTimeout: () => ({ unref() {} }), clearTimeout() {} });
      const noop = () => {};
      const state = require("../src/state")({
        theme: themeLoader.loadTheme("clawd"), lang: "en", doNotDisturb: false,
        miniMode: false, playSound: noop, sendToRenderer: noop, syncHitWin: noop,
        sendToHitWin: noop, miniPeekIn: noop, miniPeekOut: noop,
        buildContextMenu: noop, buildTrayMenu: noop, pendingPermissions: [],
        resolvePermissionEntry: noop, dismissPermissionsForDnd: noop,
        focusTerminalWindow: noop, focusHostPlatform: "darwin", processKill: () => true,
        getCursorScreenPoint: () => ({ x: 0, y: 0 }), recapSink: recap,
      });
      t.after(() => { state.cleanup(); recap.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
      const identity = resolveSessionIdentity("synthetic-boundary-session", "local");
      const opts = { agentId: "claude-code", profileId: "local", rawSessionId: identity.rawSessionId };
      const send = (event, value, extra = {}) => state.updateSession(identity.sessionId, value, event, {
        ...opts, recapOccurredAt: Date.now(), ...extra,
      });
      recap.start(); await recap.whenReady();
      if (boundary === "created-off") recap.setEnabled(false);
      if (producer === "start") {
        send("SessionStart", "idle", { sessionStartSource: "startup" });
      } else if (producer === "debounce") {
        send("UserPromptSubmit", "working");
        send("Stop", "attention", { headless: true, assistantLastOutput: "synthetic final text" });
      } else {
        // The parser supports unkeyed transcript entries. Keep canonical state
        // identity rather than bypassing the production raw-ID matching rules.
        fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: {
          content: "synthetic final text",
        } }) + "\n");
        send("PostToolUse", "working", { toolName: "AskUserQuestion", transcriptPath: transcript });
      }
      // Clear in the very same millisecond also revokes a pending record.
      if (boundary === "clear") { assert.equal(recap.clear(), true); await recap.whenReady(); }
      if (boundary === "off-on") { recap.setEnabled(false); recap.setEnabled(true); }
      if (boundary === "created-off") recap.setEnabled(true);
      if (producer === "start") send("PreToolUse", "working", { toolUseId: "new-tool" });
      else t.mock.timers.tick(2100);
      recap.flush();
      const journal = path.join(recapRoot, "events", "2026-09-03.jsonl");
      const bytes = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8") : "";
      const records = bytes.trim().split("\n").filter(Boolean).map(JSON.parse);
      const metric = producer === "start" ? "session-start" : "turn-complete";
      assert.equal(records.filter((event) => event.metrics.includes(metric)).length, boundary === "none" ? 1 : 0);
      if (producer === "start") {
        assert.equal(records.filter((event) => event.metrics.includes("tool-call")).length, 1);
      } else {
        assert.equal(state.sessions.get(identity.sessionId).state, "idle");
        assert.equal(state.deriveSessionBadge(state.sessions.get(identity.sessionId)), "done");
      }
      assert.equal(bytes.includes("synthetic final text"), false);
      assert.equal(bytes.includes(identity.rawSessionId), false);
      assert.equal(bytes.includes("recordingToken"), false);
    });
  }
}

test("recording tokens survive DND-equivalent recording, but revoke after a committed preference change", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recording-token-"));
  let preference = true;
  const recap = createRecapRuntime({ root, getEnabled: () => preference,
    setTimeout: () => ({ unref() {} }), clearTimeout() {} });
  t.after(() => { recap.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  recap.start(); await recap.whenReady();
  const token = recap.captureRecordingToken();
  recap.flush();
  assert.equal(recap.isRecordingTokenCurrent(token), true);
  // The controller commits its snapshot before routing the runtime effect.
  preference = false; recap.setEnabled(false);
  preference = true; recap.setEnabled(true);
  assert.equal(recap.isRecordingTokenCurrent(token), false);
  assert.equal(recap.isRecordingTokenCurrent(recap.captureRecordingToken()), true);
});
