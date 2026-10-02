"use strict";

// The default spec reporter does not print a crashed file's exit code or
// signal, so CI could not distinguish a SIGKILL from a native crash or a
// self-initiated process.exit. These tests pin the opt-in TAP teeing (driven by
// CLAWD_TEST_REPORT_FILE), the workflow that turns it into a failure-only
// artifact upload, and the actual startup path end to end.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const {
  DEFAULT_TEST_TIMEOUT_MS,
  resolveReporterArgs,
  resolveTestRunnerInvocation,
} = require("./run-tests");

const ROOT = path.join(__dirname, "..");
const REPORT_VAR = "CLAWD_TEST_REPORT_FILE";
const REPORT_DESTINATION = "${{ runner.temp }}/node-test-report.tap";

test("CI test report: no override keeps the default invocation untouched", () => {
  for (const env of [{}, { [REPORT_VAR]: "" }, { [REPORT_VAR]: "   " }, { [REPORT_VAR]: "\t\n" }]) {
    assert.deepStrictEqual(resolveReporterArgs(env), [], `env ${JSON.stringify(env)} must not add reporters`);
    assert.deepStrictEqual(resolveTestRunnerInvocation(env).args, [
      "--test",
      `--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
      "test/*.test.js",
    ]);
  }
});

test("CI test report: a configured path tees spec plus a resolved TAP file", () => {
  const relative = resolveReporterArgs({ [REPORT_VAR]: "reports/ci/r.tap" });
  assert.deepStrictEqual(relative, [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${path.join(ROOT, "reports", "ci", "r.tap")}`,
  ]);
  assert.ok(path.isAbsolute(relative[relative.length - 1].slice("--test-reporter-destination=".length)));

  const absolutePath = path.join(ROOT, "tmp", "absolute.tap");
  assert.deepStrictEqual(resolveReporterArgs({ [REPORT_VAR]: absolutePath }), [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${absolutePath}`,
  ]);
});

test("CI test report: report args sit before the glob and keep the timeout", () => {
  const { args } = resolveTestRunnerInvocation({ [REPORT_VAR]: "r.tap" });
  assert.strictEqual(args[0], "--test");
  assert.ok(args.includes(`--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`), "timeout must survive");
  assert.strictEqual(args[args.length - 1], "test/*.test.js", "the glob stays last");
  assert.deepStrictEqual(args.slice(2, args.length - 1), [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${path.join(ROOT, "r.tap")}`,
  ]);
});

// GitHub expressions may or may not be wrapped in ${{ }}; normalize before
// comparing so an equivalent spelling is not a false failure.
function unwrapExpression(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "")
    .trim();
}

test("CI test report: workflow uploads the TAP report only on failure", () => {
  const workflow = yaml.load(fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8"));
  const steps = workflow.jobs.test.steps;

  // Identify by the command actually run, not by the step's display name.
  const fullSuiteSteps = steps.filter(
    (step) => step.run === "npm test" || step.run === "xvfb-run -a npm test",
  );
  assert.strictEqual(fullSuiteSteps.length, 2, "both Linux and non-Linux full-suite steps must exist");
  for (const step of fullSuiteSteps) {
    assert.strictEqual(step.env?.[REPORT_VAR], REPORT_DESTINATION);
  }

  const uploadStep = steps.find((step) => step.uses === "actions/upload-artifact@v4");
  assert.ok(uploadStep, "an upload-artifact@v4 step must exist");
  assert.strictEqual(unwrapExpression(uploadStep.if), "failure()");
  assert.strictEqual(uploadStep.with?.path, REPORT_DESTINATION);
  assert.strictEqual(uploadStep.with?.["retention-days"], 14);
  // Without the matrix suffix all three platforms collide on one artifact name.
  assert.strictEqual(uploadStep.with?.name, "node-test-report-${{ matrix.os }}");
  assert.strictEqual(uploadStep.with?.["if-no-files-found"], "ignore");
  assert.ok(
    steps.indexOf(uploadStep) > steps.indexOf(fullSuiteSteps[fullSuiteSteps.length - 1]),
    "upload must follow the full-suite steps",
  );
});

const PASS_FIXTURE = [
  '"use strict";',
  'const assert = require("node:assert/strict");',
  'const test = require("node:test");',
  'test("passes", () => { assert.ok(true); });',
  "",
].join("\n");

// The first subtest passes, then the file exits before the suite can finish --
// the same "backend exited early" shape that produced the CI mystery.
const EXIT_FIXTURE = [
  '"use strict";',
  'const assert = require("node:assert/strict");',
  'const test = require("node:test");',
  'test("passes before exiting", () => { assert.ok(true); });',
  'test("exits with code 3", () => { setTimeout(() => process.exit(3), 10); });',
  // Keeps the process alive so the pending exit fires mid-run instead of after
  // the synchronous subtests have already finished.
  'test("holds the run open", async () => { await new Promise((r) => setTimeout(r, 1000)); });',
  'test("never runs", () => { assert.fail("must not run"); });',
  "",
].join("\n");

function makeRunnerRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-run-tests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const testDir = path.join(root, "repo", "test");
  fs.mkdirSync(testDir, { recursive: true });
  // A verbatim copy so the startup path (env read, mkdir, spawn, exit code) is
  // exercised, not just the argument builders.
  fs.copyFileSync(path.join(__dirname, "run-tests.js"), path.join(testDir, "run-tests.js"));
  return { root, testDir };
}

// reportRelativePath is null when the override must stay unset; the candidate
// location is still returned so a leak can be asserted against.
function runRunner(t, fixtures, reportRelativePath) {
  const { root, testDir } = makeRunnerRepo(t);
  for (const [name, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(testDir, name), content);
  }
  const reportFile = reportRelativePath == null ? null : path.join(root, reportRelativePath);
  const env = { ...process.env };
  // This test itself runs under `node --test`, which sets NODE_TEST_CONTEXT; an
  // inherited value would make the nested runner emit serialized events instead
  // of reporter text.
  delete env.NODE_TEST_CONTEXT;
  if (reportFile === null) delete env[REPORT_VAR];
  else env[REPORT_VAR] = reportFile;
  const result = spawnSync(process.execPath, [path.join(testDir, "run-tests.js")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  return { root, result, reportFile };
}

test("CI test report: startup script writes a nested report when a file exits early", (t) => {
  const harness = runRunner(
    t,
    { "a-pass.test.js": PASS_FIXTURE, "b-exit.test.js": EXIT_FIXTURE },
    path.join("out", "nested", "report.tap"),
  );
  const result = harness.result;
  assert.strictEqual(result.status, 1, result.stderr);
  assert.match(result.stdout, /✖/, "console must stay on the spec reporter");
  assert.match(result.stdout, /b-exit\.test\.js/);
  assert.doesNotMatch(result.stdout, /TAP version 13/);
  assert.ok(fs.existsSync(harness.reportFile), "the runner must create the nested report path itself");
  const tap = fs.readFileSync(harness.reportFile, "utf8");
  assert.match(tap, /exitCode: 3/);
  assert.match(tap, /# fail 1/);
});

test("CI test report: startup script writes a green report when the suite passes", (t) => {
  // A new path so it cannot be satisfied by the previous scenario's file.
  const harness = runRunner(t, { "a-pass.test.js": PASS_FIXTURE }, path.join("out2", "report.tap"));
  assert.strictEqual(harness.result.status, 0, harness.result.stderr);
  assert.ok(fs.existsSync(harness.reportFile));
  assert.match(fs.readFileSync(harness.reportFile, "utf8"), /# fail 0/);
});

test("CI test report: startup script writes no report when the override is unset", (t) => {
  const harness = runRunner(t, { "a-pass.test.js": PASS_FIXTURE }, null);
  assert.strictEqual(harness.result.status, 0, harness.result.stderr);
  assert.equal(
    fs.existsSync(path.join(harness.root, "out", "report.tap")),
    false,
    "no report may be created without the override",
  );
});
