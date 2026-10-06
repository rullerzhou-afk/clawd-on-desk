#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveTagName(env = process.env) {
  if (env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME) {
    return String(env.GITHUB_REF_NAME).trim();
  }
  const ref = typeof env.GITHUB_REF === "string" ? env.GITHUB_REF.trim() : "";
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}

function verifyReleaseVersion(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const env = options.env || process.env;
  const pkg = readJson(path.join(root, "package.json"));
  const lock = readJson(path.join(root, "package-lock.json"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  const lockVersion = typeof lock.version === "string" ? lock.version.trim() : "";
  const lockRootVersion = lock.packages && lock.packages[""]
    && typeof lock.packages[""].version === "string"
    ? lock.packages[""].version.trim()
    : "";
  const errors = [];

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push(`package.json has an invalid version: ${JSON.stringify(version)}`);
  }
  if (lockVersion !== version) {
    errors.push(`package-lock.json version ${JSON.stringify(lockVersion)} does not match ${JSON.stringify(version)}`);
  }
  if (lockRootVersion !== version) {
    errors.push(`package-lock root version ${JSON.stringify(lockRootVersion)} does not match ${JSON.stringify(version)}`);
  }

  const releaseNote = path.join(root, "docs", "releases", `release-v${version}.md`);
  if (!version || !fs.existsSync(releaseNote)) {
    errors.push(`missing release note: docs/releases/release-v${version}.md`);
  }

  const tag = resolveTagName(env);
  if (tag && tag !== `v${version}`) {
    errors.push(`release tag ${JSON.stringify(tag)} must exactly equal ${JSON.stringify(`v${version}`)}`);
  }

  return { ok: errors.length === 0, version, tag, releaseNote, errors };
}

function main() {
  let result;
  try {
    result = verifyReleaseVersion();
  } catch (err) {
    console.error(`Release version verification failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    for (const error of result.errors) console.error(`Release version verification failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Release version contract OK: v${result.version}${result.tag ? ` (${result.tag})` : ""}`);
}

if (require.main === module) main();

module.exports = { resolveTagName, verifyReleaseVersion };
