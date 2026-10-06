"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const catalog = require("../src/official-theme-catalog");
const {
  SNAPSHOT_PATH,
  updateOfficialThemeCatalogSnapshot,
  defaultFetch,
} = require("../scripts/update-official-theme-catalog-snapshot");

function validSnapshotText(catalogVersion) {
  const doc = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  doc.catalogVersion = catalogVersion;
  return JSON.stringify(doc, null, 2);
}

async function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-snapshot-"));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("bundled official theme catalog snapshot", () => {
  it("is a valid catalog document", () => {
    const parsed = catalog.parseCatalogText(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    assert.strictEqual(parsed.ok, true, (parsed.errors || []).join("; "));
    assert.ok(parsed.catalog.catalogVersion > 0);
    assert.ok(parsed.catalog.themes.length > 0);
  });

  it("reads the shipped snapshot through readCatalogSnapshot", () => {
    const snapshot = catalog.readCatalogSnapshot();
    assert.ok(snapshot);
    const parsed = catalog.parseCatalogText(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    assert.ok(parsed.ok);
    assert.strictEqual(snapshot.catalogVersion, parsed.catalog.catalogVersion);
  });

  it("treats an invalid snapshot file as absent", async () => {
    await withTempDir((dir) => {
      const target = path.join(dir, "snapshot.json");
      fs.writeFileSync(target, "{ not json", "utf8");
      assert.strictEqual(catalog.readCatalogSnapshot({ snapshotPath: target }), null);
    });
  });
});

describe("official theme catalog snapshot update", () => {
  it("writes the exact validated bytes", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "snapshot.json");
      const text = validSnapshotText(9);
      const result = await updateOfficialThemeCatalogSnapshot({
        fetchImpl: async () => text,
        snapshotPath: target,
      });
      assert.strictEqual(result.status, "written");
      assert.strictEqual(result.catalogVersion, 9);
      assert.strictEqual(fs.readFileSync(target, "utf8"), text);
    });
  });

  it("accepts an equal version but rejects a lower one without touching the file", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "snapshot.json");
      fs.writeFileSync(target, validSnapshotText(9), "utf8");
      const equal = await updateOfficialThemeCatalogSnapshot({
        fetchImpl: async () => validSnapshotText(9),
        snapshotPath: target,
      });
      assert.strictEqual(equal.status, "written");

      const before = fs.readFileSync(target, "utf8");
      const lower = await updateOfficialThemeCatalogSnapshot({
        fetchImpl: async () => validSnapshotText(8),
        snapshotPath: target,
      });
      assert.strictEqual(lower.status, "regression");
      assert.strictEqual(lower.currentVersion, 9);
      assert.strictEqual(fs.readFileSync(target, "utf8"), before);
    });
  });

  it("rejects invalid content without touching the file", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "snapshot.json");
      const before = validSnapshotText(9);
      fs.writeFileSync(target, before, "utf8");
      const result = await updateOfficialThemeCatalogSnapshot({
        fetchImpl: async () => "not json",
        snapshotPath: target,
      });
      assert.strictEqual(result.status, "invalid");
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
      assert.strictEqual(fs.readFileSync(target, "utf8"), before);
    });
  });

  it("times out a stalled fetch with a clear error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      const signal = options && options.signal;
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      if (signal && signal.aborted) abort();
      else if (signal) signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await assert.rejects(
        () => defaultFetch("https://example.invalid/catalog.json", { timeoutMs: 10 }),
        /timed out after 10 ms/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
