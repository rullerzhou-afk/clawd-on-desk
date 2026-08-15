const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MARKER_PREFIX,
  claimTitle,
  sweepStaleMarkers,
  markerFile,
  __setCacheDirForTests,
} = require("../hooks/traecode-title-lock");

const tempDirs = [];

function makeCacheDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tltest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  __setCacheDirForTests(null);
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("traecode title lock", () => {
  it("claims the title on first call and persists a marker", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    const result = claimTitle("traecode", "s1", "/p", "第一个问题");

    assert.deepStrictEqual(result, { claimed: true, title: "第一个问题" });
    const file = markerFile("traecode", "s1", "/p");
    assert.ok(fs.existsSync(file), "marker file should exist");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).title, "第一个问题");
  });

  it("does not overwrite an already-claimed session title", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    claimTitle("traecode", "s1", "/p", "第一个问题");
    const result = claimTitle("traecode", "s1", "/p", "第二个问题");

    assert.deepStrictEqual(result, { claimed: false, title: "第一个问题" });
  });

  it("treats different sessions independently", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    claimTitle("traecode", "s1", "/p", "标题A");
    const result = claimTitle("traecode", "s2", "/p", "标题B");

    assert.deepStrictEqual(result, { claimed: true, title: "标题B" });
  });

  it("distinguishes sessions by cwd as well as session id", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    claimTitle("traecode", "s1", "/p1", "标题A");
    const result = claimTitle("traecode", "s1", "/p2", "标题B");

    assert.deepStrictEqual(result, { claimed: true, title: "标题B" });
  });

  it("returns claimed:false without a marker when the title is empty", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    const result = claimTitle("traecode", "s1", "/p", "  ");
    const file = markerFile("traecode", "s1", "/p");

    assert.deepStrictEqual(result, { claimed: false, title: null });
    assert.strictEqual(fs.existsSync(file), false);
  });

  it("returns claimed:false without a marker when the title is missing", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    const result = claimTitle("traecode", "s1", "/p", null);
    const file = markerFile("traecode", "s1", "/p");

    assert.deepStrictEqual(result, { claimed: false, title: null });
    assert.strictEqual(fs.existsSync(file), false);
  });

  it("markerFile is deterministic", () => {
    assert.strictEqual(
      markerFile("traecode", "s1", "/p"),
      markerFile("traecode", "s1", "/p")
    );
    assert.notStrictEqual(
      markerFile("traecode", "s1", "/p"),
      markerFile("traecode", "s2", "/p")
    );
  });

  it("sweepStaleMarkers removes old markers and keeps fresh ones", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    const stale = markerFile("traecode", "old", "/p");
    const fresh = markerFile("traecode", "new", "/p");
    fs.writeFileSync(stale, JSON.stringify({ title: "旧", at: 0 }), "utf8");
    fs.writeFileSync(fresh, JSON.stringify({ title: "新", at: Date.now() }), "utf8");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    sweepStaleMarkers();

    assert.strictEqual(fs.existsSync(stale), false, "stale marker should be removed");
    assert.ok(fs.existsSync(fresh), "fresh marker should remain");
  });

  it("sweepStaleMarkers ignores unrelated files in the cache dir", () => {
    const dir = makeCacheDir();
    __setCacheDirForTests(dir);

    const unrelated = path.join(dir, "clawd-pidcache2-other.json");
    fs.writeFileSync(unrelated, "{}", "utf8");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(unrelated, old, old);

    sweepStaleMarkers();

    assert.ok(fs.existsSync(unrelated), "unrelated files must not be swept");
  });

  it("honors the TRAECODE_TITLE_CACHE_DIR env override", () => {
    const dir = makeCacheDir();
    const previous = process.env.TRAECODE_TITLE_CACHE_DIR;
    process.env.TRAECODE_TITLE_CACHE_DIR = dir;
    try {
      const result = claimTitle("traecode", "s1", "/p", "标题");
      assert.strictEqual(result.claimed, true);
      assert.ok(fs.existsSync(markerFile("traecode", "s1", "/p")));
    } finally {
      if (previous === undefined) delete process.env.TRAECODE_TITLE_CACHE_DIR;
      else process.env.TRAECODE_TITLE_CACHE_DIR = previous;
    }
  });
});
