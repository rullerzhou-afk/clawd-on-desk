const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const importer = require("../src/codex-pet-importer");
const adapter = require("../src/codex-pet-adapter");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "codex-pets", "tiny-atlas-png");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-pet-importer-"));
}

function fixtureManifest(overrides = {}) {
  return {
    id: "tiny-atlas-png",
    displayName: "Tiny Atlas PNG",
    description: "Importer fixture",
    spritesheetPath: "spritesheet.png",
    ...overrides,
  };
}

function fixtureSpritesheet() {
  return fs.readFileSync(path.join(FIXTURE_DIR, "spritesheet.png"));
}

function makeVp8xWebp({ width = 1536, height = 2288 } = {}) {
  const image = Buffer.alloc(10);
  image[0] = 0x10;
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  image[4] = widthMinusOne & 0xff;
  image[5] = (widthMinusOne >> 8) & 0xff;
  image[6] = (widthMinusOne >> 16) & 0xff;
  image[7] = heightMinusOne & 0xff;
  image[8] = (heightMinusOne >> 8) & 0xff;
  image[9] = (heightMinusOne >> 16) & 0xff;

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write("VP8X", 0, 4, "ascii");
  chunkHeader.writeUInt32LE(image.length, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), chunkHeader, image]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const method = entry.method == null ? 0 : entry.method;
    const flags = entry.flags == null ? 0x0800 : entry.flags;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const declaredUncompressedSize = entry.uncompressedSize == null ? raw.length : entry.uncompressedSize;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

function publicLookup(_host, _opts, cb) {
  cb(null, [{ address: "203.0.113.10", family: 4 }]);
}

function makeHttpsRequestMock(routes) {
  const calls = [];
  const request = (options, cb) => {
    calls.push(options);
    const req = new EventEmitter();
    let destroyed = false;
    req.destroy = (err) => {
      destroyed = true;
      if (err) setImmediate(() => req.emit("error", err));
    };
    req.end = () => {
      const route = routes.shift();
      if (!route) {
        req.destroy(new Error("unexpected request"));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = route.statusCode == null ? 200 : route.statusCode;
      res.headers = route.headers || {};
      res.resume = () => {};
      cb(res);
      setImmediate(() => {
        for (const chunk of route.chunks || []) {
          if (destroyed) return;
          res.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (!destroyed) res.emit("end");
      });
    };
    return req;
  };
  return { request, calls };
}

test("parses clawd import URLs and rejects unsafe remote hosts", () => {
  const parsed = importer.parseClawdImportUrl(
    "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpets%2Ftiny%2Fpet.json"
  );
  assert.strictEqual(parsed.action, "import-pet");
  assert.strictEqual(parsed.url, "https://example.test/pets/tiny/pet.json");
  const idn = importer.parseClawdImportUrl(
    `clawd://import-pet?url=${encodeURIComponent("https://例え.テスト/pets/tiny/pet.json")}`
  );
  assert.match(idn.asciiHostname, /^xn--/);

  assert.throws(
    () => importer.parseClawdImportUrl("clawd://import-pet?url=http%3A%2F%2Fexample.test%2Fpet.json"),
    /https/
  );
  assert.throws(
    () => importer.parseClawdImportUrl("clawd://import-pet?url=https%3A%2F%2Flocalhost%2Fpet.json"),
    /blocked/
  );
});

test("blocks private DNS answers in guarded lookup", async () => {
  await assert.rejects(
    () => importer.guardedLookup("pets.example", {
      lookup: (_host, _opts, cb) => cb(null, [{ address: "192.168.1.10", family: 4 }]),
    }),
    /blocked/
  );

  const resolved = await importer.guardedLookup("pets.example", {
    lookup: (_host, _opts, cb) => cb(null, [{ address: "203.0.113.10", family: 4 }]),
  });
  assert.deepStrictEqual(resolved, { address: "203.0.113.10", family: 4 });
  assert.strictEqual(importer.isBlockedIp("::1"), true);
  assert.strictEqual(importer.isBlockedIp("fc00::1"), true);
  assert.strictEqual(importer.isBlockedIp("fe80::1"), true);
  assert.strictEqual(importer.isBlockedIp("2001:4860:4860::8888"), false);
});

test("downloadHttpsBuffer re-checks redirects and enforces byte caps", async () => {
  const happy = makeHttpsRequestMock([
    { statusCode: 302, headers: { location: "https://cdn.example/pet.json" } },
    { statusCode: 200, chunks: ["ok"] },
  ]);
  const buffer = await importer.downloadHttpsBuffer("https://pets.example/pet.json", {
    lookup: publicLookup,
    request: happy.request,
    maxBytes: 16,
  });
  assert.strictEqual(buffer.toString("utf8"), "ok");
  assert.deepStrictEqual(happy.calls.map((call) => call.hostname), ["pets.example", "cdn.example"]);

  const blockedRedirect = makeHttpsRequestMock([
    { statusCode: 302, headers: { location: "https://localhost/pet.json" } },
  ]);
  await assert.rejects(
    () => importer.downloadHttpsBuffer("https://pets.example/pet.json", {
      lookup: publicLookup,
      request: blockedRedirect.request,
      maxBytes: 16,
    }),
    /blocked/
  );

  const tooLargeLength = makeHttpsRequestMock([
    { statusCode: 200, headers: { "content-length": "17" } },
  ]);
  await assert.rejects(
    () => importer.downloadHttpsBuffer("https://pets.example/pet.json", {
      lookup: publicLookup,
      request: tooLargeLength.request,
      maxBytes: 16,
    }),
    /exceeds/
  );

  const tooLargeStream = makeHttpsRequestMock([
    { statusCode: 200, chunks: [Buffer.alloc(10), Buffer.alloc(10)] },
  ]);
  await assert.rejects(
    () => importer.downloadHttpsBuffer("https://pets.example/pet.json", {
      lookup: publicLookup,
      request: tooLargeStream.request,
      maxBytes: 16,
    }),
    /exceeds/
  );
});

test("imports a direct pet.json only with same-directory spritesheet URLs", async () => {
  const root = makeTempDir();
  const manifest = fixtureManifest();
  const spritesheet = fixtureSpritesheet();
  const responses = new Map([
    ["https://example.test/pets/tiny/pet.json", Buffer.from(JSON.stringify(manifest), "utf8")],
    ["https://example.test/pets/tiny/spritesheet.png", spritesheet],
  ]);

  const imported = await importer.importCodexPetFromUrl("https://example.test/pets/tiny/pet.json", {
    codexPetsDir: path.join(root, "pets"),
    fetchBuffer: async (url) => responses.get(url),
  });

  assert.strictEqual(path.basename(imported.packageDir), "tiny-atlas-png");
  assert.strictEqual(fs.existsSync(path.join(imported.packageDir, importer.IMPORT_MARKER_FILENAME)), true);
  assert.strictEqual(adapter.validateCodexPetPackage(imported.packageDir).ok, true);

  await assert.rejects(
    () => importer.importCodexPetFromUrl("https://example.test/pets/tiny/pet.json", {
      codexPetsDir: path.join(root, "pets2"),
      fetchBuffer: async (url) => {
        if (url.endsWith("pet.json")) {
          return Buffer.from(JSON.stringify(fixtureManifest({ spritesheetPath: "../spritesheet.png" })), "utf8");
        }
        return spritesheet;
      },
    }),
    /package directory|manifest directory/
  );

  await assert.rejects(
    () => importer.importCodexPetFromUrl("https://example.test/pets/tiny/pet.json", {
      codexPetsDir: path.join(root, "pets3"),
      fetchBuffer: async (url) => {
        if (url.endsWith("pet.json")) return Buffer.alloc(importer.MAX_PET_JSON_BYTES + 1);
        return spritesheet;
      },
    }),
    /pet\.json exceeds/
  );

  await assert.rejects(
    () => importer.importCodexPetFromUrl("https://example.test/pets/tiny/pet.json", {
      codexPetsDir: path.join(root, "pets4"),
      fetchBuffer: async (url) => {
        if (url.endsWith("pet.json")) return Buffer.from(JSON.stringify(manifest), "utf8");
        return Buffer.alloc(importer.MAX_SPRITESHEET_BYTES + 1);
      },
    }),
    /spritesheet exceeds/
  );

  await assert.rejects(
    () => importer.importCodexPetFromUrl("https://example.test/pets/tiny.zip", {
      codexPetsDir: path.join(root, "pets5"),
      fetchBuffer: async () => Buffer.alloc(importer.MAX_ZIP_BYTES + 1),
    }),
    /zip package exceeds/
  );
});

test("imports zip packages from root or one top-level folder", async () => {
  const root = makeTempDir();
  const manifest = Buffer.from(JSON.stringify(fixtureManifest()), "utf8");
  const spritesheet = fixtureSpritesheet();
  const zip = makeZip([
    { name: "tiny/pet.json", data: manifest, method: 8 },
    { name: "tiny/spritesheet.png", data: spritesheet, method: 0 },
  ]);

  const imported = await importer.importCodexPetFromZipBuffer(zip, {
    codexPetsDir: path.join(root, "pets"),
  });

  assert.strictEqual(path.basename(imported.packageDir), "tiny-atlas-png");
  assert.strictEqual(adapter.validateCodexPetPackage(imported.packageDir).ok, true);

  await assert.rejects(
    () => importer.importCodexPetFromZipBuffer(Buffer.alloc(importer.MAX_ZIP_BYTES + 1)),
    /zip package exceeds/
  );
});

test("imports V2 zip packages with 8x11 spritesheets", async () => {
  const root = makeTempDir();
  const manifest = fixtureManifest({
    id: "v2-wild-boar-shape",
    displayName: "V2 Wild Boar Shape",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  });
  const zip = makeZip([
    { name: "pet.json", data: JSON.stringify(manifest), method: 8 },
    { name: "spritesheet.webp", data: makeVp8xWebp(), method: 0 },
  ]);

  const imported = await importer.importCodexPetFromZipBuffer(zip, {
    codexPetsDir: path.join(root, "pets"),
  });

  assert.strictEqual(path.basename(imported.packageDir), "v2-wild-boar-shape");
  assert.strictEqual(imported.packageInfo.spriteVersionNumber, 2);
  assert.deepStrictEqual(
    { width: imported.packageInfo.image.width, height: imported.packageInfo.image.height },
    { width: 1536, height: 2288 }
  );
  assert.strictEqual(adapter.validateCodexPetPackage(imported.packageDir).ok, true);
});

test("rejects unsafe zip paths and missing package files", () => {
  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      { name: "../pet.json", data: JSON.stringify(fixtureManifest()) },
      { name: "spritesheet.png", data: fixtureSpritesheet() },
    ])),
    /unsafe|absolute/
  );

  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      { name: "pet.json", data: JSON.stringify(fixtureManifest({ spritesheetPath: "missing.png" })) },
    ])),
    /missing spritesheet/
  );

  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      { name: "pet.json", data: JSON.stringify(fixtureManifest()) },
      { name: "other/pet.json", data: JSON.stringify(fixtureManifest()) },
      { name: "spritesheet.png", data: fixtureSpritesheet() },
    ])),
    /exactly one pet\.json/
  );

  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      { name: "pet.json", data: JSON.stringify(fixtureManifest()), flags: 0x0801 },
      { name: "spritesheet.png", data: fixtureSpritesheet() },
    ])),
    /encrypted/
  );

  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      {
        name: "pet.json",
        data: Buffer.alloc(importer.MAX_PET_JSON_BYTES + 1, 0x20),
        method: 8,
        uncompressedSize: 2,
      },
      { name: "spritesheet.png", data: fixtureSpritesheet() },
    ])),
    /zip entry exceeds .*pet\.json/
  );
});

test("does not overwrite non-pet directories in the Codex pets root", async () => {
  const root = makeTempDir();
  const petsDir = path.join(root, "pets");
  fs.mkdirSync(path.join(petsDir, "tiny-atlas-png"), { recursive: true });
  fs.writeFileSync(path.join(petsDir, "tiny-atlas-png", "notes.txt"), "keep", "utf8");

  await assert.rejects(
    () => importer.installCodexPetPackage({
      manifest: fixtureManifest(),
      files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
      codexPetsDir: petsDir,
    }),
    /refusing to overwrite/
  );
  assert.strictEqual(fs.readFileSync(path.join(petsDir, "tiny-atlas-png", "notes.txt"), "utf8"), "keep");
});

test("requires confirmation before replacing an existing non-Clawd-imported pet package", async () => {
  const root = makeTempDir();
  const petsDir = path.join(root, "pets");
  const targetDir = path.join(petsDir, "tiny-atlas-png");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "pet.json"), `${JSON.stringify(fixtureManifest({ displayName: "Local" }))}\n`, "utf8");
  fs.writeFileSync(path.join(targetDir, "spritesheet.png"), fixtureSpritesheet());

  await assert.rejects(
    () => importer.installCodexPetPackage({
      manifest: fixtureManifest({ displayName: "Remote" }),
      files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
      codexPetsDir: petsDir,
    }),
    /already exists locally/
  );

  let seenPayload = null;
  await assert.rejects(
    () => importer.installCodexPetPackage({
      manifest: fixtureManifest({ displayName: "Remote" }),
      files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
      codexPetsDir: petsDir,
      confirmReplaceExistingPackage: async (payload) => {
        seenPayload = payload;
        return false;
      },
    }),
    { code: importer.ERR_REPLACE_DECLINED }
  );
  assert.strictEqual(seenPayload.existingManifest.displayName, "Local");
  assert.strictEqual(seenPayload.incomingManifest.displayName, "Remote");

  const replaced = await importer.installCodexPetPackage({
    manifest: fixtureManifest({ displayName: "Remote" }),
    files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
    codexPetsDir: petsDir,
    confirmReplaceExistingPackage: async () => true,
  });
  assert.strictEqual(replaced.packageInfo.displayName, "Remote");
  assert.ok(importer.readImportMarker(replaced.packageDir));
});

test("requires confirmation before replacing Clawd-imported pet packages", async () => {
  const root = makeTempDir();
  const petsDir = path.join(root, "pets");
  const first = await importer.installCodexPetPackage({
    manifest: fixtureManifest({ displayName: "First" }),
    files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
    codexPetsDir: petsDir,
  });
  assert.ok(importer.readImportMarker(first.packageDir));

  await assert.rejects(
    () => importer.installCodexPetPackage({
      manifest: fixtureManifest({ displayName: "Second" }),
      files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
      codexPetsDir: petsDir,
    }),
    /already exists locally/
  );

  let seenPayload = null;
  await assert.rejects(
    () => importer.installCodexPetPackage({
      manifest: fixtureManifest({ displayName: "Second" }),
      files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
      codexPetsDir: petsDir,
      confirmReplaceExistingPackage: async (payload) => {
        seenPayload = payload;
        return false;
      },
    }),
    { code: importer.ERR_REPLACE_DECLINED }
  );
  assert.strictEqual(seenPayload.wasClawdImported, true);
  assert.ok(seenPayload.existingMarker);

  const second = await importer.installCodexPetPackage({
    manifest: fixtureManifest({ displayName: "Second" }),
    files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
    codexPetsDir: petsDir,
    confirmReplaceExistingPackage: async () => true,
  });
  assert.strictEqual(second.packageDir, first.packageDir);
  assert.strictEqual(second.packageInfo.displayName, "Second");
});
