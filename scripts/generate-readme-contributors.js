"use strict";

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const README_DIR = path.join(ROOT, "assets", "readme");
const MAINTAINERS_SVG = path.join(README_DIR, "maintainers.svg");
const CONTRIBUTORS_SVG = path.join(README_DIR, "contributors.svg");
const AVATAR_REQUEST_TIMEOUT_MS = 15_000;

const FONT_FAMILY = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
// Role text is copied from the maintainers.svg generated for #1192; settings-i18n has no role field, so update this map when maintainers change.
const MAINTAINER_ROLES = new Map([
  ["rullerzhou-afk", ["@rullerzhou-afk", "鹿鹿 · creator"]],
  ["YOIMIYA66", ["@YOIMIYA66", "maintainer"]],
  ["Bynlk", ["@Bynlk", "core contributor · Mobile / PWA"]],
]);

function loadSettingsLists() {
  const source = fs.readFileSync(path.join(ROOT, "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "settings-i18n.js" });
  return {
    maintainers: Array.from(context.ClawdSettingsI18n.MAINTAINERS),
    contributors: Array.from(context.ClawdSettingsI18n.CONTRIBUTORS),
  };
}

function loadImageHrefs(svgPath) {
  const source = fs.readFileSync(svgPath, "utf8");
  const hrefs = new Map();
  for (const match of source.matchAll(/<g\b[^>]*data-login="([^"]+)"[^>]*>[\s\S]*?<\/g>/g)) {
    const block = match[0];
    const href = block.match(/\bhref="([^"]+)"/);
    if (!href) {
      throw new Error(`Missing avatar href for ${match[1]} in ${svgPath}`);
    }
    hrefs.set(match[1], href[1]);
  }
  return hrefs;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fetchAvatar(login) {
  const url = `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=70`;
  return fetchAvatarUrl(url, login);
}

function fetchAvatarUrl(url, login, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const fail = (error) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    const succeed = (value) => finish(resolve, value);
    const request = https.get(url, (response) => {
      response.once("error", fail);
      response.once("aborted", () => {
        fail(new Error(`GitHub avatar response for ${login} was aborted`));
      });
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectCount >= 3) {
          fail(new Error(`Too many redirects while downloading ${login}`));
          return;
        }
        clearTimeout(timeout);
        fetchAvatarUrl(new URL(location, url).toString(), login, redirectCount + 1)
          .then(succeed, fail);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        fail(new Error(`GitHub avatar request for ${login} returned HTTP ${status}`));
        return;
      }
      const contentType = String(response.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (!contentType.startsWith("image/")) {
        response.resume();
        fail(new Error(`GitHub avatar request for ${login} returned ${contentType || "no content type"}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        succeed(`data:${contentType};base64,${body.toString("base64")}`);
      });
    });
    timeout = setTimeout(() => {
      const error = new Error(`GitHub avatar request for ${login} timed out after ${AVATAR_REQUEST_TIMEOUT_MS}ms`);
      request.destroy(error);
      fail(error);
    }, AVATAR_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    request.once("error", fail);
  });
}

function renderMaintainers(maintainers, imageHrefs) {
  const blocks = maintainers.map((login, index) => {
    const role = MAINTAINER_ROLES.get(login);
    if (!role) {
      throw new Error(`Missing maintainer role for ${login}`);
    }
    const href = imageHrefs.get(login);
    if (!href) {
      throw new Error(`Missing maintainer avatar for ${login}`);
    }
    const x = index * 220;
    const clipId = `cp-${login}`;
    return [
      `  <g transform="translate(${x}, 6)" data-login="${escapeXml(login)}">`,
      `    <defs><clipPath id="${escapeXml(clipId)}"><circle cx="110" cy="44" r="44"/></clipPath></defs>`,
      `    <image x="66" y="0" width="88" height="88" href="${href}" clip-path="url(#${escapeXml(clipId)})"/>`,
      `    <circle cx="110" cy="44" r="43.5" fill="none" stroke="#8b949e" stroke-opacity="0.35"/>`,
      `    <text x="110" y="104" text-anchor="middle" font-size="13" fill="#8b949e" font-family="${FONT_FAMILY}" font-weight="600">${escapeXml(role[0])}</text>`,
      `    <text x="110" y="119" text-anchor="middle" font-size="11" fill="#8b949e" font-family="${FONT_FAMILY}">${escapeXml(role[1])}</text>`,
      "  </g>",
    ].join("\n");
  }).join("\n");
  const width = maintainers.length * 220;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="134" viewBox="0 0 ${width} 134" role="img" aria-label="Clawd on Desk maintainers">\n${blocks}\n</svg>\n`;
}

function renderContributors(contributors, imageHrefs) {
  const blocks = contributors.map((login, index) => {
    const href = imageHrefs.get(login);
    if (!href) {
      throw new Error(`Missing contributor avatar for ${login}`);
    }
    const x = (index % 10) * 90;
    const y = Math.floor(index / 10) * 96 + 6;
    const clipId = `cp-${login}`;
    const label = login.length > 13 ? `${login.slice(0, 12)}…` : login;
    return [
      `  <g transform="translate(${x}, ${y})" data-login="${escapeXml(login)}">`,
      `    <defs><clipPath id="${escapeXml(clipId)}"><circle cx="45" cy="28" r="28"/></clipPath></defs>`,
      `    <image x="17" y="0" width="56" height="56" href="${href}" clip-path="url(#${escapeXml(clipId)})"/>`,
      `    <circle cx="45" cy="28" r="27.5" fill="none" stroke="#8b949e" stroke-opacity="0.35"/>`,
      `    <text x="45" y="72" text-anchor="middle" font-size="10" fill="#8b949e" font-family="${FONT_FAMILY}">${escapeXml(label)}</text>`,
      "  </g>",
    ].join("\n");
  }).join("\n");
  const height = Math.ceil(contributors.length / 10) * 96 + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" role="img" aria-label="Clawd on Desk contributors">\n${blocks}\n</svg>\n`;
}

async function generate() {
  const { maintainers, contributors } = loadSettingsLists();
  const maintainerImages = loadImageHrefs(MAINTAINERS_SVG);
  const contributorImages = loadImageHrefs(CONTRIBUTORS_SVG);
  for (const login of contributors) {
    if (!contributorImages.has(login)) {
      contributorImages.set(login, await fetchAvatar(login));
    }
  }
  fs.writeFileSync(MAINTAINERS_SVG, renderMaintainers(maintainers, maintainerImages));
  fs.writeFileSync(CONTRIBUTORS_SVG, renderContributors(contributors, contributorImages));
}

if (require.main === module) {
  generate().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { generate, loadSettingsLists, renderContributors, renderMaintainers };
