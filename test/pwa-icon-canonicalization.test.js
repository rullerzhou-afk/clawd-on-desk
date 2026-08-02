"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ICONS = [
  {
    route: "/mobile/icons/icon-256.png",
    canonical: "assets/icons/256x256.png",
    retired: "pwa/icons/icon-256.png",
  },
  {
    route: "/mobile/icons/icon-512.png",
    canonical: "assets/icons/512x512.png",
    retired: "pwa/icons/icon-512.png",
  },
];

test("PWA icon URLs use canonical packaged assets without tracked copies", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "pwa", "manifest.json"), "utf8"));
  const manifestRoutes = new Set(
    manifest.icons.map((entry) => new URL(entry.src, "https://clawd.test/mobile/").pathname),
  );
  const appSource = fs.readFileSync(path.join(ROOT, "pwa", "app.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(ROOT, "pwa", "sw.js"), "utf8");

  for (const { route, canonical, retired } of ICONS) {
    assert.ok(fs.existsSync(path.join(ROOT, canonical)), `${canonical} must remain`);
    assert.strictEqual(
      fs.existsSync(path.join(ROOT, retired)),
      false,
      `${retired} must stay retired`,
    );
    assert.ok(manifestRoutes.has(route), `${route} must remain in the web app manifest`);
    assert.ok(serviceWorker.includes(`"${route}"`), `${route} must be pre-cached`);
  }

  assert.ok(
    appSource.includes('icon: "/mobile/icons/icon-256.png"'),
    "notification icon URL must remain stable",
  );
});

test("asset policy owns the canonical Windows and PWA icon sources", () => {
  const policy = JSON.parse(
    fs.readFileSync(path.join(ROOT, "tools", "repository-asset-policy.json"), "utf8"),
  );
  const entries = new Map(policy.entries.map((entry) => [entry.path, entry]));

  for (const canonical of [
    "assets/icon.ico",
    "assets/icons/256x256.png",
    "assets/icons/512x512.png",
  ]) {
    const entry = entries.get(canonical);
    assert.ok(entry, `${canonical} must have an auditable policy entry`);
    assert.strictEqual(entry.owner, "build-release");
    assert.strictEqual(entry.packaged, true);
  }

  for (const { retired } of ICONS) {
    assert.strictEqual(entries.has(retired), false, `${retired} must not have a stale policy entry`);
  }
});
