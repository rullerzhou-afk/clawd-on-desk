"use strict";

// Shared SSH usage fetcher used by both src/usage-codex-remote.js and
// src/usage-claude-remote.js. Both remote fetchers are byte-for-byte identical
// SSH wrappers around a remote `node -e <snippet>` command; the only real
// differences are (a) the remote snippet string, (b) how stdout is parsed, and
// (c) whether the receive time (capturedAtMs) is stamped on the result. This
// module owns the spawn / timeout / registerChild / close-vs-exit / truncate
// guard logic so neither provider has to reimplement it.

const childProcess = require("child_process");
const { buildSshArgs } = require("./remote-ssh-runtime");

// Resolve a remote node binary into the command-line token used after `ssh`.
// `node` (the default) is passed through unquoted; anything else is POSIX
// single-quoted so paths with spaces / metacharacters survive the remote shell.
function resolveNodeBin(profile) {
  return profile && profile.remoteNodeBin ? profile.remoteNodeBin : "node";
}

// runRemoteUsageFetch drives one remote SSH usage probe and resolves to the
// parsed result, or an empty result on any failure (spawn error, timeout,
// non-zero remote exit, or a parser that throws / returns nothing).
//
// Params:
//   profile      Remote SSH profile (used for buildSshArgs + remoteNodeBin + id).
//   provider     "codex" | "claude"; used for the empty-result shape.
//   buildCommand (nodeBin) => string : the remote `node -e ...` command.
//   parse        (text, ctx) => result | falsy : provider-specific stdout parser.
//                ctx = { capturedAtMs, profile }. Returning a falsy value (or
//                throwing) yields the empty result. The returned object is
//                spread into the final result alongside `source`.
//   options      { spawn, runtime, timeoutMs, now } : all injectable for tests.
function runRemoteUsageFetch({ profile, provider, buildCommand, parse, options = {} }) {
  const spawn = options.spawn || childProcess.spawn;
  const runtime = options.runtime || null;
  const timeoutMs = options.timeoutMs || 8000;
  const now = options.now || Date.now;
  const emptyResult = () => ({ provider, limits: [] });
  const nodeBin = resolveNodeBin(profile);
  const args = buildSshArgs(profile).concat([buildCommand(nodeBin)]);

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
    // Wait for "close" (all stdio drained), not "exit": on large remote
    // payloads the process can exit while stdout still has unread bytes in the
    // pipe buffer, which truncates the body and makes the parser return 0
    // limits. "close" guarantees the full stdout has been read. This pairs with
    // the remote snippet's process.stdout.write(payload, ()=>process.exit(0))
    // flush-callback guard; do not weaken either side.
    child.on("close", (code) => {
      const finalCode = exitCode != null ? exitCode : code;
      // capturedAtMs = the moment we received the live response. Computed at
      // close time so providers that stamp freshness (Claude) get the receive
      // time; providers that derive it from the payload (Codex) can ignore it.
      const capturedAtMs = now();
      if (finalCode !== 0) {
        finish(emptyResult());
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try {
        parsed = parse(text, { capturedAtMs, profile });
      } catch {
        finish(emptyResult());
        return;
      }
      if (!parsed) {
        finish(emptyResult());
        return;
      }
      finish({
        ...parsed,
        source: { kind: "remote", profileId: profile && profile.id },
      });
    });
  });
}

module.exports = {
  runRemoteUsageFetch,
};
