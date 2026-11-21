"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { i18n } = require("../src/i18n");

const {
  attachSessionMetadata,
  extractPromptTitle,
  normalizeTitle,
  resolveSessionTitle,
  SESSION_TITLE_MAX,
  PROMPT_TITLE_MAX,
} = require("../hooks/codebuddy-hook");
const {
  getDirectSendFocusTarget,
  getSessionFocusTarget,
  mergeSessionFocusEntry,
} = require("../src/session-focus");
const {
  findCodeBuddyMacApp,
  findCodeBuddyWindowsApp,
  openCodeBuddyMacApp,
} = require("../src/process-app-focus");
const { focusCodeBuddyIdeTarget } = require("../src/session-focus-handoff");
const { buildSessionSnapshotEntry } = require("../src/state-session-snapshot");

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function makeExecFile(result) {
  const fn = (bin, args, options, done) => {
    fn.calls.push({ bin, args, options });
    const value = typeof result === "function" ? result(bin, args, fn.calls) : result;
    if (value && value.throwSync) throw value.throwSync;
    setImmediate(() => done(value && value.error || null, value && value.stdout || ""));
  };
  fn.calls = [];
  return fn;
}

function makeFs(files, stats = {}, readFailures = {}) {
  const reads = [];
  const remainingFailures = { ...readFailures };
  const fsApi = {
    reads,
    promises: {
      readFile: async (filePath) => {
        reads.push(filePath);
        if (remainingFailures[filePath] > 0) {
          remainingFailures[filePath] -= 1;
          throw new Error("temporary read failure");
        }
        if (!Object.hasOwn(files, filePath)) throw new Error("ENOENT");
        return files[filePath];
      },
      stat: async (filePath) => {
        if (!Object.hasOwn(stats, filePath)) throw new Error("ENOENT");
        return { mtimeMs: stats[filePath] };
      },
    },
  };
  return fsApi;
}

function codeBuddyFiles(bundlePath, {
  protocol = "codebuddycn",
  applicationName = "CodeBuddy",
  route = "x/conversation/open/y",
} = {}) {
  const appRoot = `${bundlePath}/Contents/Resources/app`;
  return {
    [`${appRoot}/product.json`]: JSON.stringify({ urlProtocol: protocol, applicationName }),
    [`${appRoot}/out/main.js`]: route,
  };
}

function codeBuddyStats(bundlePath, mtimeMs = 1) {
  const appRoot = `${bundlePath}/Contents/Resources/app`;
  return {
    [`${appRoot}/product.json`]: mtimeMs,
    [`${appRoot}/out/main.js`]: mtimeMs,
  };
}

function psLine(processId, image) {
  return `${processId} ${image}`;
}

function winCodeBuddyFiles(appDir, {
  protocol = "codebuddycn",
  nameShort = "CodeBuddy CN",
  applicationName = "buddycn",
  route = "x/conversation/open/y",
} = {}) {
  const appRoot = `${appDir}\\resources\\app`;
  return {
    [`${appRoot}\\product.json`]: JSON.stringify({ urlProtocol: protocol, nameShort, applicationName }),
    [`${appRoot}\\out\\main.js`]: route,
  };
}

function winCodeBuddyStats(appDir, mtimeMs = 1) {
  const appRoot = `${appDir}\\resources\\app`;
  return {
    [`${appRoot}\\product.json`]: mtimeMs,
    [`${appRoot}\\out\\main.js`]: mtimeMs,
  };
}

function winProcessLine(processId, image) {
  return `${processId}\t${image}`;
}

describe("PR #1386 follow-up: CodeBuddy hook titles", () => {
  it("collapses control characters and consecutive whitespace", () => {
    assert.equal(normalizeTitle("  hello\u0000\n\t world  "), "hello world");
    assert.equal(normalizeTitle("\u0000\u0001"), null);
  });

  it("truncates native and prompt titles by Unicode code points", () => {
    const longPrompt = "ab ".repeat(30);
    const promptTitle = extractPromptTitle(longPrompt);
    assert.equal(Array.from(promptTitle).length, PROMPT_TITLE_MAX);
    assert.ok(promptTitle.endsWith("\u2026"));
    const longNative = "y".repeat(SESSION_TITLE_MAX + 5);
    assert.equal(
      resolveSessionTitle({ session_title: longNative }, "Stop").title,
      `${"y".repeat(SESSION_TITLE_MAX - 1)}\u2026`
    );
  });

  it("keeps an emoji on the truncation boundary whole", () => {
    const prefix = `${"ab ".repeat(12)}ab`;
    const title = extractPromptTitle(`${prefix}\u{1F600}tail`);
    assert.equal(Array.from(title).length, PROMPT_TITLE_MAX);
    assert.ok(title.includes("\u{1F600}"));
    assert.doesNotMatch(title, LONE_SURROGATE_RE);
  });

  it("rejects a secret that appears after the truncation point", () => {
    assert.equal(extractPromptTitle(`${"public text ".repeat(6)}password=hidden`), null);
  });

  it("does not look at the next line when the first non-empty line is secret-looking", () => {
    assert.equal(extractPromptTitle("\n  token=abc123\nsecond line is harmless"), null);
  });

  it("marks a prompt fallback when the native title only contains control characters", () => {
    assert.deepEqual(
      resolveSessionTitle({ session_title: "\u0000\u0001", prompt: "real prompt" }, "UserPromptSubmit"),
      { title: "real prompt", fromPrompt: true }
    );
    const body = attachSessionMetadata("UserPromptSubmit", {
      session_title: "\u0000\u0001",
      prompt: "real prompt",
    }, {});
    assert.equal(body.session_title, "real prompt");
    assert.equal(body.session_title_from_prompt, true);
  });
});

describe("PR #1386 follow-up: CodeBuddy hook metadata", () => {
  it("forwards the IDE client, prompt title and transcript path", () => {
    const body = attachSessionMetadata("UserPromptSubmit", {
      prompt: "分辨率分别是？",
      transcript_path: "/Users/me/.codebuddy/projects/p/s.jsonl",
      client: "CodeBuddyIDE",
    }, {});
    assert.deepEqual(body, {
      codebuddy_client: "CodeBuddyIDE",
      session_title: "分辨率分别是？",
      session_title_from_prompt: true,
      transcript_path: "/Users/me/.codebuddy/projects/p/s.jsonl",
    });
  });

  it("keeps a native title formal and omits metadata from non-prompt events", () => {
    assert.deepEqual(attachSessionMetadata("UserPromptSubmit", {
      session_title: "正式标题", prompt: "ignored", client: "CLI",
    }, {}), {
      codebuddy_client: "CLI",
      session_title: "正式标题",
      session_title_from_prompt: false,
    });
    assert.deepEqual(attachSessionMetadata("Stop", { client: "CLI" }, {}), {
      codebuddy_client: "CLI",
    });
  });

  it("never writes the retired app bundle or URL scheme fields", () => {
    const body = attachSessionMetadata("UserPromptSubmit", {
      prompt: "hello",
      client: "CodeBuddyIDE",
      codebuddy_url_scheme: "codebuddycn",
      codebuddy_app_bundle: "/Applications/CodeBuddy CN.app",
    }, {});
    assert.equal(Object.hasOwn(body, "codebuddy_url_scheme"), false);
    assert.equal(Object.hasOwn(body, "codebuddy_app_bundle"), false);
  });
});

describe("PR #1386 follow-up: CodeBuddy focus target routing", () => {
  const base = {
    id: "cb",
    agentId: "codebuddy",
    codebuddyClient: "CodeBuddyIDE",
    sourcePid: 731,
    state: "working",
  };

  it("uses the app target for a local macOS IDE session", () => {
    assert.deepEqual(getSessionFocusTarget(base, { osPlatform: "darwin" }), {
      canFocus: true,
      type: "codebuddy-ide",
      url: null,
    });
  });

  it("uses the app target for a local Windows IDE session", () => {
    assert.deepEqual(getSessionFocusTarget(base, { osPlatform: "win32" }), {
      canFocus: true,
      type: "codebuddy-ide",
      url: null,
    });
  });

  it("keeps the terminal target on Linux", () => {
    assert.equal(getSessionFocusTarget(base, { osPlatform: "linux", env: {} }).type, "terminal");
  });

  it("does not use the app target for WSL, headless or PID-less sessions", () => {
    for (const osPlatform of ["darwin", "win32"]) {
      assert.equal(getSessionFocusTarget(
        { ...base, wslDistro: "Ubuntu", sourcePid: null },
        { osPlatform }
      ).canFocus, false);
      assert.notEqual(getSessionFocusTarget(
        { ...base, wslDistro: "Ubuntu" },
        { osPlatform }
      ).type, "codebuddy-ide");
      assert.notEqual(getSessionFocusTarget(
        { ...base, platform: "wsl" },
        { osPlatform }
      ).type, "codebuddy-ide");
      assert.notEqual(getSessionFocusTarget(
        { ...base, headless: true },
        { osPlatform }
      ).type, "codebuddy-ide");
      assert.notEqual(getSessionFocusTarget(
        { ...base, sourcePid: null },
        { osPlatform }
      ).type, "codebuddy-ide");
    }
  });

  it("keeps CLI and client-less sessions on the terminal path", () => {
    const { codebuddyClient, ...withoutClient } = base;
    for (const osPlatform of ["darwin", "win32"]) {
      assert.equal(getSessionFocusTarget(
        { ...base, codebuddyClient: "CLI" },
        { osPlatform }
      ).type, "terminal");
      assert.equal(getSessionFocusTarget(withoutClient, { osPlatform }).type, "terminal");
    }
  });

  it("routes through the real snapshot entry with an explicit host platform", () => {
    const session = {
      id: "codebuddy:cb",
      rawSessionId: "cb",
      agentId: "codebuddy",
      codebuddyClient: "CodeBuddyIDE",
      sourcePid: 12089,
      state: "working",
    };
    const darwinEntry = buildSessionSnapshotEntry(
      "codebuddy:cb",
      session,
      {},
      { focusHostPlatform: "darwin" }
    );
    assert.equal(darwinEntry.focusTarget.type, "codebuddy-ide");
    assert.equal(Object.hasOwn(darwinEntry, "codebuddyUrlScheme"), false);
    assert.equal(Object.hasOwn(darwinEntry, "codebuddyAppBundle"), false);
    assert.equal(
      buildSessionSnapshotEntry("codebuddy:cb", session, {}, { focusHostPlatform: "win32" })
        .focusTarget.type,
      "codebuddy-ide"
    );
    assert.equal(
      buildSessionSnapshotEntry("codebuddy:cb", session, {}, { focusHostPlatform: "linux" })
        .focusTarget.type,
      "terminal"
    );
  });
});

describe("PR #1386 follow-up: CodeBuddy direct send", () => {
  it("keeps IDE sessions on manual paste on every platform", () => {
    const entry = { id: "cb", agentId: "codebuddy", codebuddyClient: "CodeBuddyIDE", sourcePid: 731 };
    for (const osPlatform of ["darwin", "win32", "linux"]) {
      assert.deepEqual(getDirectSendFocusTarget(entry, { osPlatform }), {
        canFocus: false,
        type: "codebuddy-ide",
        url: null,
        reason: "codebuddy_ide_requires_manual_paste",
      });
    }
  });

  it("keeps CLI sessions on the terminal delivery path", () => {
    assert.equal(getDirectSendFocusTarget(
      { id: "cb", agentId: "codebuddy", codebuddyClient: "CLI", sourcePid: 731 },
      { osPlatform: "darwin" }
    ).type, "terminal");
  });
});

describe("PR #1386 follow-up: CodeBuddy app lookup", () => {
  const bundlePath = "/Applications/CodeBuddy CN.app";

  it("selects the outermost bundle for a helper image (and parses spaces)", async () => {
    const execFile = makeExecFile({
      stdout: `${psLine(100, `${bundlePath}/Contents/Frameworks/CodeBuddy Helper.app/Contents/MacOS/CodeBuddy Helper`)}\n`,
    });
    const result = await findCodeBuddyMacApp([100], {
      execFile,
      fs: makeFs(codeBuddyFiles(bundlePath), codeBuddyStats(bundlePath)),
    });
    assert.deepEqual(result, { bundlePath, urlScheme: "codebuddycn" });
    assert.deepEqual(execFile.calls[0].args, ["-ww", "-o", "pid=,comm=", "-p", "100"]);
  });

  it("skips a terminal in the chain and selects the CodeBuddy app", async () => {
    const terminalBundle = "/System/Applications/Utilities/Terminal.app";
    const result = await findCodeBuddyMacApp([200, 300], {
      execFile: makeExecFile({
        stdout: [
          psLine(200, `${terminalBundle}/Contents/MacOS/Terminal`),
          psLine(300, `${bundlePath}/Contents/MacOS/CodeBuddy CN`),
          "",
        ].join("\n"),
      }),
      fs: makeFs(codeBuddyFiles(bundlePath), codeBuddyStats(bundlePath)),
    });
    assert.deepEqual(result, { bundlePath, urlScheme: "codebuddycn" });
  });

  it("selects the bundle of the earlier PID even when ps prints rows in reverse", async () => {
    const insidersBundle = "/Applications/CodeBuddy CN Insiders.app";
    const stableBundle = "/Applications/CodeBuddy CN.app";
    const result = await findCodeBuddyMacApp([100, 200], {
      execFile: makeExecFile({
        stdout: [
          psLine(200, `${stableBundle}/Contents/MacOS/CodeBuddy CN`),
          psLine(100, `${insidersBundle}/Contents/Frameworks/CodeBuddy Helper.app/Contents/MacOS/CodeBuddy Helper`),
          "",
        ].join("\n"),
      }),
      fs: makeFs({
        ...codeBuddyFiles(insidersBundle),
        ...codeBuddyFiles(stableBundle),
      }, {
        ...codeBuddyStats(insidersBundle, 10),
        ...codeBuddyStats(stableBundle, 20),
      }),
    });
    assert.deepEqual(result, { bundlePath: insidersBundle, urlScheme: "codebuddycn" });
  });

  it("skips an app whose product.json does not name CodeBuddy", async () => {
    const otherBundle = "/Applications/Other.app";
    const result = await findCodeBuddyMacApp([400], {
      execFile: makeExecFile({
        stdout: `${psLine(400, `${otherBundle}/Contents/MacOS/Other`)}\n`,
      }),
      fs: makeFs(codeBuddyFiles(otherBundle, {
        protocol: "other",
        applicationName: "Other",
      }), codeBuddyStats(otherBundle)),
    });
    assert.equal(result, null);
  });

  it("parses live rows even when ps exits non-zero", async () => {
    const result = await findCodeBuddyMacApp([100], {
      execFile: makeExecFile({
        error: new Error("ps: one pid is gone"),
        stdout: `${psLine(100, `${bundlePath}/Contents/MacOS/CodeBuddy CN`)}\n`,
      }),
      fs: makeFs(codeBuddyFiles(bundlePath), codeBuddyStats(bundlePath)),
    });
    assert.equal(result.bundlePath, bundlePath);
  });

  it("rejects an image path that changes under posix.normalize", async () => {
    const result = await findCodeBuddyMacApp([100], {
      execFile: makeExecFile({
        stdout: `${psLine(100, `${bundlePath}/Contents//MacOS/CodeBuddy CN`)}\n`,
      }),
      fs: makeFs(codeBuddyFiles(bundlePath), codeBuddyStats(bundlePath)),
    });
    assert.equal(result, null);
  });

  it("returns null without output or candidates", async () => {
    assert.equal(await findCodeBuddyMacApp([100], {
      execFile: makeExecFile({ stdout: "" }),
      fs: makeFs({}),
    }), null);
    assert.equal(await findCodeBuddyMacApp([], {
      execFile: makeExecFile({ stdout: "" }),
      fs: makeFs({}),
    }), null);
  });

  it("reports a scheme only for builds with a valid protocol and the route", async () => {
    const withRoute = await findCodeBuddyMacApp([100], {
      execFile: makeExecFile({ stdout: `${psLine(100, `${bundlePath}/Contents/MacOS/CodeBuddy CN`)}\n` }),
      fs: makeFs(codeBuddyFiles(bundlePath), codeBuddyStats(bundlePath)),
    });
    assert.equal(withRoute.urlScheme, "codebuddycn");

    const withoutRoute = await findCodeBuddyMacApp([100], {
      execFile: makeExecFile({ stdout: `${psLine(100, `${bundlePath}/Contents/MacOS/CodeBuddy CN`)}\n` }),
      fs: makeFs(codeBuddyFiles(bundlePath, { route: "no route" }), codeBuddyStats(bundlePath, 2)),
    });
    assert.equal(withoutRoute.urlScheme, null);

    const invalidProtocol = await findCodeBuddyMacApp([100], {
      execFile: makeExecFile({ stdout: `${psLine(100, `${bundlePath}/Contents/MacOS/CodeBuddy CN`)}\n` }),
      fs: makeFs(codeBuddyFiles(bundlePath, { protocol: "1bad:" }), codeBuddyStats(bundlePath, 3)),
    });
    assert.equal(invalidProtocol.urlScheme, null);
  });

  it("caches the route per bundle and invalidates it when an mtime changes", async () => {
    const files = codeBuddyFiles(bundlePath);
    const stats = codeBuddyStats(bundlePath, 100);
    const fsApi = makeFs(files, stats);
    const execFile = makeExecFile({
      stdout: `${psLine(100, `${bundlePath}/Contents/MacOS/CodeBuddy CN`)}\n`,
    });
    const mainPath = `${bundlePath}/Contents/Resources/app/out/main.js`;
    const mainReads = () => fsApi.reads.filter((filePath) => filePath === mainPath).length;

    await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    assert.equal(mainReads(), 1, "a warm cache must not re-read main.js");

    stats[mainPath] = 101;
    await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    assert.equal(mainReads(), 2, "an app update must invalidate the cached route");
  });

  it("rechecks when only product.json's mtime changes", async () => {
    const productBundle = "/Applications/CB ProductMtime.app";
    const files = codeBuddyFiles(productBundle);
    const stats = codeBuddyStats(productBundle, 10);
    const fsApi = makeFs(files, stats);
    const execFile = makeExecFile({
      stdout: `${psLine(100, `${productBundle}/Contents/MacOS/CodeBuddy CN`)}\n`,
    });
    const productPath = `${productBundle}/Contents/Resources/app/product.json`;
    const mainPath = `${productBundle}/Contents/Resources/app/out/main.js`;
    const mainReads = () => fsApi.reads.filter((filePath) => filePath === mainPath).length;

    await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    assert.equal(mainReads(), 1);
    stats[productPath] = 11;
    await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    assert.equal(mainReads(), 2, "a product.json change must trigger a fresh decision");
  });

  it("does not return the old scheme when urlProtocol changes with unchanged mtimes", async () => {
    const protocolBundle = "/Applications/CB Protocol.app";
    const files = codeBuddyFiles(protocolBundle);
    const stats = codeBuddyStats(protocolBundle, 10);
    const fsApi = makeFs(files, stats);
    const execFile = makeExecFile({
      stdout: `${psLine(100, `${protocolBundle}/Contents/MacOS/CodeBuddy CN`)}\n`,
    });
    const productPath = `${protocolBundle}/Contents/Resources/app/product.json`;

    assert.equal((await findCodeBuddyMacApp([100], { execFile, fs: fsApi })).urlScheme, "codebuddycn");
    files[productPath] = JSON.stringify({
      urlProtocol: "codebuddycn2",
      applicationName: "CodeBuddy",
    });
    assert.equal((await findCodeBuddyMacApp([100], { execFile, fs: fsApi })).urlScheme, "codebuddycn2");
  });

  it("retries after a temporary main.js read failure", async () => {
    const retryBundle = "/Applications/CB Retry.app";
    const files = codeBuddyFiles(retryBundle);
    const stats = codeBuddyStats(retryBundle, 10);
    const mainPath = `${retryBundle}/Contents/Resources/app/out/main.js`;
    const fsApi = makeFs(files, stats, { [mainPath]: 1 });
    const execFile = makeExecFile({
      stdout: `${psLine(100, `${retryBundle}/Contents/MacOS/CodeBuddy CN`)}\n`,
    });

    assert.equal((await findCodeBuddyMacApp([100], { execFile, fs: fsApi })).urlScheme, null);
    assert.equal((await findCodeBuddyMacApp([100], { execFile, fs: fsApi })).urlScheme, "codebuddycn");
  });

  it("does not let a late concurrent failure replace a successful route", async () => {
    const concurrentBundle = "/Applications/CB Concurrent.app";
    const files = codeBuddyFiles(concurrentBundle);
    const stats = codeBuddyStats(concurrentBundle, 10);
    const productPath = `${concurrentBundle}/Contents/Resources/app/product.json`;
    const mainPath = `${concurrentBundle}/Contents/Resources/app/out/main.js`;
    let productReads = 0;
    let releaseProduct;
    const productGate = new Promise((resolve) => { releaseProduct = resolve; });
    let mainReads = 0;
    const fsApi = {
      promises: {
        readFile: (filePath) => {
          if (filePath === productPath) {
            productReads += 1;
            if (productReads === 2) releaseProduct();
            return productGate.then(() => files[filePath]);
          }
          if (filePath === mainPath) {
            mainReads += 1;
            if (mainReads === 1) return Promise.resolve(files[filePath]);
            // Settle after the successful read has written its cache entry.
            return new Promise((_resolve, reject) => {
              setImmediate(() => reject(new Error("temporary read failure")));
            });
          }
          return Promise.resolve(files[filePath]);
        },
        stat: async (filePath) => ({ mtimeMs: stats[filePath] }),
      },
    };
    const execFile = makeExecFile({
      stdout: `${psLine(100, `${concurrentBundle}/Contents/MacOS/CodeBuddy CN`)}\n`,
    });

    const [first, second] = await Promise.all([
      findCodeBuddyMacApp([100], { execFile, fs: fsApi }),
      findCodeBuddyMacApp([100], { execFile, fs: fsApi }),
    ]);
    assert.deepEqual(first, { bundlePath: concurrentBundle, urlScheme: "codebuddycn" });
    assert.deepEqual(second, { bundlePath: concurrentBundle, urlScheme: null });
    const after = await findCodeBuddyMacApp([100], { execFile, fs: fsApi });
    assert.equal(after.urlScheme, "codebuddycn");
  });
});

describe("CodeBuddy Windows app lookup", () => {
  const stableDir = "C:\\Users\\me\\AppData\\Local\\Programs\\CodeBuddy CN";
  const insidersDir = "C:\\Users\\me\\AppData\\Local\\Programs\\CodeBuddy CN Insiders";
  const stableExe = `${stableDir}\\CodeBuddy CN.exe`;
  const insidersExe = `${insidersDir}\\CodeBuddy CN Insiders.exe`;

  it("queries the recorded PIDs once through Get-Process without a visible window", async () => {
    const execFile = makeExecFile({ stdout: `${winProcessLine(45684, insidersExe)}\r\n` });
    const result = await findCodeBuddyWindowsApp([14172, 45684], {
      execFile,
      fs: makeFs(winCodeBuddyFiles(insidersDir, {
        protocol: "codebuddycn-insiders",
        nameShort: "CodeBuddy CN Insiders",
        applicationName: "buddycn-insiders",
      }), winCodeBuddyStats(insidersDir)),
    });
    assert.deepEqual(result, { bundlePath: insidersDir, urlScheme: "codebuddycn-insiders" });
    assert.equal(execFile.calls.length, 1);
    assert.equal(execFile.calls[0].bin, "powershell.exe");
    assert.equal(execFile.calls[0].options.windowsHide, true);
    assert.match(execFile.calls[0].args.at(-1), /Get-Process -Id 14172,45684 /);
  });

  it("selects the edition of the earliest recorded PID and skips helpers and shells", async () => {
    const harness = `${insidersDir}\\resources\\app\\extensions\\genie\\harness\\agent-harness.exe`;
    const result = await findCodeBuddyWindowsApp([10, 20, 30, 40], {
      execFile: makeExecFile({
        stdout: [
          winProcessLine(40, stableExe),
          winProcessLine(10, "C:\\Program Files\\Git\\usr\\bin\\bash.exe"),
          winProcessLine(20, harness),
          winProcessLine(30, insidersExe),
          "",
        ].join("\r\n"),
      }),
      fs: makeFs({
        ...winCodeBuddyFiles(stableDir),
        ...winCodeBuddyFiles(insidersDir, { protocol: "codebuddycn-insiders" }),
      }, {
        ...winCodeBuddyStats(stableDir, 10),
        ...winCodeBuddyStats(insidersDir, 20),
      }),
    });
    assert.deepEqual(result, { bundlePath: insidersDir, urlScheme: "codebuddycn-insiders" });
  });

  it("matches by product.json even though applicationName omits CodeBuddy", async () => {
    const result = await findCodeBuddyWindowsApp([38060], {
      execFile: makeExecFile({ stdout: `${winProcessLine(38060, stableExe)}\n` }),
      fs: makeFs(winCodeBuddyFiles(stableDir, { applicationName: "buddycn" }), winCodeBuddyStats(stableDir)),
    });
    assert.deepEqual(result, { bundlePath: stableDir, urlScheme: "codebuddycn" });
  });

  it("reports no scheme for a build without the conversation route", async () => {
    const legacyDir = "C:\\Program Files\\CodeBuddy CN";
    const result = await findCodeBuddyWindowsApp([7], {
      execFile: makeExecFile({ stdout: `${winProcessLine(7, `${legacyDir}\\CodeBuddy CN.exe`)}\n` }),
      fs: makeFs(winCodeBuddyFiles(legacyDir, { route: "no route" }), winCodeBuddyStats(legacyDir)),
    });
    assert.deepEqual(result, { bundlePath: legacyDir, urlScheme: null });
  });

  it("rejects relative, UNC, non-normalized and non-exe images", async () => {
    for (const image of [
      "CodeBuddy CN\\CodeBuddy CN.exe",
      "\\\\server\\share\\CodeBuddy CN\\CodeBuddy CN.exe",
      "C:\\Apps\\..\\CodeBuddy CN\\CodeBuddy CN.exe",
      "C:/Apps/CodeBuddy CN/CodeBuddy CN.exe",
      `${stableDir}\\CodeBuddy CN.dll`,
    ]) {
      const result = await findCodeBuddyWindowsApp([5], {
        execFile: makeExecFile({ stdout: `${winProcessLine(5, image)}\n` }),
        fs: makeFs({}, {}),
      });
      assert.equal(result, null, image);
    }
  });

  it("returns null without valid PIDs, output or a CodeBuddy product", async () => {
    const execFile = makeExecFile({ stdout: "" });
    assert.equal(await findCodeBuddyWindowsApp([], { execFile, fs: makeFs({}) }), null);
    assert.equal(await findCodeBuddyWindowsApp([0, -1, "x"], { execFile, fs: makeFs({}) }), null);
    assert.equal(execFile.calls.length, 0, "no process query without a valid PID");
    assert.equal(await findCodeBuddyWindowsApp([5], { execFile, fs: makeFs({}) }), null);
    const otherDir = "C:\\Apps\\Other";
    assert.equal(await findCodeBuddyWindowsApp([6], {
      execFile: makeExecFile({ stdout: `${winProcessLine(6, `${otherDir}\\Other.exe`)}\n` }),
      fs: makeFs(winCodeBuddyFiles(otherDir, { protocol: "other", nameShort: "Other", applicationName: "other" }),
        winCodeBuddyStats(otherDir)),
    }), null);
  });

  it("survives a process query that throws or fails", async () => {
    assert.equal(await findCodeBuddyWindowsApp([5], {
      execFile: makeExecFile({ throwSync: new Error("spawn failed") }),
      fs: makeFs({}),
    }), null);
    const result = await findCodeBuddyWindowsApp([38060], {
      execFile: makeExecFile({ error: new Error("one pid gone"), stdout: `${winProcessLine(38060, stableExe)}\n` }),
      fs: makeFs(winCodeBuddyFiles(stableDir), winCodeBuddyStats(stableDir)),
    });
    assert.equal(result.bundlePath, stableDir);
  });
});

describe("PR #1386 follow-up: CodeBuddy app activation", () => {
  const bundlePath = "/Applications/CodeBuddy CN.app";

  it("submits the verified bundle through /usr/bin/open as one argv", async () => {
    const execFile = makeExecFile({ stdout: "" });
    const result = await openCodeBuddyMacApp(bundlePath, { execFile });
    assert.deepEqual(result, {
      confirmed: false,
      submitted: true,
      reason: "codebuddy-app-activation-submitted",
    });
    assert.deepEqual(execFile.calls.map((call) => [call.bin, call.args]), [
      ["/usr/bin/open", [bundlePath]],
    ]);
  });

  it("reports a failed submission", async () => {
    const result = await openCodeBuddyMacApp(bundlePath, {
      execFile: makeExecFile({ error: new Error("open failed") }),
    });
    assert.deepEqual(result, {
      confirmed: false,
      submitted: false,
      reason: "codebuddy-app-activation-failed",
    });
  });
});

function runCodeBuddyTarget(overrides = {}) {
  const calls = { external: [], open: [], terminal: [], find: [], logs: [] };
  const result = focusCodeBuddyIdeTarget({
    shell: {
      openExternal(url) {
        calls.external.push(url);
        return overrides.openExternal ? overrides.openExternal(url) : Promise.resolve();
      },
    },
    focusEntry: overrides.focusEntry || {
      id: "codebuddy:cb",
      rawSessionId: "abc-123",
      agentId: "codebuddy",
    },
    sessionId: "codebuddy:cb",
    requestSource: "dashboard",
    focusLog: overrides.focusLog || ((line) => calls.logs.push(line)),
    focusTerminalSession: () => {
      calls.terminal.push("terminal");
      return overrides.terminalResult !== undefined ? overrides.terminalResult : true;
    },
    findApp(pids) {
      calls.find.push(pids);
      if (overrides.findApp) return overrides.findApp(pids);
      return Promise.resolve(
        Object.hasOwn(overrides, "app")
          ? overrides.app
          : { bundlePath: "/Applications/CodeBuddy CN.app", urlScheme: "codebuddycn" }
      );
    },
    ...(overrides.withoutOpenApp ? {} : {
      openApp(bundlePath) {
        calls.open.push(bundlePath);
        if (overrides.openApp) return overrides.openApp(bundlePath);
        return Promise.resolve(
          overrides.openResult || {
            confirmed: false,
            submitted: true,
            reason: "codebuddy-app-activation-submitted",
          }
        );
      },
    }),
  });
  return { calls, result };
}

describe("PR #1386 follow-up: CodeBuddy click dispatch", () => {
  it("requests the conversation deep link when the verified build supports it", async () => {
    const { calls, result } = runCodeBuddyTarget();
    await result;
    assert.deepEqual(calls.external, [
      "codebuddycn://codebuddy-ide/conversation/open?id=abc-123",
    ]);
    assert.equal(calls.open.length, 0);
    assert.equal(calls.terminal.length, 0);
    assert.ok(calls.logs.some((line) => line.includes("branch=codebuddy-conversation reason=opened")));
  });

  it("falls back to app activation when the deep link rejects or throws synchronously", async () => {
    for (const openExternal of [
      () => Promise.reject(new Error("no handler")),
      () => { throw new Error("no handler"); },
    ]) {
      const { calls, result } = runCodeBuddyTarget({ openExternal });
      await result;
      assert.equal(calls.open.length, 1);
      assert.equal(calls.terminal.length, 0);
      assert.ok(calls.logs.some((line) => line.includes("branch=codebuddy-conversation reason=open-failed")));
      assert.ok(calls.logs.some((line) => line.includes("branch=codebuddy-app")));
    }
  });

  it("activates the app when the build has no conversation route", async () => {
    const { calls, result } = runCodeBuddyTarget({
      app: { bundlePath: "/Applications/CodeBuddy CN.app", urlScheme: null },
    });
    await result;
    assert.equal(calls.external.length, 0);
    assert.equal(calls.open.length, 1);
    assert.equal(calls.terminal.length, 0);
  });

  it("never builds a deep link from a default, blank, invalid or missing raw id", async () => {
    for (const rawSessionId of ["default", "", "bad id!", undefined]) {
      const { calls, result } = runCodeBuddyTarget({
        focusEntry: { id: "legal_ID-1", rawSessionId, agentId: "codebuddy" },
      });
      await result;
      assert.equal(calls.external.length, 0, `raw id ${String(rawSessionId)} must not open a URL`);
      assert.equal(calls.open.length, 1);
    }
  });

  it("falls back to the terminal when app activation is not submitted", async () => {
    for (const openApp of [
      () => Promise.resolve({ confirmed: false, submitted: false, reason: "codebuddy-app-activation-failed" }),
      () => Promise.reject(new Error("open failed")),
      () => { throw new Error("open failed"); },
    ]) {
      const { calls, result } = runCodeBuddyTarget({
        app: { bundlePath: "/Applications/CodeBuddy CN.app", urlScheme: null },
        openApp,
      });
      await result;
      assert.equal(calls.terminal.length, 1);
      assert.ok(calls.logs.some((line) => line.includes("branch=codebuddy-terminal-fallback")));
    }
  });

  it("treats submitted:true as success even though confirmed is false", async () => {
    const { calls, result } = runCodeBuddyTarget({
      app: { bundlePath: "/Applications/CodeBuddy CN.app", urlScheme: null },
      openResult: { confirmed: false, submitted: true, reason: "codebuddy-app-activation-submitted" },
    });
    await result;
    assert.equal(calls.terminal.length, 0);
    assert.ok(calls.logs.some((line) => line.includes("branch=codebuddy-app")));
  });

  it("falls back to the terminal when no running CodeBuddy app is found", async () => {
    const { calls, result } = runCodeBuddyTarget({ app: null });
    await result;
    assert.equal(calls.open.length, 0);
    assert.equal(calls.terminal.length, 1);
    assert.ok(calls.logs.some((line) =>
      line.includes("branch=codebuddy-terminal-fallback reason=codebuddy-app-not-found")));
  });

  it("uses window focus directly when no app activation is provided (Windows)", async () => {
    const windowsApp = { bundlePath: "C:\\Programs\\CodeBuddy CN", urlScheme: null };
    const noRoute = runCodeBuddyTarget({ withoutOpenApp: true, app: windowsApp });
    await noRoute.result;
    assert.equal(noRoute.calls.external.length, 0);
    assert.equal(noRoute.calls.terminal.length, 1);
    assert.ok(noRoute.calls.logs.some((line) =>
      line.includes("branch=codebuddy-terminal-fallback reason=codebuddy-app-activation-unavailable")));

    const failedLink = runCodeBuddyTarget({
      withoutOpenApp: true,
      app: { ...windowsApp, urlScheme: "codebuddycn" },
      openExternal: () => Promise.reject(new Error("no handler")),
    });
    await failedLink.result;
    assert.equal(failedLink.calls.external.length, 1);
    assert.equal(failedLink.calls.terminal.length, 1);

    const deepLink = runCodeBuddyTarget({
      withoutOpenApp: true,
      app: { ...windowsApp, urlScheme: "codebuddycn-insiders" },
    });
    await deepLink.result;
    assert.deepEqual(deepLink.calls.external, [
      "codebuddycn-insiders://codebuddy-ide/conversation/open?id=abc-123",
    ]);
    assert.equal(deepLink.calls.terminal.length, 0);
  });

  it("queries PIDs in pidChain, sourcePid, agentPid order and deduplicates", async () => {
    const { calls, result } = runCodeBuddyTarget({
      focusEntry: {
        id: "codebuddy:cb",
        rawSessionId: "abc-123",
        agentId: "codebuddy",
        pidChain: [9, 7, 9, "x"],
        sourcePid: 7,
        agentPid: 5,
      },
    });
    await result;
    assert.deepEqual(calls.find[0], [9, 7, 5]);

    const withoutChain = runCodeBuddyTarget({
      focusEntry: {
        id: "codebuddy:cb",
        rawSessionId: "abc-123",
        agentId: "codebuddy",
        sourcePid: 7,
        agentPid: 5,
      },
      app: { bundlePath: "/Applications/CodeBuddy CN.app", urlScheme: null },
    });
    await withoutChain.result;
    assert.deepEqual(withoutChain.calls.find[0], [7, 5], "sourcePid must be tried before agentPid");
  });

  it("falls back to the terminal when app lookup throws or rejects", async () => {
    for (const findApp of [
      () => { throw new Error("walk failed"); },
      () => Promise.reject(new Error("walk failed")),
    ]) {
      const { calls, result } = runCodeBuddyTarget({ findApp });
      await result;
      assert.equal(calls.terminal.length, 1);
    }
  });

  it("keeps the dispatch unchanged when diagnostic logging throws", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const throwingLog = () => { throw new Error("log write failed"); };
      const deepLink = runCodeBuddyTarget({ focusLog: throwingLog });
      await deepLink.result;
      assert.equal(deepLink.calls.external.length, 1);
      assert.equal(deepLink.calls.open.length, 0);
      assert.equal(deepLink.calls.terminal.length, 0);

      const missingApp = runCodeBuddyTarget({ focusLog: throwingLog, app: null });
      await missingApp.result;
      assert.equal(missingApp.calls.terminal.length, 1);

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unhandled.length, 0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("sanitizes newlines out of errors and never leaks an unhandled rejection", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const deepLink = runCodeBuddyTarget({
        openExternal: () => Promise.reject(new Error("first\nsecond")),
      });
      await deepLink.result;
      const lookup = runCodeBuddyTarget({
        findApp: () => { throw new Error("walk\nfailed"); },
      });
      await lookup.result;
      await new Promise((resolve) => setImmediate(resolve));
      const logs = [...deepLink.calls.logs, ...lookup.calls.logs];
      assert.ok(logs.some((line) => line.includes("error=first second")));
      assert.ok(logs.some((line) => line.includes("error=walk failed")));
      assert.ok(logs.every((line) => !line.includes("\n")));
      assert.equal(unhandled.length, 0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

describe("PR #1386 follow-up: main CodeBuddy dispatch wiring", () => {
  function runMainDispatch(platform) {
    const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
    const begin = mainSource.indexOf("function focusDashboardSession(");
    const end = mainSource.indexOf("function hideDashboardSession(", begin);
    assert.ok(begin >= 0 && end > begin);

    const dispatched = [];
    const findApp = () => Promise.resolve(null);
    const findWindowsApp = () => Promise.resolve(null);
    const openApp = () => Promise.resolve({ submitted: true });
    const focusTerminalSession = () => true;
    const context = {
      sessions: new Map([["codebuddy:cb", {
        id: "codebuddy:cb",
        agentId: "codebuddy",
        codebuddyClient: "CodeBuddyIDE",
        sourcePid: 12089,
        state: "working",
      }]]),
      process: { platform },
      mergeSessionFocusEntry,
      getSessionFocusTarget,
      focusLog: () => {},
      focusTerminalSession,
      focusCodeBuddyIdeTarget: (args) => { dispatched.push(args); return Promise.resolve(); },
      findCodeBuddyMacApp: findApp,
      findCodeBuddyWindowsApp: findWindowsApp,
      openCodeBuddyMacApp: openApp,
      focusCodexThreadTarget: () => { throw new Error("unexpected codex dispatch"); },
      focusDshDesktopTarget: () => { throw new Error("unexpected dsh dispatch"); },
      focusProcessAppWindow: () => { throw new Error("unexpected codex app dispatch"); },
      publishDshFocus: () => false,
      shell: {},
    };
    vm.createContext(context);
    vm.runInContext(mainSource.slice(begin, end), context);
    const returned = context.focusDashboardSession("codebuddy:cb");
    return { returned, dispatched, findApp, findWindowsApp, openApp, focusTerminalSession };
  }

  it("calls the handoff helper and returns true synchronously", () => {
    const { returned, dispatched, findApp, openApp, focusTerminalSession } = runMainDispatch("darwin");
    assert.equal(returned, true);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].sessionId, "codebuddy:cb");
    assert.equal(dispatched[0].findApp, findApp);
    assert.equal(dispatched[0].openApp, openApp);
    assert.equal(dispatched[0].focusTerminalSession, focusTerminalSession);
    assert.equal(dispatched[0].requestSource, "dashboard");
  });

  it("uses the Windows finder and no app activation on a Windows host", () => {
    const { returned, dispatched, findWindowsApp, focusTerminalSession } = runMainDispatch("win32");
    assert.equal(returned, true);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].findApp, findWindowsApp);
    assert.equal(Object.hasOwn(dispatched[0], "openApp"), false);
    assert.equal(dispatched[0].focusTerminalSession, focusTerminalSession);
  });
});

class FakeClassList {
  constructor(element) { this.element = element; }
  add(...names) {
    const set = new Set(this.element.className.split(/\s+/).filter(Boolean));
    for (const name of names) set.add(name);
    this.element.className = [...set].join(" ");
  }
  remove(...names) {
    const drop = new Set(names);
    this.element.className = this.element.className
      .split(/\s+/).filter((name) => name && !drop.has(name)).join(" ");
  }
  toggle(name, force) {
    if (force) this.add(name);
    else this.remove(name);
  }
  contains(name) { return this.element.className.split(/\s+/).includes(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.disabled = false;
    this.style = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  querySelector() { return null; }
  focus() {}
  select() {}
}

function descendants(root) {
  const out = [];
  for (const child of root.children || []) out.push(child, ...descendants(child));
  return out;
}

function byClass(root, className) {
  return descendants(root).filter((element) =>
    element.classList && element.classList.contains(className));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function renderDashboardButtons(session) {
  const elements = new Map(
    ["content", "title", "count", "quickBanner", "quotaSummary"]
      .map((id) => [id, new FakeElement("div")]),
  );
  const document = {
    title: "",
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
  };
  const api = {
    getI18n: async () => ({ lang: "en", translations: { ...i18n.en } }),
    getSnapshot: async () => ({
      sessions: [session],
      groups: [{ host: null, displayHost: null, ids: [session.id] }],
    }),
    getKimiQuotaStatus: async () => null,
    onLangChange: () => {},
    onSessionSnapshot: () => {},
    focusSession: () => {},
    hideSession: async () => ({ status: "ok" }),
    openSessionFolder: async () => ({ status: "ok" }),
    setSessionAlias: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async () => ({ status: "applied" }),
    clearSessionAutomationGrant: async () => ({ status: "applied" }),
    ackCompletion: async () => ({ status: "ok" }),
  };
  const context = vm.createContext({
    window: { dashboardAPI: api },
    document,
    console,
    Intl,
    Date,
    setInterval: () => 1,
    requestAnimationFrame: (callback) => callback(),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../src/session-focus-unavailable.js"), "utf8"),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../src/language-picker.js"), "utf8"),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../src/dashboard-renderer.js"), "utf8"),
    context
  );
  await flush();
  await flush();
  const actions = byClass(elements.get("content"), "actions")[0];
  return descendants(actions).filter((element) => element.tagName === "BUTTON");
}

describe("PR #1386 follow-up: Dashboard CodeBuddy label", () => {
  it("labels the codebuddy-ide action with the Open CodeBuddy copy", async () => {
    const buttons = await renderDashboardButtons({
      id: "cb",
      agentId: "codebuddy",
      displayTitle: "CodeBuddy conversation",
      canFocus: true,
      focusTarget: { type: "codebuddy-ide", url: null },
      badge: "working",
      updatedAt: Date.now(),
    });
    assert.equal(buttons[0].textContent, i18n.en.dashboardOpenCodeBuddy);
  });

  it("keeps the terminal copy for a terminal target", async () => {
    const buttons = await renderDashboardButtons({
      id: "cb-terminal",
      agentId: "codebuddy",
      displayTitle: "CodeBuddy terminal",
      canFocus: true,
      focusTarget: { type: "terminal", url: null },
      badge: "idle",
      updatedAt: Date.now(),
    });
    assert.equal(buttons[0].textContent, i18n.en.dashboardJumpTerminal);
  });
});
