"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");

const download = require("../src/official-theme-download");
const { createFakeNet, streamResponse } = require("./helpers/fake-official-net");

// Models a Windows host where the `.part` cannot be unlinked until the write
// handle has closed. A teardown that removes the file while the stream is
// still open surfaces as an EBUSY rm attempt with closedAtRm === false.
function createWindowsLikeFs(shared) {
  const fakeFs = Object.create(fs);
  fakeFs.createWriteStream = (filePath) => {
    const stream = new EventEmitter();
    stream.chunks = [];
    stream.destroyed = false;
    stream.write = (chunk) => {
      if (stream.destroyed) throw new Error("write after destroy");
      stream.chunks.push(chunk);
      return true;
    };
    stream.end = (cb) => {
      if (stream.destroyed) {
        if (typeof cb === "function") cb();
        return;
      }
      shared.closed = true;
      if (typeof cb === "function") cb();
      stream.emit("close");
    };
    stream.destroy = () => {
      if (stream.destroyed) return;
      stream.destroyed = true;
      setImmediate(() => {
        shared.closed = true;
        stream.emit("close");
      });
    };
    fs.writeFileSync(filePath, "");
    return stream;
  };
  fakeFs.rmSync = (target, opts) => {
    if (String(target).endsWith(".part")) {
      shared.rmAttempts.push({ closedAtRm: shared.closed === true });
      if (!shared.closed) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
    }
    return fs.rmSync(target, opts);
  };
  return fakeFs;
}

function makeMidFlightNet(body) {
  const requests = [];
  const net = {
    requests,
    request(options) {
      const req = new EventEmitter();
      req.options = options;
      req.followRedirect = () => {};
      req.abort = () => { req.aborted = true; };
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { "content-length": String(body.length) };
        response.paused = false;
        response.resume = () => {};
        response.pause = () => {};
        response.destroy = () => { response.destroyed = true; };
        req.response = response;
        req.emit("response", response);
        response.emit("data", body.subarray(0, 4));
      };
      requests.push(req);
      return req;
    },
  };
  return net;
}

function makeEntry(body) {
  return {
    id: "hash-sage",
    version: "1.0.0",
    archive: {
      url: "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      bytes: body.length,
      unpackedBytes: body.length * 2,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    },
  };
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-download-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function downloadsDir() {
  return download.officialThemeDirs(tmp).downloads;
}

describe("official theme download", () => {
  it("streams a matching archive to a .part file and reports progress", async () => {
    const body = Buffer.from("hello official theme archive");
    const entry = makeEntry(body);
    const progress = [];
    let seenOptions = null;
    const net = createFakeNet((req, options) => {
      seenOptions = options;
      streamResponse(req, { chunks: [body.subarray(0, 5), body.subarray(5)], headers: { "content-length": String(body.length) } });
    });

    const result = await download.downloadArchive({
      fs,
      path,
      net,
      entry,
      nonce: "a".repeat(32),
      userDataDir: tmp,
      onProgress: (p) => progress.push(p.receivedBytes),
      statfs: () => 10 * 1024 * 1024 * 1024,
    });

    assert.strictEqual(result.bytes, body.length);
    assert.strictEqual(result.sha256, entry.archive.sha256);
    assert.ok(fs.existsSync(result.partPath));
    assert.ok(result.partPath.endsWith(".part"));
    assert.deepStrictEqual(progress, [...progress].sort((a, b) => a - b));
    assert.strictEqual(progress[progress.length - 1], body.length);

    assert.strictEqual(seenOptions.redirect, "manual");
    assert.strictEqual(seenOptions.credentials, "omit");
    assert.strictEqual(seenOptions.useSessionCookies, false);
    assert.strictEqual(seenOptions.referrerPolicy, "no-referrer");
    assert.strictEqual(seenOptions.cache, "no-store");
    assert.strictEqual(seenOptions.url, entry.archive.url);
  });

  it("accepts a missing content-length and rejects a mismatch", async () => {
    const body = Buffer.from("abcdef");
    const entry = makeEntry(body);
    const okNet = createFakeNet((req) => streamResponse(req, { chunks: [body] }));
    const ok = await download.downloadArchive({
      fs, path, net: okNet, entry, nonce: "b".repeat(32), userDataDir: tmp, statfs: () => 1e12,
    });
    assert.strictEqual(ok.bytes, body.length);

    const badNet = createFakeNet((req) => streamResponse(req, { chunks: [body], headers: { "content-length": "999" } }));
    const before = fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [];
    await assert.rejects(
      download.downloadArchive({ fs, path, net: badNet, entry, nonce: "c".repeat(32), userDataDir: tmp, statfs: () => 1e12 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY,
    );
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], before);
  });

  it("rejects when actual bytes differ from the catalog size", async () => {
    const body = Buffer.from("short");
    const entry = makeEntry(Buffer.from("short-longer"));
    const net = createFakeNet((req) => streamResponse(req, { chunks: [body] }));
    await assert.rejects(
      download.downloadArchive({ fs, path, net, entry, nonce: "d".repeat(32), userDataDir: tmp, statfs: () => 1e12 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY,
    );
  });

  it("rejects bytes that exceed the declared catalog size (and cleans up)", async () => {
    const body = Buffer.alloc(64, 1);
    const entry = makeEntry(Buffer.alloc(8, 1));
    const net = createFakeNet((req) => streamResponse(req, { chunks: [body] }));
    await assert.rejects(
      download.downloadArchive({ fs, path, net, entry, nonce: "e".repeat(32), userDataDir: tmp, statfs: () => 1e12 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY,
    );
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], []);
  });

  it("rejects a SHA-256 mismatch", async () => {
    const body = Buffer.from("tampered");
    const entry = makeEntry(Buffer.from("original"));
    // Keep the declared byte count the same so only the digest differs.
    entry.archive.bytes = body.length;
    const net = createFakeNet((req) => streamResponse(req, { chunks: [body] }));
    await assert.rejects(
      download.downloadArchive({ fs, path, net, entry, nonce: "f".repeat(32), userDataDir: tmp, statfs: () => 1e12 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY,
    );
  });

  it("follows allowlisted redirects and validates each hop", async () => {
    const body = Buffer.from("redirected-body");
    const entry = makeEntry(body);
    const net = createFakeNet((req) => {
      req.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/github-production-release-asset/x");
      streamResponse(req, { chunks: [body] });
    });
    const result = await download.downloadArchive({
      fs, path, net, entry, nonce: "1".repeat(32), userDataDir: tmp, statfs: () => 1e12,
    });
    assert.strictEqual(result.bytes, body.length);
    assert.strictEqual(net.requests[0].followedRedirects, 1);
  });

  it("stops with DOWNLOAD_HOST_UNSUPPORTED on an unapproved CDN host", async () => {
    const entry = makeEntry(Buffer.from("x"));
    const net = createFakeNet((req) => {
      req.emit("redirect", 302, "GET", "https://new-cdn.example/asset");
    });
    await assert.rejects(
      download.downloadArchive({ fs, path, net, entry, nonce: "2".repeat(32), userDataDir: tmp, statfs: () => 1e12 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_HOST_UNSUPPORTED,
    );
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], []);
  });

  it("rejects more than five redirects", async () => {
    const entry = makeEntry(Buffer.from("x"));
    const net = createFakeNet((req) => {
      for (let i = 0; i < 10; i += 1) {
        req.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/a");
      }
    });
    await assert.rejects(
      download.downloadArchive({ fs, path, net, entry, nonce: "3".repeat(32), userDataDir: tmp, statfs: () => 1e12 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_FAILED,
    );
  });

  it("cleans up and reports cancellation", async () => {
    const body = Buffer.from("abc");
    const entry = makeEntry(body);
    const controller = new AbortController();
    const net = createFakeNet((req) => {
      controller.abort();
    });
    await assert.rejects(
      download.downloadArchive({
        fs, path, net, entry, nonce: "4".repeat(32), userDataDir: tmp, statfs: () => 1e12, signal: controller.signal,
      }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_CANCELLED,
    );
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], []);
  });

  it("refuses to start when the space precheck fails", async () => {
    const body = Buffer.from("abc");
    const entry = makeEntry(body);
    const net = createFakeNet(() => {});
    await assert.rejects(
      download.downloadArchive({ fs, path, net, entry, nonce: "5".repeat(32), userDataDir: tmp, statfs: () => 0 }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_DISK_SPACE,
    );
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], []);
  });

  it("maps a mid-stream ENOSPC to DOWNLOAD_DISK_FULL and removes the partial file", async () => {
    const body = Buffer.from("disk-full-body");
    const entry = makeEntry(body);
    const fakeFs = Object.create(fs);
    fakeFs.createWriteStream = (target) => {
      const stream = new EventEmitter();
      let closed = false;
      fs.writeFileSync(target, "");
      stream.write = () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      };
      stream.end = (callback) => {
        if (typeof callback === "function") callback();
        if (!closed) {
          closed = true;
          stream.emit("close");
        }
      };
      stream.destroy = () => {
        if (closed) return;
        closed = true;
        setImmediate(() => stream.emit("close"));
      };
      return stream;
    };
    const net = createFakeNet((req) => streamResponse(req, { chunks: [body] }));

    await assert.rejects(
      download.downloadArchive({
        fs: fakeFs,
        path,
        net,
        entry,
        nonce: "7".repeat(32),
        userDataDir: tmp,
        statfs: () => 1e12,
      }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_DISK_FULL,
    );
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], []);
  });

  it("stops a stalled download with a stable error", async () => {
    const body = Buffer.from("abc");
    const entry = makeEntry(body);
    // A timer that fires immediately models "no bytes for N seconds".
    const net = createFakeNet((req) => {
      req.emit("response", Object.assign(new (require("node:events").EventEmitter)(), {
        statusCode: 200,
        headers: {},
        resume: () => {},
        pause: () => {},
        destroy: () => {},
      }));
    });
    await assert.rejects(
      download.downloadArchive({
        fs, path, net, entry, nonce: "6".repeat(32), userDataDir: tmp, statfs: () => 1e12,
        setTimeout: (fn) => { fn(); return 1; },
        clearTimeout: () => {},
      }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_STALLED,
    );
  });

  it("closes the write handle before removing .part on cancel (Windows-safe)", async () => {
    const body = Buffer.from("abcdefghij");
    const entry = makeEntry(body);
    const shared = { closed: false, rmAttempts: [] };
    const fakeFs = createWindowsLikeFs(shared);
    const net = makeMidFlightNet(body);
    const controller = new AbortController();
    const partPath = path.join(
      download.officialThemeDirs(tmp).downloads,
      download.officialArtifactName("hash-sage", "1.0.0", "a".repeat(32), ".part"),
    );

    const promise = download.downloadArchive({
      fs: fakeFs, path, net, entry, nonce: "a".repeat(32), userDataDir: tmp,
      statfs: () => 1e12, signal: controller.signal,
    });
    const req = net.requests[0];
    assert.strictEqual(shared.closed, false, "handle is open mid-download");
    assert.ok(fs.existsSync(partPath), ".part exists mid-download");

    controller.abort();
    await assert.rejects(promise, (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_CANCELLED);

    assert.strictEqual(shared.rmAttempts.length, 1);
    assert.strictEqual(shared.rmAttempts[0].closedAtRm, true, "rm must run after the handle closed");
    assert.strictEqual(req.aborted, true, "request aborted");
    assert.strictEqual(req.response.destroyed, true, "response destroyed");
    assert.strictEqual(fs.existsSync(partPath), false, ".part removed");

    // Late events must not resurrect the file or throw.
    req.response.emit("data", Buffer.from("late"));
    req.response.emit("end");
    assert.strictEqual(fs.existsSync(partPath), false);
  });

  it("does not leave .part behind when an integrity failure tears down an open stream", async () => {
    const body = Buffer.from("0123456789");
    const entry = makeEntry(Buffer.alloc(4, 1)); // declared smaller than body
    entry.archive.bytes = body.length;
    entry.archive.sha256 = "0".repeat(64); // force a SHA mismatch at end
    const shared = { closed: false, rmAttempts: [] };
    const fakeFs = createWindowsLikeFs(shared);
    const net = makeMidFlightNet(body);
    const partPath = path.join(
      download.officialThemeDirs(tmp).downloads,
      download.officialArtifactName("hash-sage", "1.0.0", "c".repeat(32), ".part"),
    );

    const promise = download.downloadArchive({
      fs: fakeFs, path, net, entry, nonce: "c".repeat(32), userDataDir: tmp, statfs: () => 1e12,
    });
    const req = net.requests[0];
    req.response.emit("end");
    await assert.rejects(promise, (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_INTEGRITY);
    assert.strictEqual(shared.rmAttempts.every((attempt) => attempt.closedAtRm), true);
    assert.strictEqual(fs.existsSync(partPath), false);
  });

  it("stalls out when the request never emits a response", async () => {
    const entry = makeEntry(Buffer.from("abc"));
    const net = createFakeNet(() => {});
    const started = Date.now();
    await assert.rejects(
      download.downloadArchive({
        fs, path, net, entry, nonce: "d".repeat(32), userDataDir: tmp,
        statfs: () => 1e12, stallTimeoutMs: 15,
      }),
      (err) => err.code === download.DOWNLOAD_ERROR_CODES.DOWNLOAD_STALLED,
    );
    assert.ok(Date.now() - started < 5000, "must not hang");
    assert.deepStrictEqual(fs.existsSync(downloadsDir()) ? fs.readdirSync(downloadsDir()) : [], []);
  });

  it("builds the exact strict request options", () => {
    const options = download.buildRequestOptions("https://github.com/x/y");
    assert.deepStrictEqual(options, {
      method: "GET",
      url: "https://github.com/x/y",
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  });

  it("parses only strict artifact names", () => {
    assert.deepStrictEqual(
      download.parseOfficialArtifactName("hash-sage-1.0.0-abcdef0123456789", path),
      { id: "hash-sage", version: "1.0.0", nonce: "abcdef0123456789", suffix: "", safeName: "hash-sage-1.0.0-abcdef0123456789" },
    );
    assert.strictEqual(download.parseOfficialArtifactName("hash-sage-1.0.0.part", path), null);
    assert.strictEqual(download.parseOfficialArtifactName("Hash-Sage-1.0.0-abcdef0123456789", path), null);
    assert.strictEqual(download.parseOfficialArtifactName("hash-sage-1.0.0-zz", path), null);
  });
});
