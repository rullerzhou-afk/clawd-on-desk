"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  attachSessionMetadata,
  deriveSessionTitle,
  readCodeBuddyAppInfo,
  SESSION_TITLE_MAX,
} = require("../hooks/codebuddy-hook");
const { getSessionFocusTarget } = require("../src/session-focus");
const { focusCodeBuddyIdeApp, codeBuddyMacBundleCandidates } = require("../src/process-app-focus");
const { buildSessionSnapshotEntry } = require("../src/state-session-snapshot");

describe("CodeBuddy IDE session title", () => {
  it("uses the first non-blank prompt line for UserPromptSubmit", () => {
    assert.equal(deriveSessionTitle("UserPromptSubmit", { prompt: "  first line  second" }), "first line  second");
  });

  it("prefers a native session title and truncates long values", () => {
    assert.equal(deriveSessionTitle("UserPromptSubmit", { session_title: "正式标题", prompt: "ignored" }), "正式标题");
    const long = "x".repeat(SESSION_TITLE_MAX + 5);
    assert.equal(deriveSessionTitle("UserPromptSubmit", { session_title: long }), "x".repeat(SESSION_TITLE_MAX - 1) + "\u2026");
  });

  it("does not derive a title from non-prompt events or secret-looking prompts", () => {
    assert.equal(deriveSessionTitle("Stop", { prompt: "not a title" }), null);
    assert.equal(deriveSessionTitle("UserPromptSubmit", { prompt: "token=abc123" }), null);
  });
});

describe("CodeBuddy hook metadata", () => {
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
});

describe("CodeBuddy IDE focus target", () => {
  it("uses an app focus target for CodeBuddyIDE and terminal for bare CLI", () => {
    const base = { id: "cb", agentId: "codebuddy", sourcePid: 731, state: "working" };
    assert.deepEqual(getSessionFocusTarget({ ...base, codebuddyClient: "CodeBuddyIDE" }), {
      canFocus: true,
      type: "codebuddy-ide",
      url: null,
    });
    assert.deepEqual(getSessionFocusTarget({ ...base, codebuddyClient: "CLI" }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
  });

  it("falls back to terminal when no client metadata exists", () => {
    assert.equal(getSessionFocusTarget({ id: "cb", agentId: "codebuddy", sourcePid: 731 }).type, "terminal");
  });

  it("uses a conversation deep link only when the installed build reports a scheme", () => {
    const base = { id: "cb", rawSessionId: "4fae4d89-664c-4901-aacf-910946b91ff1", agentId: "codebuddy", sourcePid: 731, codebuddyClient: "CodeBuddyIDE" };
    assert.deepEqual(getSessionFocusTarget({ ...base, codebuddyUrlScheme: "codebuddycn-insiders" }), {
      canFocus: true,
      type: "codebuddy-conversation",
      url: "codebuddycn-insiders://codebuddy-ide/conversation/open?id=4fae4d89-664c-4901-aacf-910946b91ff1",
    });
    assert.deepEqual(getSessionFocusTarget(base), { canFocus: true, type: "codebuddy-ide", url: null });
    assert.equal(getSessionFocusTarget({ ...base, codebuddyClient: "CLI", codebuddyUrlScheme: "codebuddycn-insiders" }).type, "terminal");
  });
});

describe("CodeBuddy conversation route capability", () => {
  it("detects the Insiders build and rejects builds without the route", () => {
    const files = {
      "/Applications/CodeBuddy CN Insiders.app/Contents/Resources/app/out/main.js": "x/conversation/open/y",
      "/Applications/CodeBuddy CN Insiders.app/Contents/Resources/app/product.json": JSON.stringify({ urlProtocol: "codebuddycn-insiders" }),
      "/Applications/CodeBuddy CN.app/Contents/Resources/app/out/main.js": "no route",
      "/Applications/CodeBuddy CN.app/Contents/Resources/app/product.json": JSON.stringify({ urlProtocol: "codebuddycn" }),
    };
    const fsApi = { readFileSync: (p) => { if (!(p in files)) throw new Error("missing"); return files[p]; } };
    assert.deepEqual(readCodeBuddyAppInfo("/Applications/CodeBuddy CN Insiders.app/Contents/Frameworks/x", fsApi), { bundlePath: "/Applications/CodeBuddy CN Insiders.app", urlScheme: "codebuddycn-insiders" });
    assert.deepEqual(readCodeBuddyAppInfo("/Applications/CodeBuddy CN.app/Contents/MacOS/Electron", fsApi), { bundlePath: "/Applications/CodeBuddy CN.app", urlScheme: null });
  });

  it("continues to the outer bundle when a nested app has no route", () => {
    const files = {
      "/Applications/Outer.app/Contents/Resources/app/out/main.js": "x/conversation/open/y",
      "/Applications/Outer.app/Contents/Resources/app/product.json": JSON.stringify({ urlProtocol: "outercn" }),
    };
    const fsApi = { readFileSync: (p) => { if (!(p in files)) throw new Error("missing"); return files[p]; } };
    assert.deepEqual(readCodeBuddyAppInfo("/Applications/Outer.app/Contents/Frameworks/Inner.app/Contents/MacOS/Inner", fsApi), { bundlePath: "/Applications/Outer.app", urlScheme: "outercn" });
  });
});

describe("CodeBuddy IDE app activation", () => {
  it("activates a known macOS bundle through /usr/bin/open", async () => {
    const calls = [];
    const result = await focusCodeBuddyIdeApp({}, {
      platform: "darwin",
      fs: { existsSync: (p) => p === "/Applications/CodeBuddy CN.app" },
      execFile(bin, args, _options, done) {
        calls.push([bin, args]);
        done(null);
      },
    });
    assert.equal(result.submitted, true);
    assert.deepEqual(calls, [["/usr/bin/open", ["/Applications/CodeBuddy CN.app"]]]);
  });

  it("reports not found when no candidate bundle exists", async () => {
    const result = await focusCodeBuddyIdeApp({}, {
      platform: "darwin",
      fs: { existsSync: () => false },
      execFile(_bin, _args, _options, done) { done(new Error("should not run")); },
    });
    assert.equal(result.reason, "codebuddy-app-not-found");
  });

  it("does not activate another distribution when the session bundle is missing", async () => {
    const result = await focusCodeBuddyIdeApp({ codebuddyAppBundle: "/Applications/Missing.app" }, {
      platform: "darwin",
      fs: { existsSync: (p) => p === "/Applications/CodeBuddy CN Insiders.app" },
      execFile(_bin, _args, _options, done) { done(new Error("should not run")); },
    });
    assert.equal(result.reason, "codebuddy-session-app-not-found");
  });

  it("keeps candidate paths under Applications", () => {
    const candidates = codeBuddyMacBundleCandidates();
    assert.ok(candidates.includes("/Applications/CodeBuddy CN Insiders.app"));
    assert.ok(candidates.includes("/Applications/CodeBuddy CN.app"));
    assert.ok(candidates.every(p => p.endsWith(".app")));
  });
});

describe("CodeBuddy IDE dashboard snapshot", () => {
  it("exposes the app focus target and a prompt-derived title", () => {
    const entry = buildSessionSnapshotEntry("codebuddy:ba737487", {
      id: "codebuddy:ba737487",
      rawSessionId: "ba737487",
      agentId: "codebuddy",
      sourcePid: 12089,
      sessionTitle: "分辨率分别是？",
      codebuddyClient: "CodeBuddyIDE",
      state: "attention",
    }, {});
    assert.equal(entry.sessionTitle, "分辨率分别是？");
    assert.equal(entry.codebuddyClient, "CodeBuddyIDE");
    assert.equal(entry.focusTarget.type, "codebuddy-ide");
    assert.equal(entry.canFocus, true);
  });
});

describe("CodeBuddy app bundle selection", () => {
  it("activates the session's own bundle before generic candidates", async () => {
    const calls = [];
    const result = await focusCodeBuddyIdeApp({ codebuddyAppBundle: "/Applications/CodeBuddy CN.app" }, {
      platform: "darwin",
      fs: { existsSync: (p) => p === "/Applications/CodeBuddy CN.app" || p === "/Applications/CodeBuddy CN Insiders.app" },
      execFile(bin, args, _options, done) { calls.push([bin, args]); done(null); },
    });
    assert.equal(result.submitted, true);
    assert.deepEqual(calls, [["/usr/bin/open", ["/Applications/CodeBuddy CN.app"]]]);
  });
});
