"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CORE_FILE,
  EXTENSION_FILE,
  MARKER_FILE,
  hasPiCommand,
  isManagedMarker,
  registerPiExtension,
  unregisterPiExtension,
} = require("../hooks/pi-install");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pi-install-"));
  tempDirs.push(dir);
  return dir;
}

function makeSourceDir() {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "pi-extension.ts"), "export default function clawdPiExtension() {}\n", "utf8");
  fs.writeFileSync(path.join(dir, CORE_FILE), "module.exports = { attach() {} };\n", "utf8");
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("pi-install", () => {
  it("detects npm-installed Pi command beside a resolved Node binary on Windows", () => {
    const root = makeTempDir();
    const nodeBin = path.join(root, "node.exe");
    const piCmd = path.join(root, "pi.cmd");
    fs.writeFileSync(nodeBin, "", "utf8");
    fs.writeFileSync(piCmd, "", "utf8");

    assert.strictEqual(hasPiCommand({
      platform: "win32",
      nodeBin,
      accessSync: fs.accessSync,
      execFileSync: () => {
        throw new Error("where should not be needed");
      },
    }), true);
  });

  it("falls back to `where pi` on Windows", () => {
    assert.strictEqual(hasPiCommand({
      platform: "win32",
      nodeBin: "node",
      execFileSync: (command, args) => {
        assert.strictEqual(command, "where");
        assert.deepStrictEqual(args, ["pi"]);
        return "C:\\Users\\Tester\\AppData\\Roaming\\npm\\pi.cmd\n";
      },
    }), true);
  });

  it("uses short POSIX shell probes when Pi is only available in a login shell", () => {
    const timeouts = [];

    assert.strictEqual(hasPiCommand({
      platform: "linux",
      nodeBin: "node",
      execFileSync: (command, args, options) => {
        timeouts.push(options.timeout);
        if (command === "sh") return "/usr/local/bin/pi\n";
        return "";
      },
    }), true);
    assert.deepStrictEqual(timeouts, [1500, 1500, 1500]);
  });

  it("skips registration when neither Pi config nor Pi command exists", () => {
    const root = makeTempDir();
    const sourceDir = makeSourceDir();
    const parentDir = path.join(root, ".pi", "agent");

    const result = registerPiExtension({
      parentDir,
      sourceDir,
      piCommandAvailable: false,
      silent: true,
    });

    assert.deepStrictEqual(result, {
      installed: false,
      skipped: true,
      updated: false,
      reason: "pi-not-found",
      extensionDir: path.join(parentDir, "extensions", "clawd-on-desk"),
    });
  });

  it("installs and refreshes the managed Pi extension files", () => {
    const root = makeTempDir();
    const sourceDir = makeSourceDir();
    const parentDir = path.join(root, ".pi", "agent");

    const first = registerPiExtension({
      parentDir,
      sourceDir,
      piCommandAvailable: true,
      silent: true,
    });
    const second = registerPiExtension({
      parentDir,
      sourceDir,
      piCommandAvailable: true,
      silent: true,
    });

    assert.strictEqual(first.installed, true);
    assert.strictEqual(first.updated, true);
    assert.strictEqual(second.installed, true);
    assert.strictEqual(second.updated, false);
    assert.strictEqual(fs.existsSync(path.join(first.extensionDir, EXTENSION_FILE)), true);
    assert.strictEqual(fs.existsSync(path.join(first.extensionDir, CORE_FILE)), true);
    assert.strictEqual(isManagedMarker(JSON.parse(fs.readFileSync(path.join(first.extensionDir, MARKER_FILE), "utf8"))), true);
  });

  it("does not overwrite an unmanaged existing Pi extension directory", () => {
    const root = makeTempDir();
    const sourceDir = makeSourceDir();
    const parentDir = path.join(root, ".pi", "agent");
    const extensionDir = path.join(parentDir, "extensions", "clawd-on-desk");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, EXTENSION_FILE), "user extension\n", "utf8");

    const result = registerPiExtension({
      parentDir,
      sourceDir,
      piCommandAvailable: true,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "unmanaged-existing-extension");
    assert.strictEqual(fs.readFileSync(path.join(extensionDir, EXTENSION_FILE), "utf8"), "user extension\n");
  });

  it("uninstalls only a Clawd-managed Pi extension directory", () => {
    const root = makeTempDir();
    const sourceDir = makeSourceDir();
    const parentDir = path.join(root, ".pi", "agent");
    const installed = registerPiExtension({
      parentDir,
      sourceDir,
      piCommandAvailable: true,
      silent: true,
    });

    const result = unregisterPiExtension({
      parentDir,
      silent: true,
    });

    assert.strictEqual(result.removed, true);
    assert.strictEqual(fs.existsSync(installed.extensionDir), false);
  });

  it("refuses to uninstall an unmanaged Pi extension directory", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".pi", "agent");
    const extensionDir = path.join(parentDir, "extensions", "clawd-on-desk");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, EXTENSION_FILE), "user extension\n", "utf8");

    const result = unregisterPiExtension({
      parentDir,
      silent: true,
    });

    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.reason, "unmanaged-existing-extension");
    assert.strictEqual(fs.existsSync(extensionDir), true);
  });
});
