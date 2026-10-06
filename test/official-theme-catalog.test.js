"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const catalog = require("../src/official-theme-catalog");

const VALID_URL = "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip";
const VALID_NOTICE_URL = `https://github.com/rullerzhou-afk/clawd-themes/blob/${"1".repeat(40)}/themes/hash-sage/LICENSE`;
const VALID_PREVIEW_URL = "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.preview.webp";
const VALID_SHOWCASE_URL = "https://hash-sage-art.pages.dev/progress/";
const SHA = "a".repeat(64);

function validEntry(overrides = {}) {
  return {
    id: "hash-sage",
    version: "1.0.0",
    name: { en: "Hash Sage", zh: "\u54c8\u5e0c\u4ed9\u4eba" },
    description: { en: "A cloud-riding pixel sage.", zh: "\u4e58\u4e91\u800c\u884c\u7684\u50cf\u7d20\u4ed9\u4eba\u3002" },
    minAppVersion: "1.0.0",
    archive: {
      url: VALID_URL,
      bytes: 1024,
      unpackedBytes: 2048,
      sha256: SHA,
    },
    preview: {
      url: VALID_PREVIEW_URL,
      bytes: 512,
      sha256: "b".repeat(64),
    },
    showcase: { url: VALID_SHOWCASE_URL },
    license: {
      spdx: "LicenseRef-Hash-Sage-Art",
      noticeUrl: VALID_NOTICE_URL,
      notice: {
        en: "All rights reserved. Not affiliated with OpenAI.",
        zh: "版权所有；本项目与 OpenAI 无官方关联。",
      },
    },
    ...overrides,
  };
}

function validCatalog(overrides = {}) {
  return { schemaVersion: 1, catalogVersion: 1, themes: [validEntry()], ...overrides };
}

describe("official theme catalog validation", () => {
  it("accepts a well-formed catalog", () => {
    const result = catalog.validateCatalogDocument(validCatalog());
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.catalog.themes[0].id, "hash-sage");
    assert.strictEqual(result.catalog.themes[0].archive.sha256, SHA);
    assert.strictEqual(result.catalog.themes[0].preview.url, VALID_PREVIEW_URL);
    assert.strictEqual(result.catalog.themes[0].showcase.url, VALID_SHOWCASE_URL);
    assert.strictEqual(result.catalog.themes[0].license.notice.en, "All rights reserved. Not affiliated with OpenAI.");
  });

  it("rejects schemaVersion, catalogVersion and entry count violations", () => {
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ schemaVersion: 2 })).ok, false);
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ catalogVersion: 0 })).ok, false);
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ catalogVersion: "1" })).ok, false);
    const many = { schemaVersion: 1, catalogVersion: 1, themes: Array.from({ length: 201 }, (_, i) => validEntry({ id: `theme-${i}` })) };
    assert.strictEqual(catalog.validateCatalogDocument(many).ok, false);
  });

  it("rejects duplicate and malformed ids, versions and digests", () => {
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [validEntry(), validEntry()] })).ok, false);
    for (const id of ["Hash-Sage", "-bad", "bad_underscore", "", "a".repeat(65)]) {
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [validEntry({ id })] })).ok, false, `id ${id}`);
    }
    for (const version of ["1.0", "v1.0.0", "1.0.0-beta", "01.0.0"]) {
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [validEntry({ version })] })).ok, false, `version ${version}`);
    }
    for (const sha256 of ["A".repeat(64), "a".repeat(63), "z".repeat(64), ""]) {
      const entry = validEntry();
      entry.archive.sha256 = sha256;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, `sha ${sha256}`);
    }
  });

  it("rejects bad archive sizes", () => {
    for (const bytes of [0, -1, 1.5, 300 * 1024 * 1024, "1024"]) {
      const entry = validEntry();
      entry.archive.bytes = bytes;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, `bytes ${bytes}`);
    }
    const entry = validEntry();
    entry.archive.unpackedBytes = 300 * 1024 * 1024;
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false);
  });

  it("rejects archive URLs that are not the exact approved repo path", () => {
    const cases = [
      "http://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://evil.example/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com/rullerzhou-afk/other-repo/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com/rullerzhou-afk/clawd-themes/releases/latest/download/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v2.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip?token=1",
      "https://user:pass@github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com:8443/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip#frag",
      "https://github.com//rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      "https://github.com/rullerzhou-afk/clawd-themes//releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      `${VALID_URL}/`,
    ];
    for (const url of cases) {
      const entry = validEntry();
      entry.archive.url = url;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, url);
    }
    assert.strictEqual(catalog.validateArchiveUrl(VALID_URL, { id: "hash-sage", version: "1.0.0" }).ok, true);
  });

  it("accepts only small versioned WebP previews for the same official theme", () => {
    assert.strictEqual(catalog.validatePreviewUrl(VALID_PREVIEW_URL, { id: "hash-sage", version: "1.0.0" }).ok, true);
    const badUrls = [
      "https://evil.example/hash-sage.webp",
      "https://github.com/rullerzhou-afk/clawd-themes/releases/latest/download/hash-sage-1.0.0.preview.webp",
      "https://github.com/attacker/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.preview.webp",
      "https://github.com/rullerzhou-afk/clawd-themes/releases/download/other-v1.0.0/hash-sage-1.0.0.preview.webp",
      `${VALID_PREVIEW_URL}?raw=1`,
      VALID_PREVIEW_URL.replace("https:", "http:"),
    ];
    for (const url of badUrls) {
      const entry = validEntry();
      entry.preview.url = url;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, url);
    }
    for (const bytes of [0, -1, 1.5, catalog.PREVIEW_MAX_BYTES + 1, "512"]) {
      const entry = validEntry();
      entry.preview.bytes = bytes;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, String(bytes));
    }
    for (const sha256 of ["B".repeat(64), "b".repeat(63), "z".repeat(64)]) {
      const entry = validEntry();
      entry.preview.sha256 = sha256;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, sha256);
    }
  });

  it("accepts only the matching theme animation progress page", () => {
    assert.strictEqual(catalog.validateShowcaseUrl(VALID_SHOWCASE_URL, { id: "hash-sage" }).ok, true);
    const badUrls = [
      "http://hash-sage-art.pages.dev/progress/",
      "https://evil.pages.dev/progress/",
      "https://hash-sage-art.pages.dev/",
      "https://hash-sage-art.pages.dev/progress",
      `${VALID_SHOWCASE_URL}?from=clawd`,
      `${VALID_SHOWCASE_URL}#animations`,
    ];
    for (const url of badUrls) {
      const entry = validEntry();
      entry.showcase.url = url;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, url);
    }
  });

  it("validates minAppVersion and drops malformed ones", () => {
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [validEntry({ minAppVersion: "1.0" })] })).ok, false);
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [validEntry({ minAppVersion: "2.0.0" })] })).ok, true);
  });

  it("requires the license block, a non-empty identifier, and a localized notice", () => {
    assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [validEntry({ license: undefined })] })).ok, false);
    for (const spdx of [undefined, null, "", 42]) {
      const entry = validEntry();
      entry.license.spdx = spdx;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false);
    }
    for (const notice of [undefined, null, {}, { en: "" }, { en: 42 }]) {
      const entry = validEntry();
      entry.license.notice = notice;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false);
    }
  });

  it("accepts only a commit-pinned license notice for the same official theme", () => {
    assert.strictEqual(catalog.validateLicenseNoticeUrl(VALID_NOTICE_URL, { id: "hash-sage" }).ok, true);
    const cases = [
      "https://evil.example/themes/hash-sage/LICENSE",
      `https://github.com/attacker/clawd-themes/blob/${"1".repeat(40)}/themes/hash-sage/LICENSE`,
      "https://github.com/rullerzhou-afk/clawd-themes/blob/main/themes/hash-sage/LICENSE",
      `https://github.com/rullerzhou-afk/clawd-themes/blob/${"1".repeat(40)}/themes/other-theme/LICENSE`,
      `${VALID_NOTICE_URL}?plain=1`,
      `${VALID_NOTICE_URL}#readme`,
      VALID_NOTICE_URL.replace("https:", "http:"),
    ];
    for (const noticeUrl of cases) {
      const entry = validEntry();
      entry.license.noticeUrl = noticeUrl;
      assert.strictEqual(catalog.validateCatalogDocument(validCatalog({ themes: [entry] })).ok, false, noticeUrl);
    }
  });

  it("parseCatalogText rejects invalid JSON and keeps the failure atomic", () => {
    assert.strictEqual(catalog.parseCatalogText("{not json").ok, false);
    assert.strictEqual(catalog.parseCatalogText("null").ok, false);
    assert.strictEqual(catalog.parseCatalogText(JSON.stringify(validCatalog())).ok, true);
  });
});

describe("official theme semver and state derivation", () => {
  it("compares only strict three-part versions", () => {
    assert.strictEqual(catalog.compareSemver("1.2.3", "1.2.4"), -1);
    assert.strictEqual(catalog.compareSemver("1.2.10", "1.2.9"), 1);
    assert.strictEqual(catalog.compareSemver("2.0.0", "2.0.0"), 0);
    assert.strictEqual(catalog.compareSemver("1.0", "1.0.0"), null);
    assert.strictEqual(catalog.compareSemver("1.0.0", "1.0.0-x"), null);
  });

  it("only a strictly higher catalog version produces update-available", () => {
    const entry = validEntry();
    const base = { entry, appVersion: "9.9.9" };
    assert.strictEqual(catalog.deriveOfficialThemeState({ ...base, installed: null }).state, "available");
    assert.strictEqual(
      catalog.deriveOfficialThemeState({ ...base, installed: { version: "1.0.0", repairRequired: false } }).state,
      "installed",
    );
    assert.strictEqual(
      catalog.deriveOfficialThemeState({ ...base, installed: { version: "0.9.0", repairRequired: false } }).state,
      "update-available",
    );
    assert.strictEqual(
      catalog.deriveOfficialThemeState({ ...base, installed: { version: "2.0.0", repairRequired: false } }).state,
      "installed",
    );
    assert.strictEqual(
      catalog.deriveOfficialThemeState({
        ...base,
        entry: validEntry({ minAppVersion: "99.0.0" }),
        installed: null,
      }).state,
      "update-app",
    );
    assert.strictEqual(
      catalog.deriveOfficialThemeState({ ...base, installed: { version: "1.0.0", repairRequired: true } }).state,
      "repair-required",
    );
  });

  it("detects catalog version regression", () => {
    assert.strictEqual(catalog.catalogVersionRegression(1, 2), true);
    assert.strictEqual(catalog.catalogVersionRegression(2, 2), false);
    assert.strictEqual(catalog.catalogVersionRegression(3, 2), false);
  });
});

describe("official theme redirect allowlist", () => {
  it("accepts only the exact CDN hosts", () => {
    for (const host of catalog.REDIRECT_HOST_ALLOWLIST) {
      assert.strictEqual(catalog.validateRedirectUrl(`https://${host}/x/y`).ok, true, host);
    }
    const rejected = [
      "https://evil.githubusercontent.com/x",
      "https://raw.githubusercontent.com/x",
      "http://release-assets.githubusercontent.com/x",
      "https://release-assets.githubusercontent.com:8443/x",
      "https://release-assets.githubusercontent.com/x#f",
      "https://u:p@release-assets.githubusercontent.com/x",
    ];
    for (const url of rejected) {
      const result = catalog.validateRedirectUrl(url);
      assert.strictEqual(result.ok, false, url);
    }
    const unsupported = catalog.validateRedirectUrl("https://new-cdn.example/x");
    assert.strictEqual(unsupported.code, catalog.ERROR_CODES.DOWNLOAD_HOST_UNSUPPORTED);
  });
});

describe("official theme catalog cache", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-catalog-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a validated catalog and discards a tampered cache", () => {
    const parsed = catalog.parseCatalogText(JSON.stringify(validCatalog()));
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(catalog.writeCatalogCache({ userDataDir: tmp, catalog: parsed.catalog }), true);
    const read = catalog.readCatalogCache({ userDataDir: tmp });
    assert.strictEqual(read.catalogVersion, 1);
    assert.strictEqual(read.themes[0].id, "hash-sage");

    const cachePath = catalog.catalogCachePath(tmp);
    const tampered = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    tampered.catalogVersion = 99;
    fs.writeFileSync(cachePath, JSON.stringify(tampered), "utf8");
    assert.strictEqual(catalog.readCatalogCache({ userDataDir: tmp }), null);
  });

  it("returns null when there is no cache or it is not JSON", () => {
    assert.strictEqual(catalog.readCatalogCache({ userDataDir: tmp }), null);
    fs.mkdirSync(catalog.catalogCacheDir(tmp), { recursive: true });
    fs.writeFileSync(catalog.catalogCachePath(tmp), "{broken", "utf8");
    assert.strictEqual(catalog.readCatalogCache({ userDataDir: tmp }), null);
    assert.strictEqual(fs.existsSync(catalog.catalogCachePath(tmp)), false, "malformed cache self-heals");
  });

  it("self-heals valid JSON values that are not catalog cache objects", () => {
    fs.mkdirSync(catalog.catalogCacheDir(tmp), { recursive: true });
    for (const raw of ["null", "[]", "\"x\"", "5", "{}", '{"catalog":null}']) {
      fs.writeFileSync(catalog.catalogCachePath(tmp), raw, "utf8");
      assert.strictEqual(catalog.readCatalogCache({ userDataDir: tmp }), null, raw);
      assert.strictEqual(fs.existsSync(catalog.catalogCachePath(tmp)), false, `${raw} removed`);
    }
  });
});

function fakeRequest(handler) {
  return (options) => handler(options);
}

describe("official theme catalog fetch", () => {
  it("times out a request that never produces a response", async () => {
    let aborted = 0;
    await assert.rejects(
      catalog.fetchCatalogText({
        stallTimeoutMs: 15,
        totalTimeoutMs: 100,
        requestImpl: fakeRequest(() => {
          const req = {
            on: () => req,
            end: () => {},
            abort: () => { aborted += 1; },
          };
          return req;
        }),
      }),
      (err) => err && err.code === catalog.ERROR_CODES.CATALOG_OFFLINE && /stalled/.test(err.message),
    );
    assert.strictEqual(aborted, 1);
  });

  it("enforces a total deadline even when a response keeps dripping bytes", async () => {
    let ticker = null;
    await assert.rejects(
      catalog.fetchCatalogText({
        stallTimeoutMs: 20,
        totalTimeoutMs: 35,
        requestImpl: fakeRequest(() => {
          const req = new EventEmitter();
          req.abort = () => {};
          req.end = () => {
            const response = new EventEmitter();
            response.statusCode = 200;
            response.destroy = () => {
              if (ticker) clearInterval(ticker);
              ticker = null;
            };
            response.resume = () => {};
            req.emit("response", response);
            ticker = setInterval(() => response.emit("data", Buffer.from(" ")), 5);
          };
          return req;
        }),
      }),
      (err) => err && err.code === catalog.ERROR_CODES.CATALOG_OFFLINE && /total deadline/.test(err.message),
    );
    assert.strictEqual(ticker, null);
  });

  it("sends the strict request options and reads a small body", async () => {
    let seenOptions = null;
    const body = Buffer.from(JSON.stringify(validCatalog()));
    const text = await catalog.fetchCatalogText({
      requestImpl: fakeRequest((options) => {
        seenOptions = options;
        const listeners = {};
        const req = {
          on: (event, cb) => { listeners[event] = cb; return req; },
          end: () => {
            const response = {
              statusCode: 200,
              headers: { "content-length": String(body.length) },
              on: (event, cb) => {
                if (event === "data") cb(body);
                if (event === "end") cb();
              },
              resume: () => {},
              destroy: () => {},
            };
            listeners.response(response);
          },
          abort: () => {},
        };
        return req;
      }),
    });
    assert.strictEqual(seenOptions.url, catalog.CATALOG_URL);
    assert.strictEqual(seenOptions.redirect, "manual");
    assert.strictEqual(seenOptions.credentials, "omit");
    assert.strictEqual(seenOptions.useSessionCookies, false);
    assert.strictEqual(seenOptions.referrerPolicy, "no-referrer");
    assert.strictEqual(seenOptions.cache, "no-store");
    assert.strictEqual(catalog.parseCatalogText(text).ok, true);
  });

  it("rejects any redirect and fails closed on oversized bodies", async () => {
    await assert.rejects(
      catalog.fetchCatalogText({
        requestImpl: fakeRequest(() => {
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            end: () => listeners.redirect(302, "GET", "https://evil.example/x"),
            abort: () => {},
          };
          return req;
        }),
      }),
    );

    const big = Buffer.alloc(catalog.MAX_CATALOG_BYTES + 1, 0x20);
    await assert.rejects(catalog.fetchCatalogText({
      requestImpl: fakeRequest(() => {
        const listeners = {};
        const req = {
          on: (event, cb) => { listeners[event] = cb; return req; },
          end: () => listeners.response({
            statusCode: 200,
            headers: {},
            on: (event, cb) => {
              if (event === "data") cb(big);
            },
            resume: () => {},
            destroy: () => {},
          }),
          abort: () => {},
        };
        return req;
      }),
    }));
  });
});
