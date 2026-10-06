"use strict";

// Refresh the bundled official-theme catalog snapshot from the live catalog.
// The snapshot is the last-resort list fallback when the network fetch fails
// and no disk cache exists; it carries only catalog metadata, never theme
// assets or previews. Run this before a release and commit any diff.

const fs = require("node:fs");
const path = require("node:path");

const catalog = require("../src/official-theme-catalog");

const SNAPSHOT_PATH = path.join(__dirname, "..", "src", "official-theme-catalog-snapshot.json");
const DEFAULT_FETCH_TIMEOUT_MS = 30000;

function readCurrentSnapshotVersion({ fsImpl = fs, snapshotPath = SNAPSHOT_PATH } = {}) {
  const current = catalog.readCatalogSnapshot({ fs: fsImpl, path, snapshotPath });
  return current ? current.catalogVersion : 0;
}

// `fetchImpl` is injected so the decision logic can be unit tested without the
// network. On success the exact fetched bytes are validated, then written
// verbatim; an invalid document or a version below the current snapshot is
// rejected.
async function updateOfficialThemeCatalogSnapshot({
  fetchImpl,
  fsImpl = fs,
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
  const text = await fetchImpl(catalog.CATALOG_URL);
  if (typeof text !== "string") throw new Error("catalog fetch did not return a text body");
  const parsed = catalog.parseCatalogText(text);
  if (!parsed.ok) {
    return { status: "invalid", errors: parsed.errors };
  }
  const currentVersion = readCurrentSnapshotVersion({ fsImpl, snapshotPath });
  if (parsed.catalog.catalogVersion < currentVersion) {
    return { status: "regression", currentVersion, nextVersion: parsed.catalog.catalogVersion };
  }
  fsImpl.writeFileSync(snapshotPath, text, "utf8");
  return {
    status: "written",
    catalogVersion: parsed.catalog.catalogVersion,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

async function defaultFetch(url, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`catalog request timed out after ${timeoutMs} ms`);
    }
    throw err;
  }
  if (!response.ok) throw new Error(`catalog request returned HTTP ${response.status}`);
  return response.text();
}

async function main() {
  try {
    const result = await updateOfficialThemeCatalogSnapshot({ fetchImpl: defaultFetch });
    if (result.status === "written") {
      console.log(`Wrote official theme catalog snapshot v${result.catalogVersion} (${result.bytes} bytes).`);
      return;
    }
    if (result.status === "regression") {
      console.error(
        `Refusing to write snapshot v${result.nextVersion}: current snapshot is v${result.currentVersion}.`,
      );
      process.exitCode = 1;
      return;
    }
    console.error(`Refusing to write invalid catalog: ${(result.errors || []).join("; ")}`);
    process.exitCode = 1;
  } catch (err) {
    console.error(`Failed to update official theme catalog snapshot: ${err && err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SNAPSHOT_PATH,
  DEFAULT_FETCH_TIMEOUT_MS,
  readCurrentSnapshotVersion,
  updateOfficialThemeCatalogSnapshot,
  defaultFetch,
};
