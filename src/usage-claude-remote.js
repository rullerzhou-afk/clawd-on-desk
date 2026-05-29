"use strict";

const childProcess = require("child_process");
const { buildSshArgs } = require("./remote-ssh-runtime");
const { normalizeClaudeUsageResponse } = require("./usage-parsers");

// Remote Node snippet: reads the OAuth accessToken from the remote
// ~/.claude/.credentials.json, calls the Claude usage API directly, and
// streams the raw usage JSON body back to stdout. On any failure it emits a
// small {"error":...} JSON object instead, which the receiver treats as an
// empty result. The write-then-exit-in-flush-callback pattern is required:
// process.exit(0) right after process.stdout.write() truncates payloads
// because the pipe write is async and exit() kills the process before the
// OS pipe buffer drains. The callback fires post-flush.
const REMOTE_CLAUDE_USAGE_JS =
  "(function(){" +
  "const fs=require('fs'),path=require('path'),os=require('os'),https=require('https');" +
  "const p=path.join(os.homedir(),'.claude','.credentials.json');" +
  "let o;try{o=JSON.parse(fs.readFileSync(p,'utf8')).claudeAiOauth||{};}catch(e){process.stdout.write(JSON.stringify({error:'no-creds'}),()=>process.exit(0));return;}" +
  "const tok=o.accessToken;" +
  "if(!tok){process.stdout.write(JSON.stringify({error:'no-token'}),()=>process.exit(0));return;}" +
  "const req=https.request('https://api.anthropic.com/api/oauth/usage',{method:'GET',headers:{authorization:'Bearer '+tok,'anthropic-beta':'oauth-2025-04-20','user-agent':'claude-code/2.1.0'},timeout:8000},(res)=>{" +
  "let b='';res.on('data',d=>b+=d);res.on('end',()=>{process.stdout.write(b,()=>process.exit(0));});" +
  "});" +
  "req.on('error',e=>{process.stdout.write(JSON.stringify({error:'req:'+e.message}),()=>process.exit(0));});" +
  "req.on('timeout',()=>{req.destroy();process.stdout.write(JSON.stringify({error:'timeout'}),()=>process.exit(0));});" +
  "req.end();" +
  "})();";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildRemoteClaudeUsageCommand(nodeBin = "node") {
  const node = nodeBin === "node" ? "node" : shellQuote(nodeBin);
  return `${node} -e ${shellQuote(REMOTE_CLAUDE_USAGE_JS)}`;
}

function emptyResult() {
  return { provider: "claude", limits: [] };
}

function fetchRemoteClaudeUsage(profile, options = {}) {
  const spawn = options.spawn || childProcess.spawn;
  const runtime = options.runtime || null;
  const timeoutMs = options.timeoutMs || 8000;
  const now = options.now || Date.now;
  const nodeBin = profile && profile.remoteNodeBin ? profile.remoteNodeBin : "node";
  const args = buildSshArgs(profile).concat([buildRemoteClaudeUsageCommand(nodeBin)]);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ssh", args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(emptyResult());
      return;
    }
    if (runtime && typeof runtime.registerChild === "function") runtime.registerChild(child);
    const chunks = [];
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (runtime && typeof runtime.unregisterChild === "function") runtime.unregisterChild(child);
      resolve(result);
    };
    let exitCode = null;
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(emptyResult());
    }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => finish(emptyResult()));
    child.on("exit", (code) => { exitCode = code; });
    // Wait for "close" (all stdio drained), not "exit": the remote process can
    // exit while stdout still has unread bytes in the pipe buffer, which would
    // truncate the JSON body. "close" guarantees the full stdout was read.
    child.on("close", (code) => {
      const finalCode = exitCode != null ? exitCode : code;
      // capturedAtMs = the moment we received the live usage response. See
      // normalizeClaudeUsageResponse for why this is the correct freshness key.
      const capturedAtMs = now();
      if (finalCode !== 0) {
        finish(emptyResult());
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        finish(emptyResult());
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(emptyResult());
        return;
      }
      if (parsed && parsed.error) {
        finish(emptyResult());
        return;
      }
      finish({
        ...normalizeClaudeUsageResponse(parsed, capturedAtMs),
        source: { kind: "remote", profileId: profile && profile.id },
      });
    });
  });
}

module.exports = {
  REMOTE_CLAUDE_USAGE_JS,
  buildRemoteClaudeUsageCommand,
  fetchRemoteClaudeUsage,
};
