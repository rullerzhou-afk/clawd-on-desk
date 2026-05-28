"use strict";

const childProcess = require("child_process");
const { buildSshArgs } = require("./remote-ssh-runtime");
const { extractCodexRateLimitsFromJsonl } = require("./usage-parsers");

const REMOTE_CODEX_USAGE_JS =
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
        "if(f){process.stdout.write(fs.readFileSync(path.join(dp,f),'utf8'));process.exit(0)}" +
      "}" +
    "}" +
  "}";

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
        stdio: ["ignore", "pipe", "ignore"],
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
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ provider: "codex", limits: [] });
    }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => finish({ provider: "codex", limits: [] }));
    child.on("exit", (code) => {
      if (code !== 0) {
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
