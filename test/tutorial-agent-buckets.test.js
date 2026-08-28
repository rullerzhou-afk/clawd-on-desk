"use strict";

const assert = require("node:assert");
const { describe, it, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bucketAgentsForTutorial } = require("../src/tutorial-agent-buckets");
const { detectAgentInstallations } = require("../src/agent-installation-detector");

const tempDirs = [];
after(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tutorial-buckets-"));
  tempDirs.push(dir);
  return dir;
}

const INSTALLABLE = ["claude-code", "codex", "gemini-cli", "kimi-cli", "qwen-code"];

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
        // integration installed + explicitly NOT detected → cleanup (stale hook).
        // #895: this has to be a non-default agent. Default integrations are
        // exempt, because a missing ~/.codex is not evidence of a stale hook.
        detect("qwen-code", "Qwen Code", false, "low"),
        // not installed + detected high → install
        detect("gemini-cli", "Gemini CLI", true, "high"),
        // not installed + detected low → neither (too weak to offer)
        detect("kimi-cli", "Kimi CLI", true, "low"),
      ],
      agentsPref: {
        "claude-code": { integrationInstalled: true },
        "qwen-code": { integrationInstalled: true },
        "gemini-cli": { integrationInstalled: false },
        "kimi-cli": { integrationInstalled: false },
      },
    });

    assert.deepStrictEqual(result.active, [{ agentId: "claude-code", label: "Claude Code", iconUrl: null }]);
    assert.deepStrictEqual(result.cleanup, [{ agentId: "qwen-code", label: "Qwen Code", iconUrl: null }]);
    assert.deepStrictEqual(result.install, [{ agentId: "gemini-cli", label: "Gemini CLI", iconUrl: null }]);
  });

  // #895 T5 / T5b: the tutorial told users with a genuinely installed Codex to
  // disconnect it. Both default integrations are exempt, not just codex.
  it("never proposes cleanup for a default integration, even when explicitly undetected", () => {
    for (const agentId of ["codex", "claude-code"]) {
      const result = bucketAgentsForTutorial({
        installableIds: [agentId],
        detectionAgents: [detect(agentId, agentId, false, "low")],
        agentsPref: { [agentId]: { integrationInstalled: true } },
      });
      assert.deepStrictEqual(result.cleanup, [], `${agentId} must be exempt from cleanup`);
      assert.deepStrictEqual(result.active, []);
      assert.deepStrictEqual(result.install, []);
    }
  });

  // #895 T6b: the exemption wins even when a Clawd hook really is on disk. The
  // detector's clawdIntegration field is deliberately NOT consulted — it only
  // sees the primary config marker and misses standalone statusline residue.
  it("keeps default integrations exempt even when a Clawd marker was found", () => {
    const entry = detect("codex", "Codex", false, "low");
    entry.clawdIntegration = { detected: true, reason: "marker-found" };
    const result = bucketAgentsForTutorial({
      installableIds: ["codex"],
      detectionAgents: [entry],
      agentsPref: { codex: { integrationInstalled: true } },
    });
    assert.deepStrictEqual(result.cleanup, []);
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

  // #895 T6c: an absent entry is "not checked", not "checked and missing". It
  // must not be read as detected either — the agent simply gets no bucket.
  it("treats an installable agent with no detector entry as unknown, not as cleanup", () => {
    const result = bucketAgentsForTutorial({
      installableIds: ["qwen-code"],
      detectionAgents: [],
      agentsPref: { "qwen-code": { integrationInstalled: true } },
    });
    assert.deepStrictEqual(result.cleanup, []);
    assert.strictEqual(result.install.length, 0);
    assert.strictEqual(result.active.length, 0);
  });

  // #895 T6c-variant: an entry that exists but carries no verdict is also
  // unknown. Only a strict `false` may propose a deletion.
  it("requires a strict false verdict before proposing cleanup", () => {
    for (const value of [undefined, null]) {
      const entry = detect("qwen-code", "Qwen Code", value, "low");
      const result = bucketAgentsForTutorial({
        installableIds: ["qwen-code"],
        detectionAgents: [entry],
        agentsPref: { "qwen-code": { integrationInstalled: true } },
      });
      assert.deepStrictEqual(result.cleanup, [], `detectedInstalled=${value} must not propose cleanup`);
    }
  });

  it("keeps an explicit null verdict out of active, install, and cleanup", () => {
    for (const integrationInstalled of [false, true]) {
      const result = bucketAgentsForTutorial({
        installableIds: ["qoder"],
        detectionAgents: [detect("qoder", "Qoder", null, "low")],
        agentsPref: { qoder: { integrationInstalled } },
      });
      assert.deepStrictEqual(result, { install: [], cleanup: [], active: [] });
    }
  });

  // #895 T7: the reporter's exact machine shape, fed by the REAL detector
  // rather than a hand-written fixture, so the two can't drift apart. Codex
  // installed via npm but never launched leaves no ~/.codex, and Clawd's own
  // sync does not create it (hooks/codex-install-utils.js bails when the
  // directory is missing) — so the detector genuinely reports it absent.
  it("does not propose removing Codex on a machine where Codex was never launched", () => {
    const homeDir = makeHome();
    const detection = detectAgentInstallations({
      skipDefaultIntegrations: false,
      homeDir,
      platform: "darwin",
      env: {},
      now: 1,
    });
    const codex = detection.agents.find((entry) => entry.agentId === "codex");
    assert.strictEqual(codex.detectedInstalled, false);
    assert.strictEqual(codex.reason, "not-found");

    const result = bucketAgentsForTutorial({
      installableIds: INSTALLABLE,
      detectionAgents: detection.agents,
      agentsPref: {
        "claude-code": { integrationInstalled: true },
        codex: { integrationInstalled: true },
      },
    });
    assert.deepStrictEqual(result.cleanup, []);
  });

  // #895 T6d: main.js falls back to { agents: [] } when the detector throws.
  // A whole-scan failure must never turn into a wave of removal suggestions.
  it("proposes nothing when the whole detection failed", () => {
    for (const detectionAgents of [[], null, undefined]) {
      const result = bucketAgentsForTutorial({
        installableIds: INSTALLABLE,
        detectionAgents,
        agentsPref: {
          "claude-code": { integrationInstalled: true },
          codex: { integrationInstalled: true },
          "qwen-code": { integrationInstalled: true },
        },
      });
      assert.deepStrictEqual(result.cleanup, [], `detectionAgents=${detectionAgents} must propose no cleanup`);
    }
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
