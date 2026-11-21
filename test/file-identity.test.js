"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { toNumberStats, fileIdentity, readStats } = require("../hooks/file-identity");

test("H1: nanosecond conversion matches native doubles, including negative times", t => {
  assert.equal(toNumberStats({ mtimeNs: 1700000000000000123n }).mtimeMs, 1700000000000.0002);
  assert.equal(toNumberStats({ mtimeNs: -1n }).mtimeMs, -9.999999974752427e-7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "file");
  fs.writeFileSync(file, "hello");
  for (const target of [file, dir]) {
    const actual = readStats(fs.statSync, target);
    const expected = fs.statSync(target);
    for (const field of ["size", "mode", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"]) {
      assert.equal(actual[field], expected[field], field);
    }
    for (const method of ["isFile", "isDirectory", "isSymbolicLink", "isBlockDevice",
      "isCharacterDevice", "isFIFO", "isSocket"]) assert.equal(actual[method](), expected[method]());
    assert.equal("mtime" in actual, false);
    assert.equal(fileIdentity(actual), fileIdentity(fs.statSync(target, { bigint: true })));
  }
});

test("H2: exact inode strings distinguish colliding Number IDs", () => {
  const a = { dev: 7n, ino: 2n ** 62n + 1n };
  const b = { ...a, ino: a.ino + 1n };
  assert.equal(Number(a.ino), Number(b.ino));
  assert.notEqual(fileIdentity(toNumberStats(a)), fileIdentity(toNumberStats(b)));
  assert.equal(fileIdentity({ ...a, ino: Number(a.ino) }), fileIdentity({ ...b, ino: Number(b.ino) }));
  const deviceA = { dev: a.ino, ino: 5n }, deviceB = { dev: b.ino, ino: 5n };
  assert.equal(Number(deviceA.dev), Number(deviceB.dev));
  assert.notEqual(fileIdentity(toNumberStats(deviceA)), fileIdentity(toNumberStats(deviceB)));
});

test("H3: ordinary and mixed stats retain numeric fields and equivalent identities", () => {
  for (const value of [null, undefined, { dev: 3, ino: 4, size: 10 }]) assert.equal(toNumberStats(value), value);
  const mixed = { dev: 3n, ino: 4n, mode: 33188n, size: 10, mtimeMs: 42n, atimeMs: 3,
    ctimeNs: 123456789n, birthtimeMs: 2n };
  const view = toNumberStats(mixed);
  assert.equal(view.size, 10);
  assert.equal(view.mode, 33188);
  assert.equal(view.mtimeMs, 42);
  assert.equal(view.atimeMs, 3);
  assert.equal(view.ctimeMs, 123.456789);
  assert.equal(view.birthtimeMs, 2);
  assert.equal(view.isFile, undefined);
  assert.equal(fileIdentity(view), fileIdentity({ dev: 3, ino: 4 }));
});

test("H4: birth, device and unavailable identity fallbacks", () => {
  const exact = { dev: 7n, ino: 0n, birthtimeNs: 1700000000000000123n };
  assert.equal(fileIdentity(exact), "birth:1700000000000.0002");
  assert.equal(fileIdentity(toNumberStats(exact)), fileIdentity(exact));
  assert.equal(fileIdentity({ dev: 7, ino: 0, birthtimeMs: 42 }), "birth:42");
  assert.equal(fileIdentity({ dev: 7n, ino: 0n, birthtimeMs: 0n }), "dev:7");
  assert.equal(fileIdentity({ dev: 0, ino: 0, birthtimeMs: 0 }), null);
});

test("H5: readStats takes one bigint sample", () => {
  let calls = 0;
  const view = readStats((target, options) => {
    calls++;
    assert.equal(target, 42);
    assert.deepEqual(options, { bigint: true });
    return { dev: 1n, ino: 2n, size: 3n };
  }, 42);
  assert.equal(calls, 1);
  assert.equal(view.size, 3);
});

test("H3/V15: spread-and-modified stats compute their own identity", () => {
  const view = toNumberStats({ dev: 7n, ino: 2n ** 62n + 1n, size: 10n });
  const symbol = Symbol.for("clawd-on-desk.fileIdentity");
  assert.equal(Object.getOwnPropertyDescriptor(view, symbol).enumerable, false);
  const copy = { ...view, ino: 42n, size: 11 };
  assert.equal(fileIdentity(toNumberStats(copy)), "inode:7:42");
  assert.notEqual(fileIdentity(copy), fileIdentity(view));
});

test("collision fixture shares exact IDs across path, fd and async stats", async t => {
  const { collidingFileIds } = require("./helpers/colliding-file-ids");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "file"), peer = path.join(dir, "peer");
  fs.writeFileSync(file, "x"); fs.writeFileSync(peer, "x");
  const ids = collidingFileIds(t);
  const expected = ids.snapshot(file);
  ids.assertCollision(expected, ids.snapshot(peer));
  const missing = path.join(dir, "missing");
  for (const bigint of [false, true]) {
    assert.equal(fs.statSync(missing, { bigint, throwIfNoEntry: false }), undefined);
    assert.equal(fs.lstatSync(missing, { bigint, throwIfNoEntry: false }), undefined);
  }
  const fd = fs.openSync(file, "r");
  const handle = await fs.promises.open(file, "r");
  try {
    assert.equal(fs.lstatSync(file, { bigint: true }).ino, expected);
    assert.equal(fs.fstatSync(fd, { bigint: true }).ino, expected);
    assert.equal((await fs.promises.lstat(file, { bigint: true })).ino, expected);
    assert.equal((await handle.stat({ bigint: true })).ino, expected);
    assert.equal(fs.statSync(file).ino, Number(expected));
    assert.equal(fs.lstatSync(file).ino, Number(expected));
    assert.equal(fs.fstatSync(fd).ino, Number(expected));
    assert.equal((await fs.promises.lstat(file)).ino, Number(expected));
    assert.equal((await handle.stat()).ino, Number(expected));
    assert.equal(typeof (await handle.stat({ bigint: true })).size, "bigint");
  } finally { fs.closeSync(fd); await handle.close(); }
});
