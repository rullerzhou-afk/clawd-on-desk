"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const vm = require("node:vm");
const {
  NODE_FRAME_LOADER, REMOTE_NODE_LAUNCH_COMMAND,
  buildNodeProgramFrame, buildNodeDiscoveryFrame, writeNodeFrame,
} = require("../src/remote-ssh-node-launch");

function launch(t) {
  const child = spawn(process.execPath, ["-e", NODE_FRAME_LOADER], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  return child;
}

test("issue #1316: the Node command is fixed and programs never enter argv", () => {
  assert.equal(REMOTE_NODE_LAUNCH_COMMAND, `node -e "eval(Buffer.from('${Buffer.from(NODE_FRAME_LOADER).toString("base64")}','base64').toString())"`);
  const args = { path: "C:\\Program Files\\x y", text: "中文 %PATH% !bang! $HOME" };
  const frame = buildNodeProgramFrame("return args", args, "C:\\Node\\node.exe");
  assert.deepEqual(JSON.parse(frame).args, args);
  assert.equal(frame.split("\n").length, 2);
  assert.equal(REMOTE_NODE_LAUNCH_COMMAND.includes(args.path), false);
  assert.equal(REMOTE_NODE_LAUNCH_COMMAND.includes("中文"), false);
  assert.ok(REMOTE_NODE_LAUNCH_COMMAND.length < 2000, `launcher length: ${REMOTE_NODE_LAUNCH_COMMAND.length}`);
});

for (const [name, frame, message] of [
  ["malformed JSON", "{broken\n", /JSON|property|Unexpected/],
  ["execPath mismatch", buildNodeProgramFrame("", {}, `${process.execPath}.changed`), /^Remote Node execPath changed; redeploy required\n$/],
  ["synchronous throw", buildNodeProgramFrame("throw new Error('program failed')", {}, process.execPath), /^program failed\n$/],
  ["asynchronous rejection", buildNodeProgramFrame("return Promise.reject(new Error('program failed'))", {}, process.execPath), /^program failed\n$/],
]) {
  test(`issue #1316: loader reports ${name} as one stderr message without a stack`, { timeout: 10000 }, async (t) => {
    const child = launch(t);
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    writeNodeFrame(child, frame);
    assert.deepEqual(await closed, [name === "execPath mismatch" ? 7 : 1, null]);
    assert.match(stderr, message);
    assert.equal(stderr.trim().split(/\r?\n/).length, 1);
    assert.doesNotMatch(stderr, /\n\s+at /);
  });
}

test("issue #1316: one-shot programs execute through stdin.end(frame)", { timeout: 10000 }, async (t) => {
  const child = launch(t);
  const closed = once(child, "close");
  let stdout = "";
  child.stdout.on("data", (data) => { stdout += data; });
  const args = ["C:\\Program Files\\x y", "中文", "%PATH%", "!bang!", "$HOME"];
  writeNodeFrame(child, buildNodeProgramFrame("console.log(JSON.stringify(args))", args, process.execPath));
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(JSON.parse(stdout), args);
});

test("issue #1316: a partial frame waits for newline and executes before EOF", { timeout: 10000 }, async (t) => {
  const child = launch(t);
  const closed = once(child, "close");
  const program = "console.log('ready');process.stdin.once('end',()=>console.log('drained'));process.stdin.resume();";
  const frame = buildNodeProgramFrame(program, {}, process.execPath);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stdin.write(frame.slice(0, 15));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(output, "");
  const ready = once(child.stdout, "data");
  writeNodeFrame(child, frame.slice(15), { persistent: true });
  await ready;
  assert.match(output, /ready/);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.exitCode, null);
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
  assert.match(output, /drained/);
});

test("issue #1316: trailing input and EOF belong to the program", { timeout: 10000 }, async (t) => {
  const child = launch(t);
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  const code = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.once('end',()=>console.log(s));process.stdin.resume();";
  child.stdin.end(buildNodeProgramFrame(code, {}, process.execPath) + "第二行\nthird line");
  assert.deepEqual(await closed, [0, null]);
  assert.equal(output, "第二行\nthird line\n");
});

test("issue #1316: discovery needs no old execPath and supplies the first deployment baseline", { timeout: 10000 }, async (t) => {
  const child = launch(t);
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  writeNodeFrame(child, buildNodeDiscoveryFrame());
  assert.deepEqual(await closed, [0, null]);
  const detected = JSON.parse(output);
  assert.equal(detected.execPath, process.execPath);
  assert.equal(detected.platform, process.platform);
  const frame = JSON.parse(buildNodeProgramFrame("return args", { repair: true }, detected.execPath));
  const result = vm.runInNewContext(`(function(args){${frame.code}})(args)`, { args: frame.args, process });
  assert.equal(result.repair, true);
});

test("issue #1316: every operation checks execPath before executing, with Windows case folding", () => {
  for (const platform of ["posix", "win32"]) {
    const execPath = platform === "win32" ? "C:\\Node\\node.exe" : "/usr/bin/node";
    const frame = JSON.parse(buildNodeProgramFrame("effects.push('executed')", {}, execPath));
    const effects = [];
    const run = (actual) => vm.runInNewContext(`(function(){${frame.code}})()`, { console: { error() {} }, process: { platform, execPath: actual, exit(code) { assert.equal(code, 7); throw new Error("execPath changed"); } }, effects });
    assert.throws(() => run(platform === "win32" ? "D:\\Other\\node.exe" : "/opt/node"), /execPath changed/);
    assert.deepEqual(effects, []);
    run(platform === "win32" ? execPath.toUpperCase() : execPath);
    assert.deepEqual(effects, ["executed"]);
    if (platform === "posix") assert.throws(() => run(execPath.toUpperCase()), /execPath changed/);
  }
  assert.throws(() => buildNodeProgramFrame("", {}, undefined), /probed Node execPath/);
});

test("issue #1316: loader reports a thrown string as one stderr line", async (t) => {
  const child = launch(t);
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  writeNodeFrame(child, buildNodeProgramFrame('throw "boom"', {}, process.execPath));
  assert.deepEqual(await closed, [1, null]);
  assert.equal(stderr, "boom\n");
});
