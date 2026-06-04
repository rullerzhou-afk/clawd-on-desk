const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { validateOpencodeEntry } = require("../src/doctor-detectors/opencode-entry-validator");

function fakeFs({ dirs = [], files = [], contents = null } = {}) {
  const dirSet = new Set(dirs);
  const fileSet = new Set(files);
  const impl = {
    statSync: (entry) => {
      if (!dirSet.has(entry) && !fileSet.has(entry)) {
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      }
      return { isDirectory: () => dirSet.has(entry) };
    },
    existsSync: (entry) => fileSet.has(entry) || dirSet.has(entry),
  };
  // Only expose readFileSync when contents are supplied, so the existing
  // static-only cases keep exercising the path/file checks — validateOpencodeEntry
  // skips the source scan when readFileSync is absent.
  if (contents) {
    impl.readFileSync = (entry) => {
      if (Object.prototype.hasOwnProperty.call(contents, entry)) return contents[entry];
      const err = new Error("missing");
      err.code = "ENOENT";
      throw err;
    };
  }
  return impl;
}

describe("validateOpencodeEntry", () => {
  it("rejects relative entries", () => {
    assert.deepStrictEqual(
      validateOpencodeEntry("plugins/opencode-plugin"),
      { ok: false, reason: "not-absolute" }
    );
  });

  it("reports missing plugin directories", () => {
    assert.deepStrictEqual(
      validateOpencodeEntry("/opt/clawd/hooks/opencode-plugin", { fs: fakeFs() }),
      { ok: false, reason: "directory-missing" }
    );
  });

  it("reports entries that are not directories", () => {
    const entry = "/opt/clawd/hooks/opencode-plugin";
    assert.deepStrictEqual(
      validateOpencodeEntry(entry, { fs: fakeFs({ files: [entry] }) }),
      { ok: false, reason: "not-a-directory" }
    );
  });

  it("reports missing index.mjs", () => {
    const entry = "/opt/clawd/hooks/opencode-plugin";
    assert.deepStrictEqual(
      validateOpencodeEntry(entry, { fs: fakeFs({ dirs: [entry] }) }),
      { ok: false, reason: "index-mjs-missing" }
    );
  });

  it("accepts absolute plugin directories with index.mjs", () => {
    const entry = "/opt/clawd/hooks/opencode-plugin";
    assert.deepStrictEqual(
      validateOpencodeEntry(entry, {
        fs: fakeFs({
          dirs: [entry],
          files: [path.join(entry, "index.mjs")],
        }),
      }),
      { ok: true }
    );
  });

  it("accepts Windows absolute paths", () => {
    const entry = "C:\\clawd\\hooks\\opencode-plugin";
    assert.deepStrictEqual(
      validateOpencodeEntry(entry, {
        fs: fakeFs({
          dirs: [entry],
          files: [path.join(entry, "index.mjs")],
        }),
      }),
      { ok: true }
    );
  });

  it("rejects a module with an extra named export (#413 false-green guard)", () => {
    const entry = "/opt/clawd/hooks/opencode-plugin";
    const indexPath = path.join(entry, "index.mjs");
    assert.deepStrictEqual(
      validateOpencodeEntry(entry, {
        fs: fakeFs({
          dirs: [entry],
          files: [indexPath],
          contents: {
            [indexPath]:
              "export const __test = {};\nexport default async () => ({ event: async () => {} });\n",
          },
        }),
      }),
      { ok: false, reason: "extra-module-exports" }
    );
  });

  it("accepts a module that only default-exports a function", () => {
    const entry = "/opt/clawd/hooks/opencode-plugin";
    const indexPath = path.join(entry, "index.mjs");
    assert.deepStrictEqual(
      validateOpencodeEntry(entry, {
        fs: fakeFs({
          dirs: [entry],
          files: [indexPath],
          contents: {
            [indexPath]:
              'const plugin = async () => ({ event: async () => {} });\nObject.defineProperty(plugin, "__test", { value: {} });\nexport default plugin;\n',
          },
        }),
      }),
      { ok: true }
    );
  });

  it("accepts the real opencode plugin module (single default export)", () => {
    const entry = path.join(__dirname, "..", "hooks", "opencode-plugin");
    assert.deepStrictEqual(validateOpencodeEntry(entry), { ok: true });
  });
});
