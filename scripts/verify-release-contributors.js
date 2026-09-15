#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const IDENTITY_OVERRIDES = new Map(Object.entries({
  "rullerzhou@gmail.com": null,
  "228746293+rullerzhou-afk@users.noreply.github.com": null,
  "cursoragent@cursor.com": null,
  "noreply@anthropic.com": null,
  "cheesevickey@gmail.com": "CheeseAgent",
  "wang4433@purdue.edu": "wang4433",
  "chenbaize999@gmail.com": "shengmai-justin",
  "liufeng@dtstack.com": "liugou27",
  "akaa1941@gmail.com": "chrono-meta",
  "luis@aumentra.com": "Zamaniego",
  "kaichuan2004@gmail.com": "KaiC5504",
  "411551294@qq.com": "YOIMIYA66",
  "a1330661071@gmail.com": "xiaoshidefeng",
  "draintovmasyan783@gmail.com": "draintovmasyan783-creator",
  "264600648+draintovmasryan783-creator@users.noreply.github.com": "draintovmasyan783-creator",
}));

function parseVersion(value) {
  const match = String(value || "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:-|$)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function previousReleaseTag(version, tags) {
  const current = parseVersion(version);
  if (!current) return "";
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => ({ tag: String(tag).trim(), version: parseVersion(tag) }))
    .filter((entry) => entry.tag && entry.version && compareVersion(entry.version, current) < 0)
    .sort((left, right) => compareVersion(right.version, left.version))[0]?.tag || "";
}

function githubHandleForIdentity(name, email) {
  const rawEmail = String(email || "").trim();
  const normalizedEmail = rawEmail.toLowerCase();
  if (IDENTITY_OVERRIDES.has(normalizedEmail)) return IDENTITY_OVERRIDES.get(normalizedEmail);
  const noreply = rawEmail.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
  if (noreply) return noreply[1];
  return undefined;
}

function parseReleaseIdentities(logText) {
  const identities = [];
  for (const record of String(logText || "").split("\x1e")) {
    if (!record.trim()) continue;
    const [email = "", name = "", ...bodyParts] = record.replace(/^\n/, "").split("\x00");
    identities.push({ name: name.trim(), email: email.trim(), source: "author" });
    const body = bodyParts.join("\x00");
    for (const match of body.matchAll(/^Co-Authored-By:\s*(.*?)\s*<([^>]+)>\s*$/gim)) {
      identities.push({ name: match[1].trim(), email: match[2].trim(), source: "co-author" });
    }
  }
  return identities;
}

function loadSettingsContributors(root) {
  const source = fs.readFileSync(path.join(root, "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "settings-i18n.js" });
  return Array.from(context.ClawdSettingsI18n.CONTRIBUTORS || []);
}

function verifyReleaseContributors(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const version = options.version || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const runGit = options.runGit || ((args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const errors = [];
  let tags = [];
  try {
    tags = runGit(["tag", "--list", "v*"]).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return { ok: false, version, previousTag: "", handles: [], errors: [`could not read release tags: ${err.message}`] };
  }
  const previousTag = previousReleaseTag(version, tags);
  if (!previousTag) {
    return { ok: false, version, previousTag: "", handles: [], errors: [`no previous release tag found before v${version}`] };
  }

  let logText = "";
  try {
    logText = runGit(["log", `${previousTag}..HEAD`, "--format=%aE%x00%aN%x00%B%x1e"]);
  } catch (err) {
    return { ok: false, version, previousTag, handles: [], errors: [`could not inspect ${previousTag}..HEAD: ${err.message}`] };
  }

  const handles = new Set();
  for (const identity of parseReleaseIdentities(logText)) {
    const handle = githubHandleForIdentity(identity.name, identity.email);
    if (handle === undefined) {
      errors.push(`unmapped ${identity.source} identity: ${identity.name} <${identity.email}>`);
    } else if (handle) {
      handles.add(handle);
    }
  }

  const contributors = new Set(loadSettingsContributors(root).map((value) => String(value).toLowerCase()));
  for (const handle of handles) {
    if (!contributors.has(handle.toLowerCase())) {
      errors.push(`release contributor @${handle} is missing from Settings About / README contributor lists`);
    }
  }

  return {
    ok: errors.length === 0,
    version,
    previousTag,
    handles: [...handles].sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

function main() {
  const result = verifyReleaseContributors();
  if (!result.ok) {
    for (const error of result.errors) console.error(`Release contributor verification failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Release contributor contract OK: ${result.previousTag}..HEAD (${result.handles.length} external contributors)`,
  );
}

if (require.main === module) main();

module.exports = {
  githubHandleForIdentity,
  parseReleaseIdentities,
  previousReleaseTag,
  verifyReleaseContributors,
};
