"use strict";

const { quoteForPosixShellArg } = require("./remote-ssh-quote");
const { extractCodexRateLimitsFromJsonl } = require("./usage-parsers");
const { runRemoteUsageFetch } = require("./usage-remote-fetch");

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

function buildRemoteCodexUsageCommand(nodeBin = "node") {
  const node = nodeBin === "node" ? "node" : quoteForPosixShellArg(nodeBin);
  return `${node} -e ${quoteForPosixShellArg(REMOTE_CODEX_USAGE_JS)}`;
}

function fetchRemoteCodexUsage(profile, options = {}) {
  return runRemoteUsageFetch({
    profile,
    provider: "codex",
    buildCommand: buildRemoteCodexUsageCommand,
    // Codex derives capturedAtMs from the JSONL timestamp inside the parser, so
    // the receive-time stamp is unused here.
    parse: (text) => extractCodexRateLimitsFromJsonl(text),
    options,
  });
}

module.exports = {
  REMOTE_CODEX_USAGE_JS,
  buildRemoteCodexUsageCommand,
  fetchRemoteCodexUsage,
};
