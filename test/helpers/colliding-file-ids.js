"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");

// One map covers paths, descriptors and FileHandles. Keep native Stats methods
// and all other fields intact; only the inode is synthetic.
function collidingFileIds(t) {
  const ids = new Map();
  const statSync = fs.statSync;
  const lstatSync = fs.lstatSync;
  const fstatSync = fs.fstatSync;
  const lstat = fs.promises.lstat;
  const open = fs.promises.open;
  // Tests can add another race/failure wrapper over these methods. Reset those
  // mocks before restoring natives, so nested wrappers cannot leak to a sibling.
  t.after(() => {
    t.mock.reset();
    Object.assign(fs, { statSync, lstatSync, fstatSync });
    Object.assign(fs.promises, { lstat, open });
  });

  function mapped(stat) {
    const key = `${stat.dev}:${stat.ino}`;
    if (!ids.has(key)) {
      assert.ok(ids.size < 500, "collision fixture supports at most 500 identities");
      ids.set(key, 2n ** 62n + BigInt(ids.size + 1));
    }
    return ids.get(key);
  }

  function wrapSync(original) {
    return (target, options) => {
      const exact = original(target, { ...options, bigint: true });
      if (exact === undefined) return exact;
      const ino = mapped(exact);
      const result = options?.bigint ? exact : original(target, options);
      if (result === undefined) return result;
      result.ino = options?.bigint ? ino : Number(ino);
      return result;
    };
  }

  t.mock.method(fs, "statSync", wrapSync(statSync));
  t.mock.method(fs, "lstatSync", wrapSync(lstatSync));
  t.mock.method(fs, "fstatSync", wrapSync(fstatSync));
  t.mock.method(fs.promises, "lstat", async (target, options) => {
    const exact = await lstat(target, { ...options, bigint: true });
    if (exact === undefined) return exact;
    const ino = mapped(exact);
    const result = options?.bigint ? exact : await lstat(target, options);
    if (result === undefined) return result;
    result.ino = options?.bigint ? ino : Number(ino);
    return result;
  });
  t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = async (options) => {
      const exact = await stat({ ...options, bigint: true });
      if (exact === undefined) return exact;
      const ino = mapped(exact);
      const result = options?.bigint ? exact : await stat(options);
      if (result === undefined) return result;
      result.ino = options?.bigint ? ino : Number(ino);
      return result;
    };
    return handle;
  });

  function snapshot(target) {
    return fs.statSync(target, { bigint: true }).ino;
  }

  function assertCollision(before, after) {
    assert.notEqual(before, after, "precise file IDs must differ");
    assert.equal(Number(before), Number(after), "Number file IDs must collide");
  }

  return { snapshot, assertCollision };
}

module.exports = { collidingFileIds };
