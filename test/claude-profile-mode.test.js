"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  MAX_CLAUDE_PROFILES,
  PROFILE_MODE_THEME_ID,
  applyProfileModeDefaults,
  buildProfileModeArgs,
  defaultLabelForConfigDir,
  normalizeClaudeProfiles,
  parseProfileModeArgs,
  profileIdFromLabel,
  resolveProfilePaths,
} = require("../src/claude-profile-mode");
const { claudeProfileRuntimeConfigPath } = require("../hooks/server-config");
const prefs = require("../src/prefs");

const WORK_DIR = path.join(path.parse(process.cwd()).root, "Users", "me", ".claude-work");

test("no profile arguments means a normal primary instance", () => {
  assert.deepStrictEqual(parseProfileModeArgs(["electron", "."]), { mode: null, error: null });
});

test("profile arguments round-trip through build and parse", () => {
  const args = buildProfileModeArgs({ id: "work", label: "Work", configDir: WORK_DIR }, 2);
  const parsed = parseProfileModeArgs(["electron", ".", ...args]);
  assert.strictEqual(parsed.error, null);
  assert.deepStrictEqual({ ...parsed.mode }, { id: "work", configDir: WORK_DIR, label: "Work", slot: 2 });
});

test("broken profile arguments are an error, never a silent primary", () => {
  assert.match(parseProfileModeArgs([`--clawd-profile-id=Bad Id`, `--clawd-profile-dir=${WORK_DIR}`]).error, /id/);
  assert.match(parseProfileModeArgs(["--clawd-profile-id=work", "--clawd-profile-dir=relative/dir"]).error, /dir/);
  assert.match(parseProfileModeArgs([`--clawd-profile-dir=${WORK_DIR}`]).error, /id/);
});

test("out-of-range slots fall back to the first slot", () => {
  const parsed = parseProfileModeArgs(["--clawd-profile-id=work", `--clawd-profile-dir=${WORK_DIR}`, "--clawd-profile-slot=9"]);
  assert.strictEqual(parsed.mode.slot, 1);
  assert.strictEqual(parsed.mode.label, "work");
});

test("normalizeClaudeProfiles drops invalid and duplicate rows and caps the list", () => {
  const rows = [
    { id: "work", label: "  Work  ", configDir: `${WORK_DIR}${path.sep}` },
    { id: "work", label: "Dup id", configDir: path.join(WORK_DIR, "other") },
    { id: "dup-dir", label: "Dup dir", configDir: WORK_DIR },
    { id: "rel", configDir: "relative" },
    "nope",
    { id: "b", configDir: path.join(WORK_DIR, "b"), enabled: false },
    { id: "c", configDir: path.join(WORK_DIR, "c") },
    { id: "d", configDir: path.join(WORK_DIR, "d") },
  ];
  const out = normalizeClaudeProfiles(rows);
  assert.strictEqual(out.length, MAX_CLAUDE_PROFILES);
  assert.deepStrictEqual(out[0], { id: "work", label: "Work", configDir: WORK_DIR, enabled: true });
  assert.deepStrictEqual(out.map((row) => row.id), ["work", "b", "c"]);
  assert.strictEqual(out[1].enabled, false);
});

test("prefs keep claudeProfiles normalized and default to an empty list", () => {
  assert.deepStrictEqual(prefs.getDefaults().claudeProfiles, []);
  const validated = prefs.validate({
    ...prefs.getDefaults(),
    claudeProfiles: [{ id: "work", label: "Work", configDir: WORK_DIR, extra: 1 }],
  });
  assert.deepStrictEqual(validated.claudeProfiles, [
    { id: "work", label: "Work", configDir: WORK_DIR, enabled: true },
  ]);
});

test("profile ids derive from labels and avoid collisions", () => {
  assert.strictEqual(profileIdFromLabel("Work Stuff!"), "work-stuff");
  assert.strictEqual(profileIdFromLabel("Work", ["work"]), "work-2");
  assert.strictEqual(profileIdFromLabel("日本語"), "profile");
  assert.strictEqual(defaultLabelForConfigDir(path.join(WORK_DIR, "..", ".claude-personal")), "personal");
  assert.strictEqual(defaultLabelForConfigDir(path.join(WORK_DIR, "..", ".claude")), "Work");
});

test("profile paths keep userData under the primary and state beside the hook runtime file", () => {
  const mode = { id: "work", configDir: WORK_DIR, label: "Work", slot: 1 };
  const homeDir = path.join(path.parse(process.cwd()).root, "home", "me");
  const paths = resolveProfilePaths(mode, { primaryUserDataDir: path.join(homeDir, "ud"), homeDir });
  assert.strictEqual(paths.userDataDir, path.join(homeDir, "ud", "profiles", "work"));
  assert.strictEqual(paths.runtimeConfigPath, claudeProfileRuntimeConfigPath(WORK_DIR, { homeDir }));
  assert.strictEqual(path.dirname(paths.recoveryDir), paths.stateDir);
  assert.strictEqual(path.dirname(paths.accountQuotaPersistPath), paths.stateDir);
  assert.strictEqual(path.dirname(paths.recapRoot), paths.stateDir);
});

test("first-run profile prefs use the work avatar and only Claude Code", () => {
  const out = applyProfileModeDefaults(prefs.getDefaults());
  assert.strictEqual(out.theme, PROFILE_MODE_THEME_ID);
  assert.strictEqual(out.agents["claude-code"].enabled, true);
  assert.strictEqual(out.agents["claude-code"].integrationInstalled, true);
  for (const [agentId, entry] of Object.entries(out.agents)) {
    if (agentId === "claude-code") continue;
    assert.strictEqual(entry.enabled, false, agentId);
    assert.strictEqual(entry.integrationInstalled, false, agentId);
  }
  assert.strictEqual(out.openAtLogin, false);
  assert.strictEqual(out.tutorialSeen, true);
  // The seeded snapshot must survive prefs validation unchanged.
  assert.strictEqual(prefs.validate(out).theme, PROFILE_MODE_THEME_ID);
});
