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

function makeLatestReleaseResponse(release) {
  return (options, cb) => {
    const res = {
      statusCode: 200,
      on(event, handler) {
        if (event === "data") handler(Buffer.from(JSON.stringify(release)));
        if (event === "end") handler();
        return this;
      },
    };
    cb(res);
    return { on() { return this; }, setTimeout() {} };
  };
}

function makePendingReleaseResponse(queue) {
  return (options, cb) => {
    queue.push((release) => {
      const res = {
        statusCode: 200,
        on(event, handler) {
          if (event === "data") handler(Buffer.from(JSON.stringify(release)));
          if (event === "end") handler();
          return this;
        },
      };
      cb(res);
    });
    return { on() { return this; }, setTimeout() {} };
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

  it("does not flash available overlay for non-manual checks during mini mode", async () => {
    const visualStates = [];
    const bubbles = [];
    const handlers = {};
    let hideCount = 0;
    let overlayState = null;
    const ctx = makeCtx({
      miniMode: true,
      setUpdateVisualState: (state) => {
        visualStates.push(state);
        overlayState = state;
      },
      resolveDisplayState: () => overlayState === "checking" ? "thinking" : (overlayState || "idle"),
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        return payload.defaultAction || null;
      },
      hideUpdateBubble: () => { hideCount += 1; },
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
    await updater.checkForUpdates(false);
    await handlers["update-available"]({ version: "0.5.11" });

    assert.deepStrictEqual(visualStates, ["checking", null]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking"]);
    assert.strictEqual(hideCount, 1);
  });

  it("rebuilds git-mode menus after silent available check returns to idle", async () => {
    const visualStates = [];
    const bubbles = [];
    const menuLabels = [];
    let hideCount = 0;
    let overlayState = null;
    let updater;
    const ctx = makeCtx({
      miniMode: true,
      rebuildAllMenus: () => {
        if (updater) menuLabels.push(updater.getUpdateMenuLabel());
      },
      setUpdateVisualState: (state) => {
        visualStates.push(state);
        overlayState = state;
      },
      resolveDisplayState: () => overlayState === "checking" ? "thinking" : (overlayState || "idle"),
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        return payload.defaultAction || null;
      },
      hideUpdateBubble: () => { hideCount += 1; },
    });
    const stdoutByArgs = new Map([
      ["rev-parse --abbrev-ref HEAD", "main"],
      ["fetch origin main", ""],
      ["rev-parse HEAD", "aaaaaaaa"],
      ["rev-parse origin/main", "bbbbbbbb"],
      ["show origin/main:package.json", JSON.stringify({ version: "0.5.11" })],
    ]);
    updater = initUpdater(ctx, makeDeps({
      app: {
        isPackaged: false,
        getVersion: () => "0.5.10",
        relaunch() {},
        exit() {},
      },
      fsImpl: {
        statSync: () => ({ isDirectory: () => true }),
      },
      execFileImpl: (_cmd, args, _options, cb) => {
        const key = args.join(" ");
        process.nextTick(() => cb(null, stdoutByArgs.get(key) || ""));
      },
    }));

    await updater.checkForUpdates(false);

    assert.deepStrictEqual(visualStates, ["checking", null]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking"]);
    assert.strictEqual(hideCount, 1);
    assert.strictEqual(menuLabels[menuLabels.length - 1], "Check for Updates");
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

  it("prompts x64 Windows-on-ARM users to download the native ARM64 installer", async () => {
    const bubbles = [];
    const openedUrls = [];
    let autoUpdateChecks = 0;
    const ctx = makeCtx({
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        if (payload.mode === "available") return "primary";
        if (payload.mode === "ready") return "dismiss";
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      platform: "win32",
      arch: "x64",
      app: {
        isPackaged: true,
        runningUnderARM64Translation: true,
        getVersion: () => "0.6.1",
        relaunch() {},
        exit() {},
      },
      shell: {
        openExternal(url) {
          openedUrls.push(url);
        },
      },
      autoUpdaterFactory: () => ({
        autoDownload: false,
        autoInstallOnAppQuit: true,
        on() {},
        checkForUpdates: async () => {
          autoUpdateChecks += 1;
          return null;
        },
        quitAndInstall() {},
        downloadUpdate() {},
      }),
      httpsGetImpl: makeLatestReleaseResponse({
        tag_name: "v0.6.1",
        assets: [
          {
            name: "Clawd-on-Desk-Setup-0.6.1-x64.exe",
            browser_download_url: "https://example.invalid/x64.exe",
          },
          {
            name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe",
            browser_download_url: "https://example.invalid/arm64.exe",
          },
        ],
      }),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available", "ready"]);
    assert.match(bubbles[1].title, /ARM64/);
    assert.match(bubbles[1].message, /native Windows ARM64 installer/i);
    assert.match(bubbles[1].message, /Clawd v0\.6\.1/);
    assert.doesNotMatch(bubbles[1].message, /vv0\.6\.1/);
    assert.strictEqual(openedUrls[0], "https://example.invalid/arm64.exe");
    assert.strictEqual(autoUpdateChecks, 0);
  });

  it("falls back to normal up-to-date handling when no ARM64 installer asset exists", async () => {
    const bubbles = [];
    const ctx = makeCtx({
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      platform: "win32",
      arch: "x64",
      app: {
        isPackaged: true,
        runningUnderARM64Translation: true,
        getVersion: () => "0.6.1",
        relaunch() {},
        exit() {},
      },
      httpsGetImpl: makeLatestReleaseResponse({
        tag_name: "v0.6.1",
        assets: [
          {
            name: "Clawd-on-Desk-Setup-0.6.1-x64.exe",
            browser_download_url: "https://example.invalid/x64.exe",
          },
        ],
      }),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "up-to-date"]);
  });

  it("auto-prompts translated x64 Windows-on-ARM users during updater setup", async () => {
    const bubbles = [];
    const ctx = makeCtx({
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        return "later";
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      platform: "win32",
      arch: "x64",
      app: {
        isPackaged: true,
        runningUnderARM64Translation: true,
        getVersion: () => "0.6.1",
        relaunch() {},
        exit() {},
      },
      httpsGetImpl: makeLatestReleaseResponse({
        tag_name: "v0.6.1",
        assets: [
          {
            name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe",
            browser_download_url: "https://example.invalid/arm64.exe",
          },
        ],
      }),
    }));

    updater.setupAutoUpdater();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["available"]);
  });

  it("does not let the startup ARM64 prompt overwrite an active manual update check", async () => {
    const bubbles = [];
    const pendingResponses = [];
    const ctx = makeCtx({
      showUpdateBubble: async (payload) => {
        bubbles.push(payload);
        return payload.defaultAction || null;
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      platform: "win32",
      arch: "x64",
      app: {
        isPackaged: true,
        runningUnderARM64Translation: true,
        getVersion: () => "0.6.1",
        relaunch() {},
        exit() {},
      },
      httpsGetImpl: makePendingReleaseResponse(pendingResponses),
    }));

    updater.setupAutoUpdater();
    await Promise.resolve();
    assert.strictEqual(pendingResponses.length, 1);

    const manualCheck = updater.checkForUpdates(true);
    await Promise.resolve();
    assert.strictEqual(pendingResponses.length, 2);

    pendingResponses[0]({
      tag_name: "v0.6.1",
      assets: [
        {
          name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe",
          browser_download_url: "https://example.invalid/arm64.exe",
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking"]);

    pendingResponses[1]({
      tag_name: "v0.6.1",
      assets: [
        {
          name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe",
          browser_download_url: "https://example.invalid/arm64.exe",
        },
      ],
    });
    await manualCheck;

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available"]);
  });

  it("does not let a visible startup ARM64 prompt clear a later manual update check", async () => {
    const bubbles = [];
    const visualStates = [];
    const pendingResponses = [];
    let activeAction = null;
    let activePayload = null;
    let hideCount = 0;
    const ctx = makeCtx({
      setUpdateVisualState: (state) => visualStates.push(state),
      hideUpdateBubble: () => { hideCount += 1; },
      showUpdateBubble: (payload) => {
        if (activeAction) {
          const fallback = activePayload && activePayload.defaultAction != null
            ? activePayload.defaultAction
            : null;
          const resolve = activeAction;
          activeAction = null;
          activePayload = null;
          resolve(fallback);
        }
        bubbles.push(payload);
        if (!payload.requireAction) {
          return Promise.resolve(payload.defaultAction != null ? payload.defaultAction : null);
        }
        activePayload = payload;
        return new Promise((resolve) => {
          activeAction = resolve;
        });
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      platform: "win32",
      arch: "x64",
      app: {
        isPackaged: true,
        runningUnderARM64Translation: true,
        getVersion: () => "0.6.1",
        relaunch() {},
        exit() {},
      },
      httpsGetImpl: makePendingReleaseResponse(pendingResponses),
    }));

    updater.setupAutoUpdater();
    await Promise.resolve();
    pendingResponses[0]({
      tag_name: "v0.6.1",
      assets: [
        {
          name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe",
          browser_download_url: "https://example.invalid/arm64.exe",
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["available"]);
    assert.deepStrictEqual(visualStates, ["available"]);

    const manualCheck = updater.checkForUpdates(true);
    await Promise.resolve();
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["available", "checking"]);
    assert.deepStrictEqual(visualStates, ["available", "checking"]);
    assert.strictEqual(hideCount, 0);
    assert.strictEqual(pendingResponses.length, 2);

    pendingResponses[1]({
      tag_name: "v0.6.1",
      assets: [
        {
          name: "Clawd-on-Desk-Setup-0.6.1-x64.exe",
          browser_download_url: "https://example.invalid/x64.exe",
        },
      ],
    });
    await manualCheck;

    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["available", "checking", "up-to-date"]);
    assert.deepStrictEqual(visualStates, ["available", "checking", null]);
    assert.strictEqual(hideCount, 0);
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

describe("updater Windows ARM64 migration helpers", () => {
  beforeEach(() => {
    mock.restoreAll();
    delete require.cache[require.resolve("../src/updater")];
    initUpdater = require("../src/updater");
  });

  it("detects only packaged Windows x64 apps running under ARM64 translation", () => {
    const { shouldPromptNativeArm64 } = initUpdater.__test;

    assert.strictEqual(shouldPromptNativeArm64({
      platform: "win32",
      arch: "x64",
      isPackaged: true,
      runningUnderARM64Translation: true,
    }), true);
    assert.strictEqual(shouldPromptNativeArm64({
      platform: "win32",
      arch: "arm64",
      isPackaged: true,
      runningUnderARM64Translation: false,
    }), false);
    assert.strictEqual(shouldPromptNativeArm64({
      platform: "darwin",
      arch: "x64",
      isPackaged: true,
      runningUnderARM64Translation: true,
    }), false);
    assert.strictEqual(shouldPromptNativeArm64({
      platform: "win32",
      arch: "x64",
      isPackaged: false,
      runningUnderARM64Translation: true,
    }), false);
  });

  it("formats release tags for messages with a single hard-coded v prefix", () => {
    const { formatVersionForMessage } = initUpdater.__test;

    assert.strictEqual(formatVersionForMessage("v0.6.1"), "0.6.1");
    assert.strictEqual(formatVersionForMessage("0.6.1"), "0.6.1");
  });

  it("finds Windows ARM64 installer assets without matching blockmaps", () => {
    const { findWindowsArm64InstallerAsset } = initUpdater.__test;
    const asset = findWindowsArm64InstallerAsset({
      assets: [
        { name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe.blockmap", browser_download_url: "blockmap" },
        { name: "Clawd-on-Desk-Setup-0.6.1-x64.exe", browser_download_url: "x64" },
        { name: "Clawd-on-Desk-Setup-0.6.1-arm64.exe", browser_download_url: "arm64" },
      ],
    });

    assert.strictEqual(asset.browser_download_url, "arm64");
  });
});
