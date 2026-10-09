"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  scanRelativeRequires,
  collectRelativeHookClosure,
  planAppImageHookBundle,
  isAppImageHookBundleComplete,
  materializeAppImageHookBundle,
  materializeAppImageHookScript,
  AppImageHookMaterializerError,
} = require("../hooks/appimage-hook-materializer");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-materializer-"));
  tempDirs.push(dir);
  return dir;
}

function write(dir, name, content) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("shared AppImage hook materializer — scanner", () => {
  it("recognizes whitespace, both quote styles and extensionless relative requires", () => {
    const source = [
      `require ( './a.js' );`,
      "require(\n  \"./b\"\n);",
      `require('./nested/c');`,
      `require("node:path");`,
    ].join("\n");
    assert.deepStrictEqual(scanRelativeRequires(source), ["./a.js", "./b", "./nested/c"]);
  });
});

describe("shared AppImage hook materializer — closure", () => {
  it("collects multi-entry closures order-independently from the common root", () => {
    const root = tempDir();
    const a = write(root, "state.js", 'require("./dep");\n');
    const b = write(root, "auto-start.js", 'require("./dep");\nrequire("./other");\n');
    write(root, "dep.js", "module.exports = 1;\n");
    write(root, "other.js", "module.exports = 2;\n");

    const first = collectRelativeHookClosure([a, b]);
    const second = collectRelativeHookClosure([b, a]);
    assert.strictEqual(first.rootDir, root);
    assert.deepStrictEqual(
      [...first.files.keys()].sort(),
      [...second.files.keys()].sort()
    );
    assert.deepStrictEqual(
      [...first.files.keys()].map((file) => path.relative(root, file)).sort(),
      ["auto-start.js", "dep.js", "other.js", "state.js"]
    );
  });

  it("rejects a require escaping the hooks root with structured OUTSIDE_HOOKS", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", 'require("../outside.js");\n');
    assert.throws(
      () => collectRelativeHookClosure(entry),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "OUTSIDE_HOOKS"
    );
  });

  it("anchors the root to the hooks dir instead of a common ancestor of all entries", () => {
    const repo = tempDir();
    const hooksDir = path.join(repo, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const entry = write(hooksDir, "entry.js", "module.exports = 1;\n");
    const outside = write(repo, "agents/outside.js", "module.exports = 2;\n");

    // Without an explicit root the primary entry's dirname is the boundary, so
    // an extra entry under agents/ must be rejected (not silently widen to the
    // repo root).
    assert.throws(
      () => collectRelativeHookClosure([entry, outside]),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "OUTSIDE_HOOKS"
    );
    assert.throws(
      () => collectRelativeHookClosure([outside, entry]),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "OUTSIDE_HOOKS"
    );
    assert.throws(
      () => collectRelativeHookClosure([entry, outside], { rootDir: hooksDir }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "OUTSIDE_HOOKS"
    );
  });

  it("fails closed when realpath verification errors; only ENOENT is tolerated", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", "module.exports = 1;\n");
    const denied = () => { const err = new Error("denied"); err.code = "EACCES"; throw err; };
    const gone = () => { const err = new Error("gone"); err.code = "ENOENT"; throw err; };

    assert.throws(
      () => collectRelativeHookClosure(entry, { realpathSync: denied }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "REALPATH_FAILED"
    );
    assert.doesNotThrow(() => collectRelativeHookClosure(entry, { realpathSync: gone }));
  });

  it("fails closed on a symlink that escapes the hooks root", (t) => {
    const root = tempDir();
    const outside = tempDir();
    const secret = write(outside, "secret.js", "module.exports = 'secret';\n");
    const link = path.join(root, "linked.js");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    const entry = write(root, "entry.js", 'require("./linked");\n');
    assert.throws(
      () => collectRelativeHookClosure(entry),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "OUTSIDE_HOOKS"
    );
  });

  it("reports an unreadable/missing dependency as structured READ_FAILED", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", 'require("./missing");\n');
    assert.throws(
      () => collectRelativeHookClosure(entry),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "READ_FAILED"
    );
  });
});

describe("shared AppImage hook materializer — planning and generation", () => {
  it("plans a deterministic target map keyed by entry and preserves the Codex hash protocol", () => {
    const root = tempDir();
    const entry = write(root, ".mount_Clawd/entry.js", 'require("./dep");\n');
    const extra = write(root, ".mount_Clawd/auto-start.js", 'require("./dep");\n');
    write(root, ".mount_Clawd/dep.js", "module.exports = true;\n");
    const appImagePath = "/opt/Clawd-on-Desk.AppImage";
    const materializedRoot = path.join(root, "stable-hooks");

    const plan = planAppImageHookBundle([entry, extra], { appImagePath, materializedRoot });
    assert.strictEqual(plan.entryTargets.get(path.resolve(entry)), path.join(plan.generationDir, "entry.js"));
    assert.strictEqual(plan.entryTargets.get(path.resolve(extra)), path.join(plan.generationDir, "auto-start.js"));

    // Independently recompute the pre-refactor hash: canonical appimage path,
    // sorted relative names and bytes, NUL separators, no schema tag.
    const hasher = crypto.createHash("sha256");
    hasher.update(`${appImagePath}\0`);
    for (const name of ["auto-start.js", "dep.js", "entry.js"]) {
      hasher.update(`${name}\0`);
      hasher.update(fs.readFileSync(path.join(root, ".mount_Clawd", name)));
      hasher.update("\0");
    }
    assert.strictEqual(plan.generation, hasher.digest("hex"));

    // Call order must not change the generation.
    const reversed = planAppImageHookBundle([extra, entry], { appImagePath, materializedRoot });
    assert.strictEqual(reversed.generation, plan.generation);
  });

  it("materializes byte-complete generations and repairs truncated/wrong content", () => {
    const root = tempDir();
    const sourceDir = path.join(root, ".mount_Clawd");
    const entry = write(sourceDir, "entry.js", 'require("./dep");\n');
    write(sourceDir, "dep.js", "module.exports = 42;\n");
    const materializedRoot = path.join(root, "stable-hooks");
    const options = { appImagePath: "/opt/Clawd.AppImage", materializedRoot };

    const target = materializeAppImageHookScript(entry, options);
    const plan = planAppImageHookBundle(entry, options);
    assert.ok(isAppImageHookBundleComplete(plan));
    assert.strictEqual(fs.readFileSync(target, "utf8"), 'require("./dep");\n');

    // Truncate a dependency: the old existsSync-only check would have trusted it.
    fs.writeFileSync(path.join(path.dirname(target), "dep.js"), "module.ex");
    assert.strictEqual(isAppImageHookBundleComplete(plan), false);
    materializeAppImageHookBundle(plan);
    assert.strictEqual(isAppImageHookBundleComplete(plan), true);
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(target), "dep.js"), "utf8"), "module.exports = 42;\n");

    // Wrong same-named content and marker drift are also repaired.
    fs.writeFileSync(path.join(path.dirname(target), "dep.js"), "module.exports = 99;\n");
    fs.writeFileSync(path.join(path.dirname(target), ".clawd-appimage-path"), "/other.AppImage\n");
    assert.strictEqual(isAppImageHookBundleComplete(plan), false);
    materializeAppImageHookBundle(plan);
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(target), ".clawd-appimage-path"), "utf8"), "/opt/Clawd.AppImage\n");
    assert.ok(isAppImageHookBundleComplete(plan));
  });

  it("rejects a relative APPIMAGE path instead of writing a relative generation", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", "module.exports = true;\n");
    assert.throws(
      () => planAppImageHookBundle(entry, { appImagePath: "relative/Clawd.AppImage", materializedRoot: path.join(root, "out") }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "INVALID_APPIMAGE_PATH"
    );
  });

  it("refuses to materialize a synthesized foreign platform without a controlled root", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", "module.exports = true;\n");
    const synthesized = process.platform === "linux" ? "darwin" : "linux";
    assert.throws(
      () => planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", platform: synthesized }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "UNCONTROLLED_ROOT"
    );
  });

  it("tightens a pre-existing materialized root to 0700", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX mode bits only");
      return;
    }
    const root = tempDir();
    const entry = write(root, "entry.js", "module.exports = true;\n");
    const materializedRoot = path.join(root, "stable-hooks");
    fs.mkdirSync(materializedRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(materializedRoot, 0o755);

    materializeAppImageHookScript(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    assert.strictEqual(fs.statSync(materializedRoot).mode & 0o777, 0o700);
  });

  it("is idempotent and does not rewrite an already-complete generation", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", 'require("./dep");\n');
    write(root, "dep.js", "module.exports = 1;\n");
    const materializedRoot = path.join(root, "stable-hooks");
    const plan = planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });

    const winner = materializeAppImageHookBundle(plan);
    assert.strictEqual(winner.wrote, true);
    const target = path.join(plan.generationDir, "entry.js");
    const bytesAfterWinner = fs.readFileSync(target);
    const mtimeAfterWinner = fs.statSync(target).mtimeMs;

    // A later call observes the same content-addressed generation through the
    // early "already complete" path and must not rewrite it.
    const again = materializeAppImageHookBundle(plan);
    assert.strictEqual(again.wrote, false);
    assert.strictEqual(again.replaced, false);
    assert.deepStrictEqual(fs.readFileSync(target), bytesAfterWinner);
    assert.strictEqual(fs.statSync(target).mtimeMs, mtimeAfterWinner);
    const generations = fs.readdirSync(materializedRoot).filter((name) => !name.startsWith("."));
    assert.deepStrictEqual(generations, [path.basename(plan.generationDir)]);
  });

  it("accepts a byte-complete concurrent winner when its staging rename collides", () => {
    const root = tempDir();
    const entry = write(root, "entry.js", 'require("./dep");\n');
    write(root, "dep.js", "module.exports = 1;\n");
    const materializedRoot = path.join(root, "stable-hooks");
    const plan = planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    assert.strictEqual(fs.existsSync(plan.generationDir), false);

    // Deterministic rename collision: the first staging->generation rename
    // lands a byte-complete winner generation and then throws EEXIST. This
    // exercises the catch/loser path (not the early-complete return).
    let collided = false;
    const racingFs = {
      ...fs,
      renameSync(from, to) {
        if (!collided && to === plan.generationDir) {
          collided = true;
          fs.mkdirSync(to, { recursive: true, mode: 0o700 });
          for (const file of plan.files) {
            const target = path.join(to, file.relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content);
          }
          fs.writeFileSync(path.join(to, ".clawd-appimage-path"), `${plan.appImagePath}\n`, { mode: 0o600 });
          const err = new Error("EEXIST: file already exists, rename");
          err.code = "EEXIST";
          throw err;
        }
        return fs.renameSync(from, to);
      },
    };

    const loser = materializeAppImageHookBundle(plan, { fs: racingFs });
    assert.strictEqual(collided, true, "the rename collision must have fired");
    assert.strictEqual(loser.wrote, false);
    assert.strictEqual(loser.replaced, false);
    for (const file of plan.files) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(plan.generationDir, file.relativePath)),
        file.content,
        file.relativePath
      );
    }
    const entries = fs.readdirSync(materializedRoot);
    assert.deepStrictEqual(entries, [path.basename(plan.generationDir)]);
    assert.ok(!entries.some((name) => name.includes(".tmp-") || name.includes(".replaced-")));
  });

  it("writes the marker 0600 and the generation/staging directories 0700", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX mode bits only");
      return;
    }
    const root = tempDir();
    const entry = write(root, "entry.js", 'require("./dep");\n');
    write(root, "dep.js", "module.exports = 1;\n");
    const materializedRoot = path.join(root, "stable-hooks");
    fs.mkdirSync(materializedRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(materializedRoot, 0o755);

    materializeAppImageHookScript(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    const plan = planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    assert.strictEqual(fs.statSync(materializedRoot).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(plan.generationDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(plan.generationDir, ".clawd-appimage-path")).mode & 0o777, 0o600);
    assert.deepStrictEqual(
      fs.readdirSync(materializedRoot).filter((name) => name.includes(".tmp-")),
      []
    );
  });
});
