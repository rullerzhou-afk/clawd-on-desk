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

function makeHttpResponse({ statusCode, headers = {}, body = "" }) {
  return {
    statusCode,
    headers,
    on(event, handler) {
      if (event === "data" && body) {
        process.nextTick(() => handler(Buffer.from(body)));
      }
      if (event === "end") process.nextTick(() => handler());
      return this;
    },
    resume() {},
  };
}

function makeSequencedHttpsGet(responses, requests = []) {
  const queue = [...responses];
  return (options, cb) => {
    requests.push(`${options.hostname}${options.path}`);
    const next = queue.shift();
    if (next instanceof Error) {
      return {
        on(event, handler) {
          if (event === "error") process.nextTick(() => handler(next));
          return this;
        },
        setTimeout() {},
      };
    }
    cb(makeHttpResponse(next));
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
    const requests = [];
    const ctx = makeCtx({
      setUpdateVisualState: (state) => visualStates.push(state),
      applyState: (state) => appliedStates.push(state),
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: makeSequencedHttpsGet([new Error("network down")], requests),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(visualStates, ["checking", null]);
    assert.ok(appliedStates.includes("error"));
    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "error"]);
    assert.match(bubbles[1].detail, /Operation: Check for Updates/);
    assert.match(bubbles[1].detail, /Reason: network down/);
    assert.match(bubbles[1].detail, /network down/);
  });

  it("falls back to releases/latest redirect when GitHub API is rate-limited", async () => {
    const bubbles = [];
    const requests = [];
    const ctx = makeCtx({
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: makeSequencedHttpsGet([
        {
          statusCode: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-limit": "60",
          },
          body: JSON.stringify({ message: "API rate limit exceeded" }),
        },
        {
          statusCode: 302,
          headers: {
            location: "https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/v0.5.10",
          },
        },
      ], requests),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
      "github.com/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "up-to-date"]);
  });

  it("continues into electron-updater when redirect fallback finds a newer version", async () => {
    const bubbles = [];
    const requests = [];
    const handlers = {};
    let updateChecks = 0;
    const ctx = makeCtx({
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
        checkForUpdates: async () => {
          updateChecks += 1;
          return { updateInfo: { version: "0.5.11" } };
        },
        quitAndInstall() {},
        downloadUpdate() {},
      }),
      httpsGetImpl: makeSequencedHttpsGet([
        {
          statusCode: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" },
          body: JSON.stringify({ message: "API rate limit exceeded" }),
        },
        {
          statusCode: 302,
          headers: {
            location: "https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/v0.5.11",
          },
        },
      ], requests),
    }));

    updater.setupAutoUpdater();
    await updater.checkForUpdates(true);
    await handlers["update-available"]({ version: "0.5.11" });

    assert.strictEqual(updateChecks, 1);
    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
      "github.com/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "available"]);
  });

  it("shows an error when the GitHub API and redirect fallback both fail", async () => {
    const bubbles = [];
    const requests = [];
    const ctx = makeCtx({
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: makeSequencedHttpsGet([
        {
          statusCode: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" },
          body: JSON.stringify({ message: "API rate limit exceeded" }),
        },
        {
          statusCode: 200,
          headers: {},
          body: "<html>no redirect</html>",
        },
      ], requests),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
      "github.com/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "error"]);
    assert.match(bubbles[1].detail, /GitHub releases redirect returned 200/);
  });

  it("does not fallback when GitHub reports that no releases exist", async () => {
    const bubbles = [];
    const requests = [];
    const ctx = makeCtx({
      showUpdateBubble: (payload) => bubbles.push(payload),
    });
    const updater = initUpdater(ctx, makeDeps({
      httpsGetImpl: makeSequencedHttpsGet([
        { statusCode: 404, headers: {} },
      ], requests),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "error"]);
    assert.match(bubbles[1].detail, /Reason: No releases found/);
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
      platform: "win32",
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

  it("lets Windows-on-ARM64 fall back to the normal updater when redirect fallback has no asset metadata", async () => {
    const bubbles = [];
    const requests = [];
    const openedUrls = [];
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
      shell: {
        openExternal(url) {
          openedUrls.push(url);
        },
      },
      httpsGetImpl: makeSequencedHttpsGet([
        {
          statusCode: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" },
          body: JSON.stringify({ message: "API rate limit exceeded" }),
        },
        {
          statusCode: 302,
          headers: {
            location: "https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/v0.6.1",
          },
        },
      ], requests),
    }));

    await updater.checkForUpdates(true);

    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
      "github.com/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(openedUrls, []);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking", "up-to-date"]);
  });

  it("lets Windows-on-ARM64 use the normal updater for newer redirect fallback releases without asset metadata", async () => {
    const bubbles = [];
    const requests = [];
    const openedUrls = [];
    let updateChecks = 0;
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
        getVersion: () => "0.6.0",
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
          updateChecks += 1;
          return { updateInfo: { version: "0.6.1" } };
        },
        quitAndInstall() {},
        downloadUpdate() {},
      }),
      httpsGetImpl: makeSequencedHttpsGet([
        {
          statusCode: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" },
          body: JSON.stringify({ message: "API rate limit exceeded" }),
        },
        {
          statusCode: 302,
          headers: {
            location: "https://github.com/rullerzhou-afk/clawd-on-desk/releases/tag/v0.6.1",
          },
        },
      ], requests),
    }));

    await updater.checkForUpdates(true);

    assert.strictEqual(updateChecks, 1);
    assert.deepStrictEqual(requests, [
      "api.github.com/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
      "github.com/rullerzhou-afk/clawd-on-desk/releases/latest",
    ]);
    assert.deepStrictEqual(openedUrls, []);
    assert.deepStrictEqual(bubbles.map((bubble) => bubble.mode), ["checking"]);
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

// ──────────────────────────────────────────────────────────────────────
// #329 background update scheduler coverage
//
// Exercises: quietDiscover() purity, scheduler guards (!isPackaged, git
// checkout, autoUpdateCheck off), source-tagged dedupe (user vs
// autoClose vs policy), DND/mini deferral, intent='download' round-trip
// auto-primary, ETag caching, and startup pending reconciliation.
// ──────────────────────────────────────────────────────────────────────
describe("updater #329 background scheduler", () => {
  beforeEach(() => {
    mock.restoreAll();
    delete require.cache[require.resolve("../src/updater")];
    initUpdater = require("../src/updater");
  });

  // Tiny in-memory prefs store. Mirrors the controller API surface the
  // updater touches (get / applyUpdate via setUpdatePref shim).
  function makePrefs(initial = {}) {
    const store = { autoUpdateCheck: true, pendingUpdateVersion: "", dismissedUpdateVersions: {}, ...initial };
    return {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
      snapshot: () => ({ ...store }),
    };
  }

  function makeCtxWithPrefs(prefs, overrides = {}) {
    return makeCtx({
      getUpdatePref: (k) => prefs.get(k),
      setUpdatePref: (k, v) => prefs.set(k, v),
      ...overrides,
    });
  }

  it("quietDiscover() does not touch any UI surface", async () => {
    const visualStates = [];
    const bubbles = [];
    const applied = [];
    const ctx = makeCtxWithPrefs(makePrefs(), {
      setUpdateVisualState: (s) => visualStates.push(s),
      applyState: (s) => applied.push(s),
      showUpdateBubble: (p) => bubbles.push(p),
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      httpsGetImpl: makeLatestReleaseResponse({ tag_name: "v0.9.0", assets: [] }),
    }));

    const result = await updater.quietDiscover();
    assert.strictEqual(result.status, "new-update");
    assert.strictEqual(result.version, "v0.9.0");
    assert.deepStrictEqual(visualStates, []);
    assert.deepStrictEqual(applied, []);
    assert.deepStrictEqual(bubbles, []);
  });

  it("quietDiscover() returns no-update when running version is newer", async () => {
    const ctx = makeCtxWithPrefs(makePrefs());
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.9.0", relaunch() {}, exit() {} },
      httpsGetImpl: makeLatestReleaseResponse({ tag_name: "v0.8.0", assets: [] }),
    }));
    const result = await updater.quietDiscover();
    assert.strictEqual(result.status, "no-update");
  });

  it("startUpdateScheduler() skips when !app.isPackaged", () => {
    const ctx = makeCtxWithPrefs(makePrefs());
    const setTimeoutCalls = [];
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: false, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      setTimeoutImpl: (fn, ms) => { setTimeoutCalls.push(ms); return { id: 1 }; },
    }));
    updater.startUpdateScheduler();
    assert.strictEqual(updater.isSchedulerRunning(), false);
    assert.strictEqual(setTimeoutCalls.length, 0);
  });

  it("startUpdateScheduler() skips when getRepoRoot() finds a git checkout", () => {
    const ctx = makeCtxWithPrefs(makePrefs());
    const setTimeoutCalls = [];
    // Packaged build but pretend there's a .git dir adjacent (defensive guard).
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: false, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      fsImpl: { statSync: () => ({ isDirectory: () => true }) },
      setTimeoutImpl: (fn, ms) => { setTimeoutCalls.push(ms); return { id: 1 }; },
    }));
    updater.startUpdateScheduler();
    assert.strictEqual(updater.isSchedulerRunning(), false);
    assert.strictEqual(setTimeoutCalls.length, 0);
  });

  it("startUpdateScheduler() skips when autoUpdateCheck pref is false", () => {
    const prefs = makePrefs({ autoUpdateCheck: false });
    const ctx = makeCtxWithPrefs(prefs);
    const setTimeoutCalls = [];
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      setTimeoutImpl: (fn, ms) => { setTimeoutCalls.push(ms); return { id: 1 }; },
    }));
    updater.startUpdateScheduler();
    assert.strictEqual(updater.isSchedulerRunning(), false);
    assert.strictEqual(setTimeoutCalls.length, 0);
  });

  it("startUpdateScheduler() first-delay is in [2,5] minutes", () => {
    const ctx = makeCtxWithPrefs(makePrefs());
    const setTimeoutCalls = [];
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      setTimeoutImpl: (fn, ms) => { setTimeoutCalls.push(ms); return { id: 1 }; },
      randomImpl: () => 0,  // min boundary
    }));
    updater.startUpdateScheduler();
    assert.strictEqual(setTimeoutCalls.length, 1);
    assert.ok(setTimeoutCalls[0] >= 2 * 60 * 1000, `first delay too short: ${setTimeoutCalls[0]}`);
    assert.ok(setTimeoutCalls[0] <= 5 * 60 * 1000, `first delay too long: ${setTimeoutCalls[0]}`);

    delete require.cache[require.resolve("../src/updater")];
    initUpdater = require("../src/updater");
    const setTimeoutCalls2 = [];
    const updater2 = initUpdater(makeCtxWithPrefs(makePrefs()), makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      setTimeoutImpl: (fn, ms) => { setTimeoutCalls2.push(ms); return { id: 2 }; },
      randomImpl: () => 0.999999,  // max boundary
    }));
    updater2.startUpdateScheduler();
    assert.ok(setTimeoutCalls2[0] >= 2 * 60 * 1000);
    assert.ok(setTimeoutCalls2[0] <= 5 * 60 * 1000);
  });

  it("startUpdateScheduler() is idempotent under repeat calls", () => {
    const ctx = makeCtxWithPrefs(makePrefs());
    const setTimeoutCalls = [];
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      setTimeoutImpl: (fn, ms) => { setTimeoutCalls.push(ms); return { id: setTimeoutCalls.length }; },
    }));
    updater.startUpdateScheduler();
    updater.startUpdateScheduler();
    updater.startUpdateScheduler();
    assert.strictEqual(setTimeoutCalls.length, 1);
  });

  it("stopUpdateScheduler() cancels the pending timer", () => {
    const ctx = makeCtxWithPrefs(makePrefs());
    const cancelled = [];
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      setTimeoutImpl: () => ({ id: 1 }),
      clearTimeoutImpl: (t) => cancelled.push(t),
    }));
    updater.startUpdateScheduler();
    updater.stopUpdateScheduler();
    assert.strictEqual(updater.isSchedulerRunning(), false);
    assert.strictEqual(cancelled.length, 1);
  });

  it("handlePendingVersion: source=user later → dedupe entry; next call no bubble", async () => {
    const prefs = makePrefs();
    const bubbles = [];
    const ctx = makeCtxWithPrefs(prefs, {
      showUpdateBubble: (payload) => {
        bubbles.push(payload);
        if (!payload.requireAction) return Promise.resolve({ action: payload.defaultAction || null, source: "autoClose" });
        return Promise.resolve({ action: "later", source: "user" });
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));

    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.strictEqual(bubbles.length, 1);
    assert.deepStrictEqual(prefs.snapshot().dismissedUpdateVersions, { "v0.9.0": true });

    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.strictEqual(bubbles.length, 1);  // no second bubble
  });

  it("handlePendingVersion: source=autoClose later → NO dedupe entry", async () => {
    const prefs = makePrefs();
    const bubbles = [];
    const ctx = makeCtxWithPrefs(prefs, {
      showUpdateBubble: (payload) => {
        bubbles.push(payload);
        return Promise.resolve({ action: "later", source: "autoClose" });
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));

    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.deepStrictEqual(prefs.snapshot().dismissedUpdateVersions, {});
    // Pending version is still recorded so the menu badge can show.
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "v0.9.0");
  });

  it("formats pending update menu labels without duplicating the release tag v prefix", async () => {
    const prefs = makePrefs();
    const bubbles = [];
    const ctx = makeCtxWithPrefs(prefs, {
      t: (key) => key === "checkForUpdatesPending" ? "有新版本 · v{version}" : key,
      showUpdateBubble: (payload) => {
        bubbles.push(payload);
        return Promise.resolve({ action: "later", source: "autoClose" });
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));

    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });

    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "v0.9.0");
    assert.strictEqual(updater.getUpdateMenuLabel(), "有新版本 · v0.9.0");
    assert.doesNotMatch(updater.getUpdateMenuLabel(), /vv0\.9\.0/);
    assert.strictEqual(bubbles[0].version, "v0.9.0");
    assert.doesNotMatch(bubbles[0].message, /vv0\.9\.0/);
  });

  it("handlePendingVersion: source=policy later → NO dedupe entry", async () => {
    const prefs = makePrefs();
    const ctx = makeCtxWithPrefs(prefs, {
      showUpdateBubble: () => Promise.resolve({ action: "later", source: "policy" }),
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));
    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.deepStrictEqual(prefs.snapshot().dismissedUpdateVersions, {});
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "v0.9.0");
  });

  it("handlePendingVersion: silent mode defers, onSilentModeExit fires bubble", async () => {
    const prefs = makePrefs();
    const bubbles = [];
    const ctx = makeCtxWithPrefs(prefs, {
      doNotDisturb: true,
      showUpdateBubble: (payload) => {
        bubbles.push(payload);
        return Promise.resolve({ action: "later", source: "user" });
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));

    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.strictEqual(bubbles.length, 0);  // deferred, not shown
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "v0.9.0");

    ctx.doNotDisturb = false;
    updater.onSilentModeExit();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(bubbles.length, 1);
  });

  it("onSilentModeExit: still in mini after DND off → defers again, no premature bubble", async () => {
    const prefs = makePrefs();
    const bubbles = [];
    const ctx = makeCtxWithPrefs(prefs, {
      doNotDisturb: true,
      miniMode: true,
      showUpdateBubble: (payload) => {
        bubbles.push(payload);
        return Promise.resolve({ action: "later", source: "user" });
      },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));

    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.strictEqual(bubbles.length, 0);

    // DND off but mini still on — silent mode still active.
    ctx.doNotDisturb = false;
    updater.onSilentModeExit();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(bubbles.length, 0, "bubble should not fire while still in mini mode");

    // Now exit mini too — second silent-exit call fires the bubble.
    ctx.miniMode = false;
    updater.onSilentModeExit();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(bubbles.length, 1);
  });

  it("handlePendingVersion: already-dismissed version → no bubble but pending set", async () => {
    const prefs = makePrefs({ dismissedUpdateVersions: { "v0.9.0": true } });
    const bubbles = [];
    const ctx = makeCtxWithPrefs(prefs, {
      showUpdateBubble: (p) => { bubbles.push(p); return Promise.resolve({ action: "later", source: "user" }); },
    });
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
    }));
    await updater.handlePendingVersion("v0.9.0", { tag_name: "v0.9.0" }, { trigger: "scheduled" });
    assert.strictEqual(bubbles.length, 0);
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "v0.9.0");
  });

  it("download intent round-trip clears pendingUpdateVersion when latest is no longer newer", async () => {
    // Scenario: scheduler discovered v0.9.0, user clicked Download. The
    // manual round-trip with intent='download' hits GitHub and finds the
    // release got yanked (latest now older). Pending marker must be cleared
    // so the tray badge stops lying.
    const prefs = makePrefs({ pendingUpdateVersion: "v0.9.0" });
    const ctx = makeCtxWithPrefs(prefs);
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "1.0.0", relaunch() {}, exit() {} },
      httpsGetImpl: makeLatestReleaseResponse({ tag_name: "v0.5.0", assets: [] }),
    }));
    await updater.checkForUpdates({ trigger: "manual", intent: "download" });
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "");
  });

  it("reconcilePendingOnStartup: clears pending when current >= pending", () => {
    const prefs = makePrefs({ pendingUpdateVersion: "v0.7.0", dismissedUpdateVersions: { "v0.6.0": true, "v0.8.0": true } });
    const ctx = makeCtxWithPrefs(prefs);
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "v0.7.0", relaunch() {}, exit() {} },
    }));
    updater.reconcilePendingOnStartup();
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "");
    // v0.6.0 <= 0.7.0 dropped; v0.8.0 still pending so kept.
    assert.deepStrictEqual(prefs.snapshot().dismissedUpdateVersions, { "v0.8.0": true });
  });

  it("reconcilePendingOnStartup: leaves pending when current < pending", () => {
    const prefs = makePrefs({ pendingUpdateVersion: "v0.9.0" });
    const ctx = makeCtxWithPrefs(prefs);
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "v0.7.0", relaunch() {}, exit() {} },
    }));
    updater.reconcilePendingOnStartup();
    assert.strictEqual(prefs.snapshot().pendingUpdateVersion, "v0.9.0");
  });

  it("fetchLatestRelease sends If-None-Match on the second call and resolves 304 from cache", async () => {
    let callIndex = 0;
    const requestHeaders = [];
    const httpsGetImpl = (options, cb) => {
      requestHeaders.push(options.headers);
      const isSecond = callIndex === 1;
      callIndex += 1;
      const release = { tag_name: "v0.9.0", assets: [] };
      const res = {
        statusCode: isSecond ? 304 : 200,
        headers: { etag: '"abc123"' },
        on(event, handler) {
          if (event === "data" && !isSecond) handler(Buffer.from(JSON.stringify(release)));
          if (event === "end") handler();
          return this;
        },
        resume() {},
      };
      cb(res);
      return { on() { return this; }, setTimeout() {} };
    };

    const ctx = makeCtxWithPrefs(makePrefs());
    const updater = initUpdater(ctx, makeDeps({
      app: { isPackaged: true, getVersion: () => "0.5.0", relaunch() {}, exit() {} },
      httpsGetImpl,
    }));

    const first = await updater.quietDiscover();
    assert.strictEqual(first.status, "new-update");
    assert.strictEqual(first.version, "v0.9.0");
    assert.strictEqual(requestHeaders[0]["If-None-Match"], undefined);

    const second = await updater.quietDiscover();
    assert.strictEqual(second.status, "new-update");
    assert.strictEqual(second.version, "v0.9.0");
    assert.strictEqual(requestHeaders[1]["If-None-Match"], '"abc123"');
  });
});
