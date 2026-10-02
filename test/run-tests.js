const { spawnSync } = require("node:child_process");
const { mkdirSync, readdirSync } = require("node:fs");
const path = require("node:path");

const DEFAULT_TEST_TIMEOUT_MS = 120000;

// Without a per-test timeout a hung test is not a failure: `node --test` waits
// on it forever, the remaining files never run, and no summary is printed -- so
// a regression that deadlocks one test reads as "the suite is still going"
// locally and as a stalled job in CI. A generous ceiling turns that into a
// normal red. Raise it with CLAWD_TEST_TIMEOUT_MS if a legitimately slow test
// ever needs more; 0 disables it.
function resolveTimeoutArgs(env = process.env) {
  // Number("") is 0, and 0 means "no timeout" -- so an empty or whitespace
  // override would silently remove the protection instead of falling back.
  const raw = env.CLAWD_TEST_TIMEOUT_MS;
  const configured = raw === undefined || String(raw).trim() === "" ? NaN : Number(raw);
  const timeoutMs = Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_TEST_TIMEOUT_MS;
  return timeoutMs > 0 ? [`--test-timeout=${timeoutMs}`] : [];
}

// The default spec reporter collapses a whole-file failure into a bare
// "test failed" line: it does not print the child's exit code or signal, so a
// SIGKILL, a native crash and a self-initiated process.exit all look the same.
// CI could not tell "another process killed the runner" from "Node crashed".
// Node's TAP reporter does record exitCode / signal, so when CLAWD_TEST_REPORT_FILE
// names a file we tee both reporters to it -- spec stays on stdout (local output
// is unchanged) and CI uploads the TAP file only when the job fails.
function resolveReportFilePath(env = process.env) {
  // An empty or whitespace-only override means "no report", not "a file named
  // spaces"; fall back to the default output rather than creating a stray file.
  const raw = env.CLAWD_TEST_REPORT_FILE;
  const configured = raw === undefined ? "" : String(raw).trim();
  if (configured === "") return null;
  return path.resolve(path.join(__dirname, ".."), configured);
}

function resolveReporterArgs(env = process.env) {
  const reportFilePath = resolveReportFilePath(env);
  if (reportFilePath === null) return [];
  return [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${reportFilePath}`,
  ];
}

function resolveTestRunnerInvocation(env = process.env) {
  // Node expands this single glob itself (Node 24 is pinned in .nvmrc).
  // Passing every absolute filename exceeded Windows' command-line limit once
  // the suite grew past 500 files and failed with ENAMETOOLONG before a single
  // assertion ran. Default recursive discovery is intentionally not used: it
  // would also execute helper scripts under test/fixtures/.
  return {
    args: [
      "--test",
      ...resolveTimeoutArgs(env),
      ...resolveReporterArgs(env),
      "test/*.test.js",
    ],
    cwd: path.join(__dirname, ".."),
  };
}

module.exports = {
  DEFAULT_TEST_TIMEOUT_MS,
  resolveTimeoutArgs,
  resolveReportFilePath,
  resolveReporterArgs,
  resolveTestRunnerInvocation,
};

// Requiring this file must not scan the directory or exit the process.
if (require.main !== module) return;

const testDir = __dirname;
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error("No test/*.test.js files found.");
  process.exit(1);
}

// Without a per-test timeout a hung test is not a failure: `node --test` waits
// on it forever, the remaining files never run, and no summary is printed -- so
// a regression that deadlocks one test reads as "the suite is still going"
// locally and as a stalled job in CI. A generous ceiling turns that into a
// normal red. Raise it with CLAWD_TEST_TIMEOUT_MS if a legitimately slow test
// ever needs more; 0 disables it.
const invocation = resolveTestRunnerInvocation();
const reportFilePath = resolveReportFilePath();
if (reportFilePath !== null) {
  mkdirSync(path.dirname(reportFilePath), { recursive: true });
}
const result = spawnSync(process.execPath, invocation.args, {
  cwd: invocation.cwd,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
