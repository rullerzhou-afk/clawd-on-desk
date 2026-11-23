// Runs in its own process so process.platform, child_process and koffi can be
// faked before src/focus.js destructures them at require time.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const appImage = "C:\\Apps\\CodeBuddy CN\\CodeBuddy CN.exe";
const closeCalls = [];

const fakeKoffi = {
  load(name) {
    if (name !== "kernel32.dll") throw new Error(`unexpected library: ${name}`);
    return {
      func(signature) {
        if (signature.includes("OpenProcess")) {
          return (access, inherit, processId) => ({ processId });
        }
        if (signature.includes("QueryFullProcessImageNameW")) {
          return (handle, flags, buffer, length) => {
            for (let i = 0; i < appImage.length; i++) buffer[i] = appImage.charCodeAt(i);
            length[0] = appImage.length;
            return true;
          };
        }
        if (signature.includes("CloseHandle")) {
          return (handle) => {
            closeCalls.push(handle.processId);
            return true;
          };
        }
        throw new Error(`unexpected function: ${signature}`);
      },
    };
  },
};

Object.defineProperty(process, "platform", { value: "win32" });

const execCalls = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "koffi") return fakeKoffi;
  return originalLoad.apply(this, arguments);
};

const childProcess = require("node:child_process");
const childProcessKey = require.resolve("child_process");
require.cache[childProcessKey] = {
  id: childProcessKey,
  filename: childProcessKey,
  loaded: true,
  exports: {
    ...childProcess,
    execFile: (...args) => {
      execCalls.push(args);
      const done = args[args.length - 1];
      if (typeof done === "function") setImmediate(() => done(null, ""));
    },
  },
};

// Every Windows-path read resolves to a valid CodeBuddy app; only the image
// path decides which install directory is inspected.
Object.defineProperty(fs, "promises", {
  configurable: true,
  value: {
    readFile: async (filePath) => String(filePath).endsWith("product.json")
      ? JSON.stringify({ urlProtocol: "codebuddycn", nameShort: "CodeBuddy CN", applicationName: "buddycn" })
      : "x/conversation/open/y",
    stat: async () => ({ mtimeMs: 1 }),
  },
});

const initFocus = require(path.join(__dirname, "..", "..", "src", "focus"));
const focus = initFocus({});

focus.findCodeBuddyWindowsApp([4242]).then((result) => {
  process.stdout.write(JSON.stringify({ result, execCalls: execCalls.length, closeCalls }));
}).catch((error) => {
  process.stdout.write(JSON.stringify({ error: error && error.message }));
  process.exitCode = 1;
});
