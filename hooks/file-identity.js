"use strict";

// NTFS file IDs are 64-bit integers: a default stat can lose their precision
// when it stores them as doubles. Keep the exact identity non-enumerable so
// spread-and-modified copies compute an identity from their own fields.
const IDENTITY = Symbol.for("clawd-on-desk.fileIdentity");

function msFromNs(ns) {
  // Split seconds to reproduce Node's default stat floating-point results,
  // including its rounding for timestamps before the epoch.
  let seconds = ns / 1000000000n;
  let nanos = ns % 1000000000n;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += 1000000000n;
  }
  return Number(seconds) * 1e3 + Number(nanos) / 1e6;
}

function numberValue(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

function timeMs(stats, name) {
  return typeof stats[`${name}Ns`] === "bigint"
    ? msFromNs(stats[`${name}Ns`]) : numberValue(stats[`${name}Ms`]);
}

function fileIdentity(stats) {
  if (!stats) return null;
  if (Object.hasOwn(stats, IDENTITY)) return stats[IDENTITY];
  const dev = stats.dev ?? 0;
  const ino = stats.ino ?? 0;
  const valid = (value) => typeof value === "bigint" || Number.isFinite(value);
  if (valid(dev) && valid(ino) && ino !== 0 && ino !== 0n) {
    return `inode:${dev}:${ino}`;
  }
  const birthtimeMs = timeMs(stats, "birthtime");
  if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) return `birth:${birthtimeMs}`;
  // With neither inode nor birthtime available, retain a device-change signal.
  if (valid(dev) && dev !== 0 && dev !== 0n) return `dev:${dev}`;
  return null;
}

// Bigint inputs become a limited numeric view: dev, ino, mode, size,
// four *Ms fields and type-check methods, without Date, nlink or uid.
// The exact identity is saved separately.
function toNumberStats(stats) {
  if (stats == null || !Object.values(stats).some(value => typeof value === "bigint")) return stats;
  const result = {};
  for (const name of ["dev", "ino", "mode", "size"]) result[name] = numberValue(stats[name]);
  for (const name of ["atime", "mtime", "ctime", "birthtime"]) result[`${name}Ms`] = timeMs(stats, name);
  for (const name of ["isFile", "isDirectory", "isSymbolicLink", "isBlockDevice",
    "isCharacterDevice", "isFIFO", "isSocket"]) {
    if (typeof stats[name] === "function") result[name] = () => stats[name]();
  }
  Object.defineProperty(result, IDENTITY, { value: fileIdentity(stats), enumerable: false });
  return result;
}

function readStats(statFn, target) {
  return toNumberStats(statFn(target, { bigint: true }));
}

module.exports = { toNumberStats, fileIdentity, readStats };
