"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");

const { getAllAgents } = require("../agents/registry");
const {
  getElectronBinary,
  hashSvgSource,
  readSourceManifest,
  normalizeTextLineEndings,
  updateSvgSourceHashes,
} = require("../scripts/export-agent-icons");
const {
  AGENT_ICON_DIR,
  getAgentIconPath,
  getAgentIcon,
  getAgentIconUrl,
} = require("../src/state-agent-icons");

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.strictEqual(buffer.toString("ascii", 1, 4), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function shouldCheckRuntimeIconEntry(entry) {
  return entry.isFile() && !entry.name.startsWith(".");
}

describe("state agent icons", () => {
  it("returns undefined for BrowserWindow menu icons when nativeImage is unavailable", () => {
    assert.strictEqual(getAgentIcon("claude-code"), undefined);
  });

  it("returns null for missing agent ids and icons", () => {
    assert.strictEqual(getAgentIconUrl(null), null);
    assert.strictEqual(getAgentIconUrl(""), null);
    assert.strictEqual(getAgentIconUrl("missing-agent"), null);
    assert.strictEqual(getAgentIconUrl("../claude-code"), null);
  });

  it("returns a file URL for bundled agent icons", () => {
    const iconUrl = getAgentIconUrl("claude-code");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "claude-code.png")
    );
  });

  it("returns the bundled Kiro PNG icon", () => {
    const iconUrl = getAgentIconUrl("kiro-cli");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "kiro-cli.png")
    );
    assert.strictEqual(getAgentIconPath("kiro-cli"), path.join(AGENT_ICON_DIR, "kiro-cli.png"));
  });

  it("returns bundled PNG icons for Pi and OpenClaw", () => {
    const iconUrl = getAgentIconUrl("pi");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "pi.png")
    );
    assert.strictEqual(getAgentIconPath("pi"), path.join(AGENT_ICON_DIR, "pi.png"));

    const openClawIconUrl = getAgentIconUrl("openclaw");
    assert.strictEqual(new URL(openClawIconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(openClawIconUrl)),
      path.join(AGENT_ICON_DIR, "openclaw.png")
    );
    assert.strictEqual(getAgentIconPath("openclaw"), path.join(AGENT_ICON_DIR, "openclaw.png"));
  });

  it("has canonical runtime PNG icons for every registered agent", () => {
    for (const agent of getAllAgents()) {
      const iconPath = path.join(AGENT_ICON_DIR, `${agent.id}.png`);
      assert.ok(fs.existsSync(iconPath), `Missing runtime PNG icon for ${agent.id}`);
    }
  });

  it("keeps runtime agent PNG icons at 64x64", () => {
    for (const entry of fs.readdirSync(AGENT_ICON_DIR, { withFileTypes: true })) {
      if (!shouldCheckRuntimeIconEntry(entry)) continue;
      assert.strictEqual(
        path.extname(entry.name).toLowerCase(),
        ".png",
        `${entry.name} should not be stored in the runtime icon directory`
      );
      const iconPath = path.join(AGENT_ICON_DIR, entry.name);
      const size = readPngSize(iconPath);
      assert.deepStrictEqual(size, { width: 64, height: 64 }, `${entry.name} should be 64x64`);
    }
  });

  it("ignores local dotfiles and directories when checking runtime icon dimensions", () => {
    const entries = [
      { name: ".DS_Store", isFile: () => true },
      { name: "scratch", isFile: () => false },
      { name: "codex.png", isFile: () => true },
    ];

    assert.deepStrictEqual(
      entries
        .filter(shouldCheckRuntimeIconEntry)
        .map((entry) => entry.name),
      ["codex.png"]
    );
  });

  it("keeps source SVG hashes aligned with the source manifest", () => {
    const expectedManifest = updateSvgSourceHashes({ svgSources: {} }, getAllAgents());
    assert.deepStrictEqual(readSourceManifest(), expectedManifest);
  });

  it("normalizes SVG source line endings before hashing", () => {
    assert.strictEqual(
      normalizeTextLineEndings("<svg>\r\n  <path />\r\n</svg>\r"),
      "<svg>\n  <path />\n</svg>\n"
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-svg-hash-"));
    try {
      const lfPath = path.join(tempDir, "lf.svg");
      const crlfPath = path.join(tempDir, "crlf.svg");
      fs.writeFileSync(lfPath, "<svg>\n  <path />\n</svg>\n");
      fs.writeFileSync(crlfPath, "<svg>\r\n  <path />\r\n</svg>\r\n");
      assert.strictEqual(hashSvgSource(crlfPath), hashSvgSource(lfPath));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves the real Electron binary for the exporter entrypoint", () => {
    const electronBinary = getElectronBinary();
    assert.ok(path.isAbsolute(electronBinary), "Electron binary path should be absolute");
    if (process.platform === "win32") {
      assert.strictEqual(path.basename(electronBinary).toLowerCase(), "electron.exe");
    }
  });

  it("returns the cached URL value for repeated lookups", () => {
    const first = getAgentIconUrl("codex");
    const second = getAgentIconUrl("codex");

    assert.strictEqual(second, first);
  });
});
