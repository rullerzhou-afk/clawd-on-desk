#!/usr/bin/env node
"use strict";

// Verifies that a release can produce a correct WinGet manifest.
//
// Why this needs a dedicated gate: electron-builder emits a 32-bit x86 NSIS
// stub for BOTH the x64 and the arm64 target, so PE-header inspection labels
// both installers x86. Komac resolves architecture from the URL and lets that
// value override whatever the binary analyzer derived, so the filename is the
// only correct signal we ship. That makes `build.win.artifactName` a published
// contract: drop the ${arch} token and every WinGet user silently receives the
// wrong installer.
//
// SCOPE — this checks komac's INPUT, not its output. `komac update` reads the
// previous manifest and emits one installer per PREVIOUS entry, matching each to
// the best new installer (Komac src/match_installers.rs). A correct set of input
// URLs therefore does NOT guarantee a correct manifest: if the previous manifest
// is malformed, komac faithfully reproduces its shape. Validating the generated
// YAML is a separate step; see docs/project/release-process.md.
//
// The URL algorithm below is ported from winget-types `Architecture::from_url`
// (russellbanks/winget-types, src/manifests/installer/architecture.rs).

const fs = require("node:fs");
const path = require("node:path");

const pkg = require("../package.json");

// winget-types: const DELIMITERS: [u8; 8]
const DELIMITERS = new Set([",", "/", "\\", ".", "_", "-", "(", ")"]);

// winget-types: const ARCHITECTURES: [(&str, Architecture); 32]
// Order is preserved from the source; the resolver is order-independent but a
// faithful copy keeps future diffs against upstream readable.
const ARCHITECTURES = [
  ["x86-64", "x64"],
  ["x86_64", "x64"],
  ["x64", "x64"],
  ["64-bit", "x64"],
  ["64bit", "x64"],
  ["win64a", "arm64"],
  ["win64", "x64"],
  ["winx64", "x64"],
  ["ia64", "x64"],
  ["amd64", "x64"],
  ["x86", "x86"],
  ["x32", "x86"],
  ["32-bit", "x86"],
  ["32bit", "x86"],
  ["win32", "x86"],
  ["winx86", "x86"],
  ["ia32", "x86"],
  ["i386", "x86"],
  ["i486", "x86"],
  ["i586", "x86"],
  ["i686", "x86"],
  ["386", "x86"],
  ["486", "x86"],
  ["586", "x86"],
  ["686", "x86"],
  ["arm64ec", "arm64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
  ["arm", "arm"],
  ["armv7", "arm"],
  ["aarch", "arm"],
  ["neutral", "neutral"],
];

// electron-builder arch id -> WinGet architecture.
const BUILDER_ARCH_TO_WINGET = {
  x64: "x64",
  arm64: "arm64",
  ia32: "x86",
  armv7l: "arm",
};

const TARGET_EXTENSION = { nsis: "exe" };

// winget-types: is_delimited_at.
//
// Upstream's `start` is a `usize`, so `start - 1` at index 0 is a wrapping
// underflow rather than a bounds check: in a release build it wraps to
// `usize::MAX`, `get` returns `None`, and the match is rejected — which is what
// the `start === 0` branch below reproduces. (A debug build panics instead; no
// JS port can mirror that, and it is not what ships.) Unreachable here either
// way, since every URL we build starts with `https://`.
function isDelimitedAt(url, start, length) {
  if (start === 0) return false;
  const before = url[start - 1];
  const after = url[start + length];
  if (before === undefined || after === undefined) return false;
  return DELIMITERS.has(before) && DELIMITERS.has(after);
}

// winget-types: `url.rmatch_indices(name).find(properly delimited)` — the
// rightmost delimited occurrence of `name`, or -1.
function rightmostDelimitedIndex(url, name) {
  let from = url.length;
  for (;;) {
    const index = url.lastIndexOf(name, from);
    if (index === -1) return -1;
    if (isDelimitedAt(url, index, name.length)) return index;
    if (index === 0) return -1;
    from = index - 1;
  }
}

// Primary pass of winget-types `Architecture::from_url`: among all delimited
// matches, prefer the one furthest right, then the longest name.
//
// Upstream uses `max_by_key`, which keeps the LAST maximum; the comparison
// below keeps the FIRST. The two can only disagree on a tie of both index and
// name length, which requires two distinct names to be the same substring at
// the same offset — impossible, and the table has no duplicate names.
//
// NOT A GENERAL `from_url` PORT. Upstream has a second pass that resolves
// `{arch}.{ext}` with no left delimiter (`installerx64.exe` -> x64); it is
// deliberately omitted, so this function returns null on names upstream would
// resolve. That narrowing is what makes the contract below strictly stronger
// than upstream — requiring a primary-pass match rejects names that only the
// fallback could rescue — but it means the function must not be reused as a
// drop-in `Architecture::from_url`.
function resolveArchitecture(rawUrl) {
  const url = String(rawUrl).toLowerCase();
  let best = null;
  for (const [name, architecture] of ARCHITECTURES) {
    const index = rightmostDelimitedIndex(url, name);
    if (index === -1) continue;
    if (
      best === null ||
      index > best.index ||
      (index === best.index && name.length > best.name.length)
    ) {
      best = { name, architecture, index };
    }
  }
  return best
    ? { architecture: best.architecture, matched: best.name, index: best.index }
    : { architecture: null, matched: null, index: -1 };
}

function readWindowsBuildConfig(config = pkg) {
  const build = config.build || {};
  const win = build.win || {};
  const publish = Array.isArray(build.publish) ? build.publish[0] : build.publish;
  const targets = Array.isArray(win.target) ? win.target : [];
  const entries = [];
  const implicitArchTargets = [];

  for (const target of targets) {
    const name = typeof target === "string" ? target : target && target.target;
    if (!name) continue;
    const arches = typeof target === "string" || !Array.isArray(target.arch) ? null : target.arch;
    // A bare string target ("nsis") or a missing arch list leaves the built
    // architecture up to electron-builder's default, which never reaches the
    // filename — so WinGet would have nothing to resolve.
    if (arches === null || arches.length === 0) {
      implicitArchTargets.push(name);
      continue;
    }
    for (const arch of arches) entries.push({ target: name, arch });
  }

  return {
    version: config.version || "",
    artifactName: win.artifactName || "",
    owner: (publish && publish.owner) || "",
    repo: (publish && publish.repo) || "",
    entries,
    implicitArchTargets,
  };
}

function materializeName(template, { version, arch, ext }) {
  return template
    .replace(/\$\{version\}/g, version)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{ext\}/g, ext);
}

function downloadUrl({ owner, repo, version, filename }) {
  return `https://github.com/${owner}/${repo}/releases/download/v${version}/${filename}`;
}

// GitHub reports release asset digests as `sha256:<64 lowercase hex>`. Anything
// else is not a digest we can pin content with, and an unvalidated string would
// satisfy the distinctness check with two arbitrary values.
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Accepts the `gh release view --json assets` payload, either bare or wrapped.
function normalizeAssets(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.assets) ? raw.assets : null;
  if (!list) throw new Error("assets file must be a JSON array or {assets: [...]}");
  return list.map((asset, index) => {
    if (!asset || typeof asset !== "object") {
      throw new Error(`assets[${index}] is not an object`);
    }
    return {
      name: String(asset.name || ""),
      digest: asset.digest ? String(asset.digest) : "",
      size: Number.isFinite(asset.size) ? asset.size : null,
    };
  });
}

function verifyWingetArchContract({
  config = pkg,
  assets = null,
  installersRegex = null,
  requiredArchitectures = null,
  releaseTag = null,
} = {}) {
  const build = readWindowsBuildConfig(config);
  const errors = [];
  const installers = [];

  // The submission selects assets with its own regex, which lives in the
  // workflow and knows nothing about artifactName. Without this cross-check the
  // two can desync while every other check here stays green.
  let matcher = null;
  if (installersRegex !== null) {
    try {
      matcher = new RegExp(installersRegex);
    } catch {
      errors.push(`installers-regex is not a valid regular expression: ${installersRegex}`);
    }
  }

  // The manifest version comes from the release tag while the installer URLs are
  // built from package.json. A tag cut without bumping package.json (or repointed
  // afterwards) would publish one version's metadata against another's binaries.
  if (releaseTag !== null) {
    const expectedTag = `v${build.version}`;
    if (releaseTag !== expectedTag) {
      errors.push(
        `Release tag ${releaseTag} does not match package.json version ` +
          `(${build.version}, expected tag ${expectedTag}).`,
      );
    }
  }

  if (!build.artifactName) {
    errors.push("build.win.artifactName is missing; WinGet cannot resolve an architecture.");
  } else if (!build.artifactName.includes("${arch}")) {
    errors.push(
      `build.win.artifactName must contain the \${arch} token, got: ${build.artifactName}`,
    );
  }
  if (!build.owner || !build.repo) {
    errors.push("build.publish[0] must define owner and repo to derive release URLs.");
  }
  if (!build.entries.length) {
    errors.push("build.win.target declares no architectures.");
  }
  for (const name of build.implicitArchTargets) {
    errors.push(
      `build.win.target "${name}" leaves arch implicit; WinGet needs it in the filename.`,
    );
  }

  const assetByName = new Map((assets || []).map((asset) => [asset.name, asset]));

  for (const entry of build.entries) {
    const extension = TARGET_EXTENSION[entry.target];
    if (!extension) {
      errors.push(
        `Unmapped Windows target "${entry.target}"; add it to TARGET_EXTENSION before shipping.`,
      );
      continue;
    }
    const expected = BUILDER_ARCH_TO_WINGET[entry.arch];
    if (!expected) {
      errors.push(
        `Unmapped electron-builder arch "${entry.arch}"; add it to BUILDER_ARCH_TO_WINGET.`,
      );
      continue;
    }
    if (!build.artifactName) continue;

    const filename = materializeName(build.artifactName, {
      version: build.version,
      arch: entry.arch,
      ext: extension,
    });
    const url = downloadUrl({
      owner: build.owner,
      repo: build.repo,
      version: build.version,
      filename,
    });
    const resolved = resolveArchitecture(url);

    if (resolved.architecture === null) {
      errors.push(
        `No delimited architecture token in ${filename}; WinGet would fall back to PE-header ` +
          `detection, which reports x86 for every electron-builder NSIS stub.`,
      );
    } else if (resolved.architecture !== expected) {
      errors.push(
        `${filename} resolves to WinGet architecture "${resolved.architecture}" ` +
          `(matched token "${resolved.matched}") but was built for electron-builder ` +
          `arch "${entry.arch}", which must publish as "${expected}".`,
      );
    }

    if (matcher && !matcher.test(filename)) {
      errors.push(
        `${filename} does not match the WinGet installers-regex ` +
          `${installersRegex}; the submission would not pick it up.`,
      );
    }

    const asset = assetByName.get(filename) || null;
    installers.push({
      target: entry.target,
      builderArch: entry.arch,
      expectedArchitecture: expected,
      resolvedArchitecture: resolved.architecture,
      matchedToken: resolved.matched,
      filename,
      url,
      digest: asset ? asset.digest : null,
      size: asset ? asset.size : null,
    });
  }

  const resolvedArchitectures = installers.map((entry) => entry.resolvedArchitecture);
  if (installers.length > 1 && new Set(resolvedArchitectures).size !== installers.length) {
    errors.push(
      `Windows installers do not resolve to distinct architectures: ` +
        `${installers.map((entry) => `${entry.filename}=${entry.resolvedArchitecture}`).join(", ")}`,
    );
  }

  // Distinctness alone still permits shipping a single architecture. The
  // published manifest must carry every architecture the package promises, so
  // the required set is asserted explicitly rather than inferred from whatever
  // package.json happens to declare today.
  if (requiredArchitectures !== null) {
    const required = [...requiredArchitectures].sort();
    const actual = [...new Set(resolvedArchitectures.filter(Boolean))].sort();
    if (required.join(",") !== actual.join(",")) {
      errors.push(
        `Published architectures must be exactly [${required.join(", ")}], got ` +
          `[${actual.join(", ") || "none"}].`,
      );
    }
  }

  if (assets) {
    const names = assets.map((asset) => asset.name);
    if (new Set(names).size !== names.length) {
      errors.push("Release contains duplicate asset names; cannot bind an installer to content.");
    }
    for (const entry of installers) {
      const asset = assetByName.get(entry.filename);
      if (!asset) {
        errors.push(`Release is missing the expected installer asset: ${entry.filename}`);
        continue;
      }
      if (!asset.digest) {
        errors.push(`Release asset ${entry.filename} has no digest to pin.`);
      } else if (!DIGEST_PATTERN.test(asset.digest)) {
        errors.push(
          `Release asset ${entry.filename} has an unrecognized digest "${asset.digest}"; ` +
            `expected sha256:<64 hex>.`,
        );
      }
    }
    const expectedNames = new Set(installers.map((entry) => entry.filename));
    for (const asset of assets) {
      if (expectedNames.has(asset.name)) continue;
      if (matcher ? matcher.test(asset.name) : asset.name.endsWith(".exe")) {
        errors.push(
          `Unexpected asset "${asset.name}" would also match the WinGet installer regex.`,
        );
      }
    }
    // The shipped defect published one file under both entries. Identical
    // digests mean the architectures are a naming fiction, and the explicit
    // |arch override would then mislabel real content.
    //
    // Distinct digests still do NOT prove either file is the architecture its
    // name claims — swapping the two binaries passes every check here. Nothing
    // short of inspecting the payload can establish that; the generated
    // manifest's SHA256 must be cross-checked against these values downstream.
    const digests = installers
      .map((entry) => entry.digest)
      .filter((digest) => digest && DIGEST_PATTERN.test(digest));
    if (digests.length > 1 && new Set(digests).size !== digests.length) {
      errors.push(
        `Installers share a digest; the same binary is published under more than one ` +
          `architecture: ${installers.map((e) => `${e.filename}=${e.digest}`).join(", ")}`,
      );
    }
  }

  // Komac accepts `<url>|<architecture>` and gives that override the highest
  // precedence — above its own filename inference and above PE-header analysis
  // (Komac src/download/downloads.rs). Emitting the arguments from the same
  // verified mapping that just passed the checks above means the submission
  // cannot feed komac anything the contract did not check. It does NOT
  // guarantee the manifest komac emits; see the SCOPE note at the top.
  const komacUrls = errors.length
    ? []
    : installers.map((entry) => `${entry.url}|${entry.resolvedArchitecture}`);

  return {
    schemaVersion: 2,
    version: build.version,
    releaseTag,
    artifactName: build.artifactName,
    installersRegex,
    requiredArchitectures: requiredArchitectures ? [...requiredArchitectures].sort() : null,
    installers,
    komacUrls,
    assetsChecked: assets ? assets.length : 0,
    errors,
    summary: { installers: installers.length, errors: errors.length },
  };
}

function parseArgs(argv) {
  const options = {
    assetsFile: "",
    output: "",
    installersRegex: "",
    requireArchitectures: "",
    releaseTag: "",
    packageJson: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--assets-file") options.assetsFile = argv[++index] || "";
    else if (arg === "--output") options.output = argv[++index] || "";
    else if (arg === "--installers-regex") options.installersRegex = argv[++index] || "";
    else if (arg === "--require-architectures") options.requireArchitectures = argv[++index] || "";
    else if (arg === "--release-tag") options.releaseTag = argv[++index] || "";
    else if (arg === "--package-json") options.packageJson = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readAssetsFile(assetsFile) {
  return normalizeAssets(JSON.parse(fs.readFileSync(path.resolve(assetsFile), "utf8")));
}

// The release tooling lives on the default branch, but the build configuration
// that produced a release's assets lives in that release's tag. Loading the
// config separately keeps both correct instead of forcing one checkout to serve
// both roles.
function readPackageJson(packageJsonPath) {
  return JSON.parse(fs.readFileSync(path.resolve(packageJsonPath), "utf8"));
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const assets = options.assetsFile ? readAssetsFile(options.assetsFile) : null;
  const report = verifyWingetArchContract({
    config: options.packageJson ? readPackageJson(options.packageJson) : pkg,
    assets,
    installersRegex: options.installersRegex || null,
    requiredArchitectures: options.requireArchitectures
      ? options.requireArchitectures.split(",").map((value) => value.trim()).filter(Boolean)
      : null,
    releaseTag: options.releaseTag || null,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }

  if (report.errors.length) {
    process.stderr.write(
      `WinGet architecture contract failed: ${report.errors.length} error(s).\n`,
    );
    for (const error of report.errors) process.stderr.write(`  - ${error}\n`);
    return 1;
  }
  process.stderr.write(
    `WinGet architecture contract passed for ${report.installers.length} installer(s).\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DELIMITERS,
  ARCHITECTURES,
  BUILDER_ARCH_TO_WINGET,
  DIGEST_PATTERN,
  readPackageJson,
  isDelimitedAt,
  rightmostDelimitedIndex,
  resolveArchitecture,
  readWindowsBuildConfig,
  materializeName,
  downloadUrl,
  normalizeAssets,
  readAssetsFile,
  verifyWingetArchContract,
  parseArgs,
  runCli,
};
