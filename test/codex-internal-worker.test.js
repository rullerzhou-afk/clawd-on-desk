const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isCodexMemoryWorkerPayload } = require("../hooks/codex-internal-worker");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("issue #1073: Codex internal memory worker detection", () => {
  it("matches the default <home>/.codex/memories directory", () => {
    withTempDir("codex-worker-", (home) => {
      const payload = { cwd: path.join(home, ".codex", "memories") };
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: home }), true);
    });
  });

  it("matches the memories_v2 directory", () => {
    withTempDir("codex-worker-", (home) => {
      const payload = { cwd: path.join(home, ".codex", "memories_v2") };
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: home }), true);
    });
  });

  it("matches a custom CODEX_HOME", () => {
    withTempDir("codex-worker-", (home) => {
      const codexHome = path.join(home, "custom-codex");
      const payload = { cwd: path.join(codexHome, "memories") };
      assert.strictEqual(
        isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: codexHome }, homedir: home }),
        true
      );
    });
  });

  it("ignores a trailing separator on the cwd", () => {
    withTempDir("codex-worker-", (home) => {
      const codexHome = path.join(home, "codex-home");
      const payload = { cwd: `${path.join(codexHome, "memories")}${path.sep}` };
      assert.strictEqual(
        isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: codexHome }, homedir: home }),
        true
      );
    });
  });

  it("does not trim surrounding whitespace from CODEX_HOME", () => {
    withTempDir("codex-worker-", (home) => {
      const codexHome = path.join(home, "codex-home");
      const payload = { cwd: path.join(codexHome, "memories") };
      assert.strictEqual(
        isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: `  ${codexHome}  ` }, homedir: home }),
        false
      );
    });
  });

  it("folds case and separators on win32", () => {
    const payload = { cwd: "c:/Users/Tester/.CODEX/Memories\\" };
    const options = {
      platform: "win32",
      homedir: "C:\\Users\\Tester",
      env: {},
    };
    assert.strictEqual(isCodexMemoryWorkerPayload(payload, options), true);
  });

  it("strips the \\\\?\\ namespace prefix from win32 realpath output", () => {
    const options = {
      platform: "win32",
      homedir: "C:\\linkhome",
      env: {},
      realpath(value) {
        if (value === "C:\\linkhome\\.codex\\memories") {
          return "\\\\?\\C:\\realhome\\.codex\\memories";
        }
        if (value === "C:\\other\\memories") return "C:\\realhome\\.codex\\memories";
        throw new Error("ENOENT");
      },
    };
    assert.strictEqual(
      isCodexMemoryWorkerPayload({ cwd: "C:\\other\\memories" }, options),
      true
    );
  });

  it("strips the \\\\?\\UNC\\ prefix from win32 realpath output", () => {
    const options = {
      platform: "win32",
      homedir: "\\\\linkhost\\share",
      env: {},
      realpath(value) {
        if (value === "\\\\linkhost\\share\\.codex\\memories") {
          return "\\\\?\\UNC\\realhost\\share\\.codex\\memories";
        }
        if (value === "\\\\other\\memories") return "\\\\realhost\\share\\.codex\\memories";
        throw new Error("ENOENT");
      },
    };
    assert.strictEqual(
      isCodexMemoryWorkerPayload({ cwd: "\\\\other\\memories" }, options),
      true
    );
  });

  it("never matches a relative CODEX_HOME", () => {
    const cases = [
      { env: { CODEX_HOME: "alt-codex" }, cwd: "/base/proj/alt-codex/memories" },
      { env: { CODEX_HOME: "alt-codex" }, cwd: "/base/proj/xalt-codex/memories" },
      { env: { CODEX_HOME: "." }, cwd: "/base/unrelated/project/memories" },
      { env: { CODEX_HOME: "./" }, cwd: "/base/unrelated/project/memories" },
      { env: { CODEX_HOME: "   " }, cwd: "/base/unrelated/project/memories" },
      { env: { CODEX_HOME: "../alt-codex" }, cwd: "/base/sibling/alt-codex/memories" },
    ];
    for (const { env, cwd } of cases) {
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd }, { env }),
        false,
        `${JSON.stringify(env.CODEX_HOME)} must not match ${cwd}`
      );
    }
  });

  it("never matches a win32 drive-relative CODEX_HOME", () => {
    assert.strictEqual(
      isCodexMemoryWorkerPayload(
        { cwd: "C:\\base\\alt-codex\\memories" },
        { platform: "win32", env: { CODEX_HOME: "C:alt-codex" }, homedir: "C:\\Users\\Tester" }
      ),
      false
    );
  });

  it("does not resolve a relative CODEX_HOME against the hook process cwd", () => {
    withTempDir("codex-worker-cwd-", (base) => {
      const memoriesDir = path.join(base, "proj", "memories");
      fs.mkdirSync(memoriesDir, { recursive: true });
      const originalCwd = process.cwd();
      // Codex runs the hook with its cwd set to the event cwd, so a naive
      // `resolve("..")` would make this ordinary project directory look like
      // `CODEX_HOME/../memories` and swallow a real session.
      process.chdir(memoriesDir);
      try {
        const payload = { cwd: process.cwd() };
        for (const codexHome of ["..", "../", "./.."]) {
          assert.strictEqual(
            isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: codexHome }, homedir: base }),
            false,
            `${codexHome} must not resolve against the hook cwd`
          );
        }
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it("does not resolve a parent-free relative CODEX_HOME against the hook process cwd", () => {
    withTempDir("codex-worker-relative-cwd-", (base) => {
      const projectDir = path.join(base, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(projectDir);
      try {
        // process.cwd() + "alt-codex/memories" equals the payload cwd, so a
        // resolver that anchors relative homes at the hook cwd would match.
        const payload = { cwd: path.join(process.cwd(), "alt-codex", "memories") };
        assert.strictEqual(
          isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: "alt-codex" }, homedir: base }),
          false
        );
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it("does not match a symlinked CODEX_HOME containing a parent segment", () => {
    withTempDir("codex-worker-dotdot-", (base) => {
      const target = path.join(base, "target");
      const sub = path.join(target, "sub");
      const link = path.join(base, "link");
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(path.join(base, "memories"), { recursive: true });
      fs.mkdirSync(path.join(target, "memories"), { recursive: true });
      fs.symlinkSync(sub, link, process.platform === "win32" ? "junction" : "dir");
      // String concatenation (not path.join) keeps the ".." segment, which the
      // OS canonicalizes differently than a plain string collapse would.
      const env = { CODEX_HOME: `${link}${path.sep}..` };
      // A real session under the string-collapsed directory must not be
      // swallowed by a false positive.
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd: path.join(base, "memories") }, { env, homedir: base }),
        false
      );
      // The true worker cwd (link -> target/sub, then .. -> target) is also a
      // deliberate miss: the two forms cannot be told apart without the OS.
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd: path.join(target, "memories") }, { env, homedir: base }),
        false
      );
    });
  });

  it("does not match a cwd containing a parent segment", () => {
    withTempDir("codex-worker-", (home) => {
      const cwd = `${path.join(home, ".codex", "x")}${path.sep}..${path.sep}memories`;
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd }, { env: {}, homedir: home }),
        false
      );
    });
  });

  it("does not match a win32 CODEX_HOME without a drive or UNC root", () => {
    const cases = [
      { codexHome: "/", cwd: "\\memories" },
      { codexHome: "\\Users\\x\\.codex", cwd: "\\Users\\x\\.codex\\memories" },
      { codexHome: "/c/Users/x/.codex", cwd: "\\c\\Users\\x\\.codex\\memories" },
    ];
    for (const { codexHome, cwd } of cases) {
      assert.strictEqual(
        isCodexMemoryWorkerPayload(
          { cwd },
          { platform: "win32", env: { CODEX_HOME: codexHome }, homedir: "C:\\Users\\x" }
        ),
        false,
        `${codexHome} must not match`
      );
    }
  });

  it("matches a win32 CODEX_HOME with a drive or UNC root", () => {
    const driveCwd = "C:\\Users\\Tester\\.codex\\memories";
    for (const codexHome of ["C:\\Users\\Tester\\.codex", "C:/Users/Tester/.codex"]) {
      assert.strictEqual(
        isCodexMemoryWorkerPayload(
          { cwd: driveCwd },
          { platform: "win32", env: { CODEX_HOME: codexHome }, homedir: "C:\\Users\\Tester" }
        ),
        true,
        `${codexHome} must match`
      );
    }
    assert.strictEqual(
      isCodexMemoryWorkerPayload(
        { cwd: "\\\\server\\share\\.codex\\memories" },
        { platform: "win32", env: { CODEX_HOME: "\\\\server\\share\\.codex" }, homedir: "\\\\server\\share" }
      ),
      true
    );
  });

  it("matches a win32 verbatim cwd after stripping the namespace prefix", () => {
    assert.strictEqual(
      isCodexMemoryWorkerPayload(
        { cwd: "\\\\?\\C:\\Users\\Tester\\.codex\\memories" },
        { platform: "win32", env: { CODEX_HOME: "C:\\Users\\Tester\\.codex" }, homedir: "C:\\Users\\Tester" }
      ),
      true
    );
    assert.strictEqual(
      isCodexMemoryWorkerPayload(
        { cwd: "\\\\?\\UNC\\server\\share\\.codex\\memories" },
        { platform: "win32", env: { CODEX_HOME: "\\\\server\\share\\.codex" }, homedir: "\\\\server\\share" }
      ),
      true
    );
  });

  it("matches a CODEX_HOME whose directory name ends with a space", () => {
    withTempDir("codex-worker-", (home) => {
      const codexHome = path.join(home, "space", "codex ");
      const payload = { cwd: path.join(codexHome, "memories") };
      assert.strictEqual(
        isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: codexHome }, homedir: home }),
        true
      );
    });
  });

  it("does not trim a trailing-space CODEX_HOME into its sibling directory", () => {
    withTempDir("codex-worker-", (base) => {
      const withSpace = path.join(base, "codex ");
      const withoutSpace = path.join(base, "codex");
      fs.mkdirSync(path.join(withSpace, "memories"), { recursive: true });
      fs.mkdirSync(path.join(withoutSpace, "memories"), { recursive: true });
      const env = { CODEX_HOME: withSpace };
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd: path.join(withSpace, "memories") }, { env, homedir: base }),
        true
      );
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd: path.join(withoutSpace, "memories") }, { env, homedir: base }),
        false
      );
    });
  });

  it("matches a symlinked CODEX_HOME through realpath", () => {
    withTempDir("codex-worker-real-", (realHome) => {
      fs.mkdirSync(path.join(realHome, "memories"));
      withTempDir("codex-worker-link-", (linkParent) => {
        const linkHome = path.join(linkParent, "codex-link");
        fs.symlinkSync(realHome, linkHome, "dir");
        const payload = { cwd: path.join(fs.realpathSync(realHome), "memories") };
        assert.strictEqual(
          isCodexMemoryWorkerPayload(payload, { env: { CODEX_HOME: linkHome }, homedir: linkParent }),
          true
        );
      });
    });
  });

  it("accepts an injected realpath so a non-existent home still matches", () => {
    const payload = { cwd: "/resolved/codex/memories" };
    const options = {
      env: { CODEX_HOME: "/link/codex" },
      realpath(value) {
        if (value === "/link/codex/memories") return "/resolved/codex/memories";
        throw new Error("ENOENT");
      },
    };
    assert.strictEqual(isCodexMemoryWorkerPayload(payload, options), true);
  });

  it("does not match when a transcript_path is present", () => {
    withTempDir("codex-worker-", (home) => {
      const payload = {
        cwd: path.join(home, ".codex", "memories"),
        transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
      };
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: home }), false);
    });
  });

  it("does not match a non-string transcript_path", () => {
    withTempDir("codex-worker-", (home) => {
      const payload = { cwd: path.join(home, ".codex", "memories"), transcript_path: {} };
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: home }), false);
    });
  });

  it("does not match when cwd is CODEX_HOME itself", () => {
    withTempDir("codex-worker-", (home) => {
      const codexHome = path.join(home, ".codex");
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd: codexHome }, { env: {}, homedir: home }),
        false
      );
    });
  });

  it("does not match a subdirectory of memories", () => {
    withTempDir("codex-worker-", (home) => {
      const payload = { cwd: path.join(home, ".codex", "memories", "nested") };
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: home }), false);
    });
  });

  it("does not match lookalike directory names", () => {
    withTempDir("codex-worker-", (home) => {
      for (const name of ["memoriesX", "memories_v3", "memories2"]) {
        const payload = { cwd: path.join(home, ".codex", name) };
        assert.strictEqual(
          isCodexMemoryWorkerPayload(payload, { env: {}, homedir: home }),
          false,
          `${name} must not match`
        );
      }
    });
  });

  it("does not match an unrelated directory named memories", () => {
    withTempDir("codex-worker-", (home) => {
      assert.strictEqual(
        isCodexMemoryWorkerPayload({ cwd: "/work/memories" }, { env: {}, homedir: home }),
        false
      );
    });
  });

  it("does not match a missing or non-string cwd", () => {
    for (const payload of [{}, { cwd: null }, { cwd: 42 }, { cwd: "" }, { cwd: "   " }]) {
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: "/home/u" }), false);
    }
  });

  it("does not match a non-object payload", () => {
    for (const payload of [null, undefined, "cwd", 7, true, []]) {
      assert.strictEqual(isCodexMemoryWorkerPayload(payload, { env: {}, homedir: "/home/u" }), false);
    }
  });

  it("does not match when the path dialect disagrees with the platform", () => {
    const payload = { cwd: "C:\\Users\\Tester\\.codex\\memories" };
    assert.strictEqual(
      isCodexMemoryWorkerPayload(payload, {
        platform: "posix",
        env: { CODEX_HOME: "C:\\Users\\Tester\\.codex" },
      }),
      false
    );
  });
});
