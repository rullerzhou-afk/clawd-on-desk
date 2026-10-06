"use strict";

// Deterministic ZIP fixture builder used by the official-theme installer tests.
// It writes explicit Unix modes into `externalFileAttributes` (high 16 bits)
// exactly like the official packaging script must, so the installer's
// regular-file/directory gate is exercised rather than assumed.

const zlib = require("node:zlib");

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function dosDateTime() {
  // 1980-01-01 00:00:00 — fixed so fixtures are byte-reproducible.
  return { time: 0, date: 0x0021 };
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  let unpackedBytes = 0;
  const { time, date } = dosDateTime();

  for (const entry of entries) {
    const isDir = !!entry.dir || entry.name.endsWith("/");
    const name = Buffer.from(entry.name, "utf8");
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.data || "");
    unpackedBytes += raw.length;
    const mode = entry.mode !== undefined
      ? entry.mode
      : (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644);
    const method = entry.method === "store" || isDir ? 0 : 8;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = entry.encrypted ? 0x0001 : 0;
    const versionMadeBy = (3 << 8) | 20;
    const extra = entry.extraZip64
      ? Buffer.from([0x01, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
      : Buffer.alloc(0);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(versionMadeBy, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(extra.length, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, name, extra);

    offset += localHeader.length + name.length + compressed.length;
  }

  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...localChunks, central, eocd]);
  archive.unpackedBytes = unpackedBytes;
  archive.entryCount = entries.length;
  return archive;
}

// A minimal valid external theme pack named `hash-sage` (small synthetic art).
function hashSageFixture(overrides = {}) {
  const themeJson = {
    schemaVersion: 1,
    id: "hash-sage",
    name: { en: "Hash Sage" },
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    sleepSequence: { mode: "direct" },
    states: {
      idle: ["idle.svg"],
      working: ["working.svg"],
      thinking: ["thinking.svg"],
      sleeping: ["sleeping.svg"],
    },
  };
  const svg = (text) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>${text}</text></svg>`;
  const entries = [
    { name: "hash-sage/", dir: true },
    { name: "hash-sage/theme.json", data: JSON.stringify(overrides.themeJson || themeJson) },
    { name: "hash-sage/LICENSE", data: "All rights reserved." },
    { name: "hash-sage/assets/idle.svg", data: overrides.idleSvg || svg("idle") },
    { name: "hash-sage/assets/working.svg", data: svg("working") },
    { name: "hash-sage/assets/thinking.svg", data: svg("thinking") },
    { name: "hash-sage/assets/sleeping.svg", data: svg("sleeping") },
  ];
  if (overrides.extraEntries) entries.push(...overrides.extraEntries);
  return buildZip(entries);
}

module.exports = { buildZip, hashSageFixture, S_IFREG, S_IFDIR, crc32 };
