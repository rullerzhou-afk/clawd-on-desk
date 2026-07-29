"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const { bucketAgentsForTutorial } = require("../src/tutorial-agent-buckets");

const INSTALLABLE = ["claude-code", "codex", "gemini-cli", "kimi-cli"];

function detect(agentId, agentName, detectedInstalled, confidence) {
  return { agentId, agentName, detectedInstalled, confidence };
}

describe("bucketAgentsForTutorial", () => {
  it("buckets active / cleanup / install across the marquee cases", () => {
    const result = bucketAgentsForTutorial({
      installableIds: INSTALLABLE,
      detectionAgents: [
        // integration installed + detected → active
        detect("claude-code", "Claude Code", true, "high"),
        // integration installed (default) + NOT detected → cleanup (stale hook)
        detect("codex", "Codex", false, "low"),
        // not installed + detected high → install
        detect("gemini-cli", "Gemini CLI", true, "high"),
        // not installed + detected low → neither (too weak to offer)
        detect("kimi-cli", "Kimi CLI", true, "low"),
      ],
      agentsPref: {
        "claude-code": { integrationInstalled: true },
        codex: { integrationInstalled: true },
        "gemini-cli": { integrationInstalled: false },
        "kimi-cli": { integrationInstalled: false },
      },
    });

    assert.deepStrictEqual(result.active, [{ agentId: "claude-code", label: "Claude Code", iconUrl: null }]);
    assert.deepStrictEqual(result.cleanup, [{ agentId: "codex", label: "Codex", iconUrl: null }]);
    assert.deepStrictEqual(result.install, [{ agentId: "gemini-cli", label: "Gemini CLI", iconUrl: null }]);
  });

  it("offers medium-confidence detections for install but never low", () => {
    const result = bucketAgentsForTutorial({
      installableIds: ["gemini-cli", "kimi-cli"],
      detectionAgents: [
        detect("gemini-cli", "Gemini CLI", true, "medium"),
        detect("kimi-cli", "Kimi CLI", true, "low"),
      ],
      agentsPref: {},
    });
    assert.deepStrictEqual(result.install.map((a) => a.agentId), ["gemini-cli"]);
    assert.strictEqual(result.cleanup.length, 0);
    assert.strictEqual(result.active.length, 0);
  });

  it("falls back to the agentId as label when the detector has no name", () => {
    const result = bucketAgentsForTutorial({
      installableIds: ["pi"],
      detectionAgents: [detect("pi", undefined, true, "high")],
      agentsPref: {},
    });
    assert.deepStrictEqual(result.install, [{ agentId: "pi", label: "pi", iconUrl: null }]);
  });

  it("treats an installable agent with no detector entry as not detected", () => {
    // integration installed but the detector returned nothing for it → cleanup,
    // since an absent entry must not be read as "detected".
    const result = bucketAgentsForTutorial({
      installableIds: ["codex"],
      detectionAgents: [],
      agentsPref: { codex: { integrationInstalled: true } },
    });
    assert.deepStrictEqual(result.cleanup, [{ agentId: "codex", label: "codex", iconUrl: null }]);
    assert.strictEqual(result.install.length, 0);
    assert.strictEqual(result.active.length, 0);
  });

  it("tolerates missing/empty inputs without throwing", () => {
    assert.deepStrictEqual(
      bucketAgentsForTutorial(),
      { install: [], cleanup: [], active: [] },
    );
    assert.deepStrictEqual(
      bucketAgentsForTutorial({ installableIds: ["codex"], detectionAgents: null, agentsPref: null }),
      { install: [], cleanup: [], active: [] },
    );
  });

  it("attaches the resolved icon URL to every bucket", () => {
    const result = bucketAgentsForTutorial({
      installableIds: ["codex"],
      detectionAgents: [detect("codex", "Codex", true, "high")],
      agentsPref: {},
      getAgentIconUrl: (agentId) => `file:///icons/${agentId}.png`,
    });

    assert.deepStrictEqual(result.install, [{
      agentId: "codex",
      label: "Codex",
      iconUrl: "file:///icons/codex.png",
    }]);
  });

  it("fails closed when icon resolution throws or returns a non-string", () => {
    const throwing = bucketAgentsForTutorial({
      installableIds: ["codex"],
      detectionAgents: [detect("codex", "Codex", true, "high")],
      getAgentIconUrl: () => { throw new Error("icon lookup failed"); },
    });
    const invalid = bucketAgentsForTutorial({
      installableIds: ["gemini-cli"],
      detectionAgents: [detect("gemini-cli", "Gemini CLI", true, "high")],
      getAgentIconUrl: () => 42,
    });

    assert.strictEqual(throwing.install[0].iconUrl, null);
    assert.strictEqual(invalid.install[0].iconUrl, null);
  });
});
