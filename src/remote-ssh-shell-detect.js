"use strict";

// ── Remote SSH shell-type probe ──
//
// All of Remote SSH's deploy/monitor/probe commands assume a POSIX shell
// on the remote (`mkdir -p`, `~/...` tilde expansion, `sh -c`, `nohup &`,
// `node -e`). Windows OpenSSH server with its default cmd.exe shell
// silently rejects every one of these — the symptom is a string of
// CP936/GBK error bytes that decode to mojibake locally and a hook stack
// that never installs.
//
// This module runs one cheap probe after connect to classify the remote:
//
//   { ok: true,  shell: "posix",       os: "Linux"|"Darwin"|... }
//   { ok: true,  shell: "windows-cmd", os: "windows" }
//   { ok: false, shell: "unknown",     stderr?: <decoded> }
//
// The probe is two ssh round-trips at worst (POSIX → 1, Windows → 2). It
// shares the same `buildSshArgs` plumbing so non-default-port and
// identityFile profiles work; it never throws, so a probe failure leaves
// the connect/deploy flow to whatever error path was already there.

const childProcess = require("child_process");
const { decodeShellBytes } = require("./remote-ssh-decode");

const PROBE_TIMEOUT_MS = 15000;
// Serialized proxy transports such as `gh cs ssh --stdio` have a noticeably
// slower cold round-trip on real Windows/Codespaces hosts. The ordinary probe
// keeps its established 15s bound, while a coordinator-owned probe gets enough
// time to finish naturally instead of being misclassified at the boundary.
const MANAGED_PROBE_TIMEOUT_MS = 30000;

const POSIX_OS_RX = /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX|CYGWIN|MINGW|MSYS)/i;

function spawnAndWait(spawn, command, args, opts = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, runtime, role = "shell-detect" } = opts;
  return new Promise((resolve, reject) => {
    let child;
    const childOptions = {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    try {
      child = runtime && typeof runtime.spawnManagedTransportChild === "function"
        ? runtime.spawnManagedTransportChild({ role, tool: command, args, options: childOptions })
        : spawn(command, args, childOptions);
    } catch (err) {
      reject(err);
      return;
    }
    const managed = runtime && typeof runtime.spawnManagedTransportChild === "function";
    if (!managed && runtime && typeof runtime.registerChild === "function") {
      runtime.registerChild(child);
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    let exitCode = null;
    let exitSignal = null;
    let processError = null;
    let timedOut = false;
    let drainTimer = null;
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      if (!managed) {
        try { child.kill(); } catch {}
      }
      drainTimer = setTimeout(() => {
        if (done) return;
        done = true;
        const err = Object.assign(new Error("Remote shell probe did not close after timeout"), {
          code: "transport_drain_timeout",
          timedOut: true,
          drainVerified: false,
          role,
        });
        if (managed && runtime && typeof runtime.invalidateManagedOperation === "function") {
          try { runtime.invalidateManagedOperation(err); } catch {}
          reject(err);
          return;
        }
        resolve({ code: exitCode, signal: exitSignal, stdout: "", stderr: err.message, timedOut: true, drainVerified: false });
      }, 5000);
    }, timeoutMs);
    function finish(payload) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (!managed && runtime && typeof runtime.unregisterChild === "function") {
        runtime.unregisterChild(child);
      }
      resolve(payload);
    }
    if (child.stdout) child.stdout.on("data", (d) => { stdoutChunks.push(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderrChunks.push(d); });
    if (child.stdin) { try { child.stdin.end(); } catch {} }
    child.on("error", (err) => { processError = err; });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", (code, signal) => {
      if (managed && timedOut) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        const err = Object.assign(new Error("Remote shell probe exceeded its operation deadline"), {
          code: "transport_operation_timeout",
          timedOut: true,
          drainVerified: true,
          role,
        });
        if (runtime && typeof runtime.settleManagedTimeoutAfterClose === "function") {
          try { runtime.settleManagedTimeoutAfterClose(err); } catch {}
        }
        reject(err);
        return;
      }
      if (managed && runtime && typeof runtime.assertTransportActive === "function") {
        try {
          runtime.assertTransportActive();
        } catch (err) {
          done = true;
          clearTimeout(timer);
          if (drainTimer) clearTimeout(drainTimer);
          reject(err);
          return;
        }
      }
      finish({
        code: exitCode === null ? code : exitCode,
        signal: exitSignal === null ? signal : exitSignal,
        stdout: decodeShellBytes(stdoutChunks),
        stderr: decodeShellBytes(stderrChunks) || (processError && processError.message) || "",
      });
    });
  });
}

async function detectRemoteShell({ profile, spawn, buildSshArgs, runtime, deps = {} }) {
  if (!profile) throw new Error("detectRemoteShell: profile required");
  if (typeof buildSshArgs !== "function") {
    throw new Error("detectRemoteShell: buildSshArgs required");
  }
  const spawnFn = spawn || (deps.spawn || childProcess.spawn);
  const managed = runtime && typeof runtime.spawnManagedTransportChild === "function";
  const timeoutMs = Number.isFinite(deps.timeoutMs)
    ? deps.timeoutMs
    : (managed ? MANAGED_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);

  // POSIX probe — `uname -s` is the canonical "what kernel are you" check
  // and exists on every POSIX system Clawd targets. cmd.exe responds with
  // "'uname' is not recognized…" and non-zero exit, so a 0/Linux response
  // is a strong POSIX signal.
  const posixArgs = buildSshArgs(profile).concat(["uname -s"]);
  const posix = await spawnAndWait(spawnFn, "ssh", posixArgs, { runtime, timeoutMs });
  if (posix.code === 0) {
    const firstLine = String(posix.stdout || "").trim().split(/\r?\n/)[0] || "";
    if (POSIX_OS_RX.test(firstLine)) {
      return { ok: true, shell: "posix", os: firstLine };
    }
  }

  // Windows cmd probe — `ver` is a cmd.exe builtin that prints
  // "Microsoft Windows [Version …]". A POSIX shell would error out
  // ("ver: command not found"), so a 0/"Microsoft Windows" response
  // confirms cmd.exe.
  const winArgs = buildSshArgs(profile).concat(["ver"]);
  const win = await spawnAndWait(spawnFn, "ssh", winArgs, { runtime, timeoutMs });
  if (win.code === 0 && /Microsoft Windows/i.test(win.stdout || "")) {
    return { ok: true, shell: "windows-cmd", os: "windows" };
  }

  // Unknown — could be PowerShell-as-default, fish without coreutils,
  // restricted shell, or a transient network blip. Caller decides whether
  // to abort or proceed; deploy treats unknown as "proceed, the existing
  // POSIX command would have failed loudly anyway".
  return {
    ok: false,
    shell: "unknown",
    stderr: posix.stderr || win.stderr || null,
  };
}

module.exports = {
  detectRemoteShell,
  PROBE_TIMEOUT_MS,
  MANAGED_PROBE_TIMEOUT_MS,
  POSIX_OS_RX,
};
