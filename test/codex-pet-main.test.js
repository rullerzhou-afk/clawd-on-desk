const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCodexPetMain = require("../src/codex-pet-main");

function createQueueRuntime(overrides = {}) {
  const parseCalls = [];
  const showMessageBoxCalls = [];
  const runtime = createCodexPetMain({
    app: {
      getPath: () => "user-data",
      isReady: () => false,
      ...(overrides.app || {}),
    },
    dialog: {
      async showMessageBox(parent, options) {
        showMessageBoxCalls.push({ parent, options });
        return { response: 1 };
      },
      ...(overrides.dialog || {}),
    },
    shell: {},
    settingsController: {
      get: () => "clawd",
      async applyCommand() {
        return { status: "ok" };
      },
      ...(overrides.settingsController || {}),
    },
    themeLoader: overrides.themeLoader || {},
    codexPetAdapter: {
      syncCodexPetThemes: () => ({ themes: [] }),
      readManagedMarker: () => null,
      ...(overrides.codexPetAdapter || {}),
    },
    codexPetImporter: {
      parseClawdImportUrl(rawUrl) {
        parseCalls.push(rawUrl);
        return {
          asciiHostname: "example.test",
          url: `https://example.test/${encodeURIComponent(rawUrl)}`,
        };
      },
      ...(overrides.codexPetImporter || {}),
    },
    ...(overrides.runtimeOptions || {}),
  });
  return { runtime, parseCalls, showMessageBoxCalls };
}

test("Codex Pet main helpers merge sync summaries without dropping diagnostics", () => {
  const { mergeCodexPetSyncSummaries } = createCodexPetMain.__test;
  const summary = mergeCodexPetSyncSummaries(
    {
      codexPetsDir: "old-pets",
      userThemesDir: "old-themes",
      imported: 1,
      unchanged: 2,
      activeOrphanThemeIds: [42, "codex-pet-a"],
      themes: [{ themeId: "codex-pet-a" }],
      diagnostics: [{ warnings: ["old"] }],
    },
    {
      codexPetsDir: "new-pets",
      updated: 3,
      removed: 1,
      activeOrphanThemeIds: ["42", "codex-pet-b"],
      themes: [{ themeId: "codex-pet-b" }],
      diagnostics: [{ warnings: ["new"] }],
    }
  );

  assert.strictEqual(summary.codexPetsDir, "new-pets");
  assert.strictEqual(summary.userThemesDir, "old-themes");
  assert.strictEqual(summary.imported, 1);
  assert.strictEqual(summary.updated, 3);
  assert.strictEqual(summary.unchanged, 2);
  assert.strictEqual(summary.removed, 1);
  assert.deepStrictEqual(summary.activeOrphanThemeIds, ["42", "codex-pet-a", "codex-pet-b"]);
  assert.deepStrictEqual(summary.themes.map((theme) => theme.themeId), ["codex-pet-a", "codex-pet-b"]);
  assert.strictEqual(summary.diagnostics.length, 2);
});

test("Codex Pet main helpers detect clawd protocol args case-insensitively", () => {
  const { extractClawdProtocolUrls } = createCodexPetMain.__test;
  assert.deepStrictEqual(
    extractClawdProtocolUrls([
      "Clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json",
      "--flag",
      "https://example.test",
      "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fother.json",
    ]),
    [
      "Clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json",
      "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fother.json",
    ]
  );
});

test("Codex Pet main runtime records sync summaries and normalizes adapter failures", () => {
  const runtime = createCodexPetMain({
    app: {
      getPath(name) {
        assert.strictEqual(name, "userData");
        return "user-data";
      },
      isReady: () => false,
    },
    dialog: {},
    shell: {},
    settingsController: {
      get: () => "clawd",
    },
    themeLoader: {},
    codexPetAdapter: {
      syncCodexPetThemes(options) {
        assert.deepStrictEqual(options, {
          userDataDir: "user-data",
          activeThemeId: "codex-pet-live",
        });
        return { imported: 1, themes: [{ themeId: "codex-pet-live" }] };
      },
    },
    codexPetImporter: {},
  });

  const summary = runtime.syncThemes("codex-pet-live");
  assert.deepStrictEqual(summary, { imported: 1, themes: [{ themeId: "codex-pet-live" }] });
  assert.strictEqual(runtime.getLastSyncSummary(), summary);

  const failingRuntime = createCodexPetMain({
    app: {
      getPath: () => "user-data",
      isReady: () => false,
    },
    dialog: {},
    shell: {},
    settingsController: {
      get: () => "clawd",
    },
    themeLoader: {},
    codexPetAdapter: {
      syncCodexPetThemes() {
        throw new Error("boom");
      },
    },
    codexPetImporter: {},
  });

  const failed = failingRuntime.syncThemes("clawd");
  assert.strictEqual(failed.error, "boom");
  assert.match(failed.diagnostics[0].errors[0], /failed to sync Codex Pet themes: boom/);
  assert.strictEqual(failingRuntime.getLastSyncSummary(), failed);
});

test("Codex Pet import URLs queued before app ready do not flush until explicitly drained", async () => {
  const originalSetImmediate = global.setImmediate;
  let immediateCalls = 0;
  global.setImmediate = (...args) => {
    immediateCalls += 1;
    return originalSetImmediate(...args);
  };
  try {
    const { runtime, parseCalls, showMessageBoxCalls } = createQueueRuntime();
    runtime.enqueueImportUrl("clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json");

    assert.strictEqual(immediateCalls, 0);
    assert.deepStrictEqual(parseCalls, []);
    assert.deepStrictEqual(showMessageBoxCalls, []);

    await runtime.flushPendingImportUrls();
    assert.deepStrictEqual(parseCalls, ["clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json"]);
    assert.strictEqual(showMessageBoxCalls.length, 1);
    assert.strictEqual(showMessageBoxCalls[0].options.type, "question");
  } finally {
    global.setImmediate = originalSetImmediate;
  }
});

test("Codex Pet import dialog uses zh-TW strings", async () => {
  const { runtime, showMessageBoxCalls } = createQueueRuntime({
    runtimeOptions: {
      getLang: () => "zh-TW",
    },
  });

  runtime.enqueueImportUrl("clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json");
  await runtime.flushPendingImportUrls();

  assert.strictEqual(showMessageBoxCalls.length, 1);
  assert.deepStrictEqual(showMessageBoxCalls[0].options.buttons, ["匯入", "取消"]);
  assert.strictEqual(showMessageBoxCalls[0].options.message, "從 example.test 匯入 Codex Pet？");
  assert.match(showMessageBoxCalls[0].options.detail, /下載、驗證並安裝/);
});

test("Codex Pet removal confirmation uses zh-TW strings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-pet-main-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const petsRoot = path.join(root, "pets");
  const themesRoot = path.join(root, "themes");
  const packageDir = path.join(petsRoot, "pet-one");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(path.join(themesRoot, "codex-pet-one"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "pet.json"), "{}");

  const showMessageBoxCalls = [];
  const runtime = createCodexPetMain({
    app: {
      getPath: () => root,
      isReady: () => false,
    },
    dialog: {
      async showMessageBox(parent, options) {
        showMessageBoxCalls.push({ parent, options });
        return { response: 1 };
      },
    },
    shell: {},
    settingsController: {
      get: () => "clawd",
    },
    themeLoader: {
      ensureUserThemesDir: () => themesRoot,
      getThemeMetadata: () => ({ name: "小貓" }),
    },
    codexPetAdapter: {
      readManagedMarker: () => ({
        sourcePetId: "pet-one",
        sourcePackagePath: packageDir,
      }),
      syncCodexPetThemes: () => ({ themes: [] }),
    },
    codexPetImporter: {
      getDefaultCodexPetsDir: () => petsRoot,
    },
    getLang: () => "zh-TW",
  });

  assert.deepStrictEqual(await runtime.removeCodexPet("codex-pet-one"), { status: "cancel" });

  assert.strictEqual(showMessageBoxCalls.length, 1);
  assert.deepStrictEqual(showMessageBoxCalls[0].options.buttons, ["解除安裝", "取消"]);
  assert.strictEqual(showMessageBoxCalls[0].options.message, "解除安裝匯入的寵物「小貓」？");
  assert.match(showMessageBoxCalls[0].options.detail, /無法復原/);
});

test("Codex Pet import queue ignores overlapping flush calls while the first drain is active", async () => {
  let releaseFirstImport;
  let firstImportStarted;
  const firstImportStartedPromise = new Promise((resolve) => {
    firstImportStarted = resolve;
  });
  const importCalls = [];
  const { runtime, parseCalls } = createQueueRuntime({
    dialog: {
      async showMessageBox() {
        return { response: 0 };
      },
    },
    codexPetAdapter: {
      syncCodexPetThemes: () => ({
        themes: [
          { themeId: "codex-pet-one", packageDir: "pkg-1" },
          { themeId: "codex-pet-two", packageDir: "pkg-2" },
        ],
      }),
    },
    codexPetImporter: {
      async importCodexPetFromUrl(url) {
        importCalls.push(url);
        if (importCalls.length === 1) {
          firstImportStarted();
          await new Promise((resolve) => {
            releaseFirstImport = resolve;
          });
          return { packageDir: "pkg-1", packageInfo: { id: "one", displayName: "One" } };
        }
        return { packageDir: "pkg-2", packageInfo: { id: "two", displayName: "Two" } };
      },
    },
  });

  runtime.enqueueImportUrl("clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fone.json");
  runtime.enqueueImportUrl("clawd://import-pet?url=https%3A%2F%2Fexample.test%2Ftwo.json");

  const firstFlush = runtime.flushPendingImportUrls();
  await firstImportStartedPromise;
  const secondFlush = runtime.flushPendingImportUrls();
  await secondFlush;

  assert.deepStrictEqual(parseCalls, ["clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fone.json"]);
  assert.strictEqual(importCalls.length, 1);

  releaseFirstImport();
  await firstFlush;

  assert.deepStrictEqual(parseCalls, [
    "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fone.json",
    "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Ftwo.json",
  ]);
  assert.strictEqual(importCalls.length, 2);
});
