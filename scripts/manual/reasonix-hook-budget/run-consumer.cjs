"use strict";

// Windows-only fixture driver. No Reasonix CLI session and no model calls.
// All settings, app data, runtime identity and optional preload live under TEMP.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] == null) throw new Error("Arguments must be --name value pairs");
    parsed[argv[i].slice(2)] = argv[i + 1];
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("Run on Windows; use node --check for a non-executing syntax check elsewhere");
  if (!args.consumer || !args.repo) throw new Error("Required: --consumer ABSOLUTE_EXE --repo ABSOLUTE_CLAWD_ROOT");
  const consumer = path.resolve(args.consumer);
  const repo = path.resolve(args.repo);
  const hookPath = path.resolve(args.hook || path.join(repo, "hooks", "reasonix-hook.js"));
  const mode = args.mode || "normal";
  const expect = args.expect || "pass";
  const delayMs = Number(args["delay-ms"] || 0);
  const repeat = Number(args.repeat || 1);
  const port = Number(args.port || 23337);
  const events = args.event && args.event !== "both" ? [args.event] : ["UserPromptSubmit", "PreToolUse"];
  if (!["normal", "stream"].includes(mode) || !["pass", "block"].includes(expect)) throw new Error("Invalid mode or expected decision");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 3000) throw new Error("delay-ms must be 0..3000");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("repeat must be 1..5");
  if (!Number.isInteger(port) || port < 23333 || port > 23337) throw new Error("port must be 23333..23337");
  if (events.some((event) => !["UserPromptSubmit", "PreToolUse"].includes(event))) throw new Error("Invalid event");
  for (const target of [consumer, hookPath]) if (!fs.statSync(target).isFile()) throw new Error(`Not a file: ${target}`);

  const { __test: installer } = require(path.join(repo, "hooks", "reasonix-install.js"));
  const command = installer.buildReasonixHookCommand(process.execPath, hookPath, { platform: "win32" });
  if (!command.includes("-EncodedCommand ")) throw new Error("Expected actual installer-produced Windows EncodedCommand");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-native-1198-"));
  const server = http.createServer();
  const requests = [];
  const sockets = new Set();
  const timers = new Set();
  let child = null;
  let watchdog = null;
  let failed = false;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("request", (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      requests.push({ method: req.method, path: req.url, event: parsed && parsed.event, agentId: parsed && parsed.agent_id });
      if (mode === "normal") {
        res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
        res.end('{"ok":true}');
      } else {
        // Real HTTP, no monkeypatch: 30 ms chunks keep the 100 ms inactivity
        // timeout alive; no identity header means the client waits for EOF.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("x");
        const timer = setInterval(() => res.write("x"), 30);
        timers.add(timer);
        res.on("close", () => { clearInterval(timer); timers.delete(timer); });
      }
    });
  });
  try {
    // Refuse an occupied port; never stop or reuse an existing Clawd server.
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    for (let iteration = 1; iteration <= repeat; iteration++) {
      for (const event of events) {
        const home = path.join(root, `${iteration}-${event}`);
        for (const dir of [home, path.join(home, ".clawd"), path.join(home, "reasonix"), path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local"), path.join(home, "tmp")]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(home, ".clawd", "runtime.json"), JSON.stringify({ app: "clawd-on-desk", port, ownerPid: process.pid }));
        const isolatedEnv = {
          HOME: home, USERPROFILE: home,
          APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
          TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"), REASONIX_HOME: path.join(home, "reasonix"),
          NODE_OPTIONS: "",
        };
        if (delayMs > 0) {
          const preload = path.join(home, "startup-delay.cjs");
          // Controlled delay before the hook module (and HOOK_STARTED_AT).
          // This simulates launch overhead; it is not a claim about normal PCs.
          fs.writeFileSync(preload, `const fs = require("node:fs");\nconst t = Date.now();\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});\nfs.writeFileSync(${JSON.stringify(path.join(home, "delay-proof.json"))}, JSON.stringify({ pid: process.pid, requestedMs: ${delayMs}, elapsedMs: Date.now()-t }));\n`);
          isolatedEnv.NODE_OPTIONS = `--require="${preload.replace(/\\/g, "/")}"`;
        }
        const hookEntry = { match: "*", command, env: isolatedEnv };
        fs.writeFileSync(path.join(home, "reasonix", "settings.json"), JSON.stringify({ hooks: { [event]: [hookEntry] } }, null, 2));
        const env = { ...process.env, ...isolatedEnv };
        for (const name of Object.keys(env)) if (name.startsWith("CLAWD_")) delete env[name];
        const requestStart = requests.length;
        child = spawn(consumer, ["-home", home, "-event", event, "-expect", expect], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        watchdog = setTimeout(() => child && child.kill(), 12000);
        const [code, signal] = await once(child, "close");
        clearTimeout(watchdog);
        watchdog = null;
        // The official timeout kills cmd.exe and bounds pipe draining. A Node
        // descendant can briefly remain, so let this fixture finish naturally
        // before closing its streaming socket or removing its temporary home.
        if (expect === "block") await new Promise((resolve) => setTimeout(resolve, 2500));
        child = null;
        const result = JSON.parse(stdout.trim());
        const observed = requests.slice(requestStart);
        const delayProof = delayMs ? JSON.parse(fs.readFileSync(path.join(home, "delay-proof.json"), "utf8")) : null;
        const oneExpectedPost = observed.length === 1 && observed[0].method === "POST" && observed[0].path === "/state" && observed[0].event === event && observed[0].agentId === "reasonix";
        const ok = code === 0 && signal === null && stderr === "" && oneExpectedPost;
        console.log(JSON.stringify({ mode, expected: expect, iteration, nodeVersion: process.version, hookPath, injectedStartupDelayMs: delayMs, delayProof, requests: observed, consumer: result, harnessExitCode: code, harnessSignal: signal, harnessStderr: stderr, ok }));
        if (!ok) failed = true;
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null) child.kill();
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
