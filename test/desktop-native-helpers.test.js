"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  prepareNativeHelpers,
} = require("../src/desktop-integrations/native-helpers");

test("native helpers reuse the exact source generation and reject modified binaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-native-test-"));
  let builds = 0;
  const options = {
    storageRoot: root,
    platform: "win32",
    arch: "x64",
    run(_file, args, _options, callback) {
      builds++;
      const output = args[args.indexOf("-OutputDirectory") + 1];
      for (const name of ["library-native.exe", "desktop-lyrics.exe"])
        fs.writeFileSync(path.join(output, name), "synthetic test artifact");
      callback(null);
    },
  };
  try {
    const first = await prepareNativeHelpers(options);
    assert.equal(await prepareNativeHelpers(options), first);
    assert.equal(builds, 1);
    fs.writeFileSync(path.join(first, "library-native.exe"), "changed");
    await assert.rejects(prepareNativeHelpers(options), /helpers changed/);
    assert.equal(builds, 1);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("clawd-native-test-"));
    fs.rmSync(root, { recursive: true });
  }
});

test("unsupported native targets never invoke a compiler", async () => {
  await assert.rejects(
    prepareNativeHelpers({
      platform: "linux",
      arch: "x64",
      run() {
        assert.fail("must not build");
      },
    }),
    /Windows x64/,
  );
  await assert.rejects(
    prepareNativeHelpers({
      platform: "win32",
      arch: "arm64",
      run() {
        assert.fail("must not build");
      },
    }),
    /Windows x64/,
  );
});
