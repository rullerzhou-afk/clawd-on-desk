"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { patchSigningSource, prepareMacSigning } = require("../scripts/prepare-macos-signing");

const installedSource = fs.readFileSync(require.resolve("app-builder-lib/out/codeSign/macCodeSign"), "utf8");

// Execute the actual locked upstream function, but never invoke security or
// read credentials. Distinct synthetic certificate/keychain passwords catch
// the regression that caused run 33767194750 to fail.
async function captureSigningCalls(source) {
  const calls = [];
  const exported = {};
  const stubs = {
    "builder-util": {
      exec: async (file, args) => { calls.push({ file, args }); return ""; },
      copyFile: async () => {},
      unlinkIfExists: async () => {},
      isEmptyOrSpaces: (value) => !value,
      log: { warn() {} },
    },
    "../util/dynamicImport": {},
    crypto: { ...crypto, randomBytes: (length) => Buffer.alloc(length, 1) },
    "fs/promises": { rename: async () => {} },
    "lazy-val": { Lazy: class {
      constructor(fn) { this.fn = fn; }
      get value() { return this.fn(); }
    } },
    os: { homedir: () => "/synthetic-home", tmpdir: () => "/synthetic-tmp" },
    path,
    "temp-file": { getTempName: () => "synthetic-root-certs" },
    "../util/flags": {},
    "./codesign": { importCertificate: async (link) => `/synthetic/${link}.p12` },
  };
  vm.runInNewContext(source, {
    exports: exported,
    require(name) {
      assert.ok(Object.hasOwn(stubs, name), `Unstubbed dependency: ${name}`);
      return stubs[name];
    },
    process: { env: {}, platform: "darwin" },
    __dirname: "/synthetic-builder/codeSign",
  });
  await exported.createKeychain({
    tmpDir: {},
    currentDir: "/synthetic-project",
    cscLink: "application",
    cscKeyPassword: "synthetic-application-password",
    cscILink: "installer",
    cscIKeyPassword: "synthetic-installer-password",
  });
  return calls.map(({ args }) => Array.from(args));
}

test("both certificates use their import passwords and the shared keychain password for partition access", async () => {
  const calls = await captureSigningCalls(patchSigningSource(installedSource));
  const option = (args, flag) => args[args.indexOf(flag) + 1];
  const created = option(calls.find((args) => args[0] === "create-keychain"), "-p");
  const unlocked = option(calls.find((args) => args[0] === "unlock-keychain"), "-p");
  assert.equal(created, unlocked);
  const imports = calls.filter((args) => args[0] === "import");
  assert.deepEqual(imports.map((args) => option(args, "-P")), [
    "synthetic-application-password", "synthetic-installer-password",
  ]);
  const partitions = calls.filter((args) => args[0] === "set-key-partition-list");
  assert.equal(partitions.length, 2);
  for (const args of partitions) {
    assert.equal(option(args, "-k"), created);
    assert.equal(option(args, "-S"), "apple-tool:,apple:");
  }
});

test("the reviewed signing patch is idempotent and rejects changed upstream content", () => {
  const patched = patchSigningSource(installedSource);
  assert.equal(patchSigningSource(patched), patched);
  assert.throws(() => patchSigningSource(`${installedSource}\n// changed`), /Unrecognized/);
});

test("only the recognized macOS build module is changed; version/platform mismatches preserve it", (t) => {
  const builderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mac-signing-"));
  t.after(() => fs.rmSync(builderRoot, { recursive: true, force: true }));
  const filename = path.join(builderRoot, "out", "codeSign", "macCodeSign.js");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const pkgPath = path.join(builderRoot, "package.json");
  const pkg = JSON.stringify({ version: "26.15.7" });
  fs.writeFileSync(pkgPath, pkg);
  fs.writeFileSync(filename, installedSource);
  for (const platform of ["win32", "linux"]) {
    assert.throws(() => prepareMacSigning({ builderRoot, platform }), /macOS-only/);
    assert.equal(fs.readFileSync(filename, "utf8"), installedSource);
  }
  fs.writeFileSync(pkgPath, JSON.stringify({ version: "26.15.8" }));
  assert.throws(() => prepareMacSigning({ builderRoot, platform: "darwin" }), /Unexpected/);
  assert.equal(fs.readFileSync(filename, "utf8"), installedSource);
  fs.writeFileSync(pkgPath, pkg);
  prepareMacSigning({ builderRoot, platform: "darwin" });
  assert.equal(fs.readFileSync(filename, "utf8"), patchSigningSource(installedSource));
  assert.equal(prepareMacSigning({ builderRoot, platform: "darwin" }), false);
  assert.equal(fs.readFileSync(pkgPath, "utf8"), pkg);
});

test("the workaround runs only in the Developer ID macOS job before signing", () => {
  const root = path.join(__dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "build.yml"), "utf8")
    .replace(/\r\n?/g, "\n");
  const macStart = workflow.indexOf("\n  build-mac:");
  const nextJob = workflow.indexOf("\n  build-linux:", macStart);
  const macJob = workflow.slice(macStart, nextJob);
  assert.match(macJob, /name: Correct macOS signing keychain password\n\s+if: steps\.mac-signing\.outputs\.mode == 'developer-id'\n\s+run: \|\n\s+node --test test\/macos-signing-keychain\.test\.js\n\s+node scripts\/prepare-macos-signing\.js/);
  assert.ok(macJob.indexOf("node scripts/prepare-macos-signing.js") < macJob.indexOf("name: Build macOS (Developer ID signed and notarized)"));
  assert.doesNotMatch(workflow.slice(0, macStart) + workflow.slice(nextJob), /prepare-macos-signing/);
});
