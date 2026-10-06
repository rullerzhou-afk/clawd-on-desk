"use strict";

// refreshWslDetection generation/commit arbitration under concurrent scans.
// The committed counter must only be claimed by scans that COMMIT data —
// a failed scan claiming it would make a concurrent older-but-successful
// scan discard its valid results (regression test for the startup-scan ×
// Settings-open interleaving).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");

// WSL detection is Windows-only (module reads process.platform at require
// time for its cache seed and at call time for the scan gate) — pin win32
// so the suite behaves identically on macOS/Linux checkouts.
const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { ...origPlatform, value: "win32" });

const wslUtils = require("../src/wsl-utils");
const {
  refreshWslDetection,
  detectAgentInstallations,
} = require("../src/agent-installation-detector");

const origWslFns = {
  getWslDistributions: wslUtils.getWslDistributions,
  getWslHomeDir: wslUtils.getWslHomeDir,
  execInWsl: wslUtils.execInWsl,
};

function restoreAll() {
  Object.assign(wslUtils, origWslFns);
  Object.defineProperty(process, "platform", origPlatform);
}
process.on("exit", restoreAll);

const homeDir = os.homedir();
const descriptors = [
  {
    agentId: "codex",
    agentName: "Codex CLI",
    parentDir: path.join(homeDir, ".codex"),
  },
];
const scanOptions = { descriptors, homeDir, skipDefaultIntegrations: false };

function stubHappyDistroProbes(depStdout = "DEPFILE 0\nDEPREG 0") {
  wslUtils.getWslHomeDir = async () => "/home/tester";
  wslUtils.execInWsl = async () => ({ code: 0, stdout: `OK 0\n${depStdout}\n`, stderr: "" });
}

test("a failed newer scan does not discard a concurrent older scan's results", async () => {
  let releaseOlderScan;
  const olderScanGate = new Promise((resolve) => { releaseOlderScan = resolve; });
  let listCalls = 0;
  wslUtils.getWslDistributions = async () => {
    listCalls += 1;
    if (listCalls === 1) {
      // Older scan: slow but ultimately successful enumeration.
      await olderScanGate;
      return [{ name: "TestUbuntu" }];
    }
    // Newer scan: wsl.exe enumeration failure (returns null → scan throws).
    return null;
  };
  stubHappyDistroProbes();

  const olderScan = refreshWslDetection(scanOptions);
  const newerScan = refreshWslDetection(scanOptions);

  const newerResult = await newerScan;
  assert.ok(newerResult.wslError, "newer scan should report its failure");
  assert.deepStrictEqual(newerResult.wslAgents, [], "failed scan has no data to commit");

  releaseOlderScan();
  const olderResult = await olderScan;

  assert.strictEqual(olderResult.wslError, undefined, "older scan succeeded");
  assert.strictEqual(olderResult.wslAgents.length, 1,
    "older successful scan must still commit after a newer scan failed");
  assert.strictEqual(olderResult.wslAgents[0].distro, "TestUbuntu");
  assert.strictEqual(olderResult.wslAgents[0].agentId, "codex");

  const cached = detectAgentInstallations(scanOptions);
  assert.strictEqual(cached.wslAgents.length, 1, "cache holds the committed results");
  assert.strictEqual(cached.wslPending, false);
});

test("a failed newer scan does not clobber previously committed results", async () => {
  wslUtils.getWslDistributions = async () => [{ name: "TestDebian" }];
  stubHappyDistroProbes();
  const goodResult = await refreshWslDetection(scanOptions);
  assert.strictEqual(goodResult.wslAgents.length, 1);
  assert.strictEqual(goodResult.wslAgents[0].distro, "TestDebian");

  wslUtils.getWslDistributions = async () => null;
  const failedResult = await refreshWslDetection(scanOptions);
  assert.ok(failedResult.wslError, "failed scan reports wslError");
  assert.strictEqual(failedResult.wslAgents.length, 1,
    "failure must keep serving the previous committed results");
  assert.strictEqual(failedResult.wslAgents[0].distro, "TestDebian");
});

test("DEPFILE/DEPREG signals map to hooksFilesPresent and hooksDeployed", async () => {
  wslUtils.getWslDistributions = async () => [{ name: "TestAlpine" }];

  // Files present AND registered in claude settings → badge on.
  stubHappyDistroProbes("DEPFILE 1\nDEPREG 1");
  let entry = (await refreshWslDetection(scanOptions)).wslAgents[0];
  assert.strictEqual(entry.hooksFilesPresent, true);
  assert.strictEqual(entry.hooksDeployed, true);

  // Files present but NOT registered — the post-Unpair / non-claude-agent
  // pairing state. Unpair entry point must survive, badge must go dark.
  stubHappyDistroProbes("DEPFILE 1\nDEPREG 0");
  entry = (await refreshWslDetection(scanOptions)).wslAgents[0];
  assert.strictEqual(entry.hooksFilesPresent, true,
    "files on disk keep the unpair entry point");
  assert.strictEqual(entry.hooksDeployed, false,
    "registration gone means the deployed badge goes dark");

  // Registration line without files (stale settings.json, files removed).
  stubHappyDistroProbes("DEPFILE 0\nDEPREG 1");
  entry = (await refreshWslDetection(scanOptions)).wslAgents[0];
  assert.strictEqual(entry.hooksFilesPresent, false);
  assert.strictEqual(entry.hooksDeployed, false);

  // Clean distro.
  stubHappyDistroProbes("DEPFILE 0\nDEPREG 0");
  entry = (await refreshWslDetection(scanOptions)).wslAgents[0];
  assert.strictEqual(entry.hooksFilesPresent, false);
  assert.strictEqual(entry.hooksDeployed, false);
});

test("Hermes uses its WSL-native home and per-agent plugin evidence", async () => {
  const hermesDescriptors = [{
    agentId: "hermes",
    agentName: "Hermes Agent",
    parentDir: path.join(homeDir, "AppData", "Local", "hermes"),
    configPath: path.join(homeDir, "AppData", "Local", "hermes", "plugins", "clawd-on-desk"),
  }];
  const commands = [];
  wslUtils.getWslDistributions = async () => [{ name: "HermesUbuntu" }];
  wslUtils.getWslHomeDir = async () => "/home/tester";
  wslUtils.execInWsl = async (_distro, command) => {
    commands.push(command);
    if (command.includes("CLAWD_HERMES_HOME_V1=")) {
      return { code: 0, stdout: "shell noise\nCLAWD_HERMES_HOME_V1=/home/tester/.hermes\n", stderr: "" };
    }
    return { code: 0, stdout: "OK 0\nINTFILE 0 1\nDEPFILE 1\nDEPREG 1\n", stderr: "" };
  };

  const result = await refreshWslDetection({
    descriptors: hermesDescriptors,
    homeDir,
    skipDefaultIntegrations: false,
  });
  const entry = result.wslAgents.find((item) => item.distro === "HermesUbuntu" && item.agentId === "hermes");

  assert.ok(entry);
  assert.strictEqual(entry.detectedInstalled, true);
  assert.strictEqual(entry.wslParentDir, "/home/tester/.hermes");
  assert.strictEqual(entry.integrationFilesPresent, true);
  assert.strictEqual(entry.hermesHomeResolutionUnknown, false);
  assert.ok(commands[0].includes("\\${HERMES_HOME:-\\$HOME/.hermes}"),
    "the login shell, not wsl.exe's outer launcher shell, resolves Hermes home");
  assert.ok(commands[1].includes("/home/tester/.hermes"));
  assert.ok(!commands[1].includes("AppData"));
});

test("Hermes honors custom WSL HERMES_HOME and falls back safely when resolution fails", async () => {
  const descriptors = [{
    agentId: "hermes",
    agentName: "Hermes Agent",
    parentDir: path.join(homeDir, ".hermes"),
  }];
  wslUtils.getWslHomeDir = async () => "/home/tester";
  let resolverSucceeds = true;
  wslUtils.getWslDistributions = async () => [{ name: "HermesCustom" }];
  wslUtils.execInWsl = async (_distro, command) => {
    if (command.includes("CLAWD_HERMES_HOME_V1=")) {
      return resolverSucceeds
        ? { code: 0, stdout: "CLAWD_HERMES_HOME_V1=/srv/hermes-home\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "profile failed" };
    }
    return { code: 0, stdout: "OK 0\nINTFILE 0 0\nDEPFILE 0\nDEPREG 0\n", stderr: "" };
  };
  const options = { descriptors, homeDir, skipDefaultIntegrations: false };

  let entry = (await refreshWslDetection(options)).wslAgents.find((item) => item.distro === "HermesCustom");
  assert.strictEqual(entry.wslParentDir, "/srv/hermes-home");
  assert.strictEqual(entry.hermesHomeResolutionUnknown, false);

  resolverSucceeds = false;
  entry = (await refreshWslDetection(options)).wslAgents.find((item) => item.distro === "HermesCustom");
  assert.strictEqual(entry.wslParentDir, "/home/tester/.hermes");
  assert.strictEqual(entry.hermesHomeResolutionUnknown, true);
});

test("incomplete Hermes evidence preserves the previous committed distro result", async () => {
  const descriptors = [{ agentId: "hermes", agentName: "Hermes Agent", parentDir: path.join(homeDir, ".hermes") }];
  const options = { descriptors, homeDir, skipDefaultIntegrations: false };
  wslUtils.getWslDistributions = async () => [{ name: "HermesMarkers" }];
  wslUtils.getWslHomeDir = async () => "/home/tester";
  let complete = true;
  wslUtils.execInWsl = async (_distro, command) => {
    if (command.includes("CLAWD_HERMES_HOME_V1=")) {
      return { code: 0, stdout: "CLAWD_HERMES_HOME_V1=/home/tester/.hermes\n", stderr: "" };
    }
    return {
      code: 0,
      stdout: complete
        ? "OK 0\nINTFILE 0 1\nDEPFILE 0\nDEPREG 0\n"
        : "OK 0\nDEPFILE 0\nDEPREG 0\n",
      stderr: "",
    };
  };

  let entry = (await refreshWslDetection(options)).wslAgents.find((item) => item.distro === "HermesMarkers");
  assert.strictEqual(entry.integrationFilesPresent, true);
  complete = false;
  entry = (await refreshWslDetection(options)).wslAgents.find((item) => item.distro === "HermesMarkers");
  assert.strictEqual(entry.integrationFilesPresent, true, "ambiguous scan must keep the prior evidence");
});
