"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const ADAPTER_VERSION = 6;
const MARKER_FILENAME = ".clawd-codex-pet.json";
const THEME_ID_PREFIX = "codex-pet-";
const DIRECTIONAL_DRAG_WRAPPER = "codex-pet-drag-directional-loop.svg";
const PNG_ALPHA_VALIDATION_SCHEMA_VERSION = 2;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

const DEFAULT_SPRITE_VERSION_NUMBER = 1;
const ATLAS_BY_SPRITE_VERSION = Object.freeze({
  1: Object.freeze({
    spriteVersionNumber: 1,
    width: 1536,
    height: 1872,
    columns: 8,
    rows: 9,
    frameWidth: 192,
    frameHeight: 208,
  }),
  2: Object.freeze({
    spriteVersionNumber: 2,
    width: 1536,
    height: 2288,
    columns: 8,
    rows: 11,
    frameWidth: 192,
    frameHeight: 208,
  }),
});

// Keep the historical export as the V1/default atlas for callers that do not
// need version-aware behavior.
const ATLAS = ATLAS_BY_SPRITE_VERSION[DEFAULT_SPRITE_VERSION_NUMBER];

// Mirrored from codex-pets-react/src/lib/atlas.ts at plan time on 2026-05-05.
// Upstream timing changes require manual review before this table is bumped.
const ATLAS_ROWS = [
  { key: "idle", row: 0, durations: [280, 110, 110, 140, 140, 320] },
  { key: "running-right", row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { key: "running-left", row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { key: "waving", row: 3, durations: [140, 140, 140, 280] },
  { key: "jumping", row: 4, durations: [140, 140, 140, 140, 280] },
  { key: "failed", row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { key: "waiting", row: 6, durations: [150, 150, 150, 150, 150, 260] },
  { key: "running", row: 7, durations: [120, 120, 120, 120, 120, 220] },
  { key: "review", row: 8, durations: [150, 150, 150, 150, 150, 280] },
];

const ROWS_BY_KEY = new Map(ATLAS_ROWS.map((row) => [row.key, row]));

const WRAPPER_SPECS = [
  { filename: "codex-pet-idle-loop.svg", visual: "idle-loop", rowKey: "idle", mode: "loop" },
  { filename: "codex-pet-idle-static.svg", visual: "idle-static", rowKey: "idle", mode: "static" },
  { filename: "codex-pet-waving-loop.svg", visual: "waving-loop", rowKey: "waving", mode: "loop" },
  { filename: "codex-pet-waving-once.svg", visual: "waving-once", rowKey: "waving", mode: "once" },
  { filename: "codex-pet-jumping-loop.svg", visual: "jumping-loop", rowKey: "jumping", mode: "loop" },
  { filename: "codex-pet-jumping-once.svg", visual: "jumping-once", rowKey: "jumping", mode: "once" },
  { filename: "codex-pet-failed-loop.svg", visual: "failed-loop", rowKey: "failed", mode: "loop" },
  { filename: "codex-pet-waiting-loop.svg", visual: "waiting-loop", rowKey: "waiting", mode: "loop" },
  { filename: "codex-pet-running-loop.svg", visual: "running-loop", rowKey: "running", mode: "loop" },
  { filename: "codex-pet-review-loop.svg", visual: "review-loop", rowKey: "review", mode: "loop" },
];

const DIRECTIONAL_DRAG_SPEC = Object.freeze({
  filename: DIRECTIONAL_DRAG_WRAPPER,
  visual: "drag-directional",
  rowKey: "running-right",
  mode: "loop",
});
const UNIVERSAL_VISUAL_SPECS = Object.freeze([
  ...WRAPPER_SPECS.map((spec) => Object.freeze({ ...spec })),
  DIRECTIONAL_DRAG_SPEC,
]);

function getDefaultCodexPetsDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", "pets");
}

function resolveSpriteVersion(manifest) {
  const raw = manifest && typeof manifest === "object"
    ? manifest.spriteVersionNumber
    : undefined;
  const spriteVersionNumber = raw === undefined ? DEFAULT_SPRITE_VERSION_NUMBER : raw;
  const atlas = ATLAS_BY_SPRITE_VERSION[spriteVersionNumber] || null;
  if (!Number.isInteger(spriteVersionNumber) || !atlas) {
    return {
      ok: false,
      error: "pet.json spriteVersionNumber must be 1 or 2",
      spriteVersionNumber: null,
      atlas: null,
    };
  }
  return { ok: true, spriteVersionNumber, atlas };
}

function scanCodexPetPackages(rootDir, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    return [{ ok: false, packageDir: rootDir, errors: [`failed to read pets directory: ${error.message}`] }];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = path.join(rootDir, entry.name);
      return validateCodexPetPackage(packageDir, {
        managedMarker: findManagedMarkerForPackage(options.managedMarkersByPackagePath, packageDir),
      });
    })
    .sort((a, b) => a.packageDir.localeCompare(b.packageDir, "en"));
}

function validateCodexPetPackage(packageDir, options = {}) {
  const errors = [];
  const warnings = [];
  const resolvedPackageDir = path.resolve(packageDir);
  const petJsonPath = path.join(resolvedPackageDir, "pet.json");
  const petJsonStat = safeStat(petJsonPath);
  let manifest = null;

  if (!petJsonStat || !petJsonStat.isFile()) {
    errors.push("missing pet.json");
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(petJsonPath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("pet.json must be a JSON object");
      } else {
        manifest = parsed;
      }
    } catch (error) {
      errors.push(`invalid pet.json: ${error.message}`);
    }
  }

  const id = typeof manifest?.id === "string" ? manifest.id.trim() : "";
  const displayName = clampText(
    typeof manifest?.displayName === "string" && manifest.displayName.trim()
      ? manifest.displayName
      : id,
    MAX_DISPLAY_NAME_LENGTH
  );
  const description = clampText(
    typeof manifest?.description === "string" ? manifest.description : "",
    MAX_DESCRIPTION_LENGTH
  );
  const spritesheetPath = typeof manifest?.spritesheetPath === "string" ? manifest.spritesheetPath.trim() : "";
  const spriteVersion = resolveSpriteVersion(manifest);

  if (manifest && !id) errors.push("pet.json id must be a non-empty string");
  if (manifest && !spritesheetPath) errors.push("pet.json spritesheetPath must be a non-empty string");
  if (manifest && !spriteVersion.ok) errors.push(spriteVersion.error);

  let normalizedSpritesheetPath = null;
  let spritesheetAbsPath = null;
  let spritesheetStat = null;
  let imageInfo = null;

  if (spritesheetPath) {
    const pathCheck = normalizePackageRelativePath(spritesheetPath, resolvedPackageDir);
    if (!pathCheck.ok) {
      errors.push(pathCheck.error);
    } else {
      normalizedSpritesheetPath = pathCheck.relativePath;
      spritesheetAbsPath = pathCheck.absolutePath;
      const ext = path.extname(normalizedSpritesheetPath).toLowerCase();
      if (ext !== ".webp" && ext !== ".png") {
        errors.push("spritesheetPath must point to .webp or .png");
      }
      spritesheetStat = safeStat(spritesheetAbsPath);
      if (!spritesheetStat || !spritesheetStat.isFile()) {
        errors.push(`spritesheet not found: ${normalizedSpritesheetPath}`);
      } else if (ext === ".png" || ext === ".webp") {
        const inspected = inspectSpritesheet(spritesheetAbsPath, ext, {
          atlas: spriteVersion.atlas,
          pngAlphaValidationCache: getPngAlphaValidationCache(options.managedMarker, {
            packageDir: resolvedPackageDir,
            spritesheetPath: normalizedSpritesheetPath,
            spritesheetStat,
            spriteVersionNumber: spriteVersion.spriteVersionNumber,
            atlas: spriteVersion.atlas,
          }),
        });
        imageInfo = inspected.info;
        errors.push(...inspected.errors);
        warnings.push(...inspected.warnings);
      }
    }
  }

  if (
    imageInfo
    && spriteVersion.atlas
    && (imageInfo.width !== spriteVersion.atlas.width || imageInfo.height !== spriteVersion.atlas.height)
  ) {
    errors.push(
      `spritesheet for spriteVersionNumber ${spriteVersion.spriteVersionNumber} must be `
      + `${spriteVersion.atlas.width}x${spriteVersion.atlas.height}, got ${imageInfo.width}x${imageInfo.height}`
    );
  }
  if (imageInfo && imageInfo.hasAlpha !== true) {
    errors.push("spritesheet must include an alpha channel");
  }

  const slug = derivePetSlug({ packageDir: resolvedPackageDir, id, displayName });
  const packageInfo = errors.length === 0 ? {
    packageDir: resolvedPackageDir,
    petJsonPath,
    id,
    displayName,
    description,
    slug,
    spritesheetPath: normalizedSpritesheetPath,
    spritesheetAbsPath,
    spritesheetAssetName: safeAssetBasename(normalizedSpritesheetPath),
    petJsonMtimeMs: petJsonStat.mtimeMs,
    petJsonSize: petJsonStat.size,
    spritesheetMtimeMs: spritesheetStat.mtimeMs,
    spritesheetSize: spritesheetStat.size,
    spriteVersionNumber: spriteVersion.spriteVersionNumber,
    atlas: spriteVersion.atlas,
    image: imageInfo,
    manifest,
  } : null;

  return { ok: errors.length === 0, packageDir: resolvedPackageDir, packageInfo, errors, warnings };
}

function materializeCodexPetTheme(packageInfo, userThemesDir, options = {}) {
  if (!packageInfo || typeof packageInfo !== "object") {
    throw new Error("packageInfo is required");
  }
  if (!userThemesDir) throw new Error("userThemesDir is required");

  const resolvedUserThemesDir = path.resolve(userThemesDir);
  fs.mkdirSync(resolvedUserThemesDir, { recursive: true });

  const themeId = options.themeId || resolveManagedThemeId(packageInfo, resolvedUserThemesDir);
  if (!isSafeThemeId(themeId)) throw new Error(`invalid generated theme id: ${themeId}`);

  const themeDir = path.resolve(resolvedUserThemesDir, themeId);
  if (!isPathInsideDir(resolvedUserThemesDir, themeDir)) {
    throw new Error(`generated theme path escapes user themes dir: ${themeId}`);
  }

  const existingMarker = readManagedMarker(themeDir);
  const recoverablePartial = !existingMarker && isRecoverablePartialThemeDir(themeDir, packageInfo);
  if (
    fs.existsSync(themeDir)
    && !recoverablePartial
    && (!existingMarker || !samePath(existingMarker.sourcePackagePath, packageInfo.packageDir))
  ) {
    throw new Error(`refusing to overwrite unmanaged or unrelated theme: ${themeId}`);
  }

  if (isMaterializedThemeUnchanged(existingMarker, packageInfo, themeId, themeDir)) {
    return { themeId, themeDir, marker: existingMarker, themeJson: null, operation: "unchanged" };
  }

  const operation = existingMarker && existingMarker.inProgress !== true ? "updated" : "created";
  const assetsDir = path.join(themeDir, "assets");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(
    path.join(themeDir, MARKER_FILENAME),
    `${JSON.stringify(buildMarker(packageInfo, themeId, { inProgress: true }), null, 2)}\n`,
    "utf8"
  );
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  fs.copyFileSync(packageInfo.spritesheetAbsPath, path.join(assetsDir, packageInfo.spritesheetAssetName));
  for (const spec of WRAPPER_SPECS) {
    const svg = generateUniversalWrapperSvg({
      initialFilename: spec.filename,
      spritesheetHref: packageInfo.spritesheetAssetName,
      atlas: packageInfo.atlas || ATLAS,
    });
    fs.writeFileSync(path.join(assetsDir, spec.filename), svg, "utf8");
  }
  fs.writeFileSync(
    path.join(assetsDir, DIRECTIONAL_DRAG_WRAPPER),
    generateDirectionalDragWrapperSvg({
      spritesheetHref: packageInfo.spritesheetAssetName,
      atlas: packageInfo.atlas || ATLAS,
    }),
    "utf8"
  );

  const themeJson = buildThemeJson(packageInfo, themeId);
  fs.writeFileSync(path.join(themeDir, "theme.json"), `${JSON.stringify(themeJson, null, 2)}\n`, "utf8");

  const marker = buildMarker(packageInfo, themeId);
  fs.writeFileSync(path.join(themeDir, MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  return { themeId, themeDir, marker, themeJson, operation };
}

function syncCodexPetThemes(options = {}) {
  const userThemesDir = options.userThemesDir || (options.userDataDir ? path.join(options.userDataDir, "themes") : null);
  if (!userThemesDir) throw new Error("syncCodexPetThemes requires userThemesDir or userDataDir");
  const codexPetsDir = options.codexPetsDir || getDefaultCodexPetsDir(options.homeDir || os.homedir());
  const scanned = scanCodexPetPackages(codexPetsDir, {
    managedMarkersByPackagePath: collectManagedMarkersByPackagePath(userThemesDir),
  });
  const summary = {
    codexPetsDir,
    userThemesDir,
    imported: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    removed: 0,
    activeOrphanThemeIds: [],
    themes: [],
    diagnostics: [],
  };

  for (const result of scanned) {
    if (!result.ok) {
      summary.invalid += 1;
      summary.diagnostics.push({ packageDir: result.packageDir, errors: result.errors });
      continue;
    }
    const materialized = materializeCodexPetTheme(result.packageInfo, userThemesDir);
    if (materialized.operation === "created") summary.imported += 1;
    else if (materialized.operation === "updated") summary.updated += 1;
    else if (materialized.operation === "unchanged") summary.unchanged += 1;
    summary.themes.push({
      packageDir: result.packageInfo.packageDir,
      themeId: materialized.themeId,
      operation: materialized.operation,
    });
  }

  const gc = removeOrphanManagedThemes(userThemesDir, { activeThemeId: options.activeThemeId });
  summary.removed += gc.removed;
  summary.activeOrphanThemeIds.push(...gc.activeOrphanThemeIds);
  summary.diagnostics.push(...gc.diagnostics);

  return summary;
}

function isMaterializedThemeUnchanged(marker, packageInfo, themeId, themeDir) {
  const atlas = packageInfo.atlas || ATLAS;
  if (!marker || marker.inProgress === true) return false;
  if (marker.adapterVersion !== ADAPTER_VERSION) return false;
  if (marker.generatedThemeId !== themeId) return false;
  if (!samePath(marker.sourcePackagePath, packageInfo.packageDir)) return false;
  if (marker.sourcePetId !== packageInfo.id) return false;
  if (marker.sourceSpriteVersionNumber !== packageInfo.spriteVersionNumber) return false;
  if (marker.sourceAtlasColumns !== atlas.columns) return false;
  if (marker.sourceAtlasRows !== atlas.rows) return false;
  if (marker.sourcePetJsonMtimeMs !== packageInfo.petJsonMtimeMs) return false;
  if (marker.sourcePetJsonSize !== packageInfo.petJsonSize) return false;
  if (marker.sourceSpritesheetPath !== packageInfo.spritesheetPath) return false;
  if (marker.sourceSpritesheetMtimeMs !== packageInfo.spritesheetMtimeMs) return false;
  if (marker.sourceSpritesheetSize !== packageInfo.spritesheetSize) return false;
  if (requiresPngAlphaValidationCache(packageInfo) && !isPngAlphaValidationCacheFresh(marker, packageInfo)) return false;
  if (!isRegularFile(path.join(themeDir, "theme.json"))) return false;

  const assetsDir = path.join(themeDir, "assets");
  const cachedSpritesheet = path.join(assetsDir, packageInfo.spritesheetAssetName);
  let cachedSpritesheetStat = null;
  try {
    cachedSpritesheetStat = fs.statSync(cachedSpritesheet);
  } catch {
    return false;
  }
  if (!cachedSpritesheetStat.isFile() || cachedSpritesheetStat.size !== packageInfo.spritesheetSize) return false;

  for (const spec of WRAPPER_SPECS) {
    if (!isRegularFile(path.join(assetsDir, spec.filename))) return false;
  }
  if (!isRegularFile(path.join(assetsDir, DIRECTIONAL_DRAG_WRAPPER))) return false;
  return true;
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function buildThemeJson(packageInfo, themeId) {
  const atlas = packageInfo.atlas || ATLAS;
  return {
    schemaVersion: 1,
    name: packageInfo.displayName || packageInfo.id,
    version: String(packageInfo.manifest.version || "1.0.0"),
    description: packageInfo.description,
    preview: "codex-pet-idle-loop.svg",
    viewBox: { x: 0, y: 0, width: atlas.frameWidth, height: atlas.frameHeight },
    layout: {
      contentBox: { x: 0, y: 0, width: atlas.frameWidth, height: atlas.frameHeight },
    },
    source: {
      type: "codex-pet",
      id: packageInfo.id,
      displayName: packageInfo.displayName,
      packagePath: packageInfo.packageDir,
      spritesheetPath: packageInfo.spritesheetPath,
      spriteVersionNumber: packageInfo.spriteVersionNumber || DEFAULT_SPRITE_VERSION_NUMBER,
      adapterVersion: ADAPTER_VERSION,
    },
    eyeTracking: {
      enabled: false,
      states: [],
    },
    rendering: {
      svgChannel: "object",
    },
    states: {
      idle: ["codex-pet-idle-loop.svg"],
      thinking: ["codex-pet-review-loop.svg"],
      working: ["codex-pet-running-loop.svg"],
      juggling: ["codex-pet-running-loop.svg"],
      sweeping: ["codex-pet-running-loop.svg"],
      carrying: ["codex-pet-running-loop.svg"],
      notification: ["codex-pet-waiting-loop.svg"],
      attention: ["codex-pet-jumping-loop.svg"],
      error: ["codex-pet-failed-loop.svg"],
      sleeping: ["codex-pet-idle-static.svg"],
    },
    sleepSequence: {
      mode: "direct",
    },
    workingTiers: [
      { minSessions: 1, file: "codex-pet-running-loop.svg" },
    ],
    jugglingTiers: [
      { minSessions: 1, file: "codex-pet-running-loop.svg" },
    ],
    hitBoxes: {
      default: { x: 0, y: 0, w: atlas.frameWidth, h: atlas.frameHeight },
      sleeping: { x: 0, y: 0, w: atlas.frameWidth, h: atlas.frameHeight },
      wide: { x: 0, y: 0, w: atlas.frameWidth, h: atlas.frameHeight },
    },
    reactions: {
      drag: {
        file: "codex-pet-running-loop.svg",
        fileLeft: DIRECTIONAL_DRAG_WRAPPER,
        fileRight: DIRECTIONAL_DRAG_WRAPPER,
      },
      clickLeft: { file: "codex-pet-jumping-once.svg", duration: 840 },
      clickRight: { file: "codex-pet-jumping-once.svg", duration: 840 },
      double: { files: ["codex-pet-waving-once.svg"], duration: 700 },
    },
    miniMode: {
      supported: false,
    },
  };
}

function buildMarker(packageInfo, themeId, options = {}) {
  const atlas = packageInfo.atlas || ATLAS;
  const marker = {
    managedBy: "clawd",
    kind: "codex-pet-theme",
    schemaVersion: 1,
    adapterVersion: ADAPTER_VERSION,
    generatedThemeId: themeId,
    sourcePetId: packageInfo.id,
    sourceSpriteVersionNumber: packageInfo.spriteVersionNumber || DEFAULT_SPRITE_VERSION_NUMBER,
    sourceAtlasColumns: atlas.columns,
    sourceAtlasRows: atlas.rows,
    sourcePackagePath: packageInfo.packageDir,
    sourcePetJsonMtimeMs: packageInfo.petJsonMtimeMs,
    sourcePetJsonSize: packageInfo.petJsonSize,
    sourceSpritesheetPath: packageInfo.spritesheetPath,
    sourceSpritesheetMtimeMs: packageInfo.spritesheetMtimeMs,
    sourceSpritesheetSize: packageInfo.spritesheetSize,
  };
  const pngAlphaValidation = buildPngAlphaValidationCache(packageInfo);
  if (pngAlphaValidation) marker.sourcePngAlphaValidation = pngAlphaValidation;
  if (options.inProgress === true) marker.inProgress = true;
  return marker;
}

function generateWrapperSvg({ rowKey, mode, spritesheetHref, atlas = ATLAS }) {
  const row = ROWS_BY_KEY.get(rowKey);
  if (!row) throw new Error(`unknown Codex Pet atlas row: ${rowKey}`);
  if (mode !== "loop" && mode !== "once" && mode !== "static") {
    throw new Error(`unknown wrapper mode: ${mode}`);
  }

  const escapedHref = escapeXmlAttr(spritesheetHref);
  const rowOffsetY = row.row * atlas.frameHeight;
  const animationName = `codex-pet-row-${row.key}-${mode}`;
  const initialTransform = formatTranslate(0, rowOffsetY);
  let style;

  if (mode === "static") {
    style = [
      ".atlas {",
      "  transform-box: fill-box;",
      "  transform-origin: 0 0;",
      `  transform: ${initialTransform};`,
      "  image-rendering: auto;",
      "}",
    ].join("\n");
  } else {
    const totalMs = row.durations.reduce((sum, duration) => sum + duration, 0);
    const frames = buildKeyframes(row, animationName, atlas);
    style = [
      frames,
      ".atlas {",
      "  transform-box: fill-box;",
      "  transform-origin: 0 0;",
      `  animation-name: ${animationName};`,
      `  animation-duration: ${totalMs}ms;`,
      "  animation-timing-function: step-end;",
      `  animation-iteration-count: ${mode === "loop" ? "infinite" : "1"};`,
      `  animation-fill-mode: ${mode === "loop" ? "none" : "forwards"};`,
      "  image-rendering: auto;",
      "}",
    ].join("\n");
  }

  return [
    `<!-- Generated by Clawd codex-pet-adapter v${ADAPTER_VERSION}: ${row.key} ${mode}. -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${atlas.frameWidth} ${atlas.frameHeight}" width="${atlas.frameWidth}" height="${atlas.frameHeight}">`,
    "  <defs>",
    "    <clipPath id=\"codex-pet-frame\">",
    `      <rect x="0" y="0" width="${atlas.frameWidth}" height="${atlas.frameHeight}"/>`,
    "    </clipPath>",
    "  </defs>",
    "  <style>",
    indent(style, 4),
    "  </style>",
    "  <g clip-path=\"url(#codex-pet-frame)\">",
    `    <image class="atlas" href="${escapedHref}" width="${atlas.width}" height="${atlas.height}" preserveAspectRatio="none"/>`,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

function assertDirectionalTimingParity(leftRow, rightRow) {
  const leftDurations = leftRow && leftRow.durations;
  const rightDurations = rightRow && rightRow.durations;
  if (!Array.isArray(leftDurations) || !Array.isArray(rightDurations)) {
    throw new Error("Codex Pet directional drag rows must define frame durations");
  }
  if (
    leftDurations.length !== rightDurations.length
    || leftDurations.some((duration, index) => duration !== rightDurations[index])
  ) {
    throw new Error("Codex Pet directional drag rows must use identical frame durations");
  }
  return true;
}

function getUniversalVisualSpec(filename) {
  return UNIVERSAL_VISUAL_SPECS.find((spec) => spec.filename === filename) || null;
}

function buildUniversalVisualStyle(initialSpec, atlas) {
  const initialRow = ROWS_BY_KEY.get(initialSpec.rowKey);
  const lines = [
    ".visual-row {",
    `  transform: ${formatTranslate(0, initialRow.row * atlas.frameHeight)};`,
    "}",
    ".atlas {",
    "  transform-box: fill-box;",
    "  transform-origin: 0 0;",
    "  transform: translate(0px, 0px);",
    "  animation-name: none;",
    "  animation-timing-function: step-end;",
    "  image-rendering: auto;",
    "}",
  ];

  for (const spec of UNIVERSAL_VISUAL_SPECS) {
    const row = ROWS_BY_KEY.get(spec.rowKey);
    const animationName = `codex-pet-visual-${spec.visual}`;
    const rowOffsetY = row.row * atlas.frameHeight;
    lines.push(
      `[data-clawd-codex-pet-visual=${spec.visual}] .visual-row {`,
      `  transform: ${formatTranslate(0, rowOffsetY)};`,
      "}"
    );
    if (spec.mode === "static") {
      lines.push(
        `[data-clawd-codex-pet-visual=${spec.visual}] .atlas {`,
        "  animation-name: none;",
        "}"
      );
      continue;
    }
    const totalMs = row.durations.reduce((sum, duration) => sum + duration, 0);
    lines.push(
      buildHorizontalKeyframes(row.durations, animationName, atlas),
      `[data-clawd-codex-pet-visual=${spec.visual}] .atlas {`,
      `  animation-name: ${animationName};`,
      `  animation-duration: ${totalMs}ms;`,
      `  animation-iteration-count: ${spec.mode === "loop" ? "infinite" : "1"};`,
      `  animation-fill-mode: ${spec.mode === "loop" ? "none" : "forwards"};`,
      "}"
    );
  }

  const leftRow = ROWS_BY_KEY.get("running-left");
  lines.push(
    "[data-clawd-codex-pet-visual=drag-directional][data-clawd-drag-direction=left] .visual-row {",
    `  transform: ${formatTranslate(0, leftRow.row * atlas.frameHeight)};`,
    "}"
  );
  return lines.join("\n");
}

function generateUniversalWrapperSvg({ initialFilename, spritesheetHref, atlas = ATLAS }) {
  const initialSpec = getUniversalVisualSpec(initialFilename);
  if (!initialSpec) throw new Error(`unknown Codex Pet wrapper file: ${initialFilename}`);
  assertDirectionalTimingParity(
    ROWS_BY_KEY.get("running-left"),
    ROWS_BY_KEY.get("running-right")
  );

  const escapedHref = escapeXmlAttr(spritesheetHref);
  const initialRow = ROWS_BY_KEY.get(initialSpec.rowKey);
  const initialOffsetY = initialRow.row * atlas.frameHeight;
  const style = buildUniversalVisualStyle(initialSpec, atlas);

  return [
    `<!-- Generated by Clawd codex-pet-adapter v${ADAPTER_VERSION}: universal visual bridge (${initialSpec.visual}). -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${atlas.frameWidth} ${atlas.frameHeight}" width="${atlas.frameWidth}" height="${atlas.frameHeight}" data-clawd-codex-pet-visuals="v1" data-clawd-codex-pet-visual="${initialSpec.visual}" data-clawd-drag-directional="v1" data-clawd-drag-direction="right">`,
    "  <defs>",
    "    <clipPath id=\"codex-pet-frame\">",
    `      <rect x="0" y="0" width="${atlas.frameWidth}" height="${atlas.frameHeight}"/>`,
    "    </clipPath>",
    "  </defs>",
    "  <style>",
    indent(style, 4),
    "  </style>",
    "  <g clip-path=\"url(#codex-pet-frame)\">",
    `    <g class="visual-row" transform="translate(0,-${initialOffsetY})">`,
    `      <image class="atlas" transform="translate(0,0)" href="${escapedHref}" width="${atlas.width}" height="${atlas.height}" preserveAspectRatio="none"/>`,
    "    </g>",
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

function generateDirectionalDragWrapperSvg({ spritesheetHref, atlas = ATLAS }) {
  return generateUniversalWrapperSvg({
    initialFilename: DIRECTIONAL_DRAG_WRAPPER,
    spritesheetHref,
    atlas,
  });
}

function buildKeyframes(row, animationName, atlas = ATLAS) {
  let elapsed = 0;
  const totalMs = row.durations.reduce((sum, duration) => sum + duration, 0);
  const lines = [`@keyframes ${animationName} {`];
  row.durations.forEach((duration, column) => {
    const pct = formatPercent((elapsed / totalMs) * 100);
    const x = column * atlas.frameWidth;
    const y = row.row * atlas.frameHeight;
    lines.push(`  ${pct}% { transform: ${formatTranslate(x, y)}; }`);
    elapsed += duration;
  });
  const finalColumn = row.durations.length - 1;
  lines.push(`  100% { transform: ${formatTranslate(finalColumn * atlas.frameWidth, row.row * atlas.frameHeight)}; }`);
  lines.push("}");
  return lines.join("\n");
}

function buildHorizontalKeyframes(durations, animationName, atlas = ATLAS) {
  let elapsed = 0;
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  const lines = [`@keyframes ${animationName} {`];
  durations.forEach((duration, column) => {
    const pct = formatPercent((elapsed / totalMs) * 100);
    lines.push(`  ${pct}% { transform: ${formatTranslate(column * atlas.frameWidth, 0)}; }`);
    elapsed += duration;
  });
  lines.push(`  100% { transform: ${formatTranslate((durations.length - 1) * atlas.frameWidth, 0)}; }`);
  lines.push("}");
  return lines.join("\n");
}

function inspectSpritesheet(filePath, ext, options = {}) {
  try {
    if (ext === ".png") return inspectPngSpritesheet(filePath, options);
    if (ext === ".webp") return inspectWebpSpritesheet(filePath);
  } catch (error) {
    return { info: null, errors: [`failed to inspect spritesheet: ${error.message}`], warnings: [] };
  }
  return { info: null, errors: ["unsupported spritesheet extension"], warnings: [] };
}

function inspectPngSpritesheet(filePath, options = {}) {
  const buffer = fs.readFileSync(filePath);
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(header)) {
    return { info: null, errors: ["spritesheet PNG has an invalid header"], warnings: [] };
  }

  let offset = 8;
  let info = null;
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) break;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      info = {
        format: "png",
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
        hasAlpha: data[9] === 4 || data[9] === 6,
      };
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!info) return { info: null, errors: ["spritesheet PNG is missing IHDR"], warnings: [] };

  const errors = [];
  const warnings = [];
  const atlas = options.atlas || null;
  if (atlas && info.width === atlas.width && info.height === atlas.height) {
    if (info.bitDepth !== 8 || info.colorType !== 6 || info.interlace !== 0) {
      warnings.push("PNG transparency validation only supports non-interlaced 8-bit RGBA atlases");
    } else if (isUsablePngAlphaValidationCache(options.pngAlphaValidationCache, atlas.spriteVersionNumber, atlas)) {
      info.checkedUnusedTransparency = true;
      info.checkedUnusedTransparencyCached = true;
    } else {
      const alphaErrors = validatePngAtlasAlpha(idatChunks, info, atlas);
      errors.push(...alphaErrors);
      info.checkedUnusedTransparency = alphaErrors.length === 0;
    }
  }
  return { info, errors, warnings };
}

function validatePngAtlasAlpha(idatChunks, info, atlas) {
  const bytesPerPixel = 4;
  const stride = info.width * bytesPerPixel;
  const expectedLength = info.height * (1 + stride);
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks), {
    maxOutputLength: expectedLength,
  });
  if (inflated.length < expectedLength) return ["PNG image data is shorter than expected"];

  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);
  // V2 preserves the nine action rows and appends two fully populated rows
  // containing the 16 clockwise gaze directions. Clawd does not consume those
  // gaze frames yet, so their pixels are permitted but the rows may be empty.
  const usedColumnsByRow = ATLAS_ROWS.map((row) => row.durations.length);
  while (usedColumnsByRow.length < atlas.rows) usedColumnsByRow.push(atlas.columns);
  const usedVisible = new Array(atlas.rows).fill(false);

  for (let y = 0; y < info.height; y += 1) {
    const rowStart = y * (1 + stride);
    const filter = inflated[rowStart];
    const scanline = inflated.subarray(rowStart + 1, rowStart + 1 + stride);
    unfilterPngScanline(filter, scanline, previous, current, bytesPerPixel);

    const atlasRow = Math.floor(y / atlas.frameHeight);
    const usedColumns = usedColumnsByRow[atlasRow];
    for (let x = 0; x < info.width; x += 1) {
      const column = Math.floor(x / atlas.frameWidth);
      const alpha = current[x * 4 + 3];
      if (column < usedColumns) {
        if (alpha !== 0) usedVisible[atlasRow] = true;
      } else if (alpha !== 0) {
        return [`unused atlas cell row ${atlasRow} column ${column} must be transparent`];
      }
    }

    const temp = previous;
    previous = current;
    current = temp;
  }

  const emptyRow = usedVisible.slice(0, ATLAS_ROWS.length).findIndex((visible) => !visible);
  if (emptyRow >= 0) return [`atlas row ${emptyRow} has no visible pixels in active cells`];
  return [];
}

function collectManagedMarkersByPackagePath(userThemesDir) {
  const markers = new Map();
  if (!userThemesDir || !fs.existsSync(userThemesDir)) return markers;

  let entries;
  try {
    entries = fs.readdirSync(userThemesDir, { withFileTypes: true });
  } catch {
    return markers;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const marker = readManagedMarker(path.join(userThemesDir, entry.name));
    if (!marker || marker.adapterVersion !== ADAPTER_VERSION || typeof marker.sourcePackagePath !== "string") continue;
    markers.set(pathKey(marker.sourcePackagePath), marker);
  }
  return markers;
}

function findManagedMarkerForPackage(markersByPackagePath, packageDir) {
  if (!markersByPackagePath || typeof markersByPackagePath.get !== "function") return null;
  return markersByPackagePath.get(pathKey(packageDir)) || null;
}

function getPngAlphaValidationCache(
  marker,
  { packageDir, spritesheetPath, spritesheetStat, spriteVersionNumber, atlas }
) {
  if (!marker || !spritesheetStat || !atlas) return null;
  if (!samePath(marker.sourcePackagePath, packageDir)) return null;
  if (marker.sourceSpriteVersionNumber !== spriteVersionNumber) return null;
  if (marker.sourceSpritesheetPath !== spritesheetPath) return null;
  if (marker.sourceSpritesheetMtimeMs !== spritesheetStat.mtimeMs) return null;
  if (marker.sourceSpritesheetSize !== spritesheetStat.size) return null;
  if (!isUsablePngAlphaValidationCache(marker.sourcePngAlphaValidation, spriteVersionNumber, atlas)) return null;
  if (marker.sourcePngAlphaValidation.spritesheetMtimeMs !== spritesheetStat.mtimeMs) return null;
  if (marker.sourcePngAlphaValidation.spritesheetSize !== spritesheetStat.size) return null;
  return marker.sourcePngAlphaValidation;
}

function buildPngAlphaValidationCache(packageInfo) {
  if (!requiresPngAlphaValidationCache(packageInfo)) return null;
  return {
    schemaVersion: PNG_ALPHA_VALIDATION_SCHEMA_VERSION,
    spriteVersionNumber: packageInfo.spriteVersionNumber,
    atlasWidth: packageInfo.atlas.width,
    atlasHeight: packageInfo.atlas.height,
    spritesheetMtimeMs: packageInfo.spritesheetMtimeMs,
    spritesheetSize: packageInfo.spritesheetSize,
    checkedUnusedTransparency: true,
  };
}

function requiresPngAlphaValidationCache(packageInfo) {
  return !!(
    packageInfo
    && packageInfo.image
    && packageInfo.image.format === "png"
    && packageInfo.image.checkedUnusedTransparency === true
  );
}

function isPngAlphaValidationCacheFresh(marker, packageInfo) {
  if (!marker || !packageInfo) return false;
  const cache = marker.sourcePngAlphaValidation;
  return !!(
    isUsablePngAlphaValidationCache(cache, packageInfo.spriteVersionNumber, packageInfo.atlas)
    && cache.spritesheetMtimeMs === packageInfo.spritesheetMtimeMs
    && cache.spritesheetSize === packageInfo.spritesheetSize
  );
}

function isUsablePngAlphaValidationCache(cache, spriteVersionNumber, atlas) {
  return !!(
    cache
    && cache.schemaVersion === PNG_ALPHA_VALIDATION_SCHEMA_VERSION
    && cache.spriteVersionNumber === spriteVersionNumber
    && atlas
    && cache.atlasWidth === atlas.width
    && cache.atlasHeight === atlas.height
    && cache.checkedUnusedTransparency === true
    && Number.isFinite(cache.spritesheetMtimeMs)
    && Number.isFinite(cache.spritesheetSize)
  );
}

function unfilterPngScanline(filter, scanline, previous, out, bytesPerPixel) {
  for (let i = 0; i < scanline.length; i += 1) {
    const raw = scanline[i];
    const left = i >= bytesPerPixel ? out[i - bytesPerPixel] : 0;
    const up = previous[i] || 0;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] || 0 : 0;
    let value;
    if (filter === 0) value = raw;
    else if (filter === 1) value = raw + left;
    else if (filter === 2) value = raw + up;
    else if (filter === 3) value = raw + Math.floor((left + up) / 2);
    else if (filter === 4) value = raw + paeth(left, up, upLeft);
    else throw new Error(`unsupported PNG filter type ${filter}`);
    out[i] = value & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function inspectWebpSpritesheet(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 16 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return { info: null, errors: ["spritesheet WebP has an invalid RIFF/WEBP header"], warnings: [] };
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "VP8X" && data.length >= 10) {
      return {
        info: {
          format: "webp",
          encoding: "VP8X",
          width: 1 + readUint24LE(data, 4),
          height: 1 + readUint24LE(data, 7),
          hasAlpha: !!(data[0] & 0x10),
        },
        errors: [],
        warnings: [],
      };
    }
    if (type === "VP8L" && data.length >= 5 && data[0] === 0x2f) {
      const bits = data.readUInt32LE(1);
      return {
        info: {
          format: "webp",
          encoding: "VP8L",
          width: 1 + (bits & 0x3fff),
          height: 1 + ((bits >> 14) & 0x3fff),
          hasAlpha: true,
        },
        errors: [],
        warnings: [],
      };
    }
    if (type === "VP8 " && data.length >= 10) {
      if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
        return { info: null, errors: ["spritesheet WebP VP8 frame header is invalid"], warnings: [] };
      }
      return {
        info: {
          format: "webp",
          encoding: "VP8",
          width: data.readUInt16LE(6) & 0x3fff,
          height: data.readUInt16LE(8) & 0x3fff,
          hasAlpha: false,
        },
        errors: ["spritesheet WebP must include an alpha channel"],
        warnings: [],
      };
    }
    offset = dataEnd + (length % 2);
  }

  return { info: null, errors: ["spritesheet WebP is missing a VP8/VP8L/VP8X image chunk"], warnings: [] };
}

function normalizePackageRelativePath(value, packageDir) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return { ok: false, error: "spritesheetPath must be relative" };
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return { ok: false, error: "spritesheetPath must be relative" };
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    return { ok: false, error: "spritesheetPath must not contain traversal segments" };
  }
  const absolutePath = path.resolve(packageDir, normalized);
  if (!isPathInsideDir(packageDir, absolutePath)) {
    return { ok: false, error: "spritesheetPath must stay inside the package directory" };
  }
  const relativePath = path.relative(packageDir, absolutePath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..")) {
    return { ok: false, error: "spritesheetPath must stay inside the package directory" };
  }
  return { ok: true, relativePath, absolutePath };
}

function removeOrphanManagedThemes(userThemesDir, options = {}) {
  const summary = { removed: 0, activeOrphanThemeIds: [], diagnostics: [] };
  if (!userThemesDir || !fs.existsSync(userThemesDir)) return summary;

  let entries;
  try {
    entries = fs.readdirSync(userThemesDir, { withFileTypes: true });
  } catch (error) {
    summary.diagnostics.push({ themeDir: userThemesDir, errors: [`failed to read user themes: ${error.message}`] });
    return summary;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const themeDir = path.join(userThemesDir, entry.name);
    const marker = readManagedMarker(themeDir);
    if (!marker) continue;
    if (fs.existsSync(marker.sourcePackagePath)) continue;

    if (options.activeThemeId && options.activeThemeId === entry.name) {
      summary.activeOrphanThemeIds.push(entry.name);
      summary.diagnostics.push({
        themeId: entry.name,
        themeDir,
        errors: ["managed Codex Pet source package is missing but theme is active"],
      });
      continue;
    }

    try {
      fs.rmSync(themeDir, { recursive: true, force: true });
      summary.removed += 1;
    } catch (error) {
      summary.diagnostics.push({
        themeId: entry.name,
        themeDir,
        errors: [`failed to remove orphan managed Codex Pet theme: ${error.message}`],
      });
    }
  }

  return summary;
}

function derivePetSlug({ packageDir, id, displayName }) {
  // Theme ids stay ASCII-safe even when the installed package folder preserves Unicode.
  const folder = path.basename(packageDir || "");
  if (isSafeSlug(folder)) return folder;
  const fromId = slugifyAscii(id);
  if (fromId) return fromId;
  const fromName = slugifyAscii(displayName);
  if (fromName) return fromName;
  const hash = crypto.createHash("sha1").update(`${packageDir}|${id}|${displayName}`).digest("hex").slice(0, 8);
  return `pet-${hash}`;
}

function resolveManagedThemeId(packageInfo, userThemesDir) {
  const baseId = `${THEME_ID_PREFIX}${packageInfo.slug}`;
  for (let i = 1; i < 1000; i += 1) {
    const themeId = i === 1 ? baseId : `${baseId}-${i}`;
    const themeDir = path.join(userThemesDir, themeId);
    if (!fs.existsSync(themeDir)) return themeId;
    const marker = readManagedMarker(themeDir);
    if (marker && samePath(marker.sourcePackagePath, packageInfo.packageDir)) return themeId;
    if (!marker && isRecoverablePartialThemeDir(themeDir, packageInfo)) return themeId;
  }
  throw new Error(`could not allocate generated Codex Pet theme id for ${packageInfo.packageDir}`);
}

function isRecoverablePartialThemeDir(themeDir, packageInfo) {
  if (!fs.existsSync(themeDir)) return false;
  const themeId = path.basename(themeDir);
  const baseId = `${THEME_ID_PREFIX}${packageInfo.slug}`;
  if (themeId !== baseId && !themeId.startsWith(`${baseId}-`)) return false;

  const themeJsonPath = path.join(themeDir, "theme.json");
  if (!fs.existsSync(themeJsonPath)) return true;

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(themeJsonPath, "utf8"));
  } catch {
    return false;
  }

  return !!(
    raw.source
    && raw.source.type === "codex-pet"
    && typeof raw.source.packagePath === "string"
    && samePath(raw.source.packagePath, packageInfo.packageDir)
  );
}

function readManagedMarker(themeDir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(themeDir, MARKER_FILENAME), "utf8"));
    if (
      marker
      && marker.managedBy === "clawd"
      && marker.kind === "codex-pet-theme"
      && marker.schemaVersion === 1
      && typeof marker.generatedThemeId === "string"
      && typeof marker.sourcePackagePath === "string"
    ) {
      return marker;
    }
  } catch {}
  return null;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeAssetBasename(relativePath) {
  const basename = path.posix.basename(relativePath.replace(/\\/g, "/"));
  return basename || "spritesheet.png";
}

function isSafeThemeId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isSafeSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function slugifyAscii(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function clampText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function isPathInsideDir(baseDir, candidatePath) {
  if (!baseDir || !candidatePath) return false;
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  const firstSegment = relative.split(/[\\/]/)[0];
  return relative === "" || (!!relative && firstSegment !== ".." && !path.isAbsolute(relative));
}

function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readUint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function formatPercent(value) {
  return Number(value.toFixed(6)).toString();
}

function formatTranslate(x, y) {
  const tx = x === 0 ? "0" : `-${x}`;
  const ty = y === 0 ? "0" : `-${y}`;
  return `translate(${tx}px, ${ty}px)`;
}

function indent(text, spaces) {
  const prefix = " ".repeat(spaces);
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  ADAPTER_VERSION,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  DEFAULT_SPRITE_VERSION_NUMBER,
  ATLAS,
  ATLAS_BY_SPRITE_VERSION,
  ATLAS_ROWS,
  WRAPPER_SPECS,
  DIRECTIONAL_DRAG_SPEC,
  DIRECTIONAL_DRAG_WRAPPER,
  MARKER_FILENAME,
  getDefaultCodexPetsDir,
  resolveSpriteVersion,
  scanCodexPetPackages,
  validateCodexPetPackage,
  materializeCodexPetTheme,
  syncCodexPetThemes,
  buildThemeJson,
  generateWrapperSvg,
  generateUniversalWrapperSvg,
  generateDirectionalDragWrapperSvg,
  assertDirectionalTimingParity,
  derivePetSlug,
  resolveManagedThemeId,
  readManagedMarker,
};
