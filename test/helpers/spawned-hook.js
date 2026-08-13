"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HTTP_BLOCKER = path.resolve(__dirname, "..", "hook-http-blocker.js");
const HTTP_RECORDER = path.resolve(__dirname, "hook-post-recorder.js");
const OFFLINE_PROBE = path.resolve(__dirname, "hook-offline-probe.js");
const SPAWN_RECORDER = path.resolve(__dirname, "hook-spawn-recorder.js");
const HTTP_CONTRACTS = new Set(["block", "expect-attempt", "expect-none"]);

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function createSpawnedHookHarness(options = {}) {
  const ownsHome = !options.home;
  const home = options.home || fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "clawd-hook-test-"));
  const userData = path.join(home, "user-data");
  const appData = path.join(home, "app-data");
  const localAppData = path.join(home, "local-app-data");
  const xdgConfigHome = path.join(home, "xdg-config");
  const clawdDir = path.join(home, ".clawd");
  let sequence = 0;

  for (const directory of [home, userData, appData, localAppData, xdgConfigHome, clawdDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  function run(runOptions = {}) {
    const script = path.resolve(runOptions.script || "");
    if (!runOptions.script || !fs.existsSync(script)) {
      throw new Error(`spawned hook script does not exist: ${runOptions.script || "(missing)"}`);
    }

    const httpContract = runOptions.httpContract || "block";
    if (!HTTP_CONTRACTS.has(httpContract)) {
      throw new Error(`unknown spawned-hook HTTP contract: ${httpContract}`);
    }
    sequence += 1;
    const attemptsPath = path.join(home, `http-attempts-${sequence}.json`);
    const spawnsPath = path.join(home, `process-spawns-${sequence}.json`);
    const runtimePath = path.join(clawdDir, "runtime.json");
    for (const outputPath of [attemptsPath, spawnsPath]) {
      try { fs.unlinkSync(outputPath); } catch { /* first run */ }
    }

    if (runOptions.runtimeJson === undefined) {
      try { fs.unlinkSync(runtimePath); } catch { /* already absent */ }
    } else {
      fs.writeFileSync(runtimePath, JSON.stringify(runOptions.runtimeJson), "utf8");
    }

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAWD_")) delete env[key];
    }
    for (const key of [
      "CODEX_HOME",
      "COPILOT_HOME",
      "HERMES_HOME",
      "KIMI_CODE_HOME",
      "NODE_OPTIONS",
      "REASONIX_HOME",
      "TMUX",
      "TMUX_PANE",
    ]) {
      delete env[key];
    }
    Object.assign(env, runOptions.env || {});
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: xdgConfigHome,
      CLAWD_TEST_USER_DATA: userData,
    });

    const preloads = [];
    if (httpContract === "block") {
      preloads.push(HTTP_BLOCKER);
    } else {
      preloads.push(HTTP_RECORDER);
      env.CLAWD_POST_OUT = attemptsPath;
    }
    if (runOptions.probeProcessSpawns) {
      preloads.push(SPAWN_RECORDER);
      env.CLAWD_PROBE_OUT = spawnsPath;
    }
    preloads.push(...(runOptions.preloads || []).map((preload) => path.resolve(preload)));

    const argv = [];
    for (const preload of preloads) argv.push("--require", preload);
    argv.push(script, ...(runOptions.args || []).map(String));

    const input = runOptions.input !== undefined
      ? String(runOptions.input)
      : `${JSON.stringify(runOptions.payload === undefined ? {} : runOptions.payload)}\n`;
    const result = spawnSync(process.execPath, argv, {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: runOptions.timeout || 20000,
      env,
      cwd: runOptions.cwd,
    });

    const attempts = httpContract === "block"
      ? null
      : readJsonIfPresent(attemptsPath);
    const spawns = runOptions.probeProcessSpawns ? readJsonIfPresent(spawnsPath) : null;

    if (httpContract === "expect-none") {
      assert.ok(
        Array.isArray(attempts),
        `spawned hook did not report HTTP attempts; status=${result.status}, stderr=${result.stderr}`,
      );
      assert.deepStrictEqual(
        attempts,
        [],
        `business logic must not attempt HTTP; got ${JSON.stringify(attempts)}`,
      );
    } else if (httpContract === "expect-attempt") {
      assert.ok(
        Array.isArray(attempts),
        `spawned hook did not report blocked HTTP attempts; status=${result.status}, stderr=${result.stderr}`,
      );
      assert.ok(
        attempts.length > 0,
        "business logic should attempt HTTP, but the preload recorder observed none",
      );
    }

    return Object.assign(result, {
      attempts,
      spawns,
      testHome: home,
      testUserData: userData,
      preloads,
    });
  }

  function cleanup() {
    if (!ownsHome) return;
    fs.rmSync(home, { recursive: true, force: true });
  }

  return {
    home,
    userData,
    run,
    cleanup,
  };
}

function runSpawnedHook(options) {
  const harness = createSpawnedHookHarness(options && options.harness);
  try {
    return harness.run(options);
  } finally {
    harness.cleanup();
  }
}

module.exports = {
  HTTP_BLOCKER,
  HTTP_RECORDER,
  OFFLINE_PROBE,
  SPAWN_RECORDER,
  createSpawnedHookHarness,
  runSpawnedHook,
};
