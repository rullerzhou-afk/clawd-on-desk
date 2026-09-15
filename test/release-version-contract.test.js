"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveTagName, verifyReleaseVersion } = require("../scripts/verify-release-version");

function makeFixture(t, { packageVersion = "1.2.3", lockVersion = packageVersion,
  rootVersion = packageVersion, releaseVersion = packageVersion } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-release-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs", "releases"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    version: lockVersion,
    packages: { "": { version: rootVersion } },
  }));
  if (releaseVersion) {
    fs.writeFileSync(path.join(root, "docs", "releases", `release-v${releaseVersion}.md`), "# release\n");
  }
  return root;
}

test("the current checkout satisfies the release version contract", () => {
  const result = verifyReleaseVersion({ root: path.join(__dirname, ".."), env: {} });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.version, "1.0.0");
});

test("the authoritative draft smoke checklist tracks the current package version", () => {
  const root = path.join(__dirname, "..");
  const version = require(path.join(root, "package.json")).version;
  const escapedVersion = version.replace(/\./g, "\\.");
  const processDoc = fs.readFileSync(path.join(root, "docs", "project", "release-process.md"), "utf8");
  assert.match(processDoc, new RegExp(`### v${escapedVersion} Draft Smoke Checklist`));
  assert.match(processDoc, new RegExp("packaged app shows `" + escapedVersion + "` metadata"));
  assert.match(processDoc, new RegExp("About shows `v" + escapedVersion + "`"));
});

test("package, lock root, release note, and tag must agree exactly", (t) => {
  const root = makeFixture(t, { lockVersion: "1.2.2", rootVersion: "1.2.1", releaseVersion: "" });
  const result = verifyReleaseVersion({
    root,
    env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.4" },
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("package-lock.json version")));
  assert.ok(result.errors.some((entry) => entry.includes("package-lock root version")));
  assert.ok(result.errors.some((entry) => entry.includes("missing release note")));
  assert.ok(result.errors.some((entry) => entry.includes("must exactly equal")));
});

test("branch workflow refs are ignored while tag refs are enforced", () => {
  assert.strictEqual(resolveTagName({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" }), "");
  assert.strictEqual(resolveTagName({ GITHUB_REF: "refs/tags/v2.0.0" }), "v2.0.0");
});

test("build workflow validates the release contract before every platform build", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "build.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(workflow, /validate-release:\s*[\s\S]*?npm run verify:release/);
  for (const job of ["build-windows", "build-mac", "build-linux"]) {
    assert.match(
      workflow,
      new RegExp(`\\n  ${job}:\\n    needs: validate-release`),
    );
  }
  assert.match(
    workflow,
    /release:\s*\n\s*if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/,
  );
  assert.strictEqual(
    (workflow.match(/verify-updater-metadata\.js[^\n]+--package-json package\.json/g) || []).length,
    3,
  );
});
