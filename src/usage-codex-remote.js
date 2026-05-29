"use strict";

const childProcess = require("child_process");
const { buildSshArgs } = require("./remote-ssh-runtime");
const { extractCodexRateLimitsFromJsonl } = require("./usage-parsers");

const REMOTE_CODEX_USAGE_JS =
  "(function(){" +
  "const fs=require('fs'),path=require('path'),os=require('os');" +
  "const base=path.join(os.homedir(),'.codex','sessions');" +
  "function dirs(p,r){try{return fs.readdirSync(p,{withFileTypes:true}).filter(r).map(d=>d.name).sort((a,b)=>b.localeCompare(a));}catch{return[]}}" +
  "for(const y of dirs(base,d=>d.isDirectory()&&/^\\d{4}$/.test(d.name))){" +
    "const yp=path.join(base,y);" +
    "for(const m of dirs(yp,d=>d.isDirectory()&&/^\\d{2}$/.test(d.name))){" +
      "const mp=path.join(yp,m);" +
      "for(const dd of dirs(mp,d=>d.isDirectory()&&/^\\d{2}$/.test(d.name))){" +
        "const dp=path.join(mp,dd);" +
        "const f=dirs(dp,d=>d.isFile&&d.isFile()&&d.name.startsWith('rollout-')&&d.name.endsWith('.jsonl'))[0];" +
        // Write then exit ONLY inside the flush callback. process.exit(0)
        // right after process.stdout.write() truncates large payloads: the
        // write to a pipe is async and exit() kills the process before the
        // OS pipe buffer (~64KB) drains. The callback fires post-flush.
        "if(f){process.stdout.write(fs.readFileSync(path.join(dp,f),'utf8'),()=>process.exit(0));return}" +
      "}" +
    "}" +
  "}" +
  "})();";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildRemoteCodexUsageCommand(nodeBin = "node") {
  const node = nodeBin === "node" ? "node" : shellQuote(nodeBin);
  return `${node} -e ${shellQuote(REMOTE_CODEX_USAGE_JS)}`;
}

function fetchRemoteCodexUsage(profile, options = {}) {
  const spawn = options.spawn || childProcess.spawn;
  const runtime = options.runtime || null;
  const timeoutMs = options.timeoutMs || 8000;
  const nodeBin = profile && profile.remoteNodeBin ? profile.remoteNodeBin : "node";
  const args = buildSshArgs(profile).concat([buildRemoteCodexUsageCommand(nodeBin)]);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ssh", args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ provider: "codex", limits: [] });
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
      finish({ provider: "codex", limits: [] });
    }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => finish({ provider: "codex", limits: [] }));
    child.on("exit", (code) => { exitCode = code; });
    // Wait for "close" (all stdio drained), not "exit": on large remote
    // payloads the process can exit while stdout still has unread bytes in the
    // pipe buffer, which truncates the JSONL and makes the parser return 0
    // limits. "close" guarantees the full stdout has been read.
    child.on("close", (code) => {
      const finalCode = exitCode != null ? exitCode : code;
      if (finalCode !== 0) {
        finish({ provider: "codex", limits: [] });
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      finish({
        ...extractCodexRateLimitsFromJsonl(text),
        source: { kind: "remote", profileId: profile && profile.id },
      });
    });
  });
}

module.exports = {
  REMOTE_CODEX_USAGE_JS,
  buildRemoteCodexUsageCommand,
  fetchRemoteCodexUsage,
};
