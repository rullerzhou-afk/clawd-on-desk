"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");

const installer = require("../src/official-theme-installer");
const { buildZip, hashSageFixture, S_IFDIR, S_IFREG } = require("./helpers/zip-builder");

const LIMITS = { maxEntries: 256, perEntryMaxBytes: 48 * 1024 * 1024, totalMaxBytes: 256 * 1024 * 1024 };

let tmp;
let partPath;
let stagingDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-install-"));
  partPath = path.join(tmp, "pack.part");
  stagingDir = path.join(tmp, "theme-staging", "official", "hash-sage-1.0.0-aaaaaaaaaaaaaaaa");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePart(buffer) {
  fs.writeFileSync(partPath, buffer);
}

function extract(options = {}) {
  // Each call models a fresh manager run: the staging name is reused across the
  // assertion groups, so clear it first.
  fs.rmSync(stagingDir, { recursive: true, force: true });
  return installer.extractArchiveToStaging({
    fs,
    path,
    partPath,
    stagingDir,
    id: options.id || "hash-sage",
    ...LIMITS,
    ...options,
  });
}

const S_IFLNK = 0o120000;
const S_IFIFO = 0o010000;

function entryPack(extraEntries) {
  return buildZip([
    { name: "hash-sage/", dir: true },
    { name: "hash-sage/theme.json", data: "{}" },
    ...extraEntries,
  ]);
}

function expectCode(fn, code) {
  return fn().then(
    () => { throw new Error(`expected rejection with ${code}`); },
    (err) => { assert.strictEqual(err.code, code, err.message); },
  );
}

describe("official theme installer extraction", () => {
  it("extracts a valid pack into staging", async () => {
    writePart(hashSageFixture());
    const result = await extract();
    assert.strictEqual(result.entryCount, 7);
    assert.ok(result.unpackedBytes > 0);
    assert.ok(fs.existsSync(path.join(stagingDir, "theme.json")));
    assert.ok(fs.existsSync(path.join(stagingDir, "assets", "idle.svg")));
  });

  it("rejects zip-slip, absolute, backslash and cross-top-level paths", async () => {
    // The pure gate is asserted directly; yauzl may also reject some of these
    // earlier with its own ZIP_INVALID, which is equally safe.
    assert.strictEqual(installer.resolveArchiveEntryPath("hash-sage/../evil.txt", "hash-sage").ok, false);
    assert.strictEqual(installer.resolveArchiveEntryPath("/abs.txt", "hash-sage").ok, false);
    assert.strictEqual(installer.resolveArchiveEntryPath("hash-sage\\evil.txt", "hash-sage").ok, false);
    assert.strictEqual(installer.resolveArchiveEntryPath("other-theme/theme.json", "hash-sage").ok, false);
    assert.strictEqual(installer.resolveArchiveEntryPath("top-level.txt", "hash-sage").ok, false);

    const acceptable = new Set([installer.INSTALL_ERROR_CODES.ZIP_ENTRY_PATH, installer.INSTALL_ERROR_CODES.ZIP_INVALID]);
    const rejects = (entries) => assert.rejects(extract(), (err) => {
      assert.ok(acceptable.has(err.code), `unexpected code ${err.code}: ${err.message}`);
      return true;
    });
    writePart(entryPack([{ name: "hash-sage/../evil.txt", data: "x" }]));
    await rejects();
    writePart(entryPack([{ name: "/abs.txt", data: "x" }]));
    await rejects();
    writePart(entryPack([{ name: "hash-sage\\evil.txt", data: "x" }]));
    await rejects();
    writePart(entryPack([{ name: "other-theme/theme.json", data: "x" }]));
    await rejects();
    writePart(entryPack([{ name: "top-level.txt", data: "x" }]));
    await rejects();
  });

  it("rejects duplicate and case-colliding entries", async () => {
    await expectCode(async () => {
      writePart(entryPack([
        { name: "hash-sage/a.txt", data: "1" },
        { name: "hash-sage/A.txt", data: "2" },
      ]));
      await extract();
    }, installer.INSTALL_ERROR_CODES.ZIP_DUPLICATE);
  });

  it("rejects symlinks, special files and missing modes", async () => {
    await expectCode(async () => { writePart(entryPack([{ name: "hash-sage/link", data: "x", mode: S_IFLNK | 0o777 }])); await extract(); }, installer.INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE);
    await expectCode(async () => { writePart(entryPack([{ name: "hash-sage/fifo", data: "x", mode: S_IFIFO | 0o644 }])); await extract(); }, installer.INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE);
    await expectCode(async () => { writePart(entryPack([{ name: "hash-sage/file.txt", data: "x", mode: 0 }])); await extract(); }, installer.INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE);
    // directory marked with a regular-file mode
    await expectCode(async () => {
      writePart(entryPack([{ name: "hash-sage/dir/", mode: S_IFREG | 0o644 }]));
      await extract();
    }, installer.INSTALL_ERROR_CODES.ZIP_ENTRY_TYPE);
  });

  it("rejects encrypted and ZIP64 entries", async () => {
    await expectCode(async () => { writePart(entryPack([{ name: "hash-sage/enc.txt", data: "x", encrypted: true }])); await extract(); }, installer.INSTALL_ERROR_CODES.ZIP_ENCRYPTED);
    await expectCode(async () => { writePart(entryPack([{ name: "hash-sage/z64.txt", data: "x", extraZip64: true }])); await extract(); }, installer.INSTALL_ERROR_CODES.ZIP64_UNSUPPORTED);
  });

  it("enforces entry-count, per-entry and total byte limits", async () => {
    await expectCode(async () => {
      writePart(entryPack([
        { name: "hash-sage/a.txt", data: "1" },
        { name: "hash-sage/b.txt", data: "2" },
      ]));
      await extract({ maxEntries: 2 });
    }, installer.INSTALL_ERROR_CODES.ZIP_LIMIT);

    await expectCode(async () => {
      writePart(entryPack([{ name: "hash-sage/big.txt", data: "abcdef" }]));
      await extract({ perEntryMaxBytes: 3 });
    }, installer.INSTALL_ERROR_CODES.ZIP_LIMIT);

    await expectCode(async () => {
      writePart(entryPack([{ name: "hash-sage/big.txt", data: "abcdef" }]));
      await extract({ totalMaxBytes: 3 });
    }, installer.INSTALL_ERROR_CODES.ZIP_LIMIT);
  });

  it("aborts a mid-entry extraction promptly and deterministically", async () => {
    const zipfile = new EventEmitter();
    let readCount = 0;
    zipfile.close = () => { zipfile.closed = true; };
    zipfile.readEntry = () => {
      if (readCount++ === 0) {
        setImmediate(() => zipfile.emit("entry", {
          fileName: "hash-sage/assets/idle.svg",
          externalFileAttributes: (((S_IFREG | 0o644) << 16) >>> 0),
          uncompressedSize: 10,
          generalPurposeBitFlag: 0,
          extraFields: [],
        }));
      }
      // deliberately never emits "end": the entry stream stays open
    };
    zipfile.openReadStream = (entry, cb) => {
      const stream = new EventEmitter();
      stream.pause = () => {};
      stream.resume = () => {};
      stream.destroy = () => {
        stream.destroyed = true;
        setImmediate(() => stream.emit("close"));
      };
      setImmediate(() => stream.emit("data", Buffer.from("abc")));
      cb(null, stream);
      return stream;
    };

    const controller = new AbortController();
    const promise = installer.extractArchiveToStaging({
      fs,
      path,
      partPath,
      stagingDir,
      id: "hash-sage",
      ...LIMITS,
      openZip: () => Promise.resolve(zipfile),
      signal: controller.signal,
    });
    // Let the entry stream become active.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    controller.abort();
    await assert.rejects(
      promise,
      (err) => err.code === installer.INSTALL_ERROR_CODES.CANCELLED,
    );
    assert.ok(Date.now() - started < 2000, "abort must settle promptly");
    assert.strictEqual(fs.existsSync(stagingDir), false, "staging removed");
    assert.strictEqual(zipfile.closed, true, "zip closed");
  });

  it("aborts while the zip is still opening without hanging", async () => {
    let resolveOpen;
    const openPromise = new Promise((resolve) => { resolveOpen = resolve; });
    const controller = new AbortController();
    const promise = installer.extractArchiveToStaging({
      fs,
      path,
      partPath,
      stagingDir,
      id: "hash-sage",
      ...LIMITS,
      openZip: () => openPromise,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const zipfile = new EventEmitter();
    zipfile.close = () => { zipfile.closed = true; };
    resolveOpen(zipfile);

    await assert.rejects(promise, (err) => err.code === installer.INSTALL_ERROR_CODES.CANCELLED);
    assert.strictEqual(fs.existsSync(stagingDir), false, "staging removed");
    assert.strictEqual(zipfile.closed, true, "opened zip is closed on abort");
  });

  it("removes staging on a failed extraction", async () => {
    writePart(entryPack([{ name: "hash-sage/../evil.txt", data: "x" }]));
    await assert.rejects(extract());
    assert.strictEqual(fs.existsSync(stagingDir), false);
  });
});

describe("official theme marker", () => {
  it("round-trips a valid marker and rejects corrupt/mismatched ones", () => {
    const themeDir = path.join(tmp, "theme");
    fs.mkdirSync(themeDir, { recursive: true });
    const marker = installer.buildMarker({
      id: "hash-sage",
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      sourceRepository: "rullerzhou-afk/clawd-themes",
      installedAt: new Date(0).toISOString(),
    });
    installer.writeOfficialThemeMarker(themeDir, marker, { fs, path });
    const read = installer.readOfficialThemeMarker(themeDir, { fs, path });
    assert.strictEqual(read.id, "hash-sage");
    assert.strictEqual(read.version, "1.0.0");

    fs.writeFileSync(path.join(themeDir, installer.MARKER_FILENAME), "{not json", "utf8");
    assert.strictEqual(installer.readOfficialThemeMarker(themeDir, { fs, path }), null);

    fs.writeFileSync(path.join(themeDir, installer.MARKER_FILENAME), JSON.stringify({ schemaVersion: 1, managedBy: "someone-else" }), "utf8");
    assert.strictEqual(installer.readOfficialThemeMarker(themeDir, { fs, path }), null);
  });

  it("refuses to write an invalid marker", () => {
    const themeDir = path.join(tmp, "theme");
    fs.mkdirSync(themeDir, { recursive: true });
    assert.throws(() => installer.writeOfficialThemeMarker(themeDir, { id: "BAD" }, { fs, path }));
  });

  it("treats a foreign or missing source repository as unmanaged", () => {
    const valid = installer.buildMarker({
      id: "hash-sage",
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      sourceRepository: installer.OFFICIAL_SOURCE_REPOSITORY,
      installedAt: new Date(0).toISOString(),
    });

    for (const override of [
      { sourceRepository: "evil/other-repo" },
      { sourceRepository: "" },
      { sourceRepository: undefined },
    ]) {
      const themeDir = path.join(tmp, `foreign-${Math.random().toString(16).slice(2)}`);
      fs.mkdirSync(themeDir, { recursive: true });
      fs.writeFileSync(
        path.join(themeDir, installer.MARKER_FILENAME),
        JSON.stringify({ ...valid, ...override }),
        "utf8",
      );
      assert.strictEqual(installer.readOfficialThemeMarker(themeDir, { fs, path }), null);
    }

    // A missing/invalid installedAt is equally unmanaged.
    for (const installedAt of ["", "not-a-date", undefined, 12345]) {
      const themeDir = path.join(tmp, `ts-${Math.random().toString(16).slice(2)}`);
      fs.mkdirSync(themeDir, { recursive: true });
      fs.writeFileSync(
        path.join(themeDir, installer.MARKER_FILENAME),
        JSON.stringify({ ...valid, installedAt }),
        "utf8",
      );
      assert.strictEqual(installer.readOfficialThemeMarker(themeDir, { fs, path }), null);
    }

    // markersMatch also refuses when source differs.
    const foreign = { ...valid, sourceRepository: "evil/other-repo" };
    assert.strictEqual(installer.markersMatch(valid, foreign), false);
    assert.strictEqual(installer.markersMatch(valid, valid), true);
  });
});

describe("official theme commit", () => {
  function setupStaging(markerOverrides = {}) {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "theme.json"), "{}", "utf8");
    const marker = installer.buildMarker({
      id: "hash-sage",
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      sourceRepository: "rullerzhou-afk/clawd-themes",
      installedAt: new Date(0).toISOString(),
      ...markerOverrides,
    });
    installer.writeOfficialThemeMarker(stagingDir, marker, { fs, path });
    return marker;
  }

  it("renames staging to the target and reports installed", () => {
    const stagingRoot = path.join(tmp, "theme-staging", "official");
    const targetDir = path.join(tmp, "themes", "hash-sage");
    const marker = setupStaging();
    const result = installer.commitStagedInstall({
      fs,
      path,
      stagingRoot,
      stagingDir,
      targetDir,
      themeCacheDir: path.join(tmp, "theme-cache"),
      id: "hash-sage",
      marker,
      validateStaging: () => ({ ok: true }),
      validateTarget: () => ({ ok: true }),
    });
    assert.strictEqual(result.status, "installed");
    assert.ok(fs.existsSync(path.join(targetDir, "theme.json")));
    assert.strictEqual(fs.existsSync(stagingDir), false);
  });

  it("refuses to overwrite an existing target", () => {
    const stagingRoot = path.join(tmp, "theme-staging", "official");
    const targetDir = path.join(tmp, "themes", "hash-sage");
    fs.mkdirSync(targetDir, { recursive: true });
    const marker = setupStaging();
    assert.throws(
      () => installer.commitStagedInstall({
        fs, path, stagingRoot, stagingDir, targetDir, id: "hash-sage", marker,
        validateStaging: () => ({ ok: true }), validateTarget: () => ({ ok: true }),
      }),
      (err) => err.code === installer.INSTALL_ERROR_CODES.TARGET_CONFLICT,
    );
  });

  it("removes a just-created marker-owned target when the final readback fails", () => {
    const stagingRoot = path.join(tmp, "theme-staging", "official");
    const targetDir = path.join(tmp, "themes", "hash-sage");
    const marker = setupStaging();
    const result = installer.commitStagedInstall({
      fs, path, stagingRoot, stagingDir, targetDir, id: "hash-sage", marker,
      validateStaging: () => ({ ok: true }),
      validateTarget: () => ({ ok: false, errors: ["readback failed"] }),
    });
    assert.strictEqual(result.status, "failed");
    assert.deepStrictEqual(result.errors, ["readback failed"]);
    assert.strictEqual(fs.existsSync(targetDir), false);
  });

  it("reports repair-required when the failed target cannot be removed", () => {
    const stagingRoot = path.join(tmp, "theme-staging", "official");
    const targetDir = path.join(tmp, "themes", "hash-sage");
    const marker = setupStaging();
    const realRm = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (String(target).startsWith(targetDir)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return realRm.call(fs, target, options);
    };
    try {
      const result = installer.commitStagedInstall({
        fs, path, stagingRoot, stagingDir, targetDir, id: "hash-sage", marker,
        validateStaging: () => ({ ok: true }),
        validateTarget: () => ({ ok: false, errors: ["readback failed"] }),
      });
      assert.strictEqual(result.status, "repair-required");
      assert.strictEqual(result.repairRequired, true);
      assert.deepStrictEqual(result.errors, ["readback failed", "could not remove failed install"]);
    } finally {
      fs.rmSync = realRm;
    }
  });

  it("requires the marker to be present in staging before the rename", () => {
    const stagingRoot = path.join(tmp, "theme-staging", "official");
    const targetDir = path.join(tmp, "themes", "hash-sage");
    const marker = setupStaging();
    fs.rmSync(path.join(stagingDir, installer.MARKER_FILENAME));
    assert.throws(
      () => installer.commitStagedInstall({
        fs, path, stagingRoot, stagingDir, targetDir, id: "hash-sage", marker,
        validateStaging: () => ({ ok: true }), validateTarget: () => ({ ok: true }),
      }),
      (err) => err.code === installer.INSTALL_ERROR_CODES.MARKER_INVALID,
    );
    assert.strictEqual(fs.existsSync(targetDir), false);
  });

  it("rejects staging outside the manager staging root", () => {
    const marker = installer.buildMarker({
      id: "hash-sage", version: "1.0.0", archiveSha256: "a".repeat(64),
      sourceRepository: "rullerzhou-afk/clawd-themes", installedAt: new Date(0).toISOString(),
    });
    fs.mkdirSync(stagingDir, { recursive: true });
    assert.throws(
      () => installer.commitStagedInstall({
        fs, path,
        stagingRoot: path.join(tmp, "elsewhere"),
        stagingDir,
        targetDir: path.join(tmp, "themes", "hash-sage"),
        id: "hash-sage",
        marker,
      }),
      (err) => err.code === installer.INSTALL_ERROR_CODES.COMMIT_FAILED,
    );
  });
});
