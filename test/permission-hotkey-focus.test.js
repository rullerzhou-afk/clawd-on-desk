"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { afterEach, test, mock } = require("node:test");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionWithMocks({ electron, childProcess, platform = "darwin" }) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: originalPlatform.enumerable,
    value: platform,
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "child_process") return childProcess;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function createGlobalShortcut() {
  const registered = new Map();
  return {
    registered,
    register(accelerator, handler) {
      registered.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    destroyed: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers || {};
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
    },
    on() {},
    removeListener() {},
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
    },
  };
}

function createContext(focusCalls) {
  return {
    focusTerminalForSession(sessionId) {
      focusCalls.push(sessionId);
    },
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    subscribeShortcuts: () => () => {},
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionUpdateBubble: () => {},
    clearShortcutFailure: () => {},
    reportShortcutFailure: () => {},
    permDebugLog: null,
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
  };
}

afterEach(() => {
  mock.timers.reset();
  delete require.cache[PERMISSION_MODULE_PATH];
});

async function assertHotkeyLeavesFocusUntouchedOnCaptureFailure({ accelerator, expectedBehavior }) {
  mock.timers.enable({ apis: ["setTimeout"] });

  const focusCalls = [];
  const execFileCalls = [];
  const globalShortcut = createGlobalShortcut();
  const initPermission = loadPermissionWithMocks({
    electron: {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut,
    },
    childProcess: {
      execFile(command, args, options, cb) {
        execFileCalls.push({ command, args, options });
        queueMicrotask(() => cb(new Error("Automation denied"), "", ""));
      },
    },
  });
  const permission = initPermission(createContext(focusCalls));
  const res = createResponse();

  permission.pendingPermissions.push({
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-hotkey",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    agentId: "claude-code",
    interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
  });
  permission.syncPermissionShortcuts();

  const handler = globalShortcut.registered.get(accelerator);
  assert.strictEqual(typeof handler, "function");
  handler();
  await Promise.resolve();
  mock.timers.tick(500);

  assert.strictEqual(execFileCalls.length, 1);
  assert.strictEqual(execFileCalls[0].command, "osascript");
  assert.match(execFileCalls[0].args.join("\n"), /System Events/);
  assert.match(execFileCalls[0].args.join("\n"), /frontmost/);
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body, new RegExp(`"behavior":"${expectedBehavior}"`));
  assert.strictEqual(permission.pendingPermissions.length, 0);
  assert.deepStrictEqual(focusCalls, []);
}

test("macOS allow hotkey does not focus the terminal when frontmost capture fails", async () => {
  await assertHotkeyLeavesFocusUntouchedOnCaptureFailure({
    accelerator: "CommandOrControl+Shift+Y",
    expectedBehavior: "allow",
  });
});

test("macOS deny hotkey does not focus the terminal when frontmost capture fails", async () => {
  await assertHotkeyLeavesFocusUntouchedOnCaptureFailure({
    accelerator: "CommandOrControl+Shift+N",
    expectedBehavior: "deny",
  });
});

test("opencode unknown permissions keep the global Allow/Deny shortcuts", () => {
  const globalShortcut = createGlobalShortcut();
  const initPermission = loadPermissionWithMocks({
    electron: {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut,
    },
    childProcess: { execFile() {} },
  });
  const permission = initPermission(createContext([]));
  permission.pendingPermissions.push({
    res: createResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "opencode-unknown",
    bubble: null,
    hideTimer: null,
    toolName: "unknown",
    toolInput: { command: "custom action" },
    agentId: "opencode",
    familyRequestId: "req-unknown",
    interaction: classifyPermissionInteraction({
      agentId: "opencode",
      toolName: "unknown",
    }),
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
  });

  permission.syncPermissionShortcuts();

  assert.strictEqual(
    typeof globalShortcut.registered.get("CommandOrControl+Shift+Y"),
    "function"
  );
  assert.strictEqual(
    typeof globalShortcut.registered.get("CommandOrControl+Shift+N"),
    "function"
  );
});
