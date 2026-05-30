"use strict";

const { quoteForPosixShellArg } = require("./remote-ssh-quote");
const { normalizeClaudeUsageResponse } = require("./usage-parsers");
const { runRemoteUsageFetch } = require("./usage-remote-fetch");

// Remote Node snippet: reads the OAuth accessToken from the remote
// ~/.claude/.credentials.json, calls the Claude usage API directly, and
// streams the raw usage JSON body back to stdout. On any failure it emits a
// small {"error":...} JSON object instead, which the receiver treats as an
// empty result. A 429 is reported as {"error":"http:429","retry_after":<sec>}
// so the local runtime can arm the same shared 429 backoff for remote polls.
// The write-then-exit-in-flush-callback pattern is required:
// process.exit(0) right after process.stdout.write() truncates payloads
// because the pipe write is async and exit() kills the process before the
// OS pipe buffer drains. The callback fires post-flush.
// TODO(remote-statusline): prefer SSH `cat ~/.clawd/statusline.json` first and
// only fall back to this API call when the remote snapshot is stale, mirroring
// the local hybrid. For now the remote path is API-only with 429 backoff.
const REMOTE_CLAUDE_USAGE_JS =
  "(function(){" +
  "const fs=require('fs'),path=require('path'),os=require('os'),https=require('https');" +
  "const p=path.join(os.homedir(),'.claude','.credentials.json');" +
  "let o;try{o=JSON.parse(fs.readFileSync(p,'utf8')).claudeAiOauth||{};}catch(e){process.stdout.write(JSON.stringify({error:'no-creds'}),()=>process.exit(0));return;}" +
  "const tok=o.accessToken;" +
  "if(!tok){process.stdout.write(JSON.stringify({error:'no-token'}),()=>process.exit(0));return;}" +
  "const req=https.request('https://api.anthropic.com/api/oauth/usage',{method:'GET',headers:{authorization:'Bearer '+tok,'anthropic-beta':'oauth-2025-04-20','user-agent':'claude-code/2.1.0'},timeout:8000},(res)=>{" +
  "let b='';res.on('data',d=>b+=d);res.on('end',()=>{" +
  "if(res.statusCode<200||res.statusCode>=300){var ra=res.headers&&res.headers['retry-after'];process.stdout.write(JSON.stringify({error:'http:'+res.statusCode,retry_after:ra||null}),()=>process.exit(0));return;}" +
  "process.stdout.write(b,()=>process.exit(0));});" +
  "});" +
  "req.on('error',e=>{process.stdout.write(JSON.stringify({error:'req:'+e.message}),()=>process.exit(0));});" +
  "req.on('timeout',()=>{req.destroy();process.stdout.write(JSON.stringify({error:'timeout'}),()=>process.exit(0));});" +
  "req.end();" +
  "})();";

function buildRemoteClaudeUsageCommand(nodeBin = "node") {
  const node = nodeBin === "node" ? "node" : quoteForPosixShellArg(nodeBin);
  return `${node} -e ${quoteForPosixShellArg(REMOTE_CLAUDE_USAGE_JS)}`;
}

function fetchRemoteClaudeUsage(profile, options = {}) {
  return runRemoteUsageFetch({
    profile,
    provider: "claude",
    buildCommand: buildRemoteClaudeUsageCommand,
    // capturedAtMs = the moment we received the live usage response. See
    // normalizeClaudeUsageResponse for why this is the correct freshness key.
    parse: (text, { capturedAtMs }) => {
      const trimmed = text.trim();
      if (!trimmed) return null;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (parsed && parsed.error) {
        // Propagate a remote 429 so the local runtime arms the shared backoff
        // (skips the next remote + local API poll). Other errors stay empty.
        if (typeof parsed.error === "string" && parsed.error === "http:429") {
          const secs = Number(parsed.retry_after);
          return {
            provider: "claude",
            limits: [],
            rateLimited: true,
            retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
          };
        }
        return null;
      }
      return normalizeClaudeUsageResponse(parsed, capturedAtMs);
    },
    options,
  });
}

module.exports = {
  REMOTE_CLAUDE_USAGE_JS,
  buildRemoteClaudeUsageCommand,
  fetchRemoteClaudeUsage,
};
