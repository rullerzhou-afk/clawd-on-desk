"use strict";

// Shell-independent Node entrypoint. Only this fixed loader is on the command
// line; programs and arguments travel in one newline-terminated stdin frame.
// Removing the frame reader before running the program leaves subsequent input
// (including EOF) available to persistent readiness programs. The loader pauses
// stdin after the frame; persistent programs must call process.stdin.resume().
function loadNodeFrame() {
  let buffered = Buffer.alloc(0);
  function read(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline < 0) return;
    process.stdin.pause();
    process.stdin.removeListener("data", read);
    process.stdin.removeListener("end", end);
    try {
      const frame = JSON.parse(buffered.subarray(0, newline).toString());
      if (buffered.length > newline + 1) process.stdin.unshift(buffered.subarray(newline + 1));
      const program = new Function("args", "require", frame.code);
      Promise.resolve(program(frame.args, require)).catch(fail);
    } catch (err) {
      fail(err);
    }
  }
  function fail(err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  }
  function end() {
    console.error("Missing Node program frame");
    process.exitCode = 1;
  }
  process.stdin.on("data", read);
  process.stdin.once("end", end);
}

const NODE_FRAME_LOADER = `(${loadNodeFrame.toString()})()`;
const REMOTE_NODE_LAUNCH_COMMAND = `node -e "eval(Buffer.from('${Buffer.from(NODE_FRAME_LOADER).toString("base64")}','base64').toString())"`;

function encodeNodeFrame(code, args) {
  return `${JSON.stringify({ code, args })}\n`;
}

function buildNodeProgramFrame(code, args, execPath) {
  if (typeof execPath !== "string" || !execPath || /[\x00-\x1f\x7f]/.test(execPath)) {
    throw new TypeError("A probed Node execPath is required");
  }
  const guard = [
    `const expectedExecPath=${JSON.stringify(execPath)};`,
    "const actualExecPath=process.execPath;",
    "const sameExecPath=process.platform==='win32'",
    "  ? actualExecPath.toLowerCase()===expectedExecPath.toLowerCase()",
    "  : actualExecPath===expectedExecPath;",
    "if(!sameExecPath){console.error('Remote Node execPath changed; redeploy required');process.exit(7);}\n",
  ].join("\n");
  return encodeNodeFrame(guard + code, args);
}

function buildNodeDiscoveryFrame() {
  return encodeNodeFrame("console.log(JSON.stringify({platform:process.platform,execPath:process.execPath,homedir:require('os').homedir(),version:process.version}));", {});
}

function writeNodeFrame(child, frame, { persistent = false } = {}) {
  // Persistent programs must resume stdin themselves after the loader pauses it.
  if (persistent) child.stdin.write(frame);
  else child.stdin.end(frame);
}

// Stream errors are emitted by stdin itself, independently of child errors.
// Keep the listener after failure so cleanup cannot cause an unhandled error.
function writeNodeFrameSafely(child, frame, { persistent = false, onError }) {
  let failed = false;
  const fail = (err) => {
    if (failed) return;
    failed = true;
    onError(err);
  };
  try {
    if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", fail);
    writeNodeFrame(child, frame, { persistent });
  } catch (err) {
    fail(err);
  }
  return !failed;
}

module.exports = {
  NODE_FRAME_LOADER,
  REMOTE_NODE_LAUNCH_COMMAND,
  buildNodeProgramFrame,
  buildNodeDiscoveryFrame,
  writeNodeFrame,
  writeNodeFrameSafely,
};
