"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../hooks/antigravity-statusline");
const { normalizeSessionId, buildStatusLineText, buildStateBody, main } = __test;

describe("Antigravity statusline adapter", () => {
  it("prefixes conversation ids with antigravity: once", () => {
    assert.strictEqual(normalizeSessionId("c1"), "antigravity:c1");
    assert.strictEqual(normalizeSessionId("antigravity:c1"), "antigravity:c1");
    assert.strictEqual(normalizeSessionId(undefined), "antigravity:default");
  });

  it("builds status text from model, context percent, and agent state", () => {
    const text = buildStatusLineText(
      { agent_state: "thinking" },
      { used: 100, limit: 1000, percent: 10 },
      "Gemini 3.1 Pro (High)"
    );
    assert.strictEqual(text, "Gemini 3.1 Pro (High) · 10% ctx · thinking");
  });

  it("returns empty text when nothing is known", () => {
    assert.strictEqual(buildStatusLineText({}, null, null), "");
  });

  it("builds a metadata_only body with context usage and quota attached", () => {
    const body = buildStateBody(
      { conversation_id: "c1", cwd: "/work" },
      { used: 10, limit: 100, percent: 10, source: "antigravity" },
      { geminiWeekly: { usedPercent: 98, resetAt: 1738831180000 } }
    );
    assert.deepStrictEqual(body, {
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "antigravity:c1",
      agent_id: "antigravity-cli",
      cwd: "/work",
      context_usage: { used: 10, limit: 100, percent: 10, source: "antigravity" },
      antigravity_quota: { geminiWeekly: { usedPercent: 98, resetAt: 1738831180000 } },
    });
  });

  it("omits antigravity_quota when there is none", () => {
    const body = buildStateBody({ conversation_id: "c1" }, null, null);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "antigravity_quota"), false);
  });

  it("returns null when the payload has no conversation id", () => {
    assert.strictEqual(buildStateBody({}, null, null), null);
    assert.strictEqual(buildStateBody(null, null, null), null);
  });

  it("stamps local WSL source fields and preserves an SSH host on remote WSL", () => {
    const applyWsl = (body, options) => {
      body.wsl_distro = "Ubuntu";
      if (!options.remote) body.host = "wsl:Ubuntu";
      return body;
    };
    const local = buildStateBody(
      { conversation_id: "local" },
      null,
      { geminiWeekly: { usedPercent: 1 } },
      { applyWslSourceFields: applyWsl }
    );
    assert.strictEqual(local.host, "wsl:Ubuntu");
    assert.strictEqual(local.wsl_distro, "Ubuntu");

    const remote = buildStateBody(
      { conversation_id: "remote" },
      null,
      { geminiWeekly: { usedPercent: 2 } },
      { remote: true, host: "lab", applyWslSourceFields: applyWsl }
    );
    assert.strictEqual(remote.host, "lab");
    assert.strictEqual(remote.wsl_distro, "Ubuntu");
  });

  it("main() posts state (including quota) and always writes a stdout line, even on a slow/failed POST", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1738400000000 });
    const writes = [];
    const posted = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        payload: {
          conversation_id: "c1",
          agent_state: "idle",
          model: { display_name: "Gemini 3.1 Pro (High)" },
          context_window: { context_window_size: 1000000, used_percentage: 5 },
          quota: { "gemini-weekly": { remaining_fraction: 0.02, reset_in_seconds: 431180 } },
        },
        postState: (body, options, callback) => { posted.push(JSON.parse(body)); callback(false); },
      });
    } finally {
      process.stdout.write = originalWrite;
      mock.timers.reset();
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], "Gemini 3.1 Pro (High) · 5% ctx · idle\n");
    assert.deepStrictEqual(posted[0].antigravity_quota, {
      geminiWeekly: { usedPercent: 98, resetAt: Math.round((1738400000000 + 431180 * 1000) / 60000) * 60000 },
    });
  });

  it("main() never throws and still writes stdout when stdin JSON read fails", async () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        readStdinJson: () => Promise.reject(new Error("boom")),
        postState: (body, options, callback) => callback(true),
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], "\n");
  });
});
