const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const adapter = require("../src/codex-pet-adapter");
const themeLoader = require("../src/theme-loader");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "codex-pets", "tiny-atlas-png");
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const COLUMNS = 8;
const ROWS = 9;
const V2_ROWS = 11;
const ATLAS_WIDTH = FRAME_WIDTH * COLUMNS;
const ATLAS_HEIGHT = FRAME_HEIGHT * ROWS;
const V2_ATLAS_HEIGHT = FRAME_HEIGHT * V2_ROWS;
const USED_COLUMNS_BY_ROW = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const V2_USED_COLUMNS_BY_ROW = [...USED_COLUMNS_BY_ROW, 8, 8];
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-pet-"));
  tempDirs.push(dir);
  return dir;
}

function readPng(filePath) {
  const data = fs.readFileSync(filePath);
  assert.deepStrictEqual(
    [...data.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idatChunks.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }

  const rgba = zlib.inflateSync(Buffer.concat(idatChunks));
  return { width, height, bitDepth, colorType, rgba };
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  return out;
}

function makeRgbaAtlasPng({ rows, usedColumnsByRow, extraInflatedBytes = 0 }) {
  const height = FRAME_HEIGHT * rows;
  const stride = ATLAS_WIDTH * 4;
  const raw = Buffer.alloc(height * (1 + stride) + extraInflatedBytes);

  usedColumnsByRow.forEach((usedColumns, row) => {
    const y = row * FRAME_HEIGHT + Math.floor(FRAME_HEIGHT / 2);
    for (let column = 0; column < usedColumns; column += 1) {
      const x = column * FRAME_WIDTH + Math.floor(FRAME_WIDTH / 2);
      const pixel = y * (1 + stride) + 1 + x * 4;
      raw[pixel] = 0x44;
      raw[pixel + 1] = 0x88;
      raw[pixel + 2] = 0xcc;
      raw[pixel + 3] = 0xff;
    }
  });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ATLAS_WIDTH, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

function alphaAt(png, x, y) {
  const stride = 1 + png.width * 4;
  const rowStart = y * stride;
  assert.strictEqual(png.rgba[rowStart], 0, "fixture PNG should use unfiltered rows");
  return png.rgba[rowStart + 1 + x * 4 + 3];
}

function copyFixturePackage(parentDir, folderName = "tiny-atlas-png") {
  const targetDir = path.join(parentDir, folderName);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const filename of ["pet.json", "spritesheet.png", "README.md"]) {
    fs.copyFileSync(path.join(FIXTURE_DIR, filename), path.join(targetDir, filename));
  }
  return targetDir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeWebpPackage(parentDir, folderName, webpBuffer, manifestOverrides = {}) {
  const packageDir = path.join(parentDir, folderName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "spritesheet.webp"), webpBuffer);
  writeJson(path.join(packageDir, "pet.json"), {
    id: folderName,
    displayName: folderName,
    spritesheetPath: "spritesheet.webp",
    ...manifestOverrides,
  });
  return packageDir;
}

function buildWebpBuffer(chunks) {
  const bodyParts = [Buffer.from("WEBP", "ascii")];
  for (const { type, data } of chunks) {
    const payload = Buffer.from(data);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32LE(payload.length, 4);
    bodyParts.push(header, payload);
    if (payload.length % 2 === 1) bodyParts.push(Buffer.from([0]));
  }
  const body = Buffer.concat(bodyParts);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function writeUint24LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}

function makeVp8xWebp({ width = ATLAS_WIDTH, height = ATLAS_HEIGHT, alpha = true } = {}) {
  const data = Buffer.alloc(10);
  data[0] = alpha ? 0x10 : 0;
  writeUint24LE(data, 4, width - 1);
  writeUint24LE(data, 7, height - 1);
  return buildWebpBuffer([{ type: "VP8X", data }]);
}

function makeVp8lWebp({ width = ATLAS_WIDTH, height = ATLAS_HEIGHT } = {}) {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  data.writeUInt32LE(bits >>> 0, 1);
  return buildWebpBuffer([{ type: "VP8L", data }]);
}

function makeVp8Webp({ width = ATLAS_WIDTH, height = ATLAS_HEIGHT } = {}) {
  const data = Buffer.alloc(10);
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return buildWebpBuffer([{ type: "VP8 ", data }]);
}

function makeThemeLoaderFixture(userData) {
  const appRoot = path.join(makeTempDir(), "app");
  const appDir = path.join(appRoot, "src");
  fs.mkdirSync(path.join(appRoot, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "themes"), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  themeLoader.init(appDir, userData);
}

describe("Codex Pet fixture", () => {
  it("committed tiny Codex Pet fixture matches the atlas contract", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "pet.json"), "utf8"));
    assert.strictEqual(manifest.id, "tiny-atlas-png");
    assert.strictEqual(manifest.spritesheetPath, "spritesheet.png");

    const png = readPng(path.join(FIXTURE_DIR, manifest.spritesheetPath));
    assert.strictEqual(png.width, ATLAS_WIDTH);
    assert.strictEqual(png.height, ATLAS_HEIGHT);
    assert.strictEqual(png.bitDepth, 8);
    assert.strictEqual(png.colorType, 6);

    for (let row = 0; row < ROWS; row += 1) {
      const usedColumns = USED_COLUMNS_BY_ROW[row];
      const activeX = (usedColumns - 1) * FRAME_WIDTH + Math.floor(FRAME_WIDTH / 2);
      const activeY = row * FRAME_HEIGHT + Math.floor(FRAME_HEIGHT / 2);
      assert.strictEqual(alphaAt(png, activeX, activeY), 255, `row ${row} active cells should be visible`);

      if (usedColumns < COLUMNS) {
        const unusedX = usedColumns * FRAME_WIDTH + Math.floor(FRAME_WIDTH / 2);
        assert.strictEqual(alphaAt(png, unusedX, activeY), 0, `row ${row} unused cells should be transparent`);
      }
    }
  });
});

describe("codex-pet-adapter package validation", () => {
  it("accepts the deterministic PNG fixture and records source metadata", () => {
    const result = adapter.validateCodexPetPackage(FIXTURE_DIR);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.packageInfo.id, "tiny-atlas-png");
    assert.strictEqual(result.packageInfo.slug, "tiny-atlas-png");
    assert.strictEqual(result.packageInfo.spritesheetPath, "spritesheet.png");
    assert.strictEqual(result.packageInfo.spriteVersionNumber, 1);
    assert.strictEqual(result.packageInfo.atlas, adapter.ATLAS_BY_SPRITE_VERSION[1]);
    assert.strictEqual(result.packageInfo.image.width, adapter.ATLAS.width);
    assert.strictEqual(result.packageInfo.image.height, adapter.ATLAS.height);
    assert.strictEqual(result.packageInfo.image.checkedUnusedTransparency, true);
  });

  it("preserves Unicode pet ids while deriving an ASCII slug", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(root, "yoimiya宵宫");
    writeJson(path.join(packageDir, "pet.json"), {
      id: "yoimiya宵宫",
      displayName: "yoimiya宵宫",
      spritesheetPath: "spritesheet.png",
    });

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.strictEqual(result.packageInfo.id, "yoimiya宵宫");
    assert.strictEqual(result.packageInfo.slug, "yoimiya");
  });

  it("length-caps display metadata before writing generated theme JSON", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(root, "long-meta");
    writeJson(path.join(packageDir, "pet.json"), {
      id: "long-meta",
      displayName: ` ${"N".repeat(adapter.MAX_DISPLAY_NAME_LENGTH + 20)} `,
      description: ` ${"D".repeat(adapter.MAX_DESCRIPTION_LENGTH + 20)} `,
      spritesheetPath: "spritesheet.png",
    });

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.strictEqual(result.packageInfo.displayName.length, adapter.MAX_DISPLAY_NAME_LENGTH);
    assert.strictEqual(result.packageInfo.description.length, adapter.MAX_DESCRIPTION_LENGTH);

    const materialized = adapter.materializeCodexPetTheme(result.packageInfo, path.join(root, "userData", "themes"));
    const themeJson = readJson(path.join(materialized.themeDir, "theme.json"));
    assert.strictEqual(themeJson.name.length, adapter.MAX_DISPLAY_NAME_LENGTH);
    assert.strictEqual(themeJson.description.length, adapter.MAX_DESCRIPTION_LENGTH);
  });

  it("reports missing, malformed, and non-object manifests without aborting the full sync", () => {
    const root = makeTempDir();
    const missingDir = path.join(root, "missing");
    fs.mkdirSync(missingDir, { recursive: true });
    assert.match(adapter.validateCodexPetPackage(missingDir).errors.join("; "), /missing pet\.json/);

    const badDir = path.join(root, "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "pet.json"), "{", "utf8");
    assert.match(adapter.validateCodexPetPackage(badDir).errors.join("; "), /invalid pet\.json/);

    const petsDir = path.join(root, "pets");
    copyFixturePackage(petsDir, "valid");
    for (const [folderName, value] of [
      ["null", null],
      ["zero", 0],
      ["false", false],
      ["empty-string", ""],
      ["array", []],
    ]) {
      const packageDir = path.join(petsDir, folderName);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "pet.json"), JSON.stringify(value), "utf8");
      const result = adapter.validateCodexPetPackage(packageDir);
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join("; "), /pet\.json must be a JSON object/);
    }

    const summary = adapter.syncCodexPetThemes({
      codexPetsDir: petsDir,
      userDataDir: path.join(root, "userData"),
    });
    assert.strictEqual(summary.imported, 1);
    assert.strictEqual(summary.invalid, 5);
  });

  it("rejects unsafe or unsupported spritesheet paths", () => {
    const root = makeTempDir();

    const absoluteDir = path.join(root, "absolute");
    fs.mkdirSync(absoluteDir, { recursive: true });
    writeJson(path.join(absoluteDir, "pet.json"), {
      id: "absolute",
      spritesheetPath: "C:\\outside\\spritesheet.png",
    });
    assert.match(adapter.validateCodexPetPackage(absoluteDir).errors.join("; "), /must be relative/);

    const traversalDir = path.join(root, "traversal");
    fs.mkdirSync(traversalDir, { recursive: true });
    writeJson(path.join(traversalDir, "pet.json"), {
      id: "traversal",
      spritesheetPath: "../spritesheet.png",
    });
    assert.match(adapter.validateCodexPetPackage(traversalDir).errors.join("; "), /traversal/);

    const gifDir = copyFixturePackage(root, "gif");
    writeJson(path.join(gifDir, "pet.json"), {
      id: "gif",
      spritesheetPath: "spritesheet.gif",
    });
    fs.copyFileSync(path.join(gifDir, "spritesheet.png"), path.join(gifDir, "spritesheet.gif"));
    assert.match(adapter.validateCodexPetPackage(gifDir).errors.join("; "), /\.webp or \.png/);
  });

  it("rejects PNG atlases with wrong dimensions", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(root, "wrong-size");
    const spritesheetPath = path.join(packageDir, "spritesheet.png");
    const png = fs.readFileSync(spritesheetPath);
    png.writeUInt32BE(ATLAS_WIDTH - 1, 16);
    fs.writeFileSync(spritesheetPath, png);

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("; "), /spriteVersionNumber 1 must be 1536x1872, got 1535x1872/);
  });

  it("accepts V2 PNG atlases and preserves both gaze rows as active cells", () => {
    const root = makeTempDir();
    const packageDir = path.join(root, "v2-png");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "spritesheet.png"),
      makeRgbaAtlasPng({ rows: V2_ROWS, usedColumnsByRow: V2_USED_COLUMNS_BY_ROW })
    );
    writeJson(path.join(packageDir, "pet.json"), {
      id: "v2-png",
      displayName: "V2 PNG",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.png",
    });

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.strictEqual(result.packageInfo.spriteVersionNumber, 2);
    assert.strictEqual(result.packageInfo.image.width, ATLAS_WIDTH);
    assert.strictEqual(result.packageInfo.image.height, V2_ATLAS_HEIGHT);
    assert.strictEqual(result.packageInfo.image.checkedUnusedTransparency, true);

    const userData = path.join(root, "userData");
    const materialized = adapter.materializeCodexPetTheme(
      result.packageInfo,
      path.join(userData, "themes")
    );
    const themeJson = readJson(path.join(materialized.themeDir, "theme.json"));
    const idleWrapper = fs.readFileSync(
      path.join(materialized.themeDir, "assets", "codex-pet-idle-loop.svg"),
      "utf8"
    );
    const marker = readJson(path.join(materialized.themeDir, adapter.MARKER_FILENAME));
    assert.strictEqual(themeJson.source.spriteVersionNumber, 2);
    assert.strictEqual(themeJson.eyeTracking.enabled, false);
    assert.match(idleWrapper, /<image class="atlas"[^>]+width="1536" height="2288"/);
    assert.strictEqual(marker.sourceSpriteVersionNumber, 2);
    assert.strictEqual(marker.sourceAtlasColumns, 8);
    assert.strictEqual(marker.sourceAtlasRows, 11);
    assert.strictEqual(marker.sourcePngAlphaValidation.spriteVersionNumber, 2);
    assert.strictEqual(marker.sourcePngAlphaValidation.atlasHeight, 2288);

    makeThemeLoaderFixture(userData);
    const loaded = themeLoader.loadTheme(materialized.themeId, { strict: true });
    assert.strictEqual(loaded.source.spriteVersionNumber, 2);
    assert.strictEqual(loaded.states.idle[0], "codex-pet-idle-loop.svg");
  });

  it("allows empty V2 gaze rows while keeping action rows required", () => {
    const root = makeTempDir();
    const packageDir = path.join(root, "v2-empty-gaze");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "spritesheet.png"),
      makeRgbaAtlasPng({ rows: V2_ROWS, usedColumnsByRow: USED_COLUMNS_BY_ROW })
    );
    writeJson(path.join(packageDir, "pet.json"), {
      id: "v2-empty-gaze",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.png",
    });

    const accepted = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(accepted.ok, true, accepted.errors.join("; "));

    fs.writeFileSync(
      path.join(packageDir, "spritesheet.png"),
      makeRgbaAtlasPng({
        rows: V2_ROWS,
        usedColumnsByRow: [7, ...USED_COLUMNS_BY_ROW.slice(1)],
      })
    );
    const strayActionPixel = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(strayActionPixel.ok, false);
    assert.match(
      strayActionPixel.errors.join("; "),
      /unused atlas cell row 0 column 6 must be transparent/
    );

    fs.writeFileSync(
      path.join(packageDir, "spritesheet.png"),
      makeRgbaAtlasPng({
        rows: V2_ROWS,
        usedColumnsByRow: [0, ...USED_COLUMNS_BY_ROW.slice(1)],
      })
    );
    const rejected = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(rejected.ok, false);
    assert.match(rejected.errors.join("; "), /atlas row 0 has no visible pixels in active cells/);
  });

  it("bounds PNG decompression to the declared atlas size", () => {
    const root = makeTempDir();
    const packageDir = path.join(root, "oversized-png-output");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "spritesheet.png"),
      makeRgbaAtlasPng({
        rows: ROWS,
        usedColumnsByRow: USED_COLUMNS_BY_ROW,
        extraInflatedBytes: 1,
      })
    );
    writeJson(path.join(packageDir, "pet.json"), {
      id: "oversized-png-output",
      spritesheetPath: "spritesheet.png",
    });

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("; "), /failed to inspect spritesheet/);
  });

  it("rejects unsupported sprite versions and version-specific dimension mismatches", () => {
    const root = makeTempDir();
    const v2WithV1Atlas = writeWebpPackage(root, "v2-with-v1-atlas", makeVp8xWebp(), {
      spriteVersionNumber: 2,
    });
    assert.match(
      adapter.validateCodexPetPackage(v2WithV1Atlas).errors.join("; "),
      /spriteVersionNumber 2 must be 1536x2288, got 1536x1872/
    );

    const v1WithV2Atlas = writeWebpPackage(
      root,
      "v1-with-v2-atlas",
      makeVp8xWebp({ height: V2_ATLAS_HEIGHT }),
      { spriteVersionNumber: 1 }
    );
    assert.match(
      adapter.validateCodexPetPackage(v1WithV2Atlas).errors.join("; "),
      /spriteVersionNumber 1 must be 1536x1872, got 1536x2288/
    );

    const unsupported = writeWebpPackage(
      root,
      "unsupported-version",
      makeVp8xWebp({ height: V2_ATLAS_HEIGHT }),
      { spriteVersionNumber: 3 }
    );
    const unsupportedResult = adapter.validateCodexPetPackage(unsupported);
    assert.strictEqual(unsupportedResult.ok, false);
    assert.match(unsupportedResult.errors.join("; "), /spriteVersionNumber must be 1 or 2/);
    assert.doesNotMatch(unsupportedResult.errors.join("; "), /spritesheet for spriteVersionNumber/);

    const explicitNull = writeWebpPackage(
      root,
      "null-version",
      makeVp8xWebp(),
      { spriteVersionNumber: null }
    );
    const explicitNullResult = adapter.validateCodexPetPackage(explicitNull);
    assert.strictEqual(explicitNullResult.ok, false);
    assert.match(explicitNullResult.errors.join("; "), /spriteVersionNumber must be 1 or 2/);
  });

  it("accepts valid VP8X and VP8L WebP atlas headers", () => {
    const root = makeTempDir();
    const vp8xDir = writeWebpPackage(root, "vp8x", makeVp8xWebp());
    const vp8lDir = writeWebpPackage(root, "vp8l", makeVp8lWebp());

    const vp8x = adapter.validateCodexPetPackage(vp8xDir);
    assert.strictEqual(vp8x.ok, true, vp8x.errors.join("; "));
    assert.strictEqual(vp8x.packageInfo.image.format, "webp");
    assert.strictEqual(vp8x.packageInfo.image.encoding, "VP8X");
    assert.strictEqual(vp8x.packageInfo.image.width, ATLAS_WIDTH);
    assert.strictEqual(vp8x.packageInfo.image.height, ATLAS_HEIGHT);
    assert.strictEqual(vp8x.packageInfo.image.hasAlpha, true);

    const vp8l = adapter.validateCodexPetPackage(vp8lDir);
    assert.strictEqual(vp8l.ok, true, vp8l.errors.join("; "));
    assert.strictEqual(vp8l.packageInfo.image.encoding, "VP8L");

    const v2Vp8lDir = writeWebpPackage(
      root,
      "v2-vp8l",
      makeVp8lWebp({ height: V2_ATLAS_HEIGHT }),
      { spriteVersionNumber: 2 }
    );
    const v2Vp8l = adapter.validateCodexPetPackage(v2Vp8lDir);
    assert.strictEqual(v2Vp8l.ok, true, v2Vp8l.errors.join("; "));
    assert.strictEqual(v2Vp8l.packageInfo.image.encoding, "VP8L");
    assert.strictEqual(v2Vp8l.packageInfo.image.height, V2_ATLAS_HEIGHT);
  });

  it("rejects malformed WebP headers and non-alpha WebP variants", () => {
    const root = makeTempDir();
    const badRiffDir = writeWebpPackage(root, "bad-riff", Buffer.from("not-webp"));
    assert.match(adapter.validateCodexPetPackage(badRiffDir).errors.join("; "), /invalid RIFF\/WEBP header/);

    const missingChunkDir = writeWebpPackage(root, "missing-chunk", buildWebpBuffer([
      { type: "EXIF", data: Buffer.from([1, 2, 3, 4]) },
    ]));
    assert.match(adapter.validateCodexPetPackage(missingChunkDir).errors.join("; "), /missing a VP8\/VP8L\/VP8X/);

    const vp8xNoAlphaDir = writeWebpPackage(root, "vp8x-no-alpha", makeVp8xWebp({ alpha: false }));
    assert.match(adapter.validateCodexPetPackage(vp8xNoAlphaDir).errors.join("; "), /must include an alpha channel/);

    const vp8Dir = writeWebpPackage(root, "vp8", makeVp8Webp());
    assert.match(adapter.validateCodexPetPackage(vp8Dir).errors.join("; "), /must include an alpha channel/);
  });
});

describe("codex-pet-adapter wrapper generation and materialization", () => {
  it("generates loop, once, and static wrappers without unused-frame references", () => {
    const jumpOnce = adapter.generateWrapperSvg({
      rowKey: "jumping",
      mode: "once",
      spritesheetHref: "spritesheet.png",
    });
    assert.match(jumpOnce, /animation-name: codex-pet-row-jumping-once/);
    assert.match(jumpOnce, /animation-iteration-count: 1/);
    assert.match(jumpOnce, /animation-fill-mode: forwards/);
    assert.ok(!jumpOnce.includes("translate(-960px, -832px)"));

    const runLoop = adapter.generateWrapperSvg({
      rowKey: "running",
      mode: "loop",
      spritesheetHref: "spritesheet.png",
    });
    assert.match(runLoop, /animation-iteration-count: infinite/);

    const idleStatic = adapter.generateWrapperSvg({
      rowKey: "idle",
      mode: "static",
      spritesheetHref: "spritesheet.png",
    });
    assert.ok(!idleStatic.includes("animation-name:"));
    assert.match(idleStatic, /transform: translate\(0px, 0px\)/);
  });

  it("materializes a managed Clawd theme that strict-loads through theme-loader", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(path.join(root, "pets"));
    const validation = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(validation.ok, true, validation.errors.join("; "));

    const userData = path.join(root, "userData");
    const userThemesDir = path.join(userData, "themes");
    const materialized = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);

    assert.strictEqual(materialized.themeId, "codex-pet-tiny-atlas-png");
    assert.strictEqual(fs.existsSync(path.join(materialized.themeDir, "assets", "spritesheet.png")), true);
    assert.strictEqual(fs.existsSync(path.join(materialized.themeDir, "assets", "codex-pet-jumping-once.svg")), true);

    const themeJson = readJson(path.join(materialized.themeDir, "theme.json"));
    assert.strictEqual(themeJson.rendering.svgChannel, "object");
    assert.strictEqual(themeJson.eyeTracking.enabled, false);
    assert.strictEqual(themeJson.states.working[0], "codex-pet-running-loop.svg");
    assert.strictEqual(themeJson.states.notification[0], "codex-pet-waiting-loop.svg");
    assert.strictEqual(themeJson.states.error[0], "codex-pet-failed-loop.svg");
    assert.deepStrictEqual(themeJson.hitBoxes.default, { x: 0, y: 0, w: 192, h: 208 });
    assert.strictEqual(themeJson.reactions.drag.file, "codex-pet-running-loop.svg");
    assert.strictEqual(themeJson.reactions.drag.fileLeft, "codex-pet-running-left-loop.svg");
    assert.strictEqual(themeJson.reactions.drag.fileRight, "codex-pet-running-right-loop.svg");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(themeJson, "objectScale"), false);

    const marker = readJson(path.join(materialized.themeDir, adapter.MARKER_FILENAME));
    assert.strictEqual(marker.adapterVersion, adapter.ADAPTER_VERSION);
    assert.strictEqual(marker.generatedThemeId, materialized.themeId);
    assert.strictEqual(marker.sourcePetId, "tiny-atlas-png");
    assert.strictEqual(marker.sourceAtlasColumns, 8);
    assert.strictEqual(marker.sourceAtlasRows, 9);

    makeThemeLoaderFixture(userData);
    const loaded = themeLoader.loadTheme(materialized.themeId, { strict: true });
    assert.strictEqual(loaded._id, materialized.themeId);
    assert.strictEqual(loaded.rendering.svgChannel, "object");
    assert.strictEqual(loaded.states.sleeping[0], "codex-pet-idle-static.svg");
  });

  it("does not overwrite unmanaged theme IDs and keeps managed suffixes stable", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(path.join(root, "pets"));
    const validation = adapter.validateCodexPetPackage(packageDir);
    const userThemesDir = path.join(root, "userData", "themes");
    const unmanagedDir = path.join(userThemesDir, "codex-pet-tiny-atlas-png");
    fs.mkdirSync(unmanagedDir, { recursive: true });
    fs.writeFileSync(path.join(unmanagedDir, "theme.json"), "{\"name\":\"User Theme\"}\n", "utf8");

    const first = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);
    const second = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);

    assert.strictEqual(first.themeId, "codex-pet-tiny-atlas-png-2");
    assert.strictEqual(second.themeId, "codex-pet-tiny-atlas-png-2");
    assert.strictEqual(fs.readFileSync(path.join(unmanagedDir, "theme.json"), "utf8"), "{\"name\":\"User Theme\"}\n");
  });

  it("recovers a partial first-time materialization without changing the theme id", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(path.join(root, "pets"));
    const validation = adapter.validateCodexPetPackage(packageDir);
    const userThemesDir = path.join(root, "userData", "themes");
    const partialDir = path.join(userThemesDir, "codex-pet-tiny-atlas-png");
    fs.mkdirSync(path.join(partialDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(partialDir, "assets", "half-written.svg"), "<svg/>", "utf8");

    const materialized = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);
    const marker = readJson(path.join(materialized.themeDir, adapter.MARKER_FILENAME));

    assert.strictEqual(materialized.themeId, "codex-pet-tiny-atlas-png");
    assert.strictEqual(materialized.operation, "created");
    assert.strictEqual(marker.inProgress, undefined);
    assert.strictEqual(fs.existsSync(path.join(partialDir, "assets", "half-written.svg")), false);
    assert.strictEqual(fs.existsSync(path.join(partialDir, "assets", "codex-pet-idle-loop.svg")), true);
  });

  it("keeps unmanaged theme IDs with real theme.json protected", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(path.join(root, "pets"));
    const validation = adapter.validateCodexPetPackage(packageDir);
    const userThemesDir = path.join(root, "userData", "themes");
    const unmanagedDir = path.join(userThemesDir, "codex-pet-tiny-atlas-png");
    writeJson(path.join(unmanagedDir, "theme.json"), {
      schemaVersion: 1,
      name: "User Theme",
      version: "1.0.0",
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      states: {},
    });

    const materialized = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);
    assert.strictEqual(materialized.themeId, "codex-pet-tiny-atlas-png-2");
    assert.strictEqual(readJson(path.join(unmanagedDir, "theme.json")).name, "User Theme");
  });

  it("syncs valid packages and reports invalid packages without throwing", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    copyFixturePackage(petsDir, "tiny-atlas-png");
    fs.mkdirSync(path.join(petsDir, "broken"), { recursive: true });

    const summary = adapter.syncCodexPetThemes({
      codexPetsDir: petsDir,
      userDataDir: path.join(root, "userData"),
    });

    assert.strictEqual(summary.imported, 1);
    assert.strictEqual(summary.updated, 0);
    assert.strictEqual(summary.unchanged, 0);
    assert.strictEqual(summary.invalid, 1);
    assert.deepStrictEqual(summary.themes.map((theme) => theme.themeId), ["codex-pet-tiny-atlas-png"]);
    assert.match(summary.diagnostics[0].errors.join("; "), /missing pet\.json/);
  });

  it("skips unchanged managed themes and rebuilds incomplete generated output", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    copyFixturePackage(petsDir, "tiny-atlas-png");
    const userDataDir = path.join(root, "userData");

    const first = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
    const themeDir = path.join(userDataDir, "themes", first.themes[0].themeId);
    const spritesheetPath = path.join(themeDir, "assets", "spritesheet.png");
    const wrapperPath = path.join(themeDir, "assets", "codex-pet-idle-loop.svg");
    const markerPath = path.join(themeDir, adapter.MARKER_FILENAME);
    const before = {
      spritesheetMtimeMs: fs.statSync(spritesheetPath).mtimeMs,
      wrapperMtimeMs: fs.statSync(wrapperPath).mtimeMs,
      markerMtimeMs: fs.statSync(markerPath).mtimeMs,
    };

    const second = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });

    assert.strictEqual(second.imported, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 1);
    assert.strictEqual(fs.statSync(spritesheetPath).mtimeMs, before.spritesheetMtimeMs);
    assert.strictEqual(fs.statSync(wrapperPath).mtimeMs, before.wrapperMtimeMs);
    assert.strictEqual(fs.statSync(markerPath).mtimeMs, before.markerMtimeMs);

    fs.rmSync(wrapperPath, { force: true });
    const third = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });

    assert.strictEqual(third.imported, 0);
    assert.strictEqual(third.updated, 1);
    assert.strictEqual(third.unchanged, 0);
    assert.strictEqual(fs.existsSync(wrapperPath), true);
  });

  it("caches PNG unused-cell validation for unchanged startup syncs", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    const packageDir = copyFixturePackage(petsDir, "tiny-atlas-png");
    const userDataDir = path.join(root, "userData");
    const originalInflateSync = zlib.inflateSync;
    let inflateCalls = 0;

    zlib.inflateSync = (...args) => {
      inflateCalls += 1;
      return originalInflateSync(...args);
    };

    try {
      const first = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
      const themeDir = path.join(userDataDir, "themes", first.themes[0].themeId);
      const marker = readJson(path.join(themeDir, adapter.MARKER_FILENAME));
      assert.strictEqual(first.imported, 1);
      assert.ok(inflateCalls > 0);
      assert.deepStrictEqual(marker.sourcePngAlphaValidation, {
        schemaVersion: 2,
        spriteVersionNumber: 1,
        atlasWidth: 1536,
        atlasHeight: 1872,
        spritesheetMtimeMs: fs.statSync(path.join(packageDir, "spritesheet.png")).mtimeMs,
        spritesheetSize: fs.statSync(path.join(packageDir, "spritesheet.png")).size,
        checkedUnusedTransparency: true,
      });

      inflateCalls = 0;
      const second = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
      assert.strictEqual(second.unchanged, 1);
      assert.strictEqual(inflateCalls, 0);

      const spritesheetPath = path.join(packageDir, "spritesheet.png");
      const future = new Date(Date.now() + 10000);
      fs.utimesSync(spritesheetPath, future, future);
      const third = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
      assert.strictEqual(third.updated, 1);
      assert.ok(inflateCalls > 0);
    } finally {
      zlib.inflateSync = originalInflateSync;
    }
  });

  it("caches V2 PNG validation and upgrades legacy markers on the next sync", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    const packageDir = path.join(petsDir, "v2-cache");
    const userDataDir = path.join(root, "userData");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "spritesheet.png"),
      makeRgbaAtlasPng({ rows: V2_ROWS, usedColumnsByRow: V2_USED_COLUMNS_BY_ROW })
    );
    writeJson(path.join(packageDir, "pet.json"), {
      id: "v2-cache",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.png",
    });

    const originalInflateSync = zlib.inflateSync;
    let inflateCalls = 0;
    zlib.inflateSync = (...args) => {
      inflateCalls += 1;
      return originalInflateSync(...args);
    };

    try {
      const first = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
      assert.strictEqual(first.imported, 1);
      assert.ok(inflateCalls > 0);

      const themeDir = path.join(userDataDir, "themes", first.themes[0].themeId);
      const markerPath = path.join(themeDir, adapter.MARKER_FILENAME);
      const wrapperPath = path.join(themeDir, "assets", "codex-pet-idle-loop.svg");
      let marker = readJson(markerPath);
      assert.strictEqual(marker.sourceSpriteVersionNumber, 2);
      assert.strictEqual(marker.sourceAtlasRows, 11);
      assert.strictEqual(marker.sourcePngAlphaValidation.schemaVersion, 2);
      assert.strictEqual(marker.sourcePngAlphaValidation.atlasHeight, V2_ATLAS_HEIGHT);

      inflateCalls = 0;
      const second = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
      assert.strictEqual(second.unchanged, 1);
      assert.strictEqual(inflateCalls, 0);

      marker.adapterVersion = 3;
      delete marker.sourceSpriteVersionNumber;
      delete marker.sourceAtlasColumns;
      delete marker.sourceAtlasRows;
      marker.sourcePngAlphaValidation = {
        schemaVersion: 1,
        spritesheetMtimeMs: marker.sourceSpritesheetMtimeMs,
        spritesheetSize: marker.sourceSpritesheetSize,
        checkedUnusedTransparency: true,
      };
      writeJson(markerPath, marker);

      inflateCalls = 0;
      const upgraded = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
      assert.strictEqual(upgraded.updated, 1);
      assert.ok(inflateCalls > 0);
      assert.match(fs.readFileSync(wrapperPath, "utf8"), /width="1536" height="2288"/);

      marker = readJson(markerPath);
      assert.strictEqual(marker.adapterVersion, adapter.ADAPTER_VERSION);
      assert.strictEqual(marker.sourceSpriteVersionNumber, 2);
      assert.strictEqual(marker.sourceAtlasColumns, 8);
      assert.strictEqual(marker.sourceAtlasRows, 11);
      assert.strictEqual(marker.sourcePngAlphaValidation.schemaVersion, 2);
      assert.strictEqual(marker.sourcePngAlphaValidation.atlasHeight, V2_ATLAS_HEIGHT);
    } finally {
      zlib.inflateSync = originalInflateSync;
    }
  });

  it("removes orphan managed themes when the source package disappears", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    const packageDir = copyFixturePackage(petsDir, "tiny-atlas-png");
    const userDataDir = path.join(root, "userData");
    const first = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
    const themeDir = path.join(userDataDir, "themes", first.themes[0].themeId);
    assert.strictEqual(fs.existsSync(themeDir), true);

    fs.rmSync(packageDir, { recursive: true, force: true });
    const second = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });

    assert.strictEqual(second.removed, 1);
    assert.strictEqual(fs.existsSync(themeDir), false);
  });

  it("does not remove an active orphan managed theme before main handles fallback", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    const packageDir = copyFixturePackage(petsDir, "tiny-atlas-png");
    const userDataDir = path.join(root, "userData");
    const first = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir });
    const themeId = first.themes[0].themeId;
    const themeDir = path.join(userDataDir, "themes", themeId);

    fs.rmSync(packageDir, { recursive: true, force: true });
    const second = adapter.syncCodexPetThemes({ codexPetsDir: petsDir, userDataDir, activeThemeId: themeId });

    assert.strictEqual(second.removed, 0);
    assert.deepStrictEqual(second.activeOrphanThemeIds, [themeId]);
    assert.strictEqual(fs.existsSync(themeDir), true);
    assert.match(second.diagnostics[0].errors.join("; "), /source package is missing but theme is active/);
  });
});
