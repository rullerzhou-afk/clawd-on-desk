#!/usr/bin/env node
"use strict";

// Submits one already-normalized and verified WinGet manifest tree.
//
// This deliberately does not call `komac update --submit`: doing so would
// regenerate the manifest after the output gate and could reintroduce metadata
// drift. The exact four files that passed verification are copied to a fresh
// branch based on microsoft/winget-pkgs master and opened as a one-version PR.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MANIFEST_FILES,
  PACKAGE_IDENTIFIER,
  PUBLISHER_PATH,
} = require("./verify-winget-generated-manifest.js");

const UPSTREAM_REPOSITORY = "microsoft/winget-pkgs";
const FORK_REPOSITORY = "winget-pkgs";
const PACKAGE_PATH = ["manifests", ...PUBLISHER_PATH];

function parseArgs(argv) {
  const options = {
    forkOwner: "",
    generatedRoot: "",
    expectedDigests: "",
    output: "",
    releaseTag: "",
    runAttempt: "",
    runId: "",
    sourceRepository: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fork-owner") options.forkOwner = argv[++index] || "";
    else if (arg === "--generated-root") options.generatedRoot = argv[++index] || "";
    else if (arg === "--expected-digests") options.expectedDigests = argv[++index] || "";
    else if (arg === "--output") options.output = argv[++index] || "";
    else if (arg === "--release-tag") options.releaseTag = argv[++index] || "";
    else if (arg === "--run-attempt") options.runAttempt = argv[++index] || "";
    else if (arg === "--run-id") options.runId = argv[++index] || "";
    else if (arg === "--source-repository") options.sourceRepository = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function execute(command, args, { cwd = process.cwd(), env = process.env, allow = [0] } = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allow.includes(result.status)) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}` +
      (detail ? `:\n${detail}` : ""),
    );
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function requireJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function buildSubmissionPlan({
  forkOwner,
  generatedRoot,
  expectedDigests,
  releaseTag,
  runAttempt,
  runId,
  sourceRepository,
}) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(forkOwner || "")) {
    throw new Error(`fork owner is invalid: ${JSON.stringify(forkOwner)}`);
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(releaseTag || "")) {
    throw new Error(`release tag must be vMAJOR.MINOR.PATCH: ${JSON.stringify(releaseTag)}`);
  }
  if (!/^[0-9]+$/.test(runId || "")) throw new Error("run id must contain digits only");
  if (!/^[0-9]+$/.test(runAttempt || "")) throw new Error("run attempt must contain digits only");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository || "")) {
    throw new Error(`source repository is invalid: ${JSON.stringify(sourceRepository)}`);
  }

  const version = releaseTag.slice(1);
  const manifestRelativePath = [...PACKAGE_PATH, version].join("/");
  const generatedManifestDirectory = path.join(
    path.resolve(generatedRoot),
    ...PACKAGE_PATH,
    version,
  );
  if (!expectedDigests) throw new Error("expected digests report is required");
  const branch = `automation/clawd-${version}`;
  return {
    version,
    releaseTag,
    forkOwner,
    sourceRepository,
    branch,
    expectedDigestsPath: path.resolve(expectedDigests),
    manifestRelativePath,
    generatedManifestDirectory,
    title: `Update: ${PACKAGE_IDENTIFIER} to ${version}`,
  };
}

function expectedManifestPaths(plan) {
  return Object.values(MANIFEST_FILES)
    .map((filename) => `${plan.manifestRelativePath}/${filename}`)
    .sort();
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateGeneratedFiles(plan) {
  const actual = fs.readdirSync(plan.generatedManifestDirectory, { withFileTypes: true });
  const names = actual.map((entry) => entry.name).sort();
  const expected = Object.values(MANIFEST_FILES).sort();
  if (names.join("\n") !== expected.join("\n")) {
    throw new Error(
      `generated manifest directory must contain exactly ${expected.join(", ")}; ` +
      `got ${names.join(", ") || "none"}`,
    );
  }
  for (const entry of actual) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${entry.name} must be a regular file`);
    }
  }

  const report = requireJson(
    fs.readFileSync(plan.expectedDigestsPath, "utf8"),
    "expected digests report",
  );
  if (report.schemaVersion !== 1 || report.packageIdentifier !== PACKAGE_IDENTIFIER ||
      report.version !== plan.version || report.releaseTag !== plan.releaseTag ||
      report.manifestDirectory !== plan.manifestRelativePath ||
      !Array.isArray(report.errors) || report.errors.length !== 0 ||
      !report.fileDigests || typeof report.fileDigests !== "object" ||
      Array.isArray(report.fileDigests)) {
    throw new Error("expected digests report does not match the submission plan");
  }
  const expectedPaths = expectedManifestPaths(plan);
  const digestPaths = Object.keys(report.fileDigests).sort();
  if (digestPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error("expected digests report must cover exactly the four submitted manifests");
  }
  for (const relativePath of expectedPaths) {
    const expectedDigest = report.fileDigests[relativePath];
    if (typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
      throw new Error(`expected digest is invalid for ${relativePath}`);
    }
    const filename = path.basename(relativePath);
    const actualDigest = `sha256:${sha256(path.join(plan.generatedManifestDirectory, filename))}`;
    if (actualDigest !== expectedDigest) {
      throw new Error(`generated manifest changed after validation: ${relativePath}`);
    }
  }
}

function readPullRequestFiles(runGh, number) {
  const pages = requireJson(
    runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${UPSTREAM_REPOSITORY}/pulls/${number}/files?per_page=100`,
    ]).stdout,
    `pull request ${number} files`,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`pull request ${number} files returned an unexpected shape`);
  }
  return pages.flat();
}

function pullRequestOwnsManifestPath(runGh, plan, pullRequest) {
  if (!Number.isInteger(pullRequest.number)) return false;
  return readPullRequestFiles(runGh, pullRequest.number).some((file) =>
    typeof file.filename === "string" &&
    file.filename.startsWith(`${plan.manifestRelativePath}/`),
  );
}

function findPullRequestByHead(runGh, plan) {
  const pulls = requireJson(
    runGh([
      "api",
      "-X", "GET",
      `repos/${UPSTREAM_REPOSITORY}/pulls`,
      "-f", "state=open",
      "-f", "base=master",
      "-f", `head=${plan.forkOwner}:${plan.branch}`,
      "-f", "per_page=100",
    ]).stdout,
    "pull request head lookup",
  );
  if (!Array.isArray(pulls)) throw new Error("pull request head lookup returned an unexpected shape");
  if (pulls.length > 1) throw new Error(`multiple open pull requests use ${plan.forkOwner}:${plan.branch}`);
  if (pulls.length === 0) return "";
  if (!pullRequestOwnsManifestPath(runGh, plan, pulls[0])) {
    throw new Error(`open pull request for ${plan.forkOwner}:${plan.branch} owns another path`);
  }
  return pulls[0].html_url ||
    `https://github.com/${UPSTREAM_REPOSITORY}/pull/${pulls[0].number}`;
}

function findExistingPullRequest(runGh, plan) {
  const query =
    `repo:${UPSTREAM_REPOSITORY} is:pr is:open ` +
    `"${PACKAGE_IDENTIFIER}" "${plan.version}"`;
  const search = requireJson(
    runGh(["api", "-X", "GET", "search/issues", "-f", `q=${query}`, "-f", "per_page=100"])
      .stdout,
    "pull request search",
  );
  if (!Number.isInteger(search.total_count) || !Array.isArray(search.items) ||
      search.incomplete_results !== false) {
    throw new Error("pull request search returned an incomplete or unexpected shape");
  }
  if (search.total_count > search.items.length) {
    throw new Error("pull request search result is truncated; refusing to submit");
  }
  for (const item of search.items || []) {
    if (!Number.isInteger(item.number)) {
      throw new Error("pull request search item returned an unexpected shape");
    }
    if (pullRequestOwnsManifestPath(runGh, plan, item)) {
      return item.html_url || `https://github.com/${UPSTREAM_REPOSITORY}/pull/${item.number}`;
    }
  }
  return "";
}

function buildPullRequestBody(plan, runUrl) {
  return `## 📖 Description
Update \`${PACKAGE_IDENTIFIER}\` to **${plan.version}** from the published [${plan.releaseTag} release](https://github.com/${plan.sourceRepository}/releases/tag/${plan.releaseTag}).

Preserves all four installer combinations: x64 and arm64, each with user and machine scope. Installer URLs and SHA256 values match the published release assets. Retains the NSIS ProductCode, \`/currentuser\` and \`/allusers\` switches, and \`--updated\` upgrade switch.

Generated, normalized, and fail-closed validated by [Clawd's WinGet release workflow](${runUrl}). The output gate rewrites the license and version-pinned metadata to their canonical values, then asserts those values together with the exact package/version, four-entry architecture/scope matrix, release URLs and hashes, switches, ProductCode and AppsAndFeatures metadata before this PR can be created.

## ✅ Checklist
- [ ] Signed the Contributor License Agreement (Microsoft CLA bot to verify the submitting account)
- Linked issue: not applicable; this is a new version submission.

## 📦 Manifest Checklist
- [x] Checked the catalog and open-PR results; a deterministic branch guard prevents self-duplicates
- [x] This PR only modifies one package version (\`${plan.version}\`)
- [x] Generated manifest passed the repository's architecture and output contracts
- [ ] Native \`winget validate\` and install checks are delegated to Microsoft's Windows validation pipeline
`;
}

function runSubmission(options, dependencies = {}) {
  const command = dependencies.execute || execute;
  const env = { ...process.env, ...(dependencies.env || {}) };
  const token = env.GH_TOKEN || "";
  if (!token) throw new Error("GH_TOKEN is required for WinGet submission");
  const plan = buildSubmissionPlan(options);
  validateGeneratedFiles(plan);

  const runGh = (args, commandOptions = {}) => command("gh", args, {
    ...commandOptions,
    env,
  });
  const runGit = (args, commandOptions = {}) => command("git", args, {
    ...commandOptions,
    env,
  });

  const catalog = runGh(
    ["api", `repos/${UPSTREAM_REPOSITORY}/contents/${plan.manifestRelativePath}`, "--silent"],
    { allow: [0, 1] },
  );
  if (catalog.status === 0) {
    return { status: "skipped", reason: "already-published", ...plan };
  }
  if (!/HTTP 404|Not Found/i.test(catalog.stderr)) {
    throw new Error(`catalog lookup failed:\n${catalog.stderr || catalog.stdout}`);
  }

  const ownPullRequest = findPullRequestByHead(runGh, plan);
  if (ownPullRequest) {
    return {
      status: "skipped",
      reason: "open-pull-request",
      pullRequestUrl: ownPullRequest,
      ...plan,
    };
  }

  const existingPullRequest = findExistingPullRequest(runGh, plan);
  if (existingPullRequest) {
    return {
      status: "skipped",
      reason: "open-pull-request",
      pullRequestUrl: existingPullRequest,
      ...plan,
    };
  }

  const fork = requireJson(
    runGh(["api", `repos/${plan.forkOwner}/${FORK_REPOSITORY}`]).stdout,
    "fork lookup",
  );
  if (!fork.fork || fork.parent?.full_name !== UPSTREAM_REPOSITORY) {
    throw new Error(
      `${plan.forkOwner}/${FORK_REPOSITORY} must be a fork of ${UPSTREAM_REPOSITORY}`,
    );
  }
  const account = requireJson(runGh(["api", "user"]).stdout, "authenticated user lookup");
  if (String(account.login || "").toLowerCase() !== plan.forkOwner.toLowerCase()) {
    throw new Error(
      `WINGET_TOKEN belongs to ${account.login || "an unknown account"}, ` +
      `not fork owner ${plan.forkOwner}`,
    );
  }
  if (!Number.isInteger(account.id)) throw new Error("authenticated GitHub account has no numeric id");

  const branchRef = runGh(
    ["api", `repos/${plan.forkOwner}/${FORK_REPOSITORY}/git/ref/heads/${plan.branch}`],
    { allow: [0, 1] },
  );
  if (branchRef.status === 0) {
    throw new Error(
      `fork branch ${plan.forkOwner}:${plan.branch} exists without an open pull request; ` +
      `inspect it before retrying`,
    );
  }
  if (!/HTTP 404|Not Found/i.test(branchRef.stderr)) {
    throw new Error(`fork branch lookup failed:\n${branchRef.stderr || branchRef.stdout}`);
  }

  const tempBase = dependencies.tempRoot || env.RUNNER_TEMP || os.tmpdir();
  const tempDirectory = fs.mkdtempSync(path.join(tempBase, "clawd-winget-submit-"));
  const checkout = path.join(tempDirectory, "winget-pkgs");
  try {
    runGh(["auth", "setup-git"]);
    runGit([
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--depth=1",
      "--single-branch",
      `https://github.com/${plan.forkOwner}/${FORK_REPOSITORY}.git`,
      checkout,
    ]);
    runGit(["remote", "add", "upstream", `https://github.com/${UPSTREAM_REPOSITORY}.git`], {
      cwd: checkout,
    });
    runGit(["fetch", "--filter=blob:none", "--depth=1", "upstream", "master"], {
      cwd: checkout,
    });
    runGit(["sparse-checkout", "init", "--cone"], { cwd: checkout });
    runGit(["sparse-checkout", "set", PACKAGE_PATH.join("/")], { cwd: checkout });
    runGit(["checkout", "-b", plan.branch, "upstream/master"], { cwd: checkout });

    const targetDirectory = path.join(checkout, ...plan.manifestRelativePath.split("/"));
    if (fs.existsSync(targetDirectory)) {
      return { status: "skipped", reason: "published-during-submission", ...plan };
    }
    fs.mkdirSync(targetDirectory, { recursive: true });
    for (const filename of Object.values(MANIFEST_FILES)) {
      fs.copyFileSync(
        path.join(plan.generatedManifestDirectory, filename),
        path.join(targetDirectory, filename),
        fs.constants.COPYFILE_EXCL,
      );
    }

    runGit(["add", "--", plan.manifestRelativePath], { cwd: checkout });
    const staged = runGit(["diff", "--cached", "--name-only", "-z"], { cwd: checkout })
      .stdout.split("\0").filter(Boolean).sort();
    const expected = expectedManifestPaths(plan);
    if (staged.join("\n") !== expected.join("\n")) {
      throw new Error(
        `staged paths must be exactly the four verified manifests; got ${staged.join(", ")}`,
      );
    }
    runGit(["diff", "--cached", "--check"], { cwd: checkout });
    runGit(["config", "user.name", account.login], { cwd: checkout });
    runGit(
      ["config", "user.email", `${account.id}+${account.login}@users.noreply.github.com`],
      { cwd: checkout },
    );
    runGit(["commit", "-m", plan.title], { cwd: checkout });
    runGit(["push", "--set-upstream", "origin", plan.branch], { cwd: checkout });

    const runUrl =
      `${env.GITHUB_SERVER_URL || "https://github.com"}/${plan.sourceRepository}/` +
      `actions/runs/${options.runId}`;
    const bodyPath = path.join(tempDirectory, "pr-body.md");
    fs.writeFileSync(bodyPath, buildPullRequestBody(plan, runUrl), "utf8");
    const pullRequestUrl = runGh([
      "pr",
      "create",
      "--repo", UPSTREAM_REPOSITORY,
      "--base", "master",
      "--head", `${plan.forkOwner}:${plan.branch}`,
      "--title", plan.title,
      "--body-file", bodyPath,
    ]).stdout.trim();
    if (!/^https:\/\/github\.com\/microsoft\/winget-pkgs\/pull\/[0-9]+$/.test(pullRequestUrl)) {
      throw new Error(`gh pr create returned an unexpected URL: ${pullRequestUrl}`);
    }
    return { status: "submitted", pullRequestUrl, ...plan };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const report = runSubmission(options, { env });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FORK_REPOSITORY,
  PACKAGE_PATH,
  UPSTREAM_REPOSITORY,
  buildPullRequestBody,
  buildSubmissionPlan,
  expectedManifestPaths,
  findExistingPullRequest,
  findPullRequestByHead,
  parseArgs,
  runSubmission,
  validateGeneratedFiles,
};
