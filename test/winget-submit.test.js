const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const { MANIFEST_FILES } = require("../scripts/verify-winget-generated-manifest.js");
const {
  buildPullRequestBody,
  buildSubmissionPlan,
  expectedManifestPaths,
  parseArgs,
  runSubmission,
} = require("../scripts/submit-winget-manifest.js");

const INPUT = {
  forkOwner: "rullerzhou-afk",
  expectedDigests: "/tmp/winget-digests.json",
  releaseTag: "v1.2.3",
  runAttempt: "1",
  runId: "123456",
  sourceRepository: "rullerzhou-afk/clawd-on-desk",
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "winget-submit-test-"));
  const generatedRoot = path.join(root, "generated");
  const expectedDigests = path.join(root, "winget-digests.json");
  const plan = buildSubmissionPlan({ ...INPUT, generatedRoot, expectedDigests });
  fs.mkdirSync(plan.generatedManifestDirectory, { recursive: true });
  for (const filename of Object.values(MANIFEST_FILES)) {
    fs.writeFileSync(path.join(plan.generatedManifestDirectory, filename), `${filename}\n`, "utf8");
  }
  const fileDigests = Object.fromEntries(
    expectedManifestPaths(plan).map((relativePath) => {
      const content = fs.readFileSync(
        path.join(plan.generatedManifestDirectory, path.basename(relativePath)),
      );
      return [relativePath, `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`];
    }),
  );
  fs.writeFileSync(expectedDigests, JSON.stringify({
    schemaVersion: 1,
    packageIdentifier: "rullerzhou-afk.clawd-on-desk",
    version: plan.version,
    releaseTag: plan.releaseTag,
    manifestDirectory: plan.manifestRelativePath,
    fileDigests,
    errors: [],
  }), "utf8");
  return { root, generatedRoot, expectedDigests, plan };
}

function cleanup(testFixture) {
  fs.rmSync(testFixture.root, { recursive: true, force: true });
}

function fakeExecutor(
  testFixture,
  {
    branchExists = false,
    catalogExists = false,
    existingPullRequest = false,
    ownPullRequest = false,
    searchResponse = null,
  } = {},
) {
  const calls = [];
  const execute = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    if (command === "gh" && args[0] === "api" && args[1]?.includes("/contents/")) {
      return catalogExists
        ? { status: 0, stdout: "{}", stderr: "" }
        : { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    if (command === "gh" && args.includes("search/issues")) {
      return {
        status: 0,
        stdout: JSON.stringify(searchResponse || {
          total_count: existingPullRequest ? 1 : 0,
          incomplete_results: false,
          items: existingPullRequest
            ? [{ number: 42, html_url: "https://github.com/microsoft/winget-pkgs/pull/42" }]
            : [],
        }),
        stderr: "",
      };
    }
    if (command === "gh" && args.includes("repos/microsoft/winget-pkgs/pulls") &&
        args.some((arg) => arg.startsWith("head="))) {
      return {
        status: 0,
        stdout: JSON.stringify(
          ownPullRequest
            ? [{ number: 41, html_url: "https://github.com/microsoft/winget-pkgs/pull/41" }]
            : [],
        ),
        stderr: "",
      };
    }
    if (command === "gh" && args.some((arg) => /\/pulls\/(41|42)\/files/.test(arg))) {
      return {
        status: 0,
        stdout: JSON.stringify([[
          { filename: `${testFixture.plan.manifestRelativePath}/${MANIFEST_FILES.version}` },
        ]]),
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "api" && args[1] === "repos/rullerzhou-afk/winget-pkgs") {
      return {
        status: 0,
        stdout: JSON.stringify({
          fork: true,
          parent: { full_name: "microsoft/winget-pkgs" },
        }),
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "api" && args[1] === "user") {
      return {
        status: 0,
        stdout: JSON.stringify({ id: 228746293, login: "rullerzhou-afk" }),
        stderr: "",
      };
    }
    if (command === "gh" && args.some((arg) => arg.includes("/git/ref/heads/"))) {
      return branchExists
        ? { status: 0, stdout: "{}", stderr: "" }
        : { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    if (command === "git" && args[0] === "clone") {
      fs.mkdirSync(args.at(-1), { recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "diff" && args.includes("--name-only")) {
      return {
        status: 0,
        stdout: `${expectedManifestPaths(testFixture.plan).join("\0")}\0`,
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return {
        status: 0,
        stdout: "https://github.com/microsoft/winget-pkgs/pull/999999\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, execute };
}

describe("WinGet submit planner", () => {
  it("derives a bounded branch and exact manifest path from validated inputs", () => {
    const plan = buildSubmissionPlan({ ...INPUT, generatedRoot: "/tmp/generated" });
    assert.equal(plan.version, "1.2.3");
    assert.equal(plan.branch, "automation/clawd-1.2.3");
    assert.equal(
      plan.manifestRelativePath,
      "manifests/r/rullerzhou-afk/clawd-on-desk/1.2.3",
    );
    assert.equal(expectedManifestPaths(plan).length, 4);
  });

  it("rejects shell-shaped repository, owner, tag, and run inputs", () => {
    for (const patch of [
      { forkOwner: "owner;echo" },
      { releaseTag: "v1.2.3;echo" },
      { runId: "1;echo" },
      { runAttempt: "$(echo)" },
      { sourceRepository: "owner/repo;echo" },
    ]) {
      assert.throws(
        () => buildSubmissionPlan({ ...INPUT, generatedRoot: "/tmp/generated", ...patch }),
      );
    }
    assert.throws(
      () => buildSubmissionPlan({
        ...INPUT,
        expectedDigests: "",
        generatedRoot: "/tmp/generated",
      }),
      /expected digests report is required/,
    );
  });

  it("builds a PR body that records the exact automated validation boundary", () => {
    const plan = buildSubmissionPlan({ ...INPUT, generatedRoot: "/tmp/generated" });
    const body = buildPullRequestBody(plan, "https://github.com/example/actions/runs/123");
    assert.match(body, /four installer combinations/);
    assert.match(body, /four-entry architecture\/scope matrix/);
    assert.match(body, /Microsoft's Windows validation pipeline/);
    assert.doesNotMatch(body, /winget validate.*passed/i);
  });

  it("parses every CLI option and rejects unknown arguments", () => {
    assert.deepEqual(
      parseArgs([
        "--fork-owner", "owner",
        "--expected-digests", "digests.json",
        "--generated-root", "generated",
        "--output", "report.json",
        "--release-tag", "v1.2.3",
        "--run-attempt", "2",
        "--run-id", "123",
        "--source-repository", "owner/repo",
      ]),
      {
        forkOwner: "owner",
        expectedDigests: "digests.json",
        generatedRoot: "generated",
        output: "report.json",
        releaseTag: "v1.2.3",
        runAttempt: "2",
        runId: "123",
        sourceRepository: "owner/repo",
      },
    );
    assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  });
});

describe("WinGet submission transaction", () => {
  it("copies and submits only the four verified files without placing the token in arguments", () => {
    const testFixture = fixture();
    try {
      const fake = fakeExecutor(testFixture);
      const report = runSubmission(
        {
          ...INPUT,
          generatedRoot: testFixture.generatedRoot,
          expectedDigests: testFixture.expectedDigests,
        },
        {
          env: {
            GH_TOKEN: "top-secret-token",
            GITHUB_SERVER_URL: "https://github.com",
            RUNNER_TEMP: testFixture.root,
          },
          execute: fake.execute,
          tempRoot: testFixture.root,
        },
      );
      assert.equal(report.status, "submitted");
      assert.equal(
        report.pullRequestUrl,
        "https://github.com/microsoft/winget-pkgs/pull/999999",
      );
      assert.ok(fake.calls.some((call) => call.command === "git" && call.args[0] === "push"));
      assert.ok(fake.calls.some((call) => call.command === "gh" && call.args[0] === "pr"));
      for (const call of fake.calls) {
        assert.doesNotMatch(call.args.join(" "), /top-secret-token/);
      }
    } finally {
      cleanup(testFixture);
    }
  });

  it("skips without a write when the version is already published", () => {
    const testFixture = fixture();
    try {
      const fake = fakeExecutor(testFixture, { catalogExists: true });
      const report = runSubmission(
        {
          ...INPUT,
          generatedRoot: testFixture.generatedRoot,
          expectedDigests: testFixture.expectedDigests,
        },
        { env: { GH_TOKEN: "token" }, execute: fake.execute },
      );
      assert.equal(report.status, "skipped");
      assert.equal(report.reason, "already-published");
      assert.equal(fake.calls.some((call) => call.command === "git"), false);
    } finally {
      cleanup(testFixture);
    }
  });

  it("skips without a write when an open PR already owns the exact manifest path", () => {
    const testFixture = fixture();
    try {
      const fake = fakeExecutor(testFixture, { existingPullRequest: true });
      const report = runSubmission(
        {
          ...INPUT,
          generatedRoot: testFixture.generatedRoot,
          expectedDigests: testFixture.expectedDigests,
        },
        { env: { GH_TOKEN: "token" }, execute: fake.execute },
      );
      assert.equal(report.status, "skipped");
      assert.equal(report.reason, "open-pull-request");
      assert.equal(report.pullRequestUrl, "https://github.com/microsoft/winget-pkgs/pull/42");
      assert.equal(fake.calls.some((call) => call.command === "git"), false);
    } finally {
      cleanup(testFixture);
    }
  });

  it("skips without a write when the deterministic branch already owns an open PR", () => {
    const testFixture = fixture();
    try {
      const fake = fakeExecutor(testFixture, { ownPullRequest: true });
      const report = runSubmission(
        {
          ...INPUT,
          generatedRoot: testFixture.generatedRoot,
          expectedDigests: testFixture.expectedDigests,
        },
        { env: { GH_TOKEN: "token" }, execute: fake.execute },
      );
      assert.equal(report.status, "skipped");
      assert.equal(report.reason, "open-pull-request");
      assert.equal(report.pullRequestUrl, "https://github.com/microsoft/winget-pkgs/pull/41");
      assert.equal(fake.calls.some((call) => call.command === "git"), false);
    } finally {
      cleanup(testFixture);
    }
  });

  it("fails closed when a manifest changes after its digest report was written", () => {
    const testFixture = fixture();
    try {
      fs.appendFileSync(
        path.join(testFixture.plan.generatedManifestDirectory, MANIFEST_FILES.version),
        "changed\n",
      );
      const fake = fakeExecutor(testFixture);
      assert.throws(
        () => runSubmission(
          {
            ...INPUT,
            generatedRoot: testFixture.generatedRoot,
            expectedDigests: testFixture.expectedDigests,
          },
          { env: { GH_TOKEN: "token" }, execute: fake.execute },
        ),
        /changed after validation/,
      );
      assert.equal(fake.calls.length, 0);
    } finally {
      cleanup(testFixture);
    }
  });

  it("fails closed when the deterministic fork branch exists without an open PR", () => {
    const testFixture = fixture();
    try {
      const fake = fakeExecutor(testFixture, { branchExists: true });
      assert.throws(
        () => runSubmission(
          {
            ...INPUT,
            generatedRoot: testFixture.generatedRoot,
            expectedDigests: testFixture.expectedDigests,
          },
          { env: { GH_TOKEN: "token" }, execute: fake.execute },
        ),
        /exists without an open pull request/,
      );
      assert.equal(fake.calls.some((call) => call.command === "git"), false);
    } finally {
      cleanup(testFixture);
    }
  });

  it("fails closed when the open-PR search is incomplete or malformed", () => {
    for (const searchResponse of [
      { total_count: 0, items: [] },
      { total_count: 0, incomplete_results: true, items: [] },
      { total_count: 1, incomplete_results: false, items: [{}] },
    ]) {
      const testFixture = fixture();
      try {
        const fake = fakeExecutor(testFixture, { searchResponse });
        assert.throws(
          () => runSubmission(
            {
              ...INPUT,
              generatedRoot: testFixture.generatedRoot,
              expectedDigests: testFixture.expectedDigests,
            },
            { env: { GH_TOKEN: "token" }, execute: fake.execute },
          ),
          /unexpected shape|incomplete/,
        );
        assert.equal(fake.calls.some((call) => call.command === "git"), false);
      } finally {
        cleanup(testFixture);
      }
    }
  });

  it("fails closed before any network call when the submission token is absent", () => {
    const testFixture = fixture();
    try {
      const fake = fakeExecutor(testFixture);
      assert.throws(
        () => runSubmission(
          {
            ...INPUT,
            generatedRoot: testFixture.generatedRoot,
            expectedDigests: testFixture.expectedDigests,
          },
          { env: {}, execute: fake.execute },
        ),
        /GH_TOKEN is required/,
      );
      assert.equal(fake.calls.length, 0);
    } finally {
      cleanup(testFixture);
    }
  });
});
