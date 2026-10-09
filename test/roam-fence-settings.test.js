"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const createRoamFenceLoader = require("../src/roam-fence");
const createRoamFenceSettings = require("../src/roam-fence-settings");
const { normalizeFence, publicStatus } = require("../src/roam-fence-settings");

function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-roam-fence-settings-"));
  const filePath = path.join(dir, ".clawd", "roam-area.json");
  const loader = createRoamFenceLoader({ filePath, warn: () => {} });
  return {
    dir,
    filePath,
    loader,
    runtime: createRoamFenceSettings({ filePath, loader }),
  };
}

test("roam fence settings normalize finite ordered fractions only", () => {
  assert.deepStrictEqual(normalizeFence({ left: 0.123456789, top: 0, right: 1, bottom: 0.9 }), {
    enabled: true,
    left: 0.123457,
    top: 0,
    right: 1,
    bottom: 0.9,
  });
  for (const invalid of [
    null,
    {},
    { left: "0", top: 0, right: 1, bottom: 1 },
    { left: 0.5, top: 0, right: 0.5, bottom: 1 },
    { left: -0.1, top: 0, right: 1, bottom: 1 },
    { left: 0, top: 0, right: 1.1, bottom: 1 },
  ]) assert.strictEqual(normalizeFence(invalid), null);
});

test("roam fence settings exposes only public active, inactive, and unknown state", () => {
  assert.deepStrictEqual(publicStatus(null), { status: "unknown", active: null, fence: null });
  assert.deepStrictEqual(publicStatus({ active: false, left: 0, top: 0, right: 1, bottom: 1 }), {
    status: "ok", active: false, fence: null,
  });
  assert.deepStrictEqual(publicStatus({ active: true, left: 0.2, top: 0.3, right: 0.8, bottom: 0.9 }), {
    status: "ok",
    active: true,
    fence: { left: 0.2, top: 0.3, right: 0.8, bottom: 0.9 },
  });
});

test("visual selection is atomically saved and immediately accepted by the live loader", async (t) => {
  const harness = makeRuntime();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));

  const result = await harness.runtime.saveFence({
    left: 0.125,
    top: 0.25,
    right: 0.875,
    bottom: 0.75,
  });
  assert.deepStrictEqual(result, {
    status: "ok",
    active: true,
    fence: { left: 0.125, top: 0.25, right: 0.875, bottom: 0.75 },
  });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(harness.filePath, "utf8")), {
    enabled: true,
    left: 0.125,
    top: 0.25,
    right: 0.875,
    bottom: 0.75,
  });
  assert.strictEqual(harness.loader.get().active, true);
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(harness.filePath)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(harness.filePath).mode & 0o777, 0o600);
  }
});

test("reset writes enabled false and becomes inactive after one refresh", async (t) => {
  const harness = makeRuntime();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await harness.runtime.saveFence({ left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });

  assert.deepStrictEqual(await harness.runtime.clearFence(), {
    status: "ok", active: false, fence: null,
  });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(harness.filePath, "utf8")), { enabled: false });
  assert.strictEqual(harness.loader.get().active, false);
});

test("invalid selections never touch the existing file", async (t) => {
  const harness = makeRuntime();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await harness.runtime.saveFence({ left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });
  const before = fs.readFileSync(harness.filePath, "utf8");

  const result = await harness.runtime.saveFence({ left: 0.9, top: 0, right: 0.1, bottom: 1 });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(fs.readFileSync(harness.filePath, "utf8"), before);
});

test("concurrent Settings writes are serialized and the last request wins", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-roam-fence-settings-serial-"));
  const filePath = path.join(dir, ".clawd", "roam-area.json");
  const loader = createRoamFenceLoader({ filePath, warn: () => {} });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let renameCalls = 0;
  let signalFirstRename;
  let releaseFirstRename;
  const firstRenameStarted = new Promise((resolve) => { signalFirstRename = resolve; });
  const firstRenameGate = new Promise((resolve) => { releaseFirstRename = resolve; });
  const controlledFs = {
    promises: {
      mkdir: (...args) => fs.promises.mkdir(...args),
      writeFile: (...args) => fs.promises.writeFile(...args),
      chmod: (...args) => fs.promises.chmod(...args),
      unlink: (...args) => fs.promises.unlink(...args),
      rename: async (...args) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          signalFirstRename();
          await firstRenameGate;
        }
        return fs.promises.rename(...args);
      },
    },
  };
  const runtime = createRoamFenceSettings({ filePath, loader, fs: controlledFs });
  const first = runtime.saveFence({ left: 0, top: 0, right: 0.5, bottom: 0.5 });
  await firstRenameStarted;
  const second = runtime.saveFence({ left: 0.5, top: 0.5, right: 1, bottom: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const earlyRenameCalls = renameCalls;
  releaseFirstRename();
  await Promise.all([first, second]);

  assert.strictEqual(earlyRenameCalls, 1, "the second write must wait for the first rename");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    enabled: true,
    left: 0.5,
    top: 0.5,
    right: 1,
    bottom: 1,
  });
});

test("save reports an error when the live loader does not accept the written fence", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-roam-fence-settings-reject-"));
  const filePath = path.join(dir, ".clawd", "roam-area.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const loader = {
    filePath,
    refresh: async () => {},
    get: () => ({ active: false }),
  };
  const runtime = createRoamFenceSettings({ filePath, loader });

  assert.deepStrictEqual(await runtime.saveFence({ left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }), {
    status: "error",
    message: "saved roam fence was not accepted",
  });
});

test("save reports an error when the loader keeps a different last-known-good fence", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-roam-fence-settings-stale-"));
  const filePath = path.join(dir, ".clawd", "roam-area.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const loader = {
    filePath,
    refresh: async () => {},
    get: () => ({ active: true, left: 0, top: 0, right: 0.5, bottom: 0.5 }),
  };
  const runtime = createRoamFenceSettings({ filePath, loader });

  assert.deepStrictEqual(await runtime.saveFence({ left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }), {
    status: "error",
    message: "saved roam fence was not accepted",
  });
});
