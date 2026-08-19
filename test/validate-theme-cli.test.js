"use strict";

// Exercises the REAL CLI (scripts/validate-theme.js) via spawnSync rather than the
// internal theme-loader functions it calls: what a caller observes is the process
// exit status and the message, so that is what these assert.
//
// Every failure exits 1 -- the script draws no machine-readable distinction between
// "the command was wrong" and "the theme is broken". The distinction lives in the
// message, which is why each case below asserts on stderr/stdout and not on the
// status alone. Each fixture is chosen so it can fail for only the reason named --
// see the per-case comment.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it, afterEach } = require("node:test");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "validate-theme.js");
const CALICO = path.join(REPO_ROOT, "themes", "calico");

const tempDirs = [];

function runValidateTheme(args, { cwd = REPO_ROOT } = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}

// The summary line is `<n> error(s)[, <m> warning(s)]. Fix errors ...`, wrapped in
// ANSI. Read the count rather than a glyph: it tracks what the validator DID, not
// how it painted it.
function errorCount(stdout) {
  const m = stdout.match(/(\d+) error\(s\)/);
  assert.ok(m, `no error summary in:\n${stdout}`);
  return Number(m[1]);
}

function mkTempThemeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-validate-theme-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    // Per-entry try/catch: a lingering handle on one directory (Windows) must not
    // abort the loop and leak every remaining fixture.
    try {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe("validate-theme.js CLI (real process, spawnSync)", () => {
  // ── Usage errors: the command itself is wrong ──

  it("no theme directory given", () => {
    // The parsing loop never sets themeDir, so the script exits before touching
    // the filesystem -- nothing about any theme was measured here.
    const result = runValidateTheme([]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /No theme directory given/);
    assert.match(result.stderr, /Usage: node/);
  });

  it("an empty theme directory argument is refused, not resolved to the cwd", () => {
    // path.resolve("") is the current directory, so a `"$UNSET_VAR"` that expands
    // to nothing would quietly send the validator at whatever the caller is
    // standing in. This is the reason the check is falsy rather than === null.
    const result = runValidateTheme([""]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /No theme directory given/);
    assert.doesNotMatch(result.stderr, /theme\.json not found/);
  });

  it("--assets given with no value is refused, not silently dropped", () => {
    // The old parser required args[i + 1] to be truthy; a trailing --assets left
    // the override unset and every check ran against the DEFAULT assets path, so
    // a malformed command could reach exit 0 and call the theme valid. A real
    // theme dir is passed as [0] so the flag is the only broken thing.
    const result = runValidateTheme([CALICO, "--assets"]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--assets requires a directory argument/);
  });

  it("--assets given an empty value is refused", () => {
    // Same silent-drop class as above, by a different route: "" is falsy, so the
    // old parser skipped it and reported the theme as valid (measured: exit 0).
    const result = runValidateTheme([CALICO, "--assets", ""]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--assets requires a directory argument/);
  });

  it("--assets followed by another flag fails naming what it received", () => {
    // A flag-shaped value is NOT special-cased as "missing": a directory really
    // can begin with "-", and the filesystem is what knows whether this one
    // exists. What matters is that it fails and quotes the string it was given,
    // so the author sees their own typo rather than a theme verdict.
    const result = runValidateTheme([CALICO, "--assets", "--verbose"]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--assets directory not found/);
    assert.match(result.stderr, /--verbose/);
  });

  it("--assets given more than once is refused", () => {
    // Last-one-wins silently discarded the earlier value, which is the same
    // "ran against a path you did not ask for" failure as the others here.
    const assets = path.join(CALICO, "assets");
    const result = runValidateTheme([CALICO, "--assets", assets, "--assets", assets]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--assets given more than once/);
  });

  it("an unknown option is refused, not ignored", () => {
    // Previously fell through the loop untouched (themeDir was already set), so
    // the run continued with default settings and exited 0 -- the flag the caller
    // typed had no effect and nothing said so.
    const result = runValidateTheme([CALICO, "--verbose"]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Unknown option: --verbose/);
  });

  it("a surplus positional argument is refused, not ignored", () => {
    // Same silent-drop: a second theme path was accepted and discarded, so
    // validating two themes in one command quietly validated only the first.
    const result = runValidateTheme([CALICO, path.join(REPO_ROOT, "themes", "clawd")]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Unexpected extra argument/);
  });

  // ── Setup errors: the command is well-formed, the inputs it names are not ──

  it("--assets pointing at a directory that does not exist says so", () => {
    // A sibling of a real temp dir, never created, so the only broken thing is
    // the override path.
    const missing = path.join(mkTempThemeDir(), "does-not-exist");
    const result = runValidateTheme([CALICO, "--assets", missing]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--assets directory not found/);
  });

  it("--assets pointing at a file says so instead of blaming the theme", () => {
    // Measured on the previous behavior: this produced a 27-error report about
    // the theme, because every asset lookup under a non-directory missed. The
    // theme was fine; the path was not.
    const result = runValidateTheme([CALICO, "--assets", path.join(CALICO, "theme.json")]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--assets path is not a directory/);
    assert.doesNotMatch(result.stdout, /error\(s\)/);
  });

  it("--assets whose parent is a file reports the real error, not \"not found\"", {
    // stat() on a path whose parent component is a file gives ENOTDIR here.
    // Whether Windows spells it the same way is UNMEASURED -- ENOENT is the
    // plausible candidate, but nobody here has a Windows host to check, so this
    // is skipped rather than pinned to a behavior nobody has observed. A guess
    // that happens to be wrong would go
    // red in the release-tag lane, which is the one place a red test costs a
    // build. The macOS and Linux lanes keep the guarantee.
    skip: process.platform === "win32" ? "stat() errno for a file-as-parent component is unmeasured on Windows" : false,
  }, () => {
    // ENOTDIR, not ENOENT. Collapsing every stat failure into "not found" tells
    // the author to create a directory that cannot exist at that path.
    const result = runValidateTheme([CALICO, "--assets", path.join(CALICO, "theme.json", "nope")]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /cannot be accessed \(ENOTDIR\)/);
    assert.doesNotMatch(result.stderr, /not found/);
  });

  it("theme.json missing from the given directory", () => {
    // A real, existing, EMPTY directory -- so the failure is specifically "no
    // theme.json here", not "that path does not exist".
    const dir = mkTempThemeDir();
    const result = runValidateTheme([dir]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /theme\.json not found/);
  });

  it("theme.json is not parseable JSON", () => {
    // Deliberately truncated (unclosed object) so JSON.parse must throw, rather
    // than producing valid-but-wrong JSON that would reach the schema checks.
    const dir = mkTempThemeDir();
    fs.writeFileSync(path.join(dir, "theme.json"), '{ "schemaVersion": 1, ', "utf8");
    const result = runValidateTheme([dir]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Failed to read or parse theme\.json/);
  });

  it("theme.json is a directory: reported as a read failure, not a parse failure", () => {
    // mkdirSync instead of writeFileSync -- readFileSync throws EISDIR before
    // JSON.parse ever runs, so the message must not claim "parse".
    const dir = mkTempThemeDir();
    fs.mkdirSync(path.join(dir, "theme.json"));
    const result = runValidateTheme([dir]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    // Colon-space immediately after the prefix: the errno detail is the whole
    // point, and nothing may be spliced in front of it re-asserting "parse".
    assert.match(result.stderr, /Failed to read or parse theme\.json: /);

    // That prefix is byte-identical to the one the unparseable-JSON case asserts,
    // so alone it cannot tell a read failure from a parse failure -- the very
    // distinction this test is named for. Run that case here too and require the
    // detail to differ. Comparing beats pinning an errno: EISDIR is not spelled
    // the same everywhere, and this stays true wherever it runs.
    const parseDir = mkTempThemeDir();
    fs.writeFileSync(path.join(parseDir, "theme.json"), '{ "schemaVersion": 1, ', "utf8");
    const parseResult = runValidateTheme([parseDir]);
    assert.match(parseResult.stderr, /Failed to read or parse theme\.json: /);
    assert.notStrictEqual(result.stderr, parseResult.stderr, result.stderr);
  });

  for (const [label, value] of [
    ["null", "null"],
    ["a number", "5"],
    ["a string", '"clawd"'],
    ["a boolean", "true"],
  ]) {
    it(`theme.json parses to ${label}, not a JSON object`, () => {
      // Valid JSON, not object-shaped. Previously: `null` crashed with an
      // uncaught TypeError (a stack trace, not a message), and the other three
      // produced FAIL lines that read like real findings about a theme that was
      // never there.
      const dir = mkTempThemeDir();
      fs.writeFileSync(path.join(dir, "theme.json"), value, "utf8");
      const result = runValidateTheme([dir]);
      assert.strictEqual(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /theme\.json must contain a JSON object/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    });
  }

  // ── Controls: the guards above must not widen into these ──

  it("control: theme.json parsing to an array is still validated, not rejected", () => {
    // The array boundary. typeof [] === "object" and array property access does
    // not throw, so the walk completes and reports real (if nonsensical)
    // findings. isPlainObject() rejects arrays on its own -- this asserts the CLI
    // carves them back out with an explicit Array.isArray check.
    const dir = mkTempThemeDir();
    fs.writeFileSync(path.join(dir, "theme.json"), "[]", "utf8");
    const result = runValidateTheme([dir]);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /must contain a JSON object/);
    assert.match(result.stdout, /error\(s\)/);
  });

  it("control: a missing DEFAULT <theme>/assets stays a theme finding, not a setup error", () => {
    // No --assets override. The default assets/ path is a property of the theme
    // itself, so its absence has to keep flowing through the normal checks --
    // the override guard is not allowed to swallow it.
    const dir = mkTempThemeDir();
    const themeJson = {
      schemaVersion: 1,
      name: "no-assets-dir",
      version: "1.0.0",
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      states: {},
    };
    fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify(themeJson), "utf8");
    const missing = runValidateTheme([dir]);
    assert.strictEqual(missing.status, 1, missing.stderr || missing.stdout);
    assert.doesNotMatch(missing.stderr, /--assets/);

    // The blind spot this closes is narrow, so be precise about it: if the guard
    // widened outright the case above already fails, because an early exit leaves
    // stdout empty. What slips through is the quieter form -- the assets check
    // reporting a false PASS while the run otherwise proceeds. check() prints the
    // SAME message whether it passed or failed (only the glyph differs) and this
    // fixture's states:{} guarantees exit 1 on its own, so neither the message nor
    // the status can tell a false pass from a real finding.
    // Re-run the identical theme with an (empty) assets/ present and require
    // exactly one finding to disappear. A delta pins behavior instead of
    // presentation: it survives recolors, glyph changes and future rule additions,
    // none of which say anything about whether this check happened.
    fs.mkdirSync(path.join(dir, "assets"));
    const present = runValidateTheme([dir]);
    assert.strictEqual(
      errorCount(missing.stdout) - errorCount(present.stdout),
      1,
      `${missing.stdout}\n--- with assets/ ---\n${present.stdout}`
    );
  });

  it("control: an --assets value beginning with - is a path, not a flag", () => {
    // Refusing unknown options must not make a legal directory name unreachable.
    // Relative, from a cwd we control, so the leading "-" is really in argv.
    const parent = mkTempThemeDir();
    fs.cpSync(path.join(CALICO, "assets"), path.join(parent, "-dashed", "assets"), { recursive: true });
    const result = runValidateTheme([CALICO, "--assets", "-dashed/assets"], { cwd: parent });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });

  it("control: a theme directory beginning with - is reachable after --", () => {
    // Same guarantee for the positional argument. Without "--" it is reported as
    // an unknown option, and the message points at "--" -- asserted here so the
    // escape hatch cannot be removed without a test noticing.
    const parent = mkTempThemeDir();
    fs.cpSync(CALICO, path.join(parent, "-dashed-theme"), { recursive: true });
    const viaSeparator = runValidateTheme(["--", "-dashed-theme"], { cwd: parent });
    assert.strictEqual(viaSeparator.status, 0, viaSeparator.stderr || viaSeparator.stdout);

    const without = runValidateTheme(["-dashed-theme"], { cwd: parent });
    assert.strictEqual(without.status, 1, without.stderr || without.stdout);
    assert.match(without.stderr, /Unknown option: -dashed-theme/);
    assert.match(without.stderr, /pass it after --/);
  });

  it("--assets actually redirects the lookups, it is not just validated and dropped", () => {
    // Every other --assets case in this file passes an override that resolves to
    // the same files as the default, so exit 0 proves the guard let it through --
    // never that the value reached the lookups. Measured: dropping the override at
    // the point of use (`assetsDir = path.join(resolvedDir, "assets")`) left all
    // 24 cases green. Point a VALID, existing, EMPTY directory at a theme whose
    // own assets/ is complete: only an honoured override can make it miss.
    const empty = mkTempThemeDir();
    const redirected = runValidateTheme([CALICO, "--assets", empty]);
    assert.strictEqual(redirected.status, 1, redirected.stderr || redirected.stdout);
    // Ordinary missing-asset findings, not a setup error: the path is a perfectly
    // good directory, it simply has nothing in it.
    assert.doesNotMatch(redirected.stderr, /--assets/);
    assert.ok(errorCount(redirected.stdout) > 0, redirected.stdout);
    // ...and the same theme without the override is clean, so the override is the
    // only thing that changed.
    assert.strictEqual(runValidateTheme([CALICO]).status, 0);
  });

  it("control: a well-formed --assets override still validates clean", () => {
    // The strict parser must not break the documented usage it is guarding.
    const result = runValidateTheme([CALICO, "--assets", path.join(CALICO, "assets")]);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });

  it("control: a real, shipped, valid theme validates clean", () => {
    // themes/calico rather than a hand-built fixture: assembling a theme.json
    // that clears every rule (required states, sleepSequence, eye-tracking SVG
    // ids, asset existence) would just re-derive a shipped theme. calico is
    // git-tracked and has its own assets/, so this exercises the full pass.
    const result = runValidateTheme([CALICO]);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });
});
