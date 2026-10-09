"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { launchedByGrok } = require("../hooks/clawd-hook");
const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID, SERVER_PORTS } = require("../hooks/server-config");

const CLAWD_HOOK = path.join(__dirname, "..", "hooks", "clawd-hook.js");
const CURSOR_HOOK = path.join(__dirname, "..", "hooks", "cursor-hook.js");
const GROK_HOOK = path.join(__dirname, "..", "hooks", "grok-hook.js");

function makeHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of [
    "CLAWD_REMOTE",
    "CLAWD_SSH_REMOTE",
    "CLAWD_WSL_DISTRO",
    "WSL_DISTRO_NAME",
    "GROK_SESSION_ID",
    "GROK_HOOK_EVENT",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function runHook(script, { args = [], input = "", env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => resolve({ status: null, stdout, stderr: `${stderr}${err}` }));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// Observable local state endpoint. The hook helper only accepts a runtime port
// from SERVER_PORTS, so bind the first free one and answer as Clawd.
function startStateEndpoint() {
  return new Promise((resolve, reject) => {
    const posts = [];
    const handler = (req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        posts.push({ method: req.method, url: req.url, body: parsed });
        res.writeHead(200, {
          [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ app: CLAWD_SERVER_ID }));
      });
    };
    const candidates = SERVER_PORTS.slice();
    let index = 0;
    const attempt = () => {
      if (index >= candidates.length) {
        reject(new Error("no free Clawd state port available for the guard test"));
        return;
      }
      const port = candidates[index++];
      const server = http.createServer(handler);
      server.once("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
          server.close(() => attempt());
          return;
        }
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => resolve({ server, port, posts }));
    };
    attempt();
  });
}

function statePosts(endpoint) {
  return endpoint.posts.filter((entry) => entry.method === "POST" && entry.url === "/state");
}

describe("Grok compatibility guards", () => {
  it("activates the Claude guard only on a non-empty GROK_HOOK_EVENT", () => {
    assert.strictEqual(launchedByGrok({ GROK_HOOK_EVENT: "session_start" }), true);
    assert.strictEqual(launchedByGrok({ GROK_HOOK_EVENT: "   " }), false);
    assert.strictEqual(launchedByGrok({ GROK_SESSION_ID: "sess-1" }), false);
    assert.strictEqual(launchedByGrok({ GROK_HOME: "/custom/grok" }), false);
    assert.strictEqual(launchedByGrok({ GROK_API_KEY: "unrelated" }), false);
    assert.strictEqual(launchedByGrok({}), false);
  });

  it("exits the Claude state hook passively under the Grok runner env", () => {
    const home = makeHome("clawd-grok-guard-");
    try {
      const result = spawnSync(process.execPath, [CLAWD_HOOK, "PreToolUse"], {
        input: JSON.stringify({ session_id: "sess-1" }),
        encoding: "utf8",
        timeout: 5000,
        env: isolatedEnv(home, { GROK_HOOK_EVENT: "pre_tool_use", GROK_SESSION_ID: "sess-1" }),
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "{}\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("exits the Cursor hook passively under the Grok runner env", () => {
    const home = makeHome("clawd-grok-guard-");
    try {
      const result = spawnSync(process.execPath, [CURSOR_HOOK], {
        input: JSON.stringify({ hook_event_name: "beforeSubmitPrompt" }),
        encoding: "utf8",
        timeout: 5000,
        env: isolatedEnv(home, { GROK_HOOK_EVENT: "user_prompt_submit" }),
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "{}\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("yields exactly one Grok POST and zero phantom Claude/Cursor POSTs", async () => {
    const home = makeHome("clawd-grok-guard-endpoint-");
    let endpoint = null;
    try {
      endpoint = await startStateEndpoint();
      fs.mkdirSync(path.join(home, ".clawd"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".clawd", "runtime.json"),
        JSON.stringify({ app: CLAWD_SERVER_ID, port: endpoint.port, ownerPid: process.pid }),
        "utf8"
      );

      // Grok's own adapter: exactly one state POST, passive stdout.
      const grok = await runHook(GROK_HOOK, {
        input: JSON.stringify({ hookEventName: "pre_tool_use", sessionId: "s-1", promptId: "turn-1" }),
        env: isolatedEnv(home, { GROK_HOOK_EVENT: "pre_tool_use" }),
      });
      assert.strictEqual(grok.status, 0);
      assert.strictEqual(grok.stdout, "{}\n");
      assert.strictEqual(statePosts(endpoint).length, 1);
      assert.strictEqual(statePosts(endpoint)[0].body.agent_id, "grok-build");
      assert.strictEqual(statePosts(endpoint)[0].body.session_id, "grok-build:s-1");

      // Imported default Claude compatibility: no phantom claude-code POST.
      const clawd = await runHook(CLAWD_HOOK, {
        args: ["SessionStart"],
        input: JSON.stringify({ session_id: "claude-1", hook_event_name: "SessionStart" }),
        env: isolatedEnv(home, { GROK_HOOK_EVENT: "session_start" }),
      });
      assert.strictEqual(clawd.status, 0);
      assert.strictEqual(clawd.stdout, "{}\n");

      // Cursor compatibility: no phantom cursor-agent POST.
      const cursor = await runHook(CURSOR_HOOK, {
        input: JSON.stringify({ hook_event_name: "beforeSubmitPrompt" }),
        env: isolatedEnv(home, { GROK_HOOK_EVENT: "user_prompt_submit" }),
      });
      assert.strictEqual(cursor.status, 0);
      assert.strictEqual(cursor.stdout, "{}\n");

      // Still exactly one POST in total.
      assert.strictEqual(statePosts(endpoint).length, 1);
    } finally {
      if (endpoint) await new Promise((resolve) => endpoint.server.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
