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

async function eventually(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the isolated launcher");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-launch-test-"));
  const source = path.join(root, "source with spaces ' $()");
  const temp = path.join(root, "temp");
  fs.mkdirSync(source);
  fs.mkdirSync(temp);
  const image = path.join(root, "original image.AppImage");
  fs.writeFileSync(image, "original image");
  fs.writeFileSync(path.join(source, "AppRun"), '#!/bin/bash\nexec "$TEST_NODE" "$APPDIR/app.js" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, "payload.txt"), "still readable");
  fs.writeFileSync(path.join(source, "app.js"), `
    const fs = require('node:fs');
    const path = require('node:path');
    const report = { pid: process.pid, appDir: process.env.APPDIR,
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
  `);
  const running = [];
  t.after(async () => {
    for (const entry of running) {
      if (entry.proc.exitCode === null) entry.proc.kill("SIGTERM");
      await Promise.race([entry.closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (entry.proc.exitCode === null) throw new Error("Owned test supervisor did not stop; preserving its files");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function start(args = [], suffix = "one", extraEnv = {}) {
    const resultFile = path.join(root, `result-${suffix}.json`);
    const proc = spawn("/bin/bash", ["-c", launcher, "clawd-appimage-supervisor", source, image, ...args], {
      cwd: root,
      env: { ...process.env, TMPDIR: temp, TEST_NODE: process.execPath, TEST_RESULT: resultFile, ...extraEnv },
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
