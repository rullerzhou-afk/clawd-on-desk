"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REVIEWED_PATH_EXPORTS = Object.freeze([
  "PATH",
  "XDG_DATA_DIRS",
  "LD_LIBRARY_PATH",
  "GSETTINGS_SCHEMA_DIR",
]);

const APPDIR_SENTINEL = "/__clawd_verified_appdir__";
const INHERITED_SENTINEL = "/__clawd_inherited_one__:/__clawd_inherited_two__";
const SQUASHFS_MAGIC = Buffer.from("hsqs", "ascii");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function parseTopLevelExports(content) {
  const exports = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^[ \t]*export(?:[ \t]|$)/.test(line)) {
      continue;
    }

    if (!line.startsWith("export ")) {
      throw new Error(`unsupported export syntax at AppRun line ${index + 1}`);
    }

    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`unsupported top-level export syntax at AppRun line ${index + 1}`);
    }
    exports.push({
      name: match[1],
      rhs: match[2],
      line: index + 1,
    });
  }

  return exports;
}

function assertSafePathList(value, label) {
  const parts = value.split(":");
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`${label} produces an empty search-path element: ${JSON.stringify(value)}`);
  }
  for (const part of parts) {
    if (!path.posix.isAbsolute(part)) {
      throw new Error(`${label} produces a non-absolute search-path element: ${JSON.stringify(part)}`);
    }
  }
}

function evaluateReviewedRightHandSide(rhs, variableName, inheritedValue) {
  if (rhs.length < 2 || !rhs.startsWith('"') || !rhs.endsWith('"')) {
    throw new Error(`${variableName} must use one double-quoted right-hand side`);
  }

  const source = rhs.slice(1, -1);
  const appDirToken = "${APPDIR}";
  const inheritedToken = "${" + variableName + ":+:${" + variableName + "}}";
  let output = "";

  for (let index = 0; index < source.length; ) {
    if (source.startsWith(appDirToken, index)) {
      output += APPDIR_SENTINEL;
      index += appDirToken.length;
      continue;
    }
    if (source.startsWith(inheritedToken, index)) {
      if (inheritedValue) {
        output += `:${inheritedValue}`;
      }
      index += inheritedToken.length;
      continue;
    }

    const character = source[index];
    if (character === "$" || !/[A-Za-z0-9_./:+-]/.test(character)) {
      throw new Error(
        `${variableName} contains unreviewed shell syntax at offset ${index}: ${JSON.stringify(source.slice(index))}`
      );
    }
    output += character;
    index += 1;
  }

  assertSafePathList(output, variableName);
  return output;
}

function validateAppRunContent(content) {
  const exports = parseTopLevelExports(content);
  const results = {};

  for (const variableName of REVIEWED_PATH_EXPORTS) {
    const matches = exports.filter((entry) => entry.name === variableName);
    if (matches.length !== 1) {
      throw new Error(
        `${variableName} must have exactly one top-level export assignment, found ${matches.length}`
      );
    }

    const entry = matches[0];
    results[variableName] = {
      statement: `export ${entry.name}=${entry.rhs}`,
      line: entry.line,
      inheritedUnset: evaluateReviewedRightHandSide(entry.rhs, variableName, ""),
      inheritedSet: evaluateReviewedRightHandSide(entry.rhs, variableName, INHERITED_SENTINEL),
    };
  }

  const actualExports = exports.map((entry) => entry.name).sort();
  const expectedExports = [...REVIEWED_PATH_EXPORTS].sort();
  if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
    throw new Error(
      `top-level exports changed; expected ${expectedExports.join(", ")}, got ${actualExports.join(", ") || "none"}`
    );
  }

  return results;
}

function findSquashfsOffsets(artifactPath) {
  const data = fs.readFileSync(artifactPath);
  const offsets = [];
  let offset = data.indexOf(SQUASHFS_MAGIC);
  while (offset !== -1) {
    offsets.push(offset);
    offset = data.indexOf(SQUASHFS_MAGIC, offset + 1);
  }
  return offsets;
}

function extractWithUnsquashfs(artifactPath, tempDir) {
  const offsets = findSquashfsOffsets(artifactPath);
  const errors = [];

  for (const offset of offsets) {
    const outputDir = path.join(tempDir, `unsquashfs-${offset}`);
    const result = spawnSync(
      "unsquashfs",
      ["-o", String(offset), "-d", outputDir, artifactPath, "AppRun"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    const appRunPath = path.join(outputDir, "AppRun");
    if (result.status === 0 && fs.existsSync(appRunPath)) {
      return {
        content: fs.readFileSync(appRunPath, "utf8"),
        method: `unsquashfs-offset-${offset}`,
      };
    }
    errors.push(result.error ? result.error.message : (result.stderr || `exit ${result.status}`).trim());
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  throw new Error(
    `unsquashfs could not extract AppRun from ${offsets.length} SquashFS candidate(s): ${errors.filter(Boolean).join("; ") || "no SquashFS magic found"}`
  );
}

function extractAppRun(artifactPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-apprun-"));
  try {
    const runtimeResult = spawnSync(
      artifactPath,
      ["--appimage-extract", "AppRun"],
      { cwd: tempDir, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    const runtimeExtractedPath = path.join(tempDir, "squashfs-root", "AppRun");
    if (runtimeResult.status === 0 && fs.existsSync(runtimeExtractedPath)) {
      return {
        content: fs.readFileSync(runtimeExtractedPath, "utf8"),
        method: "appimage-runtime-extract",
      };
    }

    try {
      return extractWithUnsquashfs(artifactPath, tempDir);
    } catch (fallbackError) {
      const runtimeError = runtimeResult.error
        ? runtimeResult.error.message
        : (runtimeResult.stderr || `exit ${runtimeResult.status}`).trim();
      throw new Error(
        `AppImage runtime extraction failed (${runtimeError || "unknown error"}); ${fallbackError.message}`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.artifact) {
    throw new Error("usage: verify-appimage-apprun.js --artifact <file.AppImage> [--output <manifest.json>]");
  }
  return options;
}

function verifyArtifact(artifactPath) {
  const resolvedArtifact = path.resolve(artifactPath);
  const stat = fs.statSync(resolvedArtifact);
  if (!stat.isFile()) {
    throw new Error(`AppImage artifact is not a file: ${resolvedArtifact}`);
  }

  const extracted = extractAppRun(resolvedArtifact);
  const exports = validateAppRunContent(extracted.content);
  return {
    schemaVersion: 1,
    artifact: resolvedArtifact,
    artifactSha256: sha256File(resolvedArtifact),
    appRunSha256: sha256Text(extracted.content),
    extractionMethod: extracted.method,
    reviewedPathExports: exports,
  };
}

function main(argv) {
  const options = parseArguments(argv);
  const manifest = verifyArtifact(options.artifact);
  const output = `${JSON.stringify(manifest, null, 2)}\n`;

  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
  }
  process.stdout.write(output);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`AppRun verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  REVIEWED_PATH_EXPORTS,
  evaluateReviewedRightHandSide,
  parseTopLevelExports,
  validateAppRunContent,
  verifyArtifact,
};
