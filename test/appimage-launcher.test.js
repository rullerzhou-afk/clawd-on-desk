"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const launcher = fs.readFileSync(path.join(__dirname, "../build/appimage-launcher.sh"), "utf8");
const linux = { skip: process.platform !== "linux", timeout: 15000 };

// The supervisor reads `command -p stat`, which bypasses PATH. Shadow the
// `command` builtin so a stat invocation can be simulated deterministically
// while every other command still reaches the real builtin.
function commandInterceptor() {
  return [
    "command() {",
    '  if [[ "${1-}" == "-p" && "${2-}" == "setsid" ]]; then',
    "    # Launching a real program here would run it in a function subshell, so",
    "    # $! would point at the subshell and TERM would orphan the program.",
    '    printf \'setsid\\n\' >> "$TEST_STAT_LOG"',
    "    return 97",
    "  fi",
    '  if [[ "${1-}" == "-p" && "${2-}" == "stat" ]]; then',
    "    shift 2",
    '    printf \'%s\\n\' "$*" >> "$TEST_STAT_LOG"',
    '    [[ -z "${FAKE_STAT_FAIL:-}" ]] || return 1',
    '    if [[ "$*" == *%T* ]]; then',
    '      printf \'%s\\n\' "${FAKE_FSTYPE_NAME:-ext2/ext3}"',
    "    else",
    '      printf \'%s\\n\' "${FAKE_FSTYPE_MAGIC:-ef53}"',
    "    fi",
    "    return 0",
    "  fi",
    '  builtin command "$@"',
    "}",
  ].join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function eventually(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the isolated launcher");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TIMED_OUT = Symbol("timedOut");

// Races a promise against a timer, clearing the timer as soon as the promise
// settles so a finished test does not keep the event loop alive.
async function withTimeout(promise, timeout) {
  let timer;
  const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeout); });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// Bounded supervisor wait: after a regression the supervisor can exit while the
// orphaned app still holds the stdio pipes, so `close` alone would never fire.
async function closedWithTimeout(entry, timeout = 10000) {
  const outcome = await withTimeout(entry.closed.then(([code, signal]) => ({ code, signal })), timeout);
  if (outcome === TIMED_OUT) throw new Error(`supervisor did not exit within ${timeout}ms: ${entry.stderr()}`);
  return [outcome.code, outcome.signal];
}

// /proc/<pid>/stat is `pid (comm) state ppid ...`; comm can contain spaces.
function parentPid(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

// Field 22 (index 19 after the trailing `)`) of proc_pid_stat(5).
function starttimeOf(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-launch-test-"));
  const source = path.join(root, "source with spaces ' $()");
  const temp = path.join(root, "temp");
  fs.mkdirSync(source);
  fs.mkdirSync(temp);
  const image = path.join(root, "original image.AppImage");
  fs.writeFileSync(image, "original image");
  fs.writeFileSync(path.join(source, "AppRun"), [
    "#!/bin/bash",
    "# electron-builder's AppRun reads this without a default (see its template).",
    'if [ -z "$APPIMAGE_EXIT_AFTER_INSTALL" ]; then :; fi',
    'exec "$TEST_NODE" "$APPDIR/app.js" "$@"',
  ].join("\n") + "\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "payload.txt"), "still readable");
  fs.writeFileSync(path.join(source, "app.js"), `
    const fs = require('node:fs');
    const path = require('node:path');
    const selfStat = fs.readFileSync('/proc/self/stat', 'utf8');
    const starttime = selfStat.slice(selfStat.lastIndexOf(')') + 2).split(' ')[19];
    const report = { pid: process.pid, starttime, appDir: process.env.APPDIR,
      image: process.env.APPIMAGE, cwd: process.cwd(), home: process.env.HOME,
      tmp: process.env.TMPDIR, args: process.argv.slice(2) };
    const worker = process.env.TEST_CHILD_SIGNAL ? require('node:child_process').spawn(process.execPath,
      ['-e', "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.TEST_CHILD_SIGNAL, 'signalled'); process.exit(0); }); fs.writeFileSync(process.env.TEST_CHILD_SIGNAL, 'ready'); setInterval(() => {}, 1000)"],
      { stdio: 'ignore', env: process.env }) : null;
    fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify(report));
    process.on('SIGTERM', () => {
      report.payloadOnExit = fs.readFileSync(path.join(__dirname, 'payload.txt'), 'utf8');
      if (worker) {
        setTimeout(() => {
          report.workerState = fs.readFileSync(process.env.TEST_CHILD_SIGNAL, 'utf8');
          worker.kill('SIGKILL');
          fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify(report));
          process.exit(0);
        }, 100);
        return;
      }
      if (process.env.TEST_LINGER) {
        const code = "setTimeout(() => { const fs = require('node:fs'); fs.writeFileSync(process.env.TEST_LINGER, fs.readFileSync(process.env.APPDIR + '/payload.txt')); }, 1200)";
        report.childPid = require('node:child_process').spawn(process.execPath, ['-e', code],
          { stdio: 'ignore', env: process.env }).pid;
      }
      fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify(report));
      process.exit(Number(process.env.TEST_EXIT_CODE || 0));
    });
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 30000);
  `);
  const running = [];
  t.after(async () => {
    for (const entry of running) {
      if (entry.proc.exitCode === null) entry.proc.kill("SIGTERM");
      await withTimeout(entry.closed, 2000);
      killRecordedApp(readResult(entry));
      if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
      await withTimeout(entry.closed, 2000);
      if (entry.proc.exitCode === null) throw new Error("Owned test supervisor did not stop; preserving its files");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function start(args = [], suffix = "one", extraEnv = {}, prelude = "") {
    const resultFile = path.join(root, `result-${suffix}.json`);
    const env = { ...process.env, TMPDIR: temp, TEST_NODE: process.execPath, TEST_RESULT: resultFile, ...extraEnv };
    delete env.APPIMAGE_EXIT_AFTER_INSTALL;
    const proc = spawn("/bin/bash", ["-c", prelude + launcher, "clawd-appimage-supervisor", source, image, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data; });
    const closed = once(proc, "close");
    const entry = { proc, closed, resultFile, stderr: () => stderr };
    running.push(entry);
    return entry;
  }
  return { root, source, temp, image, start };
}

function readResult(entry) {
  try { return JSON.parse(fs.readFileSync(entry.resultFile, "utf8")); } catch { return null; }
}

// A pid may have been reused since the fixture ran, so only SIGKILL when the
// recorded command line and /proc starttime still identify the recorded app.
function killRecordedApp(report) {
  if (!report || typeof report.pid !== "number" ||
      typeof report.appDir !== "string" || typeof report.starttime !== "string") {
    return;
  }
  const { pid } = report;
  let argv;
  let stat;
  try {
    argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return;
  }
  if (argv[0] !== process.execPath) return;
  if (argv[1] !== path.join(report.appDir, "app.js")) return;
  const starttime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (starttime !== report.starttime) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

test("copied runtime survives source removal and preserves arguments and environment", linux, async (t) => {
  const f = fixture(t);
  const args = ["--ozone-platform=x11", "", "a b", "$(touch unexpected)", "--", "'quoted'"];
  const entry = f.start(args);
  const ready = await eventually(() => readResult(entry));
  assert.deepEqual(ready.args, args);
  assert.equal(ready.image, f.image);
  assert.equal(ready.cwd, f.root);
  assert.equal(ready.home, process.env.HOME);
  assert.equal(ready.tmp, f.temp);
  assert.notEqual(ready.appDir, f.source);
  assert.equal(fs.statSync(path.dirname(ready.appDir)).mode & 0o777, 0o700);
  fs.rmSync(f.source, { recursive: true });
  process.kill(ready.pid, "SIGTERM");
  assert.deepEqual(await entry.closed, [0, null], entry.stderr());
  assert.equal(readResult(entry).payloadOnExit, "still readable");
  assert.equal(fs.existsSync(path.dirname(ready.appDir)), false);
  assert.equal(fs.existsSync(path.join(f.root, "unexpected")), false);
});

test("SIGTERM to the supervisor forwards graceful shutdown before deleting files", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start();
  const ready = await eventually(() => readResult(entry));
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await entry.closed, [0, null], entry.stderr());
  assert.equal(readResult(entry).payloadOnExit, "still readable");
  assert.equal(fs.existsSync(path.dirname(ready.appDir)), false);
});

test("concurrent launches have independent directories and shutdown", linux, async (t) => {
  const f = fixture(t);
  const first = f.start([], "first");
  const second = f.start([], "second");
  const a = await eventually(() => readResult(first));
  const b = await eventually(() => readResult(second));
  assert.notEqual(a.appDir, b.appDir);
  first.proc.kill("SIGTERM");
  assert.deepEqual(await first.closed, [0, null], first.stderr());
  assert.equal(fs.readFileSync(path.join(b.appDir, "payload.txt"), "utf8"), "still readable");
  assert.doesNotThrow(() => process.kill(b.pid, 0));
  second.proc.kill("SIGTERM");
  assert.deepEqual(await second.closed, [0, null], second.stderr());
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("an interrupted wait still reports the application's nonzero exit status", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start([], "failed-exit", { TEST_EXIT_CODE: "17" });
  await eventually(() => readResult(entry));
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await entry.closed, [17, null], entry.stderr());
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("supervisor leaves service children alive for the main process to shut down", linux, async (t) => {
  const f = fixture(t);
  const childSignal = path.join(f.root, "child-signal.txt");
  const entry = f.start([], "service", { TEST_CHILD_SIGNAL: childSignal });
  await eventually(() => readResult(entry));
  await eventually(() => fs.existsSync(childSignal));
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await entry.closed, [0, null], entry.stderr());
  assert.equal(readResult(entry).workerState, "ready");
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("failed copy does not launch the application or retain a partial directory", linux, async (t) => {
  if (process.getuid() === 0) return t.skip("requires ordinary user permissions");
  const f = fixture(t);
  const denied = path.join(f.source, "denied");
  fs.writeFileSync(denied, "cannot copy");
  fs.chmodSync(denied, 0);
  t.after(() => { if (fs.existsSync(denied)) fs.chmodSync(denied, 0o600); });
  const entry = f.start();
  assert.deepEqual(await entry.closed, [1, null]);
  assert.match(entry.stderr(), /copy failed/);
  assert.equal(readResult(entry), null);
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("main exit does not delete files still needed by a child in its process group", linux, async (t) => {
  const f = fixture(t);
  const lingerResult = path.join(f.root, "child-result.txt");
  const entry = f.start([], "linger", { TEST_LINGER: lingerResult });
  const ready = await eventually(() => readResult(entry));
  process.kill(ready.pid, "SIGTERM");
  await eventually(() => readResult(entry).childPid);
  assert.equal(fs.readFileSync(path.join(ready.appDir, "payload.txt"), "utf8"), "still readable");
  await eventually(() => fs.existsSync(lingerResult));
  assert.equal(fs.readFileSync(lingerResult, "utf8"), "still readable");
  assert.deepEqual(await entry.closed, [0, null], entry.stderr());
});

// Never use this interceptor to exercise a path that actually launches the
// application: replacing `command` with a shell function makes the supervisor's
// backgrounded `command -p setsid ... &` run in a function subshell, so `$!`
// captures the subshell rather than the program and the TERM would orphan it.
test("issue #1048: a FUSE-backed TMPDIR is rejected by filesystem magic", linux, async (t) => {
  const f = fixture(t);
  const statLog = path.join(f.root, "stat.log");
  const entry = f.start([], "fuse-tmpdir", {
    TEST_STAT_LOG: statLog,
    FAKE_FSTYPE_NAME: "fuse",
    FAKE_FSTYPE_MAGIC: "65735546",
  }, `${commandInterceptor()}\n`);
  assert.deepEqual(await entry.closed, [1, null]);
  assert.match(entry.stderr(), /TMPDIR must not be on a FUSE filesystem/);
  assert.equal(readResult(entry), null);
  assert.deepEqual(fs.readdirSync(f.temp), []);
  const lines = fs.readFileSync(statLog, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one stat call, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], new RegExp(`^-f -c %t -- ${escapeRegExp(f.temp)}/clawd-appimage\\.[A-Za-z0-9]{8}$`));
  assert.ok(!lines.includes("setsid"), "the FUSE check must reject the run directory before setsid");
});

test("issue #1048: a failing TMPDIR stat aborts before launching", linux, async (t) => {
  const f = fixture(t);
  const statLog = path.join(f.root, "stat.log");
  const entry = f.start([], "stat-fail", {
    TEST_STAT_LOG: statLog,
    FAKE_STAT_FAIL: "1",
  }, `${commandInterceptor()}\n`);
  assert.deepEqual(await closedWithTimeout(entry), [1, null]);
  assert.match(entry.stderr(), /cannot inspect temporary filesystem/);
  assert.equal(readResult(entry), null);
  assert.deepEqual(fs.readdirSync(f.temp), []);
  assert.ok(!fs.readFileSync(statLog, "utf8").includes("setsid"), "setsid must not run after a failed stat");
});

test("issue #1048: supervisor survives an inherited monitor SHELLOPTS and still owns the app", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start([], "monitor", {
    SHELLOPTS: "braceexpand:emacs:errexit:hashall:histexpand:history:interactive-comments:monitor",
  });
  const ready = await eventually(() => readResult(entry));
  await delay(300);
  assert.equal(entry.proc.exitCode, null, "supervisor must stay alive while the app runs");
  assert.equal(fs.existsSync(path.dirname(ready.appDir)), true, "the runtime copy must still exist");
  assert.equal(parentPid(ready.pid), entry.proc.pid, "the app parent must be the supervisor");
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await closedWithTimeout(entry), [0, null], entry.stderr());
  assert.equal(readResult(entry).payloadOnExit, "still readable");
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("issue #1048: an inherited SHELLOPTS without nounset still launches the app", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start([], "nounset", { SHELLOPTS: "braceexpand:hashall:interactive-comments" });
  await eventually(() => readResult(entry));
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await closedWithTimeout(entry), [0, null], entry.stderr());
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

// A signal death reports exitCode === null, and a just-killed process may still
// answer kill(pid, 0), so watch the `exit` event instead of polling.
async function assertSurvives(child, report, label) {
  const exitPromise = once(child, "exit");
  exitPromise.catch(() => {});
  killRecordedApp(report);
  const outcome = await withTimeout(exitPromise, 300);
  if (outcome !== TIMED_OUT) {
    assert.fail(`${label}: process was terminated (code=${outcome[0]}, signal=${outcome[1]})`);
  }
  assert.equal(child.exitCode, null, `${label}: exitCode`);
  assert.equal(child.signalCode, null, `${label}: signalCode`);
}

function trackChild(t, child) {
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
}

test("issue #1048: killRecordedApp requires a matching argv[0]", linux, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kill-argv0-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "app.js");
  fs.writeFileSync(script, "setTimeout(() => {}, 30000);\n");
  // argv0 fakes argv[0] without any descendant process to clean up.
  const child = spawn(process.execPath, [script], { argv0: "/not/the/test/node", stdio: "ignore" });
  trackChild(t, child);
  await once(child, "spawn");
  await assertSurvives(child, { pid: child.pid, appDir: dir, starttime: starttimeOf(child.pid) }, "argv[0] mismatch");
});

test("issue #1048: killRecordedApp requires a matching argv[1]", linux, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kill-argv1-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  trackChild(t, child);
  await once(child, "spawn");
  await assertSurvives(child, { pid: child.pid, appDir: dir, starttime: starttimeOf(child.pid) }, "argv[1] mismatch");
});

test("issue #1048: killRecordedApp requires a matching starttime", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start([], "kill-starttime");
  await eventually(() => readResult(entry));
  killRecordedApp({ ...readResult(entry), starttime: "0" });
  await delay(300);
  assert.equal(entry.proc.exitCode, null, "supervisor must stay alive while the app runs");
  assert.equal(entry.proc.signalCode, null);
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await closedWithTimeout(entry), [0, null], entry.stderr());
});

test("issue #1048: killRecordedApp kills the fully matching recorded app", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start([], "kill-match");
  const ready = await eventually(() => readResult(entry));
  killRecordedApp(readResult(entry));
  await eventually(() => {
    try { process.kill(ready.pid, 0); return false; } catch { return true; }
  });
});

test("issue #1048: supervisor survives an inherited errexit SHELLOPTS and reports the app exit code", linux, async (t) => {
  const f = fixture(t);
  const entry = f.start([], "errexit", {
    SHELLOPTS: "braceexpand:errexit:hashall:interactive-comments",
    TEST_EXIT_CODE: "17",
  });
  await eventually(() => readResult(entry));
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await closedWithTimeout(entry), [17, null], entry.stderr());
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("issue #1048: supervisor survives a BASH_ENV job-control file and still owns the app", linux, async (t) => {
  const f = fixture(t);
  const bashEnv = path.join(f.root, "bash-env.sh");
  fs.writeFileSync(bashEnv, "set -m\n");
  const entry = f.start([], "bash-env", { BASH_ENV: bashEnv });
  const ready = await eventually(() => readResult(entry));
  await delay(300);
  assert.equal(entry.proc.exitCode, null, "supervisor must stay alive while the app runs");
  assert.equal(fs.existsSync(path.dirname(ready.appDir)), true, "the runtime copy must still exist");
  assert.equal(parentPid(ready.pid), entry.proc.pid, "the app parent must be the supervisor");
  entry.proc.kill("SIGTERM");
  assert.deepEqual(await closedWithTimeout(entry), [0, null], entry.stderr());
  assert.equal(readResult(entry).payloadOnExit, "still readable");
  assert.deepEqual(fs.readdirSync(f.temp), []);
});
