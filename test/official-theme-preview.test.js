"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const preview = require("../src/official-theme-preview");
const { createFakeNet, streamResponse } = require("./helpers/fake-official-net");

let tmp = null;

function fixtureEntry(body) {
  return {
    id: "hash-sage",
    version: "1.0.0",
    preview: {
      url: "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.preview.webp",
      bytes: body.length,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    },
  };
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("official theme preview", () => {
  it("downloads, verifies and reuses a small local preview", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-preview-"));
    const body = Buffer.from("small-webp-fixture");
    const entry = fixtureEntry(body);
    const net = createFakeNet((req) => {
      streamResponse(req, {
        chunks: [body.subarray(0, 5), body.subarray(5)],
        headers: { "content-length": String(body.length) },
      });
    });

    const first = await preview.ensurePreviewFile({ entry, userDataDir: tmp, net });
    assert.strictEqual(first.cached, false);
    assert.deepStrictEqual(fs.readFileSync(first.path), body);
    assert.deepStrictEqual(net.requests[0].options, preview.buildPreviewRequestOptions(entry.preview.url));

    const second = await preview.ensurePreviewFile({ entry, userDataDir: tmp, net });
    assert.strictEqual(second.cached, true);
    assert.strictEqual(second.path, first.path);
    assert.strictEqual(net.requests.length, 1);
  });

  it("rejects integrity failures and leaves no partial preview", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-preview-"));
    const body = Buffer.from("expected-preview");
    const entry = fixtureEntry(body);
    const net = createFakeNet((req) => {
      streamResponse(req, {
        chunks: [Buffer.from("different-bytes")],
        headers: { "content-length": String(body.length) },
      });
    });

    await assert.rejects(
      preview.ensurePreviewFile({ entry, userDataDir: tmp, net }),
      (err) => err && err.code === preview.PREVIEW_ERROR_CODES.PREVIEW_INTEGRITY,
    );
    const dir = preview.previewCacheDir(tmp);
    assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });

  it("rejects redirects outside the fixed release CDN allowlist", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-preview-"));
    const body = Buffer.from("preview");
    const entry = fixtureEntry(body);
    const net = createFakeNet((req) => {
      req.emit("redirect", 302, "GET", "https://evil.example/preview.webp");
    });

    await assert.rejects(
      preview.ensurePreviewFile({ entry, userDataDir: tmp, net }),
      (err) => err && err.code === preview.PREVIEW_ERROR_CODES.PREVIEW_FAILED,
    );
    assert.strictEqual(net.requests[0].followedRedirects || 0, 0);
  });

  it("follows an allowlisted GitHub release redirect", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-preview-"));
    const body = Buffer.from("preview");
    const entry = fixtureEntry(body);
    const net = createFakeNet((req) => {
      req.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/preview.webp");
      streamResponse(req, { chunks: [body] });
    });

    const result = await preview.ensurePreviewFile({ entry, userDataDir: tmp, net });
    assert.strictEqual(result.cached, false);
    assert.strictEqual(net.requests[0].followedRedirects, 1);
  });

  it("replaces a corrupt cached preview with verified bytes", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-preview-"));
    const body = Buffer.from("verified-preview");
    const entry = fixtureEntry(body);
    const target = preview.previewCachePath(entry, tmp);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "corrupt");
    const net = createFakeNet((req) => {
      streamResponse(req, { chunks: [body] });
    });

    const result = await preview.ensurePreviewFile({ entry, userDataDir: tmp, net });
    assert.strictEqual(result.cached, false);
    assert.deepStrictEqual(fs.readFileSync(target), body);
  });
});
