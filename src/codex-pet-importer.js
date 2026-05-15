"use strict";

const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const { domainToASCII } = require("url");
const zlib = require("zlib");

const adapter = require("./codex-pet-adapter");

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024;
const MAX_PET_JSON_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const IMPORT_MARKER_FILENAME = ".clawd-imported-pet.json";
const ERR_REPLACE_DECLINED = "ERR_CLAWD_CODEX_PET_REPLACE_DECLINED";
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".corp"];

function getDefaultCodexPetsDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", "pets");
}

function parseClawdImportUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("invalid clawd import URL");
  }
  if (parsed.protocol !== "clawd:") throw new Error("unsupported protocol");

  const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  if (action !== "import-pet") throw new Error(`unsupported clawd action: ${action || "(missing)"}`);

  const remote = parsed.searchParams.get("url");
  if (!remote) throw new Error("import-pet URL requires a url parameter");
  const importUrl = normalizeRemotePetUrl(remote);
  return { action: "import-pet", url: importUrl.href, asciiHostname: importUrl.hostname };
}

function normalizeRemotePetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("invalid pet URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Codex Pet imports require an https URL");
  if (parsed.username || parsed.password) throw new Error("Codex Pet import URLs must not contain credentials");
  const asciiHost = domainToASCII(parsed.hostname || "");
  if (!asciiHost) throw new Error("Codex Pet import URL must include a valid hostname");
  if (isBlockedHostname(asciiHost)) throw new Error(`blocked Codex Pet import host: ${asciiHost}`);
  parsed.hostname = asciiHost;
  parsed.hash = "";
  return parsed;
}

function isBlockedHostname(hostname) {
  const ascii = domainToASCII(String(hostname || "")).toLowerCase();
  if (!ascii) return true;
  if (ascii === "localhost") return true;
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => ascii.endsWith(suffix))) return true;
  return net.isIP(ascii) ? isBlockedIp(ascii) : false;
}

function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address) {
  const parts = String(address).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const n = (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  };
  return (
    inRange(ipv4ToInt("0.0.0.0"), 8)
    || inRange(ipv4ToInt("10.0.0.0"), 8)
    || inRange(ipv4ToInt("100.64.0.0"), 10)
    || inRange(ipv4ToInt("127.0.0.0"), 8)
    || inRange(ipv4ToInt("169.254.0.0"), 16)
    || inRange(ipv4ToInt("172.16.0.0"), 12)
    || inRange(ipv4ToInt("192.168.0.0"), 16)
    || inRange(ipv4ToInt("224.0.0.0"), 4)
    || inRange(ipv4ToInt("240.0.0.0"), 4)
    || n === ipv4ToInt("255.255.255.255")
  );
}

function ipv4ToInt(address) {
  const parts = address.split(".").map((part) => Number(part));
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function isBlockedIpv6(address) {
  const lower = String(address || "").toLowerCase();
  const mapped = lower.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  const first = lower.split(":")[0] || "";
  const firstWord = parseInt(first, 16);
  if (!Number.isFinite(firstWord)) return true;
  return (
    (firstWord & 0xfe00) === 0xfc00
    || (firstWord & 0xffc0) === 0xfe80
    || (firstWord & 0xff00) === 0xff00
  );
}

async function guardedLookup(hostname, options = {}) {
  const ascii = domainToASCII(String(hostname || ""));
  if (!ascii || isBlockedHostname(ascii)) throw new Error(`blocked Codex Pet import host: ${ascii || hostname}`);
  if (net.isIP(ascii)) {
    if (isBlockedIp(ascii)) throw new Error(`blocked Codex Pet import address: ${ascii}`);
    return { address: ascii, family: net.isIP(ascii) };
  }

  const lookup = options.lookup || dns.lookup;
  const records = await new Promise((resolve, reject) => {
    lookup(ascii, { all: true, verbatim: false }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Codex Pet import host did not resolve: ${ascii}`);
  }
  for (const record of records) {
    if (!record || !record.address || isBlockedIp(record.address)) {
      throw new Error(`blocked Codex Pet import address for ${ascii}: ${(record && record.address) || "(missing)"}`);
    }
  }
  return { address: records[0].address, family: records[0].family || net.isIP(records[0].address) };
}

async function downloadHttpsBuffer(rawUrl, options = {}) {
  const maxBytes = options.maxBytes || MAX_ZIP_BYTES;
  const redirects = options.redirects || 0;
  if (redirects > MAX_REDIRECTS) throw new Error("too many redirects while importing Codex Pet");

  const url = normalizeRemotePetUrl(rawUrl);
  const resolved = await guardedLookup(url.hostname, { lookup: options.lookup });

  return new Promise((resolve, reject) => {
    const request = options.request || https.request;
    const req = request({
      protocol: "https:",
      hostname: url.hostname,
      servername: url.hostname,
      port: url.port || 443,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { "User-Agent": "Clawd-Codex-Pet-Importer" },
      lookup: (_hostname, _opts, cb) => cb(null, resolved.address, resolved.family),
      timeout: options.timeoutMs || 30000,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, url);
        } catch (err) {
          reject(new Error(`invalid redirect URL: ${err.message}`));
          return;
        }
        downloadHttpsBuffer(next.href, { ...options, maxBytes, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`Codex Pet download failed with HTTP ${status}`));
        return;
      }
      const contentLength = Number(res.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        res.resume();
        reject(new Error(`Codex Pet download exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error(`Codex Pet download exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks, total)));
    });
    req.on("timeout", () => req.destroy(new Error("Codex Pet download timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function importCodexPetFromUrl(rawUrl, options = {}) {
  const url = normalizeRemotePetUrl(rawUrl);
  const fetchBuffer = options.fetchBuffer || ((href, fetchOptions) => downloadHttpsBuffer(href, {
    lookup: options.lookup,
    request: options.request,
    maxBytes: fetchOptions && fetchOptions.maxBytes,
  }));

  if (url.pathname.toLowerCase().endsWith(".zip")) {
    const zipBuffer = await fetchBuffer(url.href, { maxBytes: MAX_ZIP_BYTES, kind: "zip" });
    if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error(`zip package exceeds ${MAX_ZIP_BYTES} bytes`);
    return importCodexPetFromZipBuffer(zipBuffer, options);
  }

  if (!path.posix.basename(url.pathname).toLowerCase().endsWith(".json")) {
    throw new Error("Codex Pet import URL must point to a .zip package or pet.json");
  }
  const petJsonBuffer = await fetchBuffer(url.href, { maxBytes: MAX_PET_JSON_BYTES, kind: "pet.json" });
  const manifest = parsePetJsonBuffer(petJsonBuffer);
  const spritesheetUrl = resolveDirectSpritesheetUrl(url, manifest);
  const spritesheetBuffer = await fetchBuffer(spritesheetUrl.href, {
    maxBytes: MAX_SPRITESHEET_BYTES,
    kind: "spritesheet",
  });
  if (spritesheetBuffer.length > MAX_SPRITESHEET_BYTES) {
    throw new Error(`spritesheet exceeds ${MAX_SPRITESHEET_BYTES} bytes`);
  }
  return installCodexPetPackage({
    manifest,
    files: [{ relativePath: manifest.spritesheetPath, buffer: spritesheetBuffer }],
    codexPetsDir: options.codexPetsDir,
    confirmReplaceExistingPackage: options.confirmReplaceExistingPackage,
  });
}

async function importCodexPetFromZipBuffer(zipBuffer, options = {}) {
  const extracted = extractCodexPetZip(zipBuffer);
  return installCodexPetPackage({
    manifest: extracted.manifest,
    files: [{ relativePath: extracted.manifest.spritesheetPath, buffer: extracted.spritesheetBuffer }],
    codexPetsDir: options.codexPetsDir,
    confirmReplaceExistingPackage: options.confirmReplaceExistingPackage,
  });
}

function parsePetJsonBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("pet.json response must be a buffer");
  if (buffer.length > MAX_PET_JSON_BYTES) throw new Error(`pet.json exceeds ${MAX_PET_JSON_BYTES} bytes`);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    throw new Error(`invalid pet.json: ${err.message}`);
  }
}

function resolveDirectSpritesheetUrl(petUrl, manifest) {
  const spritesheetPath = normalizePackageRelativePath(manifest && manifest.spritesheetPath, "spritesheetPath");
  const target = new URL(spritesheetPath, petUrl);
  if (target.origin !== petUrl.origin) throw new Error("pet.json spritesheet must stay on the same origin");

  const baseDir = petUrl.pathname.endsWith("/")
    ? petUrl.pathname
    : petUrl.pathname.slice(0, petUrl.pathname.lastIndexOf("/") + 1);
  if (!target.pathname.startsWith(baseDir)) {
    throw new Error("pet.json spritesheet must stay in the manifest directory");
  }
  return normalizeRemotePetUrl(target.href);
}

async function installCodexPetPackage({ manifest, files, codexPetsDir, confirmReplaceExistingPackage } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest is required");
  const rootDir = path.resolve(codexPetsDir || getDefaultCodexPetsDir());
  const packageName = derivePackageDirName(manifest);
  const targetDir = path.resolve(path.join(rootDir, packageName));
  if (!isPathInsideDir(rootDir, targetDir)) throw new Error("derived package path escapes pets directory");

  const stagingDir = path.resolve(path.join(rootDir, `${packageName}.importing-${process.pid}-${Date.now()}`));
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(stagingDir, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const file of files || []) {
      const relativePath = normalizePackageRelativePath(file.relativePath, "package file");
      const dest = path.resolve(path.join(stagingDir, relativePath));
      if (!isPathInsideDir(stagingDir, dest)) throw new Error(`package file escapes staging directory: ${relativePath}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.buffer);
    }

    const validation = adapter.validateCodexPetPackage(stagingDir);
    if (!validation.ok) throw new Error(`imported Codex Pet package is invalid: ${validation.errors.join("; ")}`);

    if (fs.existsSync(targetDir)) {
      if (!fs.existsSync(path.join(targetDir, "pet.json"))) {
        throw new Error(`refusing to overwrite non-pet directory: ${targetDir}`);
      }
      const existingMarker = readImportMarker(targetDir);
      if (typeof confirmReplaceExistingPackage !== "function") {
        throw new Error(`Codex Pet package already exists locally: ${targetDir}`);
      }
      const existingManifest = readPetManifestIfPresent(targetDir);
      const confirmed = await confirmReplaceExistingPackage({
        packageDir: targetDir,
        packageName,
        existingManifest,
        incomingManifest: manifest,
        existingMarker,
        wasClawdImported: !!existingMarker,
      });
      if (!confirmed) {
        const err = new Error("Codex Pet package replacement was cancelled");
        err.code = ERR_REPLACE_DECLINED;
        throw err;
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, targetDir);
    fs.writeFileSync(path.join(targetDir, IMPORT_MARKER_FILENAME), `${JSON.stringify({
      managedBy: "clawd",
      kind: "codex-pet-import",
      schemaVersion: 1,
      importedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");

    const finalValidation = adapter.validateCodexPetPackage(targetDir);
    if (!finalValidation.ok) {
      throw new Error(`installed Codex Pet package is invalid: ${finalValidation.errors.join("; ")}`);
    }
    return { packageDir: targetDir, packageInfo: finalValidation.packageInfo };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

function readImportMarker(packageDir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(packageDir, IMPORT_MARKER_FILENAME), "utf8"));
    if (
      marker
      && marker.managedBy === "clawd"
      && marker.kind === "codex-pet-import"
      && marker.schemaVersion === 1
    ) {
      return marker;
    }
  } catch {}
  return null;
}

function readPetManifestIfPresent(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, "pet.json"), "utf8"));
  } catch {
    return null;
  }
}

function extractCodexPetZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("zip package must be a buffer");
  if (buffer.length > MAX_ZIP_BYTES) throw new Error(`zip package exceeds ${MAX_ZIP_BYTES} bytes`);
  const entries = readZipEntries(buffer);
  const petEntries = entries.filter((entry) => !entry.directory && path.posix.basename(entry.name) === "pet.json");
  const supportedPetEntries = petEntries.filter((entry) => {
    const parts = entry.name.split("/");
    return parts.length === 1 || parts.length === 2;
  });
  if (supportedPetEntries.length !== 1) {
    throw new Error("zip package must contain exactly one pet.json at the root or inside one top-level folder");
  }

  const petEntry = supportedPetEntries[0];
  const petPrefix = petEntry.name.includes("/") ? `${petEntry.name.slice(0, petEntry.name.lastIndexOf("/") + 1)}` : "";
  const petJsonBuffer = extractZipEntry(buffer, petEntry, MAX_PET_JSON_BYTES);
  const manifest = parsePetJsonBuffer(petJsonBuffer);
  const spritesheetPath = normalizePackageRelativePath(manifest.spritesheetPath, "spritesheetPath");
  manifest.spritesheetPath = spritesheetPath;

  const expectedSpritesheet = `${petPrefix}${spritesheetPath}`;
  const spritesheetEntry = entries.find((entry) => !entry.directory && entry.name === expectedSpritesheet);
  if (!spritesheetEntry) throw new Error(`zip package is missing spritesheet: ${spritesheetPath}`);
  const spritesheetBuffer = extractZipEntry(buffer, spritesheetEntry, MAX_SPRITESHEET_BYTES);
  return { manifest, spritesheetBuffer };
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset + centralDirSize > buffer.length) throw new Error("zip central directory is out of bounds");

  const entries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid zip central directory");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const rawName = buffer.slice(nameStart, nameStart + nameLength);
    const name = normalizeZipEntryName(rawName.toString(flags & 0x0800 ? "utf8" : "utf8"));
    if (flags & 0x0001) throw new Error(`encrypted zip entries are not supported: ${name}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("zip64 packages are not supported");
    }
    entries.push({
      name,
      directory: name.endsWith("/"),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("invalid zip package: missing central directory");
}

function extractZipEntry(buffer, entry, maxBytes) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`invalid zip local header for ${entry.name}`);
  }
  if (entry.uncompressedSize > maxBytes) throw new Error(`zip entry exceeds ${maxBytes} bytes: ${entry.name}`);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error(`zip entry data is out of bounds: ${entry.name}`);
  const compressed = buffer.slice(dataStart, dataEnd);
  let output;
  if (entry.method === 0) output = compressed;
  else if (entry.method === 8) output = inflateRawZipEntry(compressed, maxBytes, entry.name);
  else throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
  if (output.length !== entry.uncompressedSize) throw new Error(`zip entry size mismatch: ${entry.name}`);
  if (output.length > maxBytes) throw new Error(`zip entry exceeds ${maxBytes} bytes: ${entry.name}`);
  return output;
}

function inflateRawZipEntry(compressed, maxBytes, entryName) {
  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`zip entry exceeds ${maxBytes} bytes: ${entryName}`);
    }
    throw error;
  }
}

function normalizeZipEntryName(name) {
  const normalized = String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) throw new Error("zip entry has an empty name");
  if (/^[a-zA-Z]:\//.test(normalized)) throw new Error(`zip entry uses an absolute path: ${name}`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    if (normalized.endsWith("/") && parts[parts.length - 1] === "") {
      const dirParts = parts.slice(0, -1);
      if (!dirParts.some((part) => part === "" || part === "." || part === "..")) return `${dirParts.join("/")}/`;
    }
    throw new Error(`unsafe zip entry path: ${name}`);
  }
  return normalized;
}

function normalizePackageRelativePath(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${fieldName} must be a non-empty string`);
  const raw = value.trim().replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) throw new Error(`${fieldName} must be relative`);
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`${fieldName} must stay inside the package directory`);
  }
  return normalized;
}

function derivePackageDirName(manifest) {
  // Import package directories may preserve Unicode names. The adapter derives
  // separate ASCII-safe Clawd theme ids from the installed package metadata.
  const candidate = sanitizePackageDirName(manifest.id) || sanitizePackageDirName(manifest.displayName);
  if (candidate) return candidate;
  const hash = crypto.createHash("sha1").update(JSON.stringify(manifest)).digest("hex").slice(0, 8);
  return `pet-${hash}`;
}

function sanitizePackageDirName(value) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+$/, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "";
}

function isPathInsideDir(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(root + path.sep);
}

module.exports = {
  MAX_ZIP_BYTES,
  MAX_SPRITESHEET_BYTES,
  MAX_PET_JSON_BYTES,
  IMPORT_MARKER_FILENAME,
  ERR_REPLACE_DECLINED,
  getDefaultCodexPetsDir,
  parseClawdImportUrl,
  normalizeRemotePetUrl,
  isBlockedHostname,
  isBlockedIp,
  guardedLookup,
  downloadHttpsBuffer,
  importCodexPetFromUrl,
  importCodexPetFromZipBuffer,
  extractCodexPetZip,
  readZipEntries,
  extractZipEntry,
  resolveDirectSpritesheetUrl,
  installCodexPetPackage,
  readImportMarker,
};
