// opencode-family payload ↔ renderer contract (plan §3.5/§9).
//
// The bubble payload is the only channel between permission.js (which knows
// the registry) and bubble-renderer.js (which does not). This locks both
// sides of that contract:
//   - the payload builder emits the neutral family* vocabulary and never the
//     legacy per-agent names
//   - the renderer consumes exactly that vocabulary, emits the single
//     "family-always" decide behavior, and its blanket-always tooltip is
//     templated with {agent} in every language (a MiMo user must never read
//     "opencode" in the warning)

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const initPermission = require("../src/permission");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");
const { SUPPORTED_LANGS } = require("../src/i18n");

function makeCtx(overrides = {}) {
  return {
    lang: "en",
    focusTerminalForSession: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    updateDebugLog: null,
    sessionDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
    resolvePermissionEntry: () => {},
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function buildPayload(entryOverrides) {
  // The builder closes over ctx, so it is exposed on the initPermission
  // instance rather than module-level __test.
  const perm = initPermission(makeCtx());
  const permEntry = {
    res: null,
    abortHandler: null,
    suggestions: [],
    sessionId: "opencode:ses_1",
    bubble: null,
    hideTimer: null,
    toolName: "bash",
    toolInput: { command: "echo x" },
    resolvedSuggestion: null,
    createdAt: Date.now(),
    ...entryOverrides,
  };
  permEntry.interaction = permEntry.interaction || classifyPermissionInteraction({
    agentId: permEntry.agentId,
    toolName: permEntry.toolName,
  });
  return perm.buildPermissionBubblePayload(permEntry);
}

describe("opencode-family bubble payload", () => {
  it("forwards local detail and an explicit compact presentation epoch", () => {
    const payload = buildPayload({
      agentId: "claude-code",
      detailText: "full local detail",
      detailTruncated: true,
    });
    assert.strictEqual(payload.detailText, "full local detail");
    assert.strictEqual(payload.detailTruncated, true);
    assert.deepStrictEqual(payload.presentation, { expanded: false, measurementEpoch: 0 });
  });

  it("family entries emit the neutral family* vocabulary", () => {
    const payload = buildPayload({
      agentId: "opencode",
      familyRequestId: "req-1",
      familyBridgeUrl: "http://127.0.0.1:9",
      familyBridgeToken: "tok",
      familyAlwaysCandidates: ["bash"],
      familyPatterns: ["npm *"],
    });

    assert.strictEqual(payload.familyAgentId, "opencode");
    assert.strictEqual(payload.familyDisplayName, "OpenCode");
    assert.deepStrictEqual(payload.familyAlways, ["bash"]);
    assert.deepStrictEqual(payload.familyPatterns, ["npm *"]);
    // the legacy per-agent names must be gone from the payload surface
    assert.strictEqual("isOpencode" in payload, false);
    assert.strictEqual("opencodeAlways" in payload, false);
    assert.strictEqual("opencodePatterns" in payload, false);
  });

  it("non-family entries carry no family provenance", () => {
    const payload = buildPayload({ agentId: "claude-code" });
    assert.strictEqual(payload.familyAgentId, null);
    assert.strictEqual(payload.familyDisplayName, null);
    assert.deepStrictEqual(payload.familyAlways, []);
    assert.deepStrictEqual(payload.familyPatterns, []);
  });
});

describe("bubble-renderer family contract (static)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");

  // Per this repo's convention (see bubble-kimi-cue.test.js) the renderer is
  // asserted against its source rather than instantiated — but at STATEMENT
  // granularity inside the family branch, so breaking any rendering step
  // (detail chain, pill, Always wiring) fails a specific assertion instead of
  // surviving a loose includes() check.
  function familyBranch() {
    const start = source.indexOf("if (data.familyAgentId) {");
    assert.notStrictEqual(start, -1, "family branch not found");
    const end = source.indexOf("revealCard();", start);
    assert.notStrictEqual(end, -1, "family branch end not found");
    return source.slice(start, end);
  }

  it("renders the tool pill from the PascalCased tool name", () => {
    const branch = familyBranch();
    assert.match(branch, /const displayName = rawName\.charAt\(0\)\.toUpperCase\(\) \+ rawName\.slice\(1\);/);
    assert.match(branch, /toolPill\.setAttribute\("data-tool", displayName\);/);
  });

  it("keeps the full detail-selection chain: filepath → command → url → familyPatterns → raw JSON", () => {
    const branch = familyBranch();
    assert.match(branch, /detail = \[\.\.\.new Set\(input\.filepath\.split\(","\)/);
    assert.match(branch, /detail = input\.command;/);
    assert.match(branch, /detail = input\.url;/);
    assert.match(branch, /Array\.isArray\(data\.familyPatterns\) && data\.familyPatterns\.length/);
    assert.match(branch, /detail = \[\.\.\.new Set\(data\.familyPatterns\)\]\.join\(", "\);/);
    assert.match(branch, /commandBlock\.textContent = truncate\(detail, 200\);/);
  });

  it("wires the Always button: candidates gate, {agent} tooltip vars, family-always decide", () => {
    const branch = familyBranch();
    assert.match(branch, /Array\.isArray\(data\.familyAlways\) && data\.familyAlways\.length > 0/);
    assert.match(branch, /const agentName = data\.familyDisplayName \|\| data\.familyAgentId;/);
    assert.match(branch, /bubbleText\(data\.lang, "alwaysAllowBlanketTitle", \{ agent: agentName \}\)/);
    assert.match(branch, /window\.bubbleAPI\.decide\("family-always"\)/);
  });

  it("carries no legacy per-agent references anywhere in the renderer", () => {
    for (const legacy of ["data.isOpencode", "opencodeAlways", "opencodePatterns", '"opencode-always"']) {
      assert.strictEqual(source.includes(legacy), false, `legacy reference survived: ${legacy}`);
    }
  });

  it("blanket-always tooltip is {agent}-templated (twice) in every language, no hardcoded product name", () => {
    const lines = source.split("\n").filter((l) => l.includes("alwaysAllowBlanketTitle:"));
    assert.strictEqual(lines.length, SUPPORTED_LANGS.length,
      `expected the tooltip in exactly ${SUPPORTED_LANGS.length} supported languages`);
    for (const line of lines) {
      const occurrences = line.split("{agent}").length - 1;
      assert.strictEqual(occurrences, 2, `tooltip must use {agent} twice: ${line.trim().slice(0, 60)}…`);
      assert.strictEqual(/opencode/i.test(line), false, "tooltip must not hardcode a product name");
    }
  });

  it("bubbleText replaces every occurrence of a placeholder (repeated {agent})", () => {
    // bubbleText lives in the renderer (no registry/module access) — assert
    // the implementation uses split/join (replace-all) rather than a single
    // String.replace, which would leave the second {agent} unsubstituted.
    const fnMatch = source.match(/function bubbleText\([\s\S]*?\n}/);
    assert.ok(fnMatch, "bubbleText not found");
    assert.ok(fnMatch[0].includes(".split(") && fnMatch[0].includes(").join("),
      "bubbleText must replace all placeholder occurrences (split/join)");
  });
});
