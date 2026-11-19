"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { registerKiroDesktopHooks: install, unregisterKiroDesktopHooks: uninstall,
  isOwnedKiroDesktopCommand: owned } = require("../hooks/kiro-desktop-install");

// Keep every installer mutation inside a disposable, explicit home.
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-desktop-install-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const hooksPath = path.join(homeDir, ".kiro", "hooks", "clawd-on-desk.json");
  const options = { homeDir, nodeBin: "/opt/node", platform: "darwin" };
  const write = value => {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(value));
  };
  return { options, hooksPath, write, read: () => JSON.parse(fs.readFileSync(hooksPath)) };
}

test("kiro-desktop: creates five hooks and idempotent install preserves bytes and mtime", t => {
  const f = fixture(t);
  assert.equal(install(f.options).added, 5);
  const before = fs.readFileSync(f.hooksPath, "utf8");
  const mtime = fs.statSync(f.hooksPath).mtimeMs;
  assert.deepEqual(install(f.options), { added: 0, updated: 0, skipped: 5, hooksPath: f.hooksPath });
  assert.equal(fs.statSync(f.hooksPath).mtimeMs, mtime);
  assert.equal(fs.readFileSync(f.hooksPath, "utf8"), before);
  assert.deepEqual(f.read().hooks.map(hook => hook.trigger), [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop",
  ]);
});

test("kiro-desktop: preserves foreign hooks and fields, fills missing version, replaces moved paths", t => {
  const f = fixture(t);
  const foreign = { name: "mine", trigger: "Stop", action: { type: "command", command: "echo hi" } };
  f.write({
    custom: 42,
    hooks: [foreign, {
      trigger: "Stop",
      action: { type: "command", command: '"/old/node" "/old/kiro-desktop-hook.js"' },
    }],
  });
  assert.equal(install(f.options).updated, 1);
  assert.equal(f.read().version, "v1");
  assert.equal(f.read().custom, 42);
  assert.deepEqual(f.read().hooks[0], foreign);
  assert.equal(f.read().hooks.length, 6);
  assert.equal(install(f.options).skipped, 5);
});

for (const document of [{ version: "v2", hooks: [] }, { hooks: {} }, [], null]) {
  test(`kiro-desktop: refuses unsupported document ${JSON.stringify(document)}`, t => {
    const f = fixture(t);
    f.write(document);
    const before = fs.readFileSync(f.hooksPath);
    assert.throws(() => install(f.options));
    assert.deepEqual(fs.readFileSync(f.hooksPath), before);
    assert.equal(uninstall(f.options).registrationRemoved, null);
    assert.deepEqual(fs.readFileSync(f.hooksPath), before);
  });
}

test("kiro-desktop: malformed JSON stays untouched on install and uninstall", t => {
  const f = fixture(t);
  f.write({});
  fs.writeFileSync(f.hooksPath, "{");
  assert.throws(() => install(f.options));
  const result = uninstall(f.options);
  assert.equal(result.registrationRemoved, null);
  assert.ok(result.error);
  assert.equal(fs.readFileSync(f.hooksPath, "utf8"), "{");
});

test("kiro-desktop: ownership requires the complete two-token command shape", () => {
  for (const command of [
    '"/old/node" "/old/kiro-desktop-hook.js"',
    '"C:\\Program Files\\node.exe" "D:\\old app\\kiro-desktop-hook.js"',
  ]) {
    assert.equal(owned(command), true);
  }
  for (const command of [
    'echo kiro-desktop-hook.js',
    'node /x/kiro-desktop-hook.js.backup',
    'node /x/kiro-desktop-hook.js --extra',
    'node /x/kiro-desktop-hook.js && echo ok',
    'python /x/kiro-desktop-hook.js',
  ]) {
    assert.equal(owned(command), false);
  }
});

test("kiro-desktop: uninstall deletes only an emptied owned shell", t => {
  const f = fixture(t);
  install(f.options);
  assert.equal(uninstall(f.options).removed, 5);
  assert.equal(fs.existsSync(f.hooksPath), false);
  assert.equal(uninstall(f.options).registrationRemoved, true);
  for (const empty of [{ hooks: [] }, { version: "v1", hooks: [] }]) {
    f.write(empty);
    assert.equal(uninstall(f.options).changed, false);
    assert.deepEqual(f.read(), empty);
  }
});

test("kiro-desktop: uninstall preserves foreign document, action types, and sibling files", t => {
  const f = fixture(t);
  install(f.options);
  const foreign = { action: { type: "prompt", command: 'node /x/kiro-desktop-hook.js' } };
  f.write({ ...f.read(), owner: "user", hooks: [...f.read().hooks, foreign] });
  const sibling = path.join(path.dirname(f.hooksPath), "user.json");
  fs.writeFileSync(sibling, "keep");
  assert.equal(uninstall(f.options).registrationRemoved, true);
  assert.deepEqual(f.read(), { version: "v1", owner: "user", hooks: [foreign] });
  assert.equal(fs.readFileSync(sibling, "utf8"), "keep");
  install(f.options);
  f.write({ ...f.read(), hooks: f.read().hooks.filter(h => h !== foreign && h.action.type === "command") });
  uninstall(f.options);
  assert.deepEqual(f.read(), { version: "v1", owner: "user", hooks: [] });
});

test("kiro-desktop: uses unpacked paths and a cmd-compatible Windows launcher", t => {
  const f = fixture(t);
  install({
    ...f.options,
    platform: "win32",
    nodeBin: "C:/Program Files/nodejs/node.exe",
    scriptPath: "D:/My App/app.asar/hooks/kiro-desktop-hook.js",
  });
  const command = f.read().hooks[0].action.command;
  assert.equal(command.startsWith('& '), false);
  assert.equal(command, '"C:/Program Files/nodejs/node.exe" "D:/My App/app.asar.unpacked/hooks/kiro-desktop-hook.js"');
  assert.equal(owned(command), true);
  assert.equal(install({ ...f.options, nodeBin: null }).updated, 5);
  assert.ok(f.read().hooks[0].action.command.startsWith('"C:/Program Files/nodejs/node.exe"'));
});


for (const character of ["!", "%"]) {
  test(`kiro-desktop: refuses unmanaged path character ${character} before changing config`, t => {
    const f = fixture(t);
    install(f.options);
    const before = fs.readFileSync(f.hooksPath);
    for (const override of [
    { scriptPath: `/Applications/My Clawd${character}/hooks/kiro-desktop-hook.js` },
    { nodeBin: `/Applications/Node${character}/node` },
    ]) {
      assert.throws(() => install({ ...f.options, ...override }), /Cannot safely manage.*unsupported characters/);
      assert.deepEqual(fs.readFileSync(f.hooksPath), before);
    }
  });
}

for (const operation of ["renameSync", "writeFileSync", "unlinkSync"]) {
  test(`kiro-desktop: uninstall ${operation} failure keeps Settings installation committed`, async t => {
    const f = fixture(t);
    install(f.options);
    if (operation !== "unlinkSync") f.write({ ...f.read(), user: true });
    const before = fs.readFileSync(f.hooksPath);
    const original = fs[operation];
    t.mock.method(fs, operation, function failTarget(...args) {
      const target = operation === "renameSync" ? args[1] : args[0];
      const isConfigMutation = target === f.hooksPath
        || (operation === "writeFileSync" && path.dirname(String(target)) === path.dirname(f.hooksPath));
      if (isConfigMutation) {
        const error = new Error("injected missing mutation source");
        error.code = "ENOENT";
        throw error;
      }
      return original.apply(this, args);
    });
    const result = uninstall(f.options);
    assert.equal(result.registrationRemoved, null);
    assert.match(result.error, /injected missing mutation source/);
    assert.deepEqual(fs.readFileSync(f.hooksPath), before);
    const actions = require("../src/settings-actions-agents");
    const snapshot = require("../src/prefs").getDefaults();
    Object.assign(snapshot.agents["kiro-desktop"], { enabled: true, integrationInstalled: true });
    let stopped = false;
    const outcome = await actions.uninstallAgentIntegration({ agentId: "kiro-desktop" }, {
      snapshot,
      uninstallIntegrationForAgent: () => uninstall(f.options),
      stopMonitorForAgent() {
        stopped = true;
      },
    });
    assert.equal(outcome.status, "error");
    assert.equal(outcome.commit, undefined);
    assert.equal(snapshot.agents["kiro-desktop"].integrationInstalled, true);
    assert.equal(stopped, false);
  });
}
