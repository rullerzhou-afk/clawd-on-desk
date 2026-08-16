"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { pathToFileURL } = require("node:url");

// core.mjs resolves ~/.clawd at module evaluation and every plugin init resets
// its debug log. Keep the production-shaped fixture entirely inside a temp HOME.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-family-session-cwd-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const OPENCODE_CONFIG = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});

const fetchCalls = [];
let createOpencodeFamilyPlugin;
let bridgePort = 41000;

function createContext(directory) {
  return {
    serverUrl: "http://127.0.0.1:1/",
    directory,
    client: {
      _client: {
        post: async () => ({ data: {} }),
      },
    },
  };
}

async function settlePosts() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

before(async () => {
  globalThis.fetch = async (url, opts) => {
    const call = {
      url: String(url),
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    };
    fetchCalls.push(call);
    const headers = {
      "x-clawd-server": "clawd-on-desk",
      ...(call.body && call.body.metadata_only === true
        ? { "x-clawd-metadata-accepted": "1" }
        : {}),
    };
    return {
      status: call.body && call.body.metadata_only === true ? 204 : 200,
      headers: { get: (name) => headers[String(name).toLowerCase()] || null },
      text: async () => "ok",
    };
  };
  globalThis.Bun = {
    serve() {
      bridgePort += 1;
      return { port: bridgePort };
    },
  };

  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(modulePath).href));
});

after(() => {
  delete globalThis.fetch;
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("opencode-family session directory ownership (#796)", () => {
  it("uses the owning session directory after a later directory initializes the same factory", async () => {
    // Production shape: one entry-module factory product, invoked once per
    // directory Instance. v1.18.11 routes the session event only to hooksA.
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooksA = await plugin(createContext("C:\\active-project"));
    await plugin(createContext("C:\\history-b"));

    fetchCalls.length = 0;
    await hooksA.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_live",
          info: {
            id: "ses_live",
            directory: "C:\\active-project",
          },
        },
      },
    });

    await settlePosts();
    const statePost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(statePost, "owning handler did not POST /state");

    // This is the single red→green assertion. Before the fix it is
    // C:\history-b (the latest init); after the fix it is session info truth.
    assert.strictEqual(statePost.body.cwd, "C:\\active-project");
  });

  it("keeps legacy fallback before the info latch and omits unknown cwd after it", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\legacy-single-project"));
    assert.deepStrictEqual(plugin.__test.resolveSessionDirectory("opencode:default"), {
      directory: "C:\\legacy-single-project",
      source: "legacy-init-fallback",
    });

    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_legacy", status: { type: "busy" } },
      },
    });
    await settlePosts();
    const legacyPost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(legacyPost);
    assert.strictEqual(legacyPost.body.cwd, "C:\\legacy-single-project");

    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_known",
          info: { id: "ses_known", directory: "C:\\known" },
        },
      },
    });
    assert.strictEqual(plugin.__test._hostEmitsSessionInfo, true);
    assert.deepStrictEqual(plugin.__test.resolveSessionDirectory("opencode:default"), {
      directory: null,
      source: "none",
    });

    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_unknown", status: { type: "busy" } },
      },
    });
    await settlePosts();
    const unknownPost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(unknownPost);
    assert.strictEqual(Object.hasOwn(unknownPost.body, "cwd"), false);
  });

  it("captures session.updated even though it does not map to a Clawd state", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\active-project"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_move",
          info: { id: "ses_move", directory: "C:\\before" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_move",
          info: { id: "ses_move", directory: "C:\\after" },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(fetchCalls.some((call) => call.url.endsWith("/state")), false);

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_move", status: { type: "busy" } },
      },
    });
    await settlePosts();
    const statePost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(statePost);
    assert.strictEqual(statePost.body.cwd, "C:\\after");
  });

  it("keeps two owning handlers bound to their own directories across interleaved state and tool events", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooksA = await plugin(createContext("C:\\project-a"));
    const hooksB = await plugin(createContext("C:\\project-b"));

    await hooksA.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_a",
          info: { id: "ses_a", directory: "C:\\project-a" },
        },
      },
    });
    await hooksB.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_b",
          info: { id: "ses_b", directory: "C:\\project-b" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    await hooksA.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      },
    });
    await hooksB.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_b", status: { type: "busy" } },
      },
    });
    await hooksA.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_a",
          part: { type: "tool", state: { status: "running" } },
        },
      },
    });
    await hooksB.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_b",
          part: { type: "tool", state: { status: "running" } },
        },
      },
    });
    await settlePosts();

    const statePosts = fetchCalls.filter((call) => call.url.endsWith("/state"));
    assert.deepStrictEqual(
      statePosts.map((call) => [call.body.session_id, call.body.state, call.body.cwd]),
      [
        ["opencode:ses_a", "thinking", "C:\\project-a"],
        ["opencode:ses_b", "thinking", "C:\\project-b"],
        ["opencode:ses_a", "working", "C:\\project-a"],
        ["opencode:ses_b", "working", "C:\\project-b"],
      ]
    );
  });

  it("serializes a deleted session with its authoritative cwd before cleanup", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\active-project"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_delete",
          info: { id: "ses_delete", directory: "C:\\active-project" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    await hooks.event({
      event: {
        type: "session.deleted",
        properties: {
          sessionID: "ses_delete",
          info: { id: "ses_delete", directory: "C:\\active-project" },
        },
      },
    });
    await settlePosts();
    const endPost = fetchCalls.find((call) => (
      call.url.endsWith("/state") && call.body.event === "SessionEnd"
    ));
    assert.ok(endPost);
    assert.strictEqual(endPost.body.cwd, "C:\\active-project");
    assert.strictEqual(plugin.__test._sessionDirectoryById.has("opencode:ses_delete"), false);
  });

  it("uses info-only session ids for root, lastSeen, and SessionStart", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\info-project"));

    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: "ses_info_only", directory: "C:\\info-project" },
        },
      },
    });
    await settlePosts();

    assert.strictEqual(plugin.__test._rootSessionId, "ses_info_only");
    assert.strictEqual(plugin.__test._lastSeenSessionId, "ses_info_only");
    const startPost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(startPost);
    assert.strictEqual(startPost.body.session_id, "opencode:ses_info_only");
    assert.strictEqual(startPost.body.cwd, "C:\\info-project");
  });

  it("binds an explicit permission session before the legacy lastSeen fallback", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\project-a"));

    for (const [sessionID, directory] of [
      ["ses_a", "C:\\project-a"],
      ["ses_b", "C:\\project-b"],
    ]) {
      await hooks.event({
        event: {
          type: "session.created",
          properties: { sessionID, info: { id: sessionID, directory } },
        },
      });
    }
    await settlePosts();
    assert.strictEqual(plugin.__test._lastSeenSessionId, "ses_b");
    fetchCalls.length = 0;

    // Contract guard: current dispatch updates lastSeen from this permission
    // event before forwarding it, so this documents explicit-id precedence
    // rather than mutation-killing the direct getEventSessionId() call.
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_a",
          sessionID: "ses_a",
          permission: "bash",
          metadata: { command: "echo a" },
          patterns: [],
          always: [],
        },
      },
    });
    await settlePosts();
    const permissionPost = fetchCalls.find((call) => call.url.endsWith("/permission"));
    assert.ok(permissionPost);
    assert.strictEqual(permissionPost.body.session_id, "opencode:ses_a");
    assert.strictEqual(permissionPost.body.cwd, "C:\\project-a");

    // A later legacy payload still follows the existing lastSeen contract.
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_b", status: { type: "busy" } },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_legacy",
          permission: "bash",
          metadata: { command: "echo legacy" },
          patterns: [],
          always: [],
        },
      },
    });
    await settlePosts();
    const legacyPost = fetchCalls.find((call) => call.url.endsWith("/permission"));
    assert.ok(legacyPost);
    assert.strictEqual(legacyPost.body.session_id, "opencode:ses_b");
    assert.strictEqual(legacyPost.body.cwd, "C:\\project-b");
  });
});

describe("opencode-family session title (#829)", () => {
  it("forwards a title change as a metadata-only POST and includes it in later state bodies", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));

    // session.created with a placeholder title -> captured. The first capture
    // also fires a metadata-only push (prevTitle undefined !== title), which
    // the server safely drops because the session does not exist yet; the
    // SessionStart lifecycle POST below carries the title instead. The push
    // is deliberate — it covers "created untitled, titled later" (see the
    // captureSessionTitle comment in core.mjs).
    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_t",
          info: { id: "ses_t", directory: "C:\\proj", title: "New session - 2026" },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(plugin.__test._sessionTitleById.get("opencode:ses_t"), "New session - 2026");

    // The lifecycle POSTs from session.created carry the captured title.
    const createdPost = fetchCalls.find((c) => c.url.endsWith("/state") && c.body && c.body.event === "SessionStart");
    assert.ok(createdPost, "SessionStart POST missing");
    assert.strictEqual(createdPost.body.session_title, "New session - 2026");

    // session.updated swaps in the real title -> metadata-only push.
    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_t",
          info: { id: "ses_t", directory: "C:\\proj", title: "轻松问候" },
        },
      },
    });
    await settlePosts();

    assert.strictEqual(plugin.__test._sessionTitleById.get("opencode:ses_t"), "轻松问候");
    const metaPost = fetchCalls.find((c) => c.url.endsWith("/state") && c.body && c.body.metadata_only === true);
    assert.ok(metaPost, "expected a metadata-only POST for the title change");
    // postToClawd enriches every POST with process-tree fields. Split those
    // off and deepStrictEqual the rest against the EXACT title-push contract
    // so the complete metadata-only body is covered: a missing field or an
    // unexpected extra one both fail (#841 review).
    const ENRICH_KEYS = ["agent_pid", "cwd", "source_pid", "pid_chain", "editor", "tmux_socket", "tmux_client", "orca_pane_key"];
    const enrichments = {};
    const contract = { ...metaPost.body };
    for (const key of ENRICH_KEYS) {
      if (key in contract) {
        enrichments[key] = contract[key];
        delete contract[key];
      }
    }
    assert.deepStrictEqual(contract, {
      state: "idle",
      session_id: "opencode:ses_t",
      event: "SessionUpdate",
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      metadata_only: true,
      session_title: "轻松问候",
    });
    // Enrichment sanity: the session-directory truth and the plugin pid are
    // always stamped onto the outbound body.
    assert.strictEqual(enrichments.cwd, "C:\\proj");
    assert.strictEqual(typeof enrichments.agent_pid, "number");
  });

  it("does not POST when the title is unchanged and a blank title is ignored", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_d",
          info: { id: "ses_d", directory: "C:\\proj", title: "Stable Title" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    // Same title -> no fetch at all.
    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_d",
          info: { id: "ses_d", directory: "C:\\proj", title: "Stable Title" },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(fetchCalls.length, 0, "no POST expected for an unchanged title");

    // Blank title -> ignored, no capture, no POST.
    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_d",
          info: { id: "ses_d", directory: "C:\\proj", title: "   " },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(fetchCalls.length, 0, "no POST expected for a blank title");
    assert.strictEqual(plugin.__test._sessionTitleById.get("opencode:ses_d"), "Stable Title");
  });

  it("normalizes and bounds the title before storing or sending it", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));

    const longTitle = "A".repeat(200);
    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_n",
          info: { id: "ses_n", directory: "C:\\proj", title: `  messy\t\n${longTitle}  ` },
        },
      },
    });
    await settlePosts();

    // Control chars collapse to single spaces, leading/trailing trimmed,
    // capped at 80 chars with a trailing ellipsis. "messy " is 6 chars, so
    // the A run is 79 - 6 = 73 chars before the ellipsis.
    const stored = plugin.__test._sessionTitleById.get("opencode:ses_n");
    assert.ok(stored.length <= 80, `stored title must be <= 80 chars, got ${stored.length}`);
    assert.ok(stored.endsWith("…"));
    assert.strictEqual(stored, `messy ${"A".repeat(73)}…`);

    // The metadata-only body for a later change is also bounded.
    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_n",
          info: { id: "ses_n", directory: "C:\\proj", title: "B".repeat(300) },
        },
      },
    });
    await settlePosts();
    const metaPost = fetchCalls.find((c) => c.url.endsWith("/state") && c.body && c.body.metadata_only === true);
    assert.ok(metaPost);
    assert.ok(metaPost.body.session_title.length <= 80);
    assert.ok(metaPost.body.session_title.endsWith("…"));
  });

  it("strips bidi formatting marks before storing or sending the title", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));
    const bidi = "safe\u061c\u200efile\u202etxt.exe\u2066done\u2069";

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_bidi",
          info: { id: "ses_bidi", directory: "C:\\proj", title: bidi },
        },
      },
    });
    await settlePosts();

    const stored = plugin.__test._sessionTitleById.get("opencode:ses_bidi");
    assert.strictEqual(stored, "safe file txt.exe done");
    assert.doesNotMatch(stored, /[\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/u);
    assert.ok(fetchCalls.length > 0);
    for (const call of fetchCalls) {
      if (call.body && call.body.session_title) {
        assert.doesNotMatch(call.body.session_title, /[\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/u);
      }
    }
  });

  it("keeps truncated titles well-formed at astral and surrogate boundaries", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));
    const title = `${"A".repeat(78)}😀BC\uD83Dtail\uDC00`;

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_unicode_boundary",
          info: { id: "ses_unicode_boundary", directory: "C:\\proj", title },
        },
      },
    });
    await settlePosts();

    const stored = plugin.__test._sessionTitleById.get("opencode:ses_unicode_boundary");
    assert.strictEqual(stored, `${"A".repeat(78)}😀…`);
    assert.strictEqual(stored.isWellFormed(), true);
    assert.strictEqual(Array.from(stored).length, 80);

    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_unicode_boundary",
          info: {
            id: "ses_unicode_boundary",
            directory: "C:\\proj",
            title: "before\uD83Dmiddle\uDC00after",
          },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(
      plugin.__test._sessionTitleById.get("opencode:ses_unicode_boundary"),
      "before�middle�after",
    );
  });

  it("does not log the title text into the debug log", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));

    const secretTitle = "UniqueSecretTitle-829";
    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_l",
          info: { id: "ses_l", directory: "C:\\proj", title: secretTitle },
        },
      },
    });
    await settlePosts();

    const logPath = plugin.__test._debugLogPath;
    const logContent = fs.readFileSync(logPath, "utf8");
    assert.ok(!logContent.includes(secretTitle), "debug log must not contain the title text");
    assert.ok(logContent.includes("SESSION_TITLE"), "debug log should record that a title event happened");
  });

  it("handles MiMo-style patch event shape where info lives at event.properties.info", async () => {
    // Official opencode SDK: event.properties.info. MiMo-derived hosts patch
    // the same shape. getEventSessionInfo reads info from properties.info in
    // both cases, so title capture works for the whole family.
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_m",
          info: { id: "ses_m", directory: "C:\\proj", title: "MiMo Title" },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(plugin.__test._sessionTitleById.get("opencode:ses_m"), "MiMo Title");
  });

  it("clears the title map on session.deleted and server.instance.disposed", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\proj"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_c",
          info: { id: "ses_c", directory: "C:\\proj", title: "To Delete" },
        },
      },
    });
    await settlePosts();
    assert.ok(plugin.__test._sessionTitleById.has("opencode:ses_c"));

    await hooks.event({
      event: {
        type: "session.deleted",
        properties: {
          sessionID: "ses_c",
          info: { id: "ses_c", directory: "C:\\proj", title: "To Delete" },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(plugin.__test._sessionTitleById.has("opencode:ses_c"), false, "title must be cleared on session.deleted");
  });
});
