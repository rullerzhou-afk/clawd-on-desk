"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  addClaudeConfigDir,
  removeClaudeConfigDir,
  setClaudeConfigDirLabel,
} = require("../src/settings-actions-claude-config-dirs");
const { commandRegistry } = require("../src/settings-actions");

// Host absolute paths: the commands normalize folders with the host's path
// rules, so POSIX literals would not round-trip on Windows.
const PRIMARY = path.resolve("/home/u/.claude");
const WORK = path.resolve("/home/u/.claude-work");

function snapshot(configDirs, extra = {}) {
  return {
    manageClaudeHooksAutomatically: true,
    agents: {
      "claude-code": { integrationInstalled: true, enabled: true, ...(configDirs ? { configDirs } : {}) },
      codex: { integrationInstalled: true, enabled: true },
    },
    ...extra,
  };
}

function deps(snap, overrides = {}) {
  const calls = { install: [], uninstall: [] };
  return {
    calls,
    deps: {
      snapshot: snap,
      primaryClaudeConfigDir: PRIMARY,
      installClaudeConfigDir: async (dir) => { calls.install.push(dir); return { status: "ok", dir }; },
      uninstallClaudeConfigDir: async (dir) => { calls.uninstall.push(dir); return { status: "ok", dir }; },
      ...overrides,
    },
  };
}

describe("Claude config folder settings commands", () => {
  it("are registered and serialized with other agent integration commands", () => {
    for (const name of ["addClaudeConfigDir", "removeClaudeConfigDir", "setClaudeConfigDirLabel"]) {
      assert.strictEqual(typeof commandRegistry[name], "function", name);
      assert.strictEqual(commandRegistry[name].lockKey, "agentIntegration", name);
    }
  });

  it("installs hooks before recording a new folder", async () => {
    const { calls, deps: d } = deps(snapshot());
    const result = await addClaudeConfigDir({ dir: `${WORK}${path.sep}` }, d);
    assert.deepStrictEqual(calls.install, [WORK]);
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.commit.agents["claude-code"].configDirs, [{ dir: WORK, label: "" }]);
    assert.deepStrictEqual(result.commit.agents.codex, { integrationInstalled: true, enabled: true });
  });

  it("does not record a folder whose hooks failed", async () => {
    const { deps: d } = deps(snapshot(), {
      installClaudeConfigDir: async () => ({ status: "error", message: "Claude hook repair did not verify healthy" }),
    });
    const result = await addClaudeConfigDir({ dir: WORK }, d);
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /verify healthy/);
    assert.strictEqual(result.commit, undefined);
  });

  it("only records the folder while automatic hook management is off", async () => {
    const { calls, deps: d } = deps(snapshot(undefined, { manageClaudeHooksAutomatically: false }));
    const result = await addClaudeConfigDir({ dir: WORK }, d);
    assert.deepStrictEqual(calls.install, []);
    assert.deepStrictEqual(result.commit.agents["claude-code"].configDirs, [{ dir: WORK, label: "" }]);
  });

  it("rejects the primary folder, relative paths and duplicates", async () => {
    const { calls, deps: d } = deps(snapshot([{ dir: WORK, label: "" }]));
    assert.strictEqual((await addClaudeConfigDir({ dir: PRIMARY }, d)).reason, "primary");
    assert.strictEqual((await addClaudeConfigDir({ dir: "rel/dir" }, d)).status, "error");
    assert.deepStrictEqual(await addClaudeConfigDir({ dir: WORK }, d), { status: "ok", noop: true });
    assert.deepStrictEqual(calls.install, []);
  });

  it("removes hooks before dropping a folder", async () => {
    const { calls, deps: d } = deps(snapshot([{ dir: WORK, label: "job" }, { dir: PRIMARY, label: "me" }]));
    const result = await removeClaudeConfigDir({ dir: WORK }, d);
    assert.deepStrictEqual(calls.uninstall, [WORK]);
    assert.deepStrictEqual(result.commit.agents["claude-code"].configDirs, [{ dir: PRIMARY, label: "me" }]);
    assert.strictEqual((await removeClaudeConfigDir({ dir: PRIMARY }, d)).reason, "primary");
  });

  it("keeps the folder listed when hook removal fails", async () => {
    const { deps: d } = deps(snapshot([{ dir: WORK, label: "" }]), {
      uninstallClaudeConfigDir: async () => ({ status: "error", message: "Failed to read settings.json" }),
    });
    const result = await removeClaudeConfigDir({ dir: WORK }, d);
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.commit, undefined);
  });

  it("renames folders, including the primary one", () => {
    const { deps: d } = deps(snapshot([{ dir: WORK, label: "" }]));
    const renamed = setClaudeConfigDirLabel({ dir: WORK, label: "  Job  " }, d);
    assert.deepStrictEqual(renamed.commit.agents["claude-code"].configDirs, [{ dir: WORK, label: "Job" }]);
    const primary = setClaudeConfigDirLabel({ dir: PRIMARY, label: "personal" }, d);
    assert.deepStrictEqual(primary.commit.agents["claude-code"].configDirs, [
      { dir: PRIMARY, label: "personal" },
      { dir: WORK, label: "" },
    ]);
    assert.strictEqual(setClaudeConfigDirLabel({ dir: path.resolve("/elsewhere"), label: "x" }, d).status, "error");
  });

  it("PR #1329 follow-up: reports whether adding a folder actually installed hooks", async () => {
    for (const flags of [
      { manageClaudeHooksAutomatically: false },
      { enabled: false },
      { integrationInstalled: false },
      {},
    ]) {
      const snap = snapshot();
      if ("manageClaudeHooksAutomatically" in flags) snap.manageClaudeHooksAutomatically = flags.manageClaudeHooksAutomatically;
      else Object.assign(snap.agents["claude-code"], flags);
      const { calls, deps: d } = deps(snap);
      const result = await addClaudeConfigDir({ dir: WORK }, d);
      const installed = Object.keys(flags).length === 0;
      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.installed, installed);
      assert.strictEqual(calls.install.length, installed ? 1 : 0);
      assert.deepStrictEqual(result.commit.agents["claude-code"].configDirs, [{ dir: WORK, label: "" }]);
    }
  });

});
