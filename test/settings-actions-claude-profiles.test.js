"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  addClaudeProfile,
  removeClaudeProfile,
  updateClaudeProfile,
  validateClaudeProfiles,
} = require("../src/settings-actions-claude-profiles");
const { commandRegistry, updateRegistry } = require("../src/settings-actions");

const ROOT = path.parse(process.cwd()).root;
const PRIMARY = path.join(ROOT, "u", ".claude");
const WORK = path.join(ROOT, "u", ".claude-work");

function deps(overrides = {}) {
  return {
    snapshot: { claudeProfiles: [] },
    isDirectory: () => true,
    getPrimaryClaudeConfigDir: () => PRIMARY,
    ...overrides,
  };
}

test("profile commands and validator are registered", () => {
  assert.strictEqual(commandRegistry["claudeProfiles.add"], addClaudeProfile);
  assert.strictEqual(commandRegistry["claudeProfiles.update"], updateClaudeProfile);
  assert.strictEqual(commandRegistry["claudeProfiles.remove"], removeClaudeProfile);
  assert.strictEqual(updateRegistry.claudeProfiles, validateClaudeProfiles);
});

test("adding a profile names it from the folder and commits it enabled", () => {
  const result = addClaudeProfile({ configDir: WORK }, deps());
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.claudeProfiles, [
    { id: "work", label: "work", configDir: WORK, enabled: true },
  ]);
  assert.strictEqual(validateClaudeProfiles(result.commit.claudeProfiles).status, "ok");
});

test("an explicit name wins over the folder name", () => {
  const result = addClaudeProfile({ configDir: WORK, label: "Office" }, deps());
  assert.deepStrictEqual(result.profile, { id: "office", label: "Office", configDir: WORK, enabled: true });
});

test("adding rejects relative, missing, primary and duplicate folders", () => {
  assert.strictEqual(addClaudeProfile({ configDir: "rel" }, deps()).status, "error");
  assert.strictEqual(addClaudeProfile({ configDir: WORK }, deps({ isDirectory: () => false })).status, "error");
  assert.match(addClaudeProfile({ configDir: PRIMARY }, deps()).message, /main pet/);
  const existing = deps({ snapshot: { claudeProfiles: [{ id: "work", label: "Work", configDir: WORK, enabled: true }] } });
  assert.match(addClaudeProfile({ configDir: WORK }, existing).message, /already added/);
});

test("adding stops at the profile limit and inside a profile pet", () => {
  const full = deps({
    snapshot: {
      claudeProfiles: ["a", "b", "c"].map((id) => ({
        id, label: id, configDir: path.join(ROOT, "u", id), enabled: true,
      })),
    },
  });
  assert.match(addClaudeProfile({ configDir: WORK }, full).message, /limit/);
  assert.match(addClaudeProfile({ configDir: WORK }, deps({ isProfileInstance: true })).message, /main Clawd/);
});

test("update renames or pauses a profile; remove drops it", () => {
  const snapshot = { claudeProfiles: [{ id: "work", label: "Work", configDir: WORK, enabled: true }] };
  assert.deepStrictEqual(
    updateClaudeProfile({ id: "work", enabled: false }, { snapshot }).commit.claudeProfiles[0].enabled,
    false
  );
  assert.strictEqual(
    updateClaudeProfile({ id: "work", label: "Office" }, { snapshot }).commit.claudeProfiles[0].label,
    "Office"
  );
  assert.strictEqual(updateClaudeProfile({ id: "work", label: "Work" }, { snapshot }).noop, true);
  assert.strictEqual(updateClaudeProfile({ id: "work", label: "   " }, { snapshot }).status, "error");
  assert.strictEqual(updateClaudeProfile({ id: "nope" }, { snapshot }).status, "error");
  assert.deepStrictEqual(removeClaudeProfile({ id: "work" }, { snapshot }).commit.claudeProfiles, []);
  assert.strictEqual(removeClaudeProfile({ id: "nope" }, { snapshot }).noop, true);
});

test("the update validator rejects unnormalized lists", () => {
  assert.strictEqual(validateClaudeProfiles([{ id: "work", label: "Work", configDir: WORK, enabled: true, x: 1 }]).status, "error");
  assert.strictEqual(validateClaudeProfiles([{ id: "work", label: " Work", configDir: WORK, enabled: true }]).status, "error");
  assert.strictEqual(validateClaudeProfiles("nope").status, "error");
});
