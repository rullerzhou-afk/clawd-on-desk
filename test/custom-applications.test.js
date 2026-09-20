"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { identifyCustomApplication, normalizeCustomApplications } = require("../src/custom-applications");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-custom-ai-"));
}

test("identifies a selected Windows executable with a stable custom agent id", () => {
  const dir = tempDir();
  const executable = path.join(dir, "Nova-AI.exe");
  fs.writeFileSync(executable, "");
  const first = identifyCustomApplication(executable, { platform: "win32" });
  const second = identifyCustomApplication(executable, { platform: "win32" });
  assert.strictEqual(first.name, "Nova AI");
  assert.strictEqual(first.executablePath, executable);
  assert.match(first.id, /^custom-nova-ai-[a-f0-9]{12}$/);
  assert.strictEqual(second.id, first.id);
});

test("selects the primary executable from an installation folder", () => {
  const dir = path.join(tempDir(), "NovaAI");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "updater.exe"), "");
  fs.writeFileSync(path.join(dir, "NovaAI.exe"), "");
  const application = identifyCustomApplication(dir, { platform: "win32" });
  assert.strictEqual(application.executablePath, path.join(dir, "NovaAI.exe"));
});

test("does not identify a folder containing only maintenance executables", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "uninstall.exe"), "");
  fs.writeFileSync(path.join(dir, "updater.exe"), "");
  assert.strictEqual(identifyCustomApplication(dir, { platform: "win32" }), null);
});

test("requires a real executable inside a macOS app bundle", () => {
  const appDir = path.join(tempDir(), "Nova AI.app");
  fs.mkdirSync(appDir);
  assert.strictEqual(identifyCustomApplication(appDir, { platform: "darwin" }), null);

  const executable = path.join(appDir, "Contents", "MacOS", "Nova AI");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "");
  fs.chmodSync(executable, 0o755);
  const application = identifyCustomApplication(appDir, { platform: "darwin" });
  assert.strictEqual(application.executablePath, executable);
});

test("does not register a non-executable POSIX extensionless file", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const executable = path.join(dir, "nova");
  fs.writeFileSync(executable, "");
  fs.chmodSync(executable, 0o644);
  assert.strictEqual(identifyCustomApplication(executable, { platform: "linux" }), null);
  fs.chmodSync(executable, 0o755);
  assert.strictEqual(identifyCustomApplication(executable, { platform: "linux" }).executablePath, executable);
});

test("normalizes, deduplicates, and rejects malformed custom application records", () => {
  const valid = {
    id: "custom-nova-ai-0123456789ab",
    name: "Nova AI",
    sourcePath: "C:\\NovaAI",
    executablePath: "C:\\NovaAI\\NovaAI.exe",
    processName: "NovaAI.exe",
    category: "code",
  };
  assert.deepStrictEqual(normalizeCustomApplications([valid, valid, { id: "bad" }]), [valid]);
});
