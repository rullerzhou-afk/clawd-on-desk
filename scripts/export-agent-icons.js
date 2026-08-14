"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const { spawnSync } = require("child_process");
const { writeJsonAtomic } = require("../hooks/json-utils");

let app;
let nativeImage;
try {
  ({ app, nativeImage } = require("electron"));
} catch {
  app = null;
  nativeImage = null;
}

const { getAllAgents } = require("../agents/registry");

const ICON_SIZE = 64;
const ARTWORK_SIZE = 56;
const CONTRAST_TILE_SIZE = 56;
const CONTRAST_TILE_RADIUS = 10;
const CONTRAST_TILE_ARTWORK_SIZE = 40;
const CONTRAST_TILE_COLORS = Object.freeze({
  "neutral-light-tile": Object.freeze([244, 244, 244, 255]),
  "neutral-dark-tile": Object.freeze([63, 63, 70, 255]),
});
const BYTES_PER_PIXEL = 4;
const ALPHA_CHANNEL_OFFSET = 3;
const SOURCE_DIR = path.join(__dirname, "..", "assets", "source", "agent-icons");
const SOURCE_MANIFEST_PATH = path.join(SOURCE_DIR, "source-manifest.json");
const OUTPUT_DIR = path.join(__dirname, "..", "assets", "icons", "agents");
const SOURCE_EXTENSIONS = [".png", ".svg"];
const EXPORTER_ENV = "CLAWD_AGENT_ICON_EXPORTER";
const LOBE_ICONS_UPSTREAM = Object.freeze({
  upstreamPackage: "@lobehub/icons-static-png",
  upstreamVersion: "1.95.0",
  license: "MIT",
  variant: "light",
});
const LOBE_ICONS_OFFICIAL_WEBSITE = Object.freeze({
  upstreamName: "Lobe Icons",
  upstreamUrl: "https://lobehub.com/icons",
  license: "MIT",
});

function lobeSource(originalFilename, extra = {}) {
  return { originalFilename, fallback: false, ...LOBE_ICONS_UPSTREAM, ...extra };
}

const SOURCE_PROVENANCE = Object.freeze({
  "antigravity-cli": lobeSource("antigravity-color.png"),
  // Anthropic 的 Claude 标（放射星芒），不是 Claude Code CLI 的像素兽：额度环
  // 报的是账号订阅额度，而圆形币把方形像素图裁掉四角后既丢信息又显脏。
  "claude-code": lobeSource("claude-color.png"),
  codebuddy: lobeSource("codebuddy-color.png"),
  codewhale: { originalFilename: "codewhale.png", fallback: true },
  codex: lobeSource("openai.png", { contrastTreatment: "neutral-light-tile" }),
  "deepseek-harness": lobeSource("deepseek-color.png"),
  "copilot-cli": lobeSource("githubcopilot.png", { contrastTreatment: "neutral-light-tile" }),
  "cursor-agent": lobeSource("cursor.png", { contrastTreatment: "neutral-light-tile" }),
  "gemini-cli": lobeSource("geminicli-color.png"),
  hermes: lobeSource("hermesagent.png", { contrastTreatment: "neutral-light-tile" }),
  "kimi-cli": {
    originalFilename: "kimi-cli.png",
    sourceFilename: "kimi-cli-legacy.png",
    fallback: true,
    exportMode: "passthrough",
    archivedSources: [
      {
        originalFilename: "kimi-color.png",
        sourceFilename: "kimi-cli.png",
        ...LOBE_ICONS_UPSTREAM,
      },
      {
        originalFilename: "kimi-color.svg",
        sourceFilename: "kimi-cli.svg",
        upstreamPackage: "lobe-icons",
        upstreamVersion: "1.95.0",
        license: "MIT",
        variant: "light",
      },
    ],
  },
  "kiro-cli": lobeSource("kiro-color.png"),
  mimocode: lobeSource("xiaomimimo.png", { contrastTreatment: "neutral-light-tile" }),
  openclaw: lobeSource("openclaw-color.png"),
  opencode: lobeSource("opencode.png", { contrastTreatment: "neutral-light-tile" }),
  pi: lobeSource("pi.png", { contrastTreatment: "neutral-light-tile" }),
  qoder: lobeSource("qoder-color.png"),
  qoderwork: {
    originalFilename: "qoderwork.png",
    sourceFilename: "qoderwork-legacy.png",
    fallback: true,
    exportMode: "passthrough",
    archivedSources: [
      { originalFilename: "qoderwork.png", sourceFilename: "qoderwork.png" },
    ],
  },
  qwenwork: {
    originalFilename: "qwenwork.png",
    sourceFilename: "qwenwork.png",
    fallback: true,
    exportMode: "passthrough",
  },
  "qwen-code": lobeSource("qwen-color.png", { contrastTreatment: "neutral-light-tile" }),
  reasonix: { originalFilename: "reasonix.png", fallback: true },
  workbuddy: {
    originalFilename: "workbuddy.png",
    fallback: false,
  },
  zcode: { originalFilename: "zcode.png", fallback: true, exportMode: "passthrough" },
});

function getSourceCandidatePath(agentId, extension) {
  return path.join(SOURCE_DIR, `${agentId}${extension}`);
}

function getSourcePath(agentId) {
  const configuredFilename = SOURCE_PROVENANCE[agentId] && SOURCE_PROVENANCE[agentId].sourceFilename;
  if (configuredFilename) {
    const configuredPath = path.join(SOURCE_DIR, configuredFilename);
    return fs.existsSync(configuredPath) ? configuredPath : null;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const sourcePath = getSourceCandidatePath(agentId, extension);
    if (fs.existsSync(sourcePath)) return sourcePath;
  }
  return null;
}

function normalizeTextLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hashSvgSource(filePath) {
  return crypto
    .createHash("sha256")
    .update(normalizeTextLineEndings(fs.readFileSync(filePath, "utf8")), "utf8")
    .digest("hex");
}

function hashFileSource(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashSource(filePath) {
  return path.extname(filePath).toLowerCase() === ".svg"
    ? hashSvgSource(filePath)
    : hashFileSource(filePath);
}

function readSourceManifest() {
  if (!fs.existsSync(SOURCE_MANIFEST_PATH)) return { sources: {}, svgSources: {}, outputs: {} };
  const manifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST_PATH, "utf8"));
  if (!manifest || typeof manifest !== "object") return { sources: {}, svgSources: {}, outputs: {} };
  if (!manifest.sources || typeof manifest.sources !== "object") {
    manifest.sources = {};
  }
  if (!manifest.svgSources || typeof manifest.svgSources !== "object") {
    manifest.svgSources = {};
  }
  if (!manifest.outputs || typeof manifest.outputs !== "object") {
    manifest.outputs = {};
  }
  return manifest;
}

function writeSourceManifest(manifest) {
  writeJsonAtomic(SOURCE_MANIFEST_PATH, manifest);
}

function hasRasterAndSvgSources(agentId) {
  const pngPath = getSourceCandidatePath(agentId, ".png");
  const svgPath = getSourceCandidatePath(agentId, ".svg");
  return fs.existsSync(pngPath) && fs.existsSync(svgPath);
}

function updateSvgSourceHashes(manifest, agents) {
  manifest.svgSources = {};
  for (const agent of agents) {
    if (!hasRasterAndSvgSources(agent.id)) continue;
    const svgPath = getSourceCandidatePath(agent.id, ".svg");
    manifest.svgSources[agent.id] = {
      sourceFilename: path.basename(svgPath),
      sourceType: "svg",
      sha256: hashSvgSource(svgPath),
      ...LOBE_ICONS_OFFICIAL_WEBSITE,
    };
  }
  return manifest;
}

function getSourceManifestRecord(agentId) {
  const sourcePath = getSourcePath(agentId);
  if (!sourcePath) {
    throw new Error(`Missing source asset for agent icon: ${agentId}`);
  }

  const provenance = SOURCE_PROVENANCE[agentId];
  if (!provenance) {
    throw new Error(`Missing source provenance for agent icon: ${agentId}`);
  }

  const record = {
    agentId,
    originalFilename: provenance.originalFilename,
    sourceFilename: path.basename(sourcePath),
    sourceType: path.extname(sourcePath).slice(1).toLowerCase(),
    sha256: hashSource(sourcePath),
    fallback: provenance.fallback,
  };
  if (provenance.exportMode) record.exportMode = provenance.exportMode;
  for (const field of [
    "upstreamPackage",
    "upstreamVersion",
    "license",
    "variant",
    "contrastTreatment",
  ]) {
    if (provenance[field]) record[field] = provenance[field];
  }
  if (provenance.archivedSources) {
    record.archivedSources = provenance.archivedSources.map((source) => {
      const archivedPath = path.join(SOURCE_DIR, source.sourceFilename);
      if (!fs.existsSync(archivedPath)) {
        throw new Error(`Missing archived source asset for agent icon: ${source.sourceFilename}`);
      }
      const archivedRecord = {
        originalFilename: source.originalFilename,
        sourceFilename: source.sourceFilename,
        sourceType: path.extname(archivedPath).slice(1).toLowerCase(),
        sha256: hashSource(archivedPath),
      };
      for (const field of ["upstreamPackage", "upstreamVersion", "license", "variant"]) {
        if (source[field]) archivedRecord[field] = source[field];
      }
      return archivedRecord;
    });
  }
  return record;
}

function updateSourceRecords(manifest, agents) {
  manifest.sources = {};
  for (const agent of agents) {
    manifest.sources[agent.id] = getSourceManifestRecord(agent.id);
  }
  return manifest;
}

function updateSourceManifest(manifest, agents) {
  updateSourceRecords(manifest, agents);
  updateSvgSourceHashes(manifest, agents);
  if (!manifest.outputs || typeof manifest.outputs !== "object") manifest.outputs = {};
  return manifest;
}

function getOutputManifestRecord(entry, manifest) {
  const sourceRecord = manifest.sources && manifest.sources[entry.agentId];
  if (!sourceRecord || typeof sourceRecord.sha256 !== "string") {
    throw new Error(`Missing source manifest record for generated icon: ${entry.agentId}`);
  }
  return {
    agentId: entry.agentId,
    outputFilename: `${entry.agentId}.png`,
    outputSha256: entry.outputSha256,
    generatedFromSourceSha256: sourceRecord.sha256,
  };
}

function updateOutputRecords(manifest, exported) {
  manifest.outputs = {};
  for (const entry of exported) {
    manifest.outputs[entry.agentId] = getOutputManifestRecord(entry, manifest);
  }
  return manifest;
}

function assertOutputManifestCurrent(entry, manifest) {
  const actual = manifest.outputs && manifest.outputs[entry.agentId];
  const expected = getOutputManifestRecord(entry, manifest);
  if (actual && isDeepStrictEqual(actual, expected)) return;

  throw new Error(
    [
      `Generated output manifest changed for ${entry.agentId}.`,
      "Review the exporter change and run: npm run export-agent-icons -- --accept-svg-sources",
    ].join(" ")
  );
}

function assertSourceManifestCurrent(agentId, manifest = readSourceManifest()) {
  const actual = manifest.sources && manifest.sources[agentId];
  const expected = getSourceManifestRecord(agentId);
  if (actual && isDeepStrictEqual(actual, expected)) return;

  throw new Error(
    [
      `Source manifest changed for ${agentId}.`,
      "Review the canonical source and run: npm run export-agent-icons -- --accept-svg-sources",
    ].join(" ")
  );
}

function assertRasterSourceCurrent(agentId, manifest = readSourceManifest()) {
  if (!hasRasterAndSvgSources(agentId)) return;

  const svgPath = getSourceCandidatePath(agentId, ".svg");
  const record = manifest.svgSources && manifest.svgSources[agentId];
  const expectedHash = record && typeof record.sha256 === "string" ? record.sha256 : null;
  if (!expectedHash) {
    throw new Error(
      [
        `Missing SVG source hash for ${agentId}.`,
        "After refreshing the same-name PNG source, run: npm run export-agent-icons -- --accept-svg-sources",
      ].join(" ")
    );
  }

  const actualHash = hashSvgSource(svgPath);
  if (actualHash.toLowerCase() === expectedHash.toLowerCase()) return;

  throw new Error(
    [
      `SVG source hash changed for ${agentId}.`,
      `Refresh the same-name PNG source from ${path.relative(process.cwd(), svgPath)}, then run: npm run export-agent-icons -- --accept-svg-sources`,
    ].join(" ")
  );
}

function getAlphaBounds(bitmap, width, height) {
  const expectedLength = width * height * BYTES_PER_PIXEL;
  if (!Buffer.isBuffer(bitmap) || bitmap.length < expectedLength) {
    throw new Error(`Invalid bitmap buffer for ${width}x${height} image`);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let hasTransparency = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = bitmap[(y * width + x) * BYTES_PER_PIXEL + ALPHA_CHANNEL_OFFSET];
      if (alpha < 255) hasTransparency = true;
      if (alpha === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return {
    hasTransparency,
    bounds: maxX < minX || maxY < minY
      ? null
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function calculateContainedSize(width, height, maximumSize = ARTWORK_SIZE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid artwork dimensions: ${width}x${height}`);
  }

  const scale = Math.min(maximumSize / width, maximumSize / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function centerOffset(containerSize, contentSize) {
  return Math.floor((containerSize - contentSize) / 2);
}

function prepareArtwork(image, maximumSize = ARTWORK_SIZE) {
  const sourceSize = image.getSize();
  const analysis = getAlphaBounds(image.toBitmap(), sourceSize.width, sourceSize.height);
  if (!analysis.bounds) {
    throw new Error("Agent icon source contains no visible pixels");
  }

  const sourceBounds = analysis.hasTransparency
    ? analysis.bounds
    : { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height };
  const cropped = analysis.hasTransparency ? image.crop(sourceBounds) : image;
  const targetSize = calculateContainedSize(sourceBounds.width, sourceBounds.height, maximumSize);
  const resized = targetSize.width === sourceBounds.width && targetSize.height === sourceBounds.height
    ? cropped
    : cropped.resize({ ...targetSize, quality: "best" });
  if (!resized || resized.isEmpty()) {
    throw new Error("Unable to resize agent icon artwork");
  }

  return { resized, sourceSize, sourceBounds, targetSize, hadTransparency: analysis.hasTransparency };
}

function fillRoundedContrastTile(canvas, treatment) {
  const color = CONTRAST_TILE_COLORS[treatment];
  if (!color) throw new Error(`Unsupported Agent icon contrast treatment: ${treatment}`);
  const offset = centerOffset(ICON_SIZE, CONTRAST_TILE_SIZE);
  const radius = CONTRAST_TILE_RADIUS;
  const last = CONTRAST_TILE_SIZE - 1;

  for (let y = 0; y < CONTRAST_TILE_SIZE; y += 1) {
    for (let x = 0; x < CONTRAST_TILE_SIZE; x += 1) {
      const nearestX = Math.max(radius - 0.5, Math.min(x + 0.5, last - radius + 0.5));
      const nearestY = Math.max(radius - 0.5, Math.min(y + 0.5, last - radius + 0.5));
      const distance = Math.hypot(x + 0.5 - nearestX, y + 0.5 - nearestY);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (coverage === 0) continue;

      const targetOffset = ((offset + y) * ICON_SIZE + offset + x) * BYTES_PER_PIXEL;
      canvas[targetOffset] = color[0];
      canvas[targetOffset + 1] = color[1];
      canvas[targetOffset + 2] = color[2];
      canvas[targetOffset + ALPHA_CHANNEL_OFFSET] = Math.round(color[3] * coverage);
    }
  }
}

function compositeBitmap(canvas, bitmap, targetSize, x, y) {
  for (let row = 0; row < targetSize.height; row += 1) {
    for (let column = 0; column < targetSize.width; column += 1) {
      const sourceOffset = (row * targetSize.width + column) * BYTES_PER_PIXEL;
      const targetOffset = ((y + row) * ICON_SIZE + x + column) * BYTES_PER_PIXEL;
      const sourceAlpha = bitmap[sourceOffset + ALPHA_CHANNEL_OFFSET] / 255;
      if (sourceAlpha === 0) continue;

      const targetAlpha = canvas[targetOffset + ALPHA_CHANNEL_OFFSET] / 255;
      const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < ALPHA_CHANNEL_OFFSET; channel += 1) {
        const sourceValue = bitmap[sourceOffset + channel];
        const targetValue = canvas[targetOffset + channel];
        canvas[targetOffset + channel] = Math.round(
          (sourceValue * sourceAlpha + targetValue * targetAlpha * (1 - sourceAlpha)) / outputAlpha
        );
      }
      canvas[targetOffset + ALPHA_CHANNEL_OFFSET] = Math.round(outputAlpha * 255);
    }
  }
}

function composeCenteredImage(image, targetSize, options = {}) {
  const bitmap = image.toBitmap();
  const expectedLength = targetSize.width * targetSize.height * BYTES_PER_PIXEL;
  if (bitmap.length < expectedLength) {
    throw new Error(`Invalid resized bitmap for ${targetSize.width}x${targetSize.height} image`);
  }

  const canvas = Buffer.alloc(ICON_SIZE * ICON_SIZE * BYTES_PER_PIXEL);
  const x = centerOffset(ICON_SIZE, targetSize.width);
  const y = centerOffset(ICON_SIZE, targetSize.height);
  if (options.contrastTreatment) fillRoundedContrastTile(canvas, options.contrastTreatment);
  compositeBitmap(canvas, bitmap, targetSize, x, y);

  const composed = nativeImage.createFromBitmap(canvas, {
    width: ICON_SIZE,
    height: ICON_SIZE,
    scaleFactor: 1,
  });
  if (!composed || composed.isEmpty()) {
    throw new Error("Unable to compose centered agent icon");
  }
  return { image: composed, offset: { x, y } };
}

function exportIcon(agentId, options = {}) {
  if (!nativeImage) {
    throw new Error("Run the Node entrypoint instead: node scripts/export-agent-icons.js");
  }

  const sourcePath = getSourcePath(agentId);
  if (!sourcePath) {
    throw new Error(`Missing source asset for agent icon: ${agentId}`);
  }
  assertSourceManifestCurrent(agentId, options.manifest);
  assertRasterSourceCurrent(agentId, options.manifest);

  const image = nativeImage.createFromPath(sourcePath);
  if (!image || image.isEmpty()) {
    throw new Error(`Unable to load agent icon source: ${sourcePath}`);
  }

  const outputDir = options.outputDir || OUTPUT_DIR;
  const outputPath = path.join(outputDir, `${agentId}.png`);
  const provenance = SOURCE_PROVENANCE[agentId];
  if (provenance.exportMode === "passthrough") {
    const outputBuffer = fs.readFileSync(sourcePath);
    if (!options.dryRun) {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, outputBuffer);
    }
    return {
      agentId,
      sourcePath,
      outputPath,
      outputSha256: hashBuffer(outputBuffer),
      exportMode: "passthrough",
    };
  }

  const artworkSize = provenance.contrastTreatment
    ? CONTRAST_TILE_ARTWORK_SIZE
    : ARTWORK_SIZE;
  const artwork = prepareArtwork(image, artworkSize);
  const composed = composeCenteredImage(artwork.resized, artwork.targetSize, provenance);
  const outputBuffer = composed.image.toPNG();

  if (!options.dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, outputBuffer);
  }

  return {
    agentId,
    sourcePath,
    outputPath,
    outputSha256: hashBuffer(outputBuffer),
    sourceSize: artwork.sourceSize,
    sourceBounds: artwork.sourceBounds,
    targetSize: artwork.targetSize,
    offset: composed.offset,
    hadTransparency: artwork.hadTransparency,
  };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const acceptSvgSources = process.argv.includes("--accept-svg-sources");
  const exported = [];
  const agents = getAllAgents();
  const manifest = readSourceManifest();
  let stagingDir = null;

  if (acceptSvgSources) {
    updateSourceManifest(manifest, agents);
  }

  try {
    if (!dryRun) stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-agent-icon-outputs-"));
    for (const agent of agents) {
      exported.push(exportIcon(agent.id, {
        dryRun,
        manifest,
        outputDir: stagingDir || OUTPUT_DIR,
      }));
    }

    if (acceptSvgSources) {
      updateOutputRecords(manifest, exported);
    } else {
      for (const entry of exported) assertOutputManifestCurrent(entry, manifest);
    }

    if (!dryRun) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      for (const entry of exported) {
        fs.copyFileSync(entry.outputPath, path.join(OUTPUT_DIR, `${entry.agentId}.png`));
      }
      if (acceptSvgSources) writeSourceManifest(manifest);
    }
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  for (const entry of exported) {
    const mode = dryRun ? "checked" : "exported";
    const finalOutputPath = path.join(OUTPUT_DIR, `${entry.agentId}.png`);
    console.log(`${mode} ${entry.agentId}: ${path.relative(process.cwd(), finalOutputPath)}`);
  }
}

function getElectronBinary() {
  try {
    const electronPath = require("electron");
    if (typeof electronPath === "string" && electronPath) return electronPath;
  } catch {}

  if (process.platform === "win32") {
    return path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
  }
  return path.join(__dirname, "..", "node_modules", ".bin", "electron");
}

function runInElectron() {
  const electronBin = getElectronBinary();
  if (!fs.existsSync(electronBin)) {
    throw new Error("Electron is not installed. Run npm install before exporting agent icons.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-agent-icons-"));
  const entryPath = path.join(tempDir, "main.js");
  const packagePath = path.join(tempDir, "package.json");

  fs.writeFileSync(packagePath, JSON.stringify({ main: "main.js" }));
  fs.writeFileSync(
    entryPath,
    [
      `"use strict";`,
      `process.env.${EXPORTER_ENV} = "1";`,
      `require(${JSON.stringify(__filename)});`,
      "",
    ].join("\n")
  );

  const result = spawnSync(electronBin, [tempDir, ...process.argv.slice(2)], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, [EXPORTER_ENV]: "1" },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

if (require.main === module) {
  try {
    runInElectron();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
} else if (process.env[EXPORTER_ENV] === "1") {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (app && typeof app.quit === "function") {
      app.quit();
    }
    process.exit(process.exitCode || 0);
  }
}

module.exports = {
  ICON_SIZE,
  ARTWORK_SIZE,
  CONTRAST_TILE_SIZE,
  CONTRAST_TILE_ARTWORK_SIZE,
  SOURCE_DIR,
  SOURCE_MANIFEST_PATH,
  OUTPUT_DIR,
  SOURCE_PROVENANCE,
  LOBE_ICONS_OFFICIAL_WEBSITE,
  getSourcePath,
  readSourceManifest,
  writeSourceManifest,
  normalizeTextLineEndings,
  hashSvgSource,
  hashFileSource,
  hashBuffer,
  hashSource,
  getElectronBinary,
  updateSvgSourceHashes,
  getSourceManifestRecord,
  updateSourceRecords,
  updateSourceManifest,
  getOutputManifestRecord,
  updateOutputRecords,
  assertOutputManifestCurrent,
  assertSourceManifestCurrent,
  assertRasterSourceCurrent,
  getAlphaBounds,
  calculateContainedSize,
  centerOffset,
  prepareArtwork,
  composeCenteredImage,
  exportIcon,
};
