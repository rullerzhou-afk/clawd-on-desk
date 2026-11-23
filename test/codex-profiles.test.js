"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { resolveSessionIdentity } = require("../src/session-key");
const {
  codexProfileIdentity,
  loadCodexProfiles,
  normalizeCodexProfileConfig,
  resolveCodexProfile,
} = require("../src/codex-profiles");

// Absolute fixture paths must use the host platform's separators and drive.
const TEST_HOME = path.join(os.tmpdir(), "clawd-codex-profiles-fixtures");

test("default profile preserves the existing home and optional profiles are validated and labeled", () => {
  const profiles = normalizeCodexProfileConfig({
    profiles: [{ id: "company", label: " Company ", home: "~/work-codex" }],
  }, { home: TEST_HOME, env: { CODEX_HOME: path.join(TEST_HOME, "personal-codex") } });

  assert.deepEqual(profiles.map(({ id, label, home, isDefault, quotaSource }) =>
    ({ id, label, home, isDefault, quotaSource })), [
    {
      id: "default",
      label: "Codex",
      home: path.join(TEST_HOME, "personal-codex"),
      isDefault: true,
      quotaSource: null,
    },
    {
      id: "company",
      label: "Company",
      home: path.join(TEST_HOME, "work-codex"),
      isDefault: false,
      quotaSource: "codex-profile:company",
    },
  ]);
});

test("PR #1196 follow-up: invalid Codex profile config logs a startup warning", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const startupLoad = main.match(/\bloadCodexProfiles\(\{[^\n]+\}\)/);
  assert.ok(startupLoad);
  const warnings = [];
  const profiles = vm.runInNewContext(startupLoad[0], {
    loadCodexProfiles: (options) => loadCodexProfiles({
      ...options,
      readFileSync: () => "{invalid json",
      home: TEST_HOME,
      env: {},
    }),
    sessionLog() {}, // the session log path is initialized after this call
    console: { warn: (message) => warnings.push(message) },
  });
  assert.equal(profiles.length, 1);
  assert.match(warnings[0] || "", /local Codex profile config is invalid/);
});

test("invalid, duplicate, overlapping, or credential-shaped profile config fails closed", () => {
  const home = TEST_HOME;
  const work = path.join(home, "..", "work");
  const invalid = [
    { profiles: [{ id: "../work", label: "Work", home: work }] },
    { profiles: [{ id: "work", label: "Work", home: "relative" }] },
    { profiles: [{ id: "work", label: "Work", home: path.join(home, ".codex", "sessions") }] },
    { profiles: [{ id: "work", label: "Codex", home: work }] },
    { profiles: [{ id: "work", label: "Work", home: work, token: "ignored" }] },
    { profiles: [{ id: "work", label: "Work", home: work },
      { id: "work", label: "Again", home: path.join(home, "..", "again") }] },
    { profiles: [{ id: "work", label: "Work", home: work },
      { id: "again", label: "Again", home: path.join(work, "nested") }] },
  ];
  for (const config of invalid) {
    assert.deepEqual(normalizeCodexProfileConfig(config, { home, env: {} }).map((profile) => profile.id), ["default"]);
  }
});

test("loader treats a missing file as default and malformed JSON as fail-closed", () => {
  const configPath = path.join(TEST_HOME, ".clawd", "codex-profiles.json");
  const missing = loadCodexProfiles({
    home: TEST_HOME,
    env: {},
    configPath,
    readFileSync: () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
  });
  assert.equal(missing.length, 1);

  const malformed = loadCodexProfiles({
    home: TEST_HOME,
    env: {},
    configPath,
    readFileSync: () => "{ invalid",
  });
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].home, path.join(TEST_HOME, ".codex"));
});

test("profile identities isolate matching raw session ids while retaining their display id", () => {
  const [personal, company] = normalizeCodexProfileConfig({
    profiles: [{ id: "company", label: "Company", home: path.join(TEST_HOME, ".codex-company") }],
  }, { home: TEST_HOME, env: {} });
  const a = codexProfileIdentity("same-session", personal);
  const b = codexProfileIdentity("same-session", company);

  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.rawSessionId, b.rawSessionId);
  assert.equal(b.codexProfileId, "company");
  assert.equal(b.codexProfileLabel, "Company");
  assert.equal(b.codexProfileIsDefault, false);
});

test("PR #1196 follow-up: only transcripts in an extra profile's rollout directories select it", () => {
  const profiles = normalizeCodexProfileConfig({
    profiles: [{ id: "company", label: "Company", home: path.join(TEST_HOME, ".codex-company") }],
  }, { home: TEST_HOME, env: {} });
  assert.equal(resolveCodexProfile(path.join(TEST_HOME, ".codex-company", "sessions", "a.jsonl"), profiles), profiles[1]);
  assert.equal(resolveCodexProfile(path.join(TEST_HOME, ".codex-company", "archived_sessions", "a.jsonl"), profiles), profiles[1]);
  for (const transcript of [
    null, "relative.jsonl",
    path.join(TEST_HOME, ".codex", "sessions", "a.jsonl"),
    path.join(TEST_HOME, ".codex-company-other", "sessions", "a.jsonl"),
    path.join(TEST_HOME, ".codex-company", "other", "a.jsonl"),
  ]) {
    assert.equal(resolveCodexProfile(transcript, profiles), profiles[0], String(transcript));
  }
});

test("PR #1196 follow-up: follows rollout directory symlinks and defaults on multiple matches", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-rollout-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const company = path.join(root, "company");
  const personal = path.join(root, "personal");
  const rollouts = path.join(root, "rollouts");
  for (const dir of [company, personal, rollouts]) fs.mkdirSync(dir);
  const profiles = normalizeCodexProfileConfig({
    profiles: [
      { id: "company", label: "Company", home: company },
      { id: "personal", label: "Personal", home: personal },
    ],
  }, { home: root, env: {} });
  const symlink = (target, link) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  try {
    symlink(rollouts, path.join(company, "archived_sessions"));
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return t.skip("directory link permission is unavailable");
    throw error;
  }
  const transcript = path.join(rollouts, "rollout.jsonl");
  assert.equal(resolveCodexProfile(transcript, profiles), profiles[1]);
  symlink(rollouts, path.join(personal, "sessions"));
  assert.equal(resolveCodexProfile(transcript, profiles), profiles[0]);
});

test("PR #1196 follow-up: single-profile routing preserves legacy custom transcript paths", () => {
  const profiles = normalizeCodexProfileConfig(null, {
    home: TEST_HOME,
    env: { CODEX_HOME: path.join(TEST_HOME, "custom-codex") },
  });

  assert.equal(profiles[0].home, path.join(TEST_HOME, "custom-codex"));
  assert.equal(resolveCodexProfile(path.join(TEST_HOME, "synthetic", "legacy-session.jsonl"), profiles), profiles[0]);
  assert.equal(resolveCodexProfile(null, profiles), profiles[0]);
  assert.equal(resolveCodexProfile("relative.jsonl", profiles), profiles[0]);
});

for (const edge of ["overlaps the default root", "contains a parent segment", "is a dangling file link"]) {
  test(`PR #1196 follow-up: a transcript that ${edge} stays with the default profile`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-hook-path-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const defaultSessions = path.join(root, ".codex", "sessions");
    const companyHome = path.join(root, "company");
    const companySessions = path.join(companyHome, "sessions");
    const outside = path.join(root, "outside", "nested");
    for (const dir of [defaultSessions, companyHome, outside]) fs.mkdirSync(dir, { recursive: true });
    const profiles = normalizeCodexProfileConfig({
      profiles: [{ id: "company", label: "Company", home: companyHome }],
    }, { home: root, env: {} });
    assert.equal(profiles.length, 2);
    const directoryLink = process.platform === "win32" ? "junction" : "dir";
    let transcript;
    try {
      if (edge === "overlaps the default root") {
        fs.symlinkSync(defaultSessions, companySessions, directoryLink);
        transcript = path.join(defaultSessions, "rollout.jsonl");
        fs.writeFileSync(transcript, "");
      } else {
        fs.mkdirSync(companySessions);
        if (edge === "contains a parent segment") {
          const link = path.join(companySessions, "link");
          fs.symlinkSync(outside, link, directoryLink);
          transcript = [link, "..", "rollout.jsonl"].join(path.sep);
          fs.writeFileSync(path.join(root, "outside", "rollout.jsonl"), "");
          fs.writeFileSync(path.join(companySessions, "rollout.jsonl"), "");
        } else {
          transcript = path.join(companySessions, "rollout.jsonl");
          fs.symlinkSync(path.join(outside, "missing.jsonl"), transcript, "file");
        }
      }
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return t.skip("symlink permission is unavailable");
      throw error;
    }
    assert.equal(resolveCodexProfile(transcript, profiles), profiles[0]);
  });
}

test("zero-config preserves the legacy local session identity and quota source", () => {
  const rawId = "codex:legacy-session";
  const [defaultProfile] = normalizeCodexProfileConfig(undefined, { home: TEST_HOME, env: {} });
  assert.equal(defaultProfile.quotaSource, null);
  assert.equal(defaultProfile.id, "default");
  assert.equal(codexProfileIdentity(rawId, defaultProfile).sessionId,
    resolveSessionIdentity(rawId, "local").sessionId);
  assert.equal(resolveCodexProfile(null, [defaultProfile]), defaultProfile);
  assert.equal(resolveCodexProfile(path.join(TEST_HOME, "unexpected.jsonl"), [defaultProfile]), defaultProfile);
});

test("symlinked homes cannot duplicate or overlap a physical Codex home", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-realpath-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultHome = path.join(root, "personal");
  const aliasHome = path.join(root, "company-alias");
  fs.mkdirSync(defaultHome);
  fs.symlinkSync(defaultHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
  const options = { home: root, env: { CODEX_HOME: defaultHome } };
  for (const home of [aliasHome, path.join(aliasHome, "sessions")]) {
    const profiles = normalizeCodexProfileConfig({
      profiles: [{ id: "company", label: "Company", home }],
    }, options);
    assert.deepEqual(profiles.map((profile) => profile.id), ["default"]);
  }
});

test("transcript ownership resolves real paths and symlink aliases identically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultHome = path.join(root, "personal");
  const companyHome = path.join(root, "company");
  const aliasHome = path.join(root, "company-alias");
  fs.mkdirSync(defaultHome);
  fs.mkdirSync(companyHome);
  fs.symlinkSync(companyHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
  const profiles = normalizeCodexProfileConfig({
    profiles: [{ id: "company", label: "Company", home: aliasHome }],
  }, { home: root, env: { CODEX_HOME: defaultHome } });
  assert.equal(profiles.length, 2);
  assert.equal(resolveCodexProfile(path.join(companyHome, "sessions", "a.jsonl"), profiles), profiles[1]);
  assert.equal(resolveCodexProfile(path.join(aliasHome, "sessions", "a.jsonl"), profiles), profiles[1]);
});

test("PR #1196 follow-up: rejects overlapping physical rollout roots across live and archived sessions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-overlapping-rollouts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultHome = path.join(root, "default");
  const companyHome = path.join(root, "company");
  const labHome = path.join(root, "lab");
  const shared = path.join(root, "shared");
  const nested = path.join(shared, "nested");
  for (const dir of [defaultHome, companyHome, labHome, nested]) fs.mkdirSync(dir, { recursive: true });
  const link = (target, linkPath) => fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  try {
    link(shared, path.join(companyHome, "sessions"));
    link(nested, path.join(labHome, "archived_sessions"));
    link(shared, path.join(defaultHome, "archived_sessions"));
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return t.skip("directory link permission is unavailable");
    throw error;
  }
  const company = { id: "company", label: "Company", home: companyHome };
  const lab = { id: "lab", label: "Lab", home: labHome };
  for (const [codexHome, profiles] of [
    [defaultHome, [company]], [path.join(root, "another-default"), [company, lab]],
  ]) {
    const normalized = normalizeCodexProfileConfig({ profiles }, { home: root, env: { CODEX_HOME: codexHome } });
    assert.deepEqual(normalized.map((profile) => profile.id), ["default"]);
  }
});

test("profile configuration reads only its JSON config, never credentials or tokens", () => {
  const configPath = path.join(TEST_HOME, ".clawd", "codex-profiles.json");
  const readPaths = [];
  const profiles = loadCodexProfiles({
    home: TEST_HOME,
    env: {},
    configPath,
    readFileSync(file) {
      readPaths.push(file);
      assert.equal(file, configPath, "only profile metadata configuration may be read");
      return JSON.stringify({ profiles: [
        { id: "company", label: "Company", home: path.join(TEST_HOME, "company") },
      ] });
    },
  });
  assert.equal(profiles.length, 2);
  assert.deepEqual(readPaths, [configPath]);
});
