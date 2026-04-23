const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert");

let initUpdater = require("../src/updater");

function makeCtx(overrides = {}) {
  return {
    doNotDisturb: false,
    miniMode: false,
    rebuildAllMenus() {},
    updateLog() {},
    t: (k) => k,
    showUpdateBubble() {},
    hideUpdateBubble() {},
    setUpdateVisualState() {},
    applyState() {},
    resolveDisplayState: () => "idle",
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const app = {
    isPackaged: true,
    getVersion: () => "0.5.10",
    relaunch() {},
    exit() {},
  };
  return {
    app,
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
    },
    shell: {
      openExternal() {},
    },
    Notification: class {
      constructor() {}
      show() {}
    },
    httpsGetImpl: null,
    execFileImpl: null,
    fsImpl: null,
    autoUpdaterFactory: () => ({
      autoDownload: false,
      autoInstallOnAppQuit: true,
      on() {},
      checkForUpdates: async () => null,
      quitAndInstall() {},
      downloadUpdate() {},
    }),
    ...overrides,
  };
}

describe("updater visual flow", () => {
  beforeEach(() => {
    mock.restoreAll();
    delete require.cache[require.resolve("../src/updater")];
    initUpdater = require("../src/updater");
  });

  it("shows checking state and up-to-date bubble when latest version matches", async () => {
    const visualStates = [];
    const bubbles = [];
    const applied = [];
    let overlayState = null;
    const ctx = makeCtx({
      setUpdateVisualState: (state) => {
        visualStates.push(state);
        overlayState = state;
      },
      applyState: (state, svgOverride) => applied.push({ state, svgOverride }),
      resolveDisplayState: () => overlayState === "checking" ? "thinking" : (overlayState ? "notification" : "idle"),
      getSvgOverride: (state) => state === "thinking" ? "clawd-working-debugger.svg" : null,
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: (options, cb) => {
        const res = {
          statusCode: 200,
          on(event, handler) {
            if (event === "data") handler(Buffer.from(JSON.stringify({ tag_name: "v0.5.10" })));
            if (event === "end") handler();
            return this;
          },
        };
        cb(res);
        return { on() { return this; }, setTimeout() {} };
      },
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(visualStates, ["checking", null]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "up-to-date"]);
    assert.ok(
      applied.some((entry) => entry.state === "thinking" && entry.svgOverride === "clawd-working-debugger.svg")
    );
  });

  it("does not assume a clawd-specific checking override when the current theme has none", async () => {
    const visualStates = [];
    const bubbles = [];
    const applied = [];
    let overlayState = null;
    const ctx = makeCtx({
      setUpdateVisualState: (state) => {
        visualStates.push(state);
        overlayState = state;
      },
      applyState: (state, svgOverride) => applied.push({ state, svgOverride }),
      resolveDisplayState: () => overlayState === "checking" ? "thinking" : (overlayState ? "notification" : "idle"),
      getSvgOverride: () => null,
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: (options, cb) => {
        const res = {
          statusCode: 200,
          on(event, handler) {
            if (event === "data") handler(Buffer.from(JSON.stringify({ tag_name: "v0.5.10" })));
            if (event === "end") handler();
            return this;
          },
        };
        cb(res);
        return { on() { return this; }, setTimeout() {} };
      },
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(visualStates, ["checking", null]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "up-to-date"]);
    assert.ok(
      applied.some((entry) => entry.state === "thinking" && entry.svgOverride == null)
    );
  });

  it("switches to available -> notification when a newer packaged release is found", async () => {
    const visualStates = [];
    const bubbles = [];
    const applied = [];
    let overlayState = null;
    const handlers = {};
    const ctx = makeCtx({
      setUpdateVisualState: (state) => {
        visualStates.push(state);
        overlayState = state;
      },
      applyState: (state, svgOverride) => applied.push({ state, svgOverride }),
      resolveDisplayState: () => {
        if (overlayState === "checking") return "thinking";
        if (overlayState === "available") return "notification";
        return overlayState || "idle";
      },
      getSvgOverride: (state) => state === "thinking" ? "clawd-working-debugger.svg" : null,
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        if (payload.mode === "available") return "later";
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      autoUpdaterFactory: () => ({
        autoDownload: false,
        autoInstallOnAppQuit: true,
        on(event, handler) { handlers[event] = handler; },
        checkForUpdates: async () => ({ updateInfo: { version: "0.5.11" } }),
        quitAndInstall() {},
        downloadUpdate() {},
      }),
      httpsGetImpl: (options, cb) => {
        const res = {
          statusCode: 200,
          on(event, handler) {
            if (event === "data") handler(Buffer.from(JSON.stringify({ tag_name: "v0.5.11" })));
            if (event === "end") handler();
            return this;
          },
        };
        cb(res);
        return { on() { return this; }, setTimeout() {} };
      },
    }));

    updater.setupAutoUpdater();
    await updater.checkForUpdates(true);
    await handlers["update-available"]({ version: "0.5.11" });

    assert.deepStrictEqual(visualStates, ["checking", "available", null]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available"]);
    assert.ok(applied.some((entry) => entry.state === "thinking" && entry.svgOverride === "clawd-working-debugger.svg"));
    assert.ok(applied.some((entry) => entry.state === "notification" && entry.svgOverride == null));
  });

  it("shows error state and detail bubble when GitHub API check fails", async () => {
    const visualStates = [];
    const appliedStates = [];
    const bubbles = [];
    const ctx = makeCtx({
      setUpdateVisualState: (state) => visualStates.push(state),
      applyState: (state) => appliedStates.push(state),
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: () => {
        const req = {
          on(event, handler) {
            if (event === "error") {
              process.nextTick(() => handler(new Error("network down")));
            }
            return this;
          },
          setTimeout() {},
        };
        return req;
      },
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(visualStates, ["checking", null]);
    assert.ok(appliedStates.includes("error"));
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "error"]);
    assert.match(bubbles[1].detail, /Operation: Check for Updates/);
    assert.match(bubbles[1].detail, /Reason: network down/);
    assert.match(bubbles[1].detail, /network down/);
  });

  it("shows a real error bubble when packaged download fails after user starts it", async () => {
    const bubbles = [];
    const handlers = {};
    const ctx = makeCtx({
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        if (payload.mode === "available") return "primary";
        if (payload.mode === "error") return "dismiss";
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      autoUpdaterFactory: () => ({
        autoDownload: false,
        autoInstallOnAppQuit: true,
        on(event, handler) { handlers[event] = handler; },
        checkForUpdates: async () => ({ updateInfo: { version: "0.5.11" } }),
        quitAndInstall() {},
        downloadUpdate() {
          return Promise.resolve().then(() => handlers.error(new Error("download exploded")));
        },
      }),
      httpsGetImpl: (options, cb) => {
        const res = {
          statusCode: 200,
          on(event, handler) {
            if (event === "data") handler(Buffer.from(JSON.stringify({ tag_name: "v0.5.11" })));
            if (event === "end") handler();
            return this;
          },
        };
        cb(res);
        return { on() { return this; }, setTimeout() {} };
      },
    }));

    updater.setupAutoUpdater();
    await updater.checkForUpdates(true);
    await handlers["update-available"]({ version: "0.5.11" });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available", "downloading", "error"]);
    assert.match(bubbles[3].detail, /download exploded/);
  });

  it("uses the macOS packaged-update path by opening the releases page and showing a success bubble", async () => {
    const originalPlatform = process.platform;
    const bubbles = [];
    const handlers = {};
    const openedUrls = [];
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      delete require.cache[require.resolve("../src/updater")];
      initUpdater = require("../src/updater");
      const ctx = makeCtx({
        showUpdateBubble: async (payload) => {
          bubbles.push(payload);
          if (payload.mode === "available") return "primary";
          if (payload.mode === "ready") return "dismiss";
          return payload.defaultAction || null;
        },
      });
      const updater = initUpdater(ctx, makeDeps({
        shell: {
          openExternal(url) {
            openedUrls.push(url);
          },
        },
        autoUpdaterFactory: () => ({
          autoDownload: false,
          autoInstallOnAppQuit: true,
          on(event, handler) { handlers[event] = handler; },
          checkForUpdates: async () => ({ updateInfo: { version: "0.5.11" } }),
          quitAndInstall() {},
          downloadUpdate() {
            throw new Error("downloadUpdate should not run on macOS");
          },
        }),
        httpsGetImpl: (options, cb) => {
          const res = {
            statusCode: 200,
            on(event, handler) {
              if (event === "data") handler(Buffer.from(JSON.stringify({ tag_name: "v0.5.11" })));
              if (event === "end") handler();
              return this;
            },
          };
          cb(res);
          return { on() { return this; }, setTimeout() {} };
        },
      }));

      updater.setupAutoUpdater();
      await updater.checkForUpdates(true);
      await handlers["update-available"]({ version: "0.5.11" });

      assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available", "ready"]);
      assert.strictEqual(openedUrls[0], "https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest");
      assert.match(bubbles[2].message, /opened/i);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("uses a friendly dirty-worktree message while keeping detailed file status", async () => {
    const bubbles = [];
    const ctx = makeCtx({
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        if (payload.mode === "available") return "primary";
        if (payload.mode === "error") return "dismiss";
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: {
        isPackaged: false,
        getVersion: () => "0.5.10",
        relaunch() {},
        exit() {},
      },
      fsImpl: {
        statSync(file) {
          if (String(file).endsWith("\\.git") || String(file).endsWith("/.git")) {
            return { isDirectory: () => true };
          }
          throw new Error("unexpected stat");
        },
      },
      execFileImpl(command, args, options, callback) {
        const key = `${command} ${args.join(" ")}`;
        if (key === "git rev-parse --abbrev-ref HEAD") return callback(null, "main");
        if (key === "git fetch origin main") return callback(null, "");
        if (key === "git rev-parse HEAD") return callback(null, "localsha");
        if (key === "git rev-parse origin/main") return callback(null, "remotesha");
        if (key === "git show origin/main:package.json") return callback(null, JSON.stringify({ version: "0.5.11" }));
        if (key === "git status --porcelain") return callback(null, "M package-lock.json\nM src/main.js");
        return callback(new Error(`unexpected command: ${key}`));
      },
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available", "error"]);
    assert.match(bubbles[2].message, /modified|commit|stash/i);
    assert.match(bubbles[2].detail, /Failure Type: Dirty Worktree/i);
    assert.match(bubbles[2].detail, /Operation: Apply Git Update/i);
    assert.match(bubbles[2].detail, /package-lock\.json/);
  });

  it("pulses attention on packaged update download completion so the success sound path runs", async () => {
    const appliedStates = [];
    let resetSoundCooldownCalls = 0;
    const handlers = {};
    const ctx = makeCtx({
      resetSoundCooldown: () => { resetSoundCooldownCalls++; },
      applyState: (state) => appliedStates.push(state),
      showUpdateBubble: async (payload) => {
        if (payload.mode === "ready") return "later";
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      autoUpdaterFactory: () => ({
        autoDownload: false,
        autoInstallOnAppQuit: true,
        on(event, handler) { handlers[event] = handler; },
        checkForUpdates: async () => null,
        quitAndInstall() {},
        downloadUpdate() {},
      }),
    }));

    updater.setupAutoUpdater();
    await handlers["update-downloaded"]({ version: "0.5.11" });

    assert.strictEqual(resetSoundCooldownCalls, 1);
    assert.ok(appliedStates.includes("attention"));
  });
});
