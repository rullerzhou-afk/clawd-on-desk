"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectAgentInstallation } = require("../src/agent-installation-detector");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");

// Product layout contracts, independently exercised on real temporary paths.
// Qoder .auth intentionally has no kind contract here: preserve compatibility.
const fixtures = [
  ["qoder", "projects", "dir"],
  ["qoder", "logs", "dir"],
  ["qoder", "bin", "dir"],
  ["qoder", "state.json", "file"],
  ["zcode", "v2/credentials.json", "file"],
  ["zcode", "v2/telemetry-state.json", "file"],
  ["zcode", "v2/config.json", "file"],
  ["zcode", "cli/exec", "dir"],
  ["codebuddy", "projects", "dir"],
  ["codebuddy", "sessions", "dir"],
  ["codebuddy", "logs", "dir"],
  ["codebuddy", "history.jsonl", "file"],
  ["codebuddy", "file-history", "dir"],
  ["codebuddy", "traces", "dir"],
  ["codebuddy", "shell-snapshots", "dir"],
  ["codebuddy", "local_storage", "dir"],
  ["codebuddy", "usage-data", "dir"],
  ["codebuddy", "debug", "dir"],
  ["codebuddy", "tasks", "dir"],
  ["codebuddy", "teams", "dir"],
  ["codebuddy", "blobs", "dir"],
  ["codebuddy", "channels", "dir"],
  ["codebuddy", "computer-use", "dir"],
];

function makeFixture(t, agentId, dirname = `.${agentId}`) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-artifact-kinds-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(homeDir)), path.resolve(os.tmpdir()));
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const parentDir = path.join(homeDir, dirname);
  fs.mkdirSync(parentDir, { recursive: true });
  const descriptor = getAgentDescriptor(agentId);
  const configPath = path.join(parentDir, agentId === "zcode" ? "cli/config.json" : "settings.json");
  // The injected filesystem must retain its full interface. Guard contents,
  // rather than replacing lstat: these tests exercise real filesystem kinds.
  const guardedFs = Object.create(fs);
  guardedFs.readFileSync = (filePath, ...args) => {
    const resolved = path.resolve(filePath);
    assert.ok(resolved.startsWith(`${path.resolve(homeDir)}${path.sep}`), `external read: ${resolved}`);
    assert.ok(resolved.endsWith("settings.json") || resolved.endsWith(path.join("cli", "config.json")), `artifact contents read: ${resolved}`);
    return fs.readFileSync(filePath, ...args);
  };
  return {
    parentDir,
    configPath,
    guardedFs,
    detect: () => detectAgentInstallation(descriptor, { homeDir, env: {}, fs: guardedFs }),
  };
}

function createArtifact(parentDir, relativePath, kind) {
  const target = path.join(parentDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (kind === "dir") fs.mkdirSync(target);
  else fs.writeFileSync(target, "");
  return target;
}

for (const [agentId, artifact, kind] of fixtures) {
  test(`${agentId} accepts an empty product ${kind}: ${artifact}`, (t) => {
    const f = makeFixture(t, agentId);
    createArtifact(f.parentDir, artifact, kind);
    const actual = f.detect();
    assert.equal(actual.detectedInstalled, true);
    assert.equal(actual.confidence, "high");
    assert.equal(actual.reason, "product-artifact");
  });
  test(`${agentId} rejects wrong-type product evidence: ${artifact}`, (t) => {
    const f = makeFixture(t, agentId);
    createArtifact(f.parentDir, artifact, kind === "dir" ? "file" : "dir");
    const actual = f.detect();
    assert.equal(actual.detectedInstalled, null);
    assert.equal(actual.reason, "insufficient-evidence");
  });
}

for (const kind of ["file", "dir"]) {
  test(`Qoder .auth retains existing ${kind} compatibility`, (t) => {
    const f = makeFixture(t, "qoder");
    createArtifact(f.parentDir, ".auth", kind);
    assert.equal(f.detect().reason, "product-artifact");
  });
}

test("WorkBuddy embedded CodeBuddy memwatch logs remain product evidence", (t) => {
  const f = makeFixture(t, "codebuddy");
  createArtifact(f.parentDir, "logs/memwatch/cli-memwatch-fixture.log", "file");
  assert.equal(f.detect().reason, "product-artifact");
});

test("Qoder CN accepts a product directory and rejects its file impostor", (t) => {
  const f = makeFixture(t, "qoder", ".qoder-cn");
  const target = createArtifact(f.parentDir, "projects", "file");
  assert.equal(f.detect().detectedInstalled, null);
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  assert.equal(f.detect().reason, "product-artifact");
});

for (const agentId of ["qoder", "zcode", "codebuddy"]) {
  test(`${agentId} preserves insufficient empty/shared folders and Clawd-only config`, (t) => {
    const f = makeFixture(t, agentId);
    assert.equal(f.detect().detectedInstalled, null);
    createArtifact(f.parentDir, "skills", "dir");
    createArtifact(f.parentDir, "agents", "dir");
    createArtifact(f.parentDir, "AGENTS.md", "file");
    assert.equal(f.detect().detectedInstalled, null);
    const hook = { type: "command", command: `node ${agentId === "zcode" ? "zcode" : agentId}-hook.js` };
    const config = agentId === "zcode"
      ? { hooks: { enabled: true, events: { Stop: [hook] } } }
      : { hooks: { Stop: [{ matcher: "*", hooks: [hook] }] } };
    fs.mkdirSync(path.dirname(f.configPath), { recursive: true });
    fs.writeFileSync(f.configPath, JSON.stringify(config));
    assert.equal(f.detect().detectedInstalled, null);
    fs.writeFileSync(f.configPath, JSON.stringify({ ...config, language: "en" }));
    assert.equal(f.detect().reason, "config-file");
  });
}

// Windows CI may not permit real file symlinks. This seam only asserts the
// pre-existing link policy is preserved; it is not a production defect claim.
for (const [agentId, artifact] of [["qoder", "state.json"], ["zcode", "v2/credentials.json"], ["codebuddy", "history.jsonl"]]) {
  test(`${agentId} preserves existing artifact symlink policy`, (t) => {
    const f = makeFixture(t, agentId);
    const target = path.join(f.parentDir, artifact);
    f.guardedFs.lstatSync = (filePath, ...args) => path.resolve(filePath) === target
      ? { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, size: 0 }
      : fs.lstatSync(filePath, ...args);
    assert.equal(f.detect().reason, "product-artifact");
  });
}
