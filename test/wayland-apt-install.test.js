"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const SMOKE_WORKFLOW = path.join(WORKFLOW_DIR, "wayland-smoke.yml");
const CACHE_WORKFLOW = path.join(WORKFLOW_DIR, "wayland-apt-cache.yml");
const INSTALL_SCRIPT = path.join(ROOT, "ci", "install-wayland-deps.sh");
const PACKAGES_FILE = path.join(ROOT, "ci", "wayland-apt-packages.txt");

// These control-flow tests need bash 4+ and a Linux-like command set. CI runs
// them on its Ubuntu job; a local bash can be supplied explicitly for a
// non-Linux sanity check.
const TEST_BASH = process.env.WAYLAND_APT_TEST_BASH || "/bin/bash";
const SHIM_OPTIONS = {
  skip: process.platform !== "linux" && !process.env.WAYLAND_APT_TEST_BASH,
  timeout: 60000,
};

const CACHE_PATH = "~/.cache/wayland-apt-debs";
const CACHE_KEY =
  "wayland-apt-v1-${{ steps.apt-key.outputs.image }}-${{ runner.arch }}-" +
  "${{ hashFiles('ci/wayland-apt-packages.txt', 'ci/install-wayland-deps.sh') }}";

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function fakeSudo() {
  return `#!/bin/sh
printf 'sudo' >> "$FAKE_LOG"
for arg in "$@"; do printf ' %s' "$arg" >> "$FAKE_LOG"; done
printf '\\n' >> "$FAKE_LOG"
case "$1" in
  chown) exit 0 ;;
esac
exec "$@"
`;
}

function fakeDate() {
  return `#!/bin/sh
offset="$(cat "$FAKE_DATE_OFFSET_FILE" 2>/dev/null || printf '0')"
printf '%s\\n' $(( \${FAKE_DATE_START:-1000} + offset ))
`;
}

function fakeTimeout() {
  return `#!/bin/sh
printf 'timeout' >> "$FAKE_LOG"
for arg in "$@"; do printf ' %s' "$arg" >> "$FAKE_LOG"; done
printf '\\n' >> "$FAKE_LOG"
index="$(cat "$FAKE_TIMEOUT_STATE" 2>/dev/null || printf '0')"
printf '%s\\n' $(( index + 1 )) > "$FAKE_TIMEOUT_STATE"
sequence="\${FAKE_TIMEOUT_RC_SEQUENCE:-}"
selected=0
if [ -n "$sequence" ]; then
  selected="$(printf '%s\\n' "$sequence" | cut -d, -f$(( index + 1 )))"
  [ -n "$selected" ] || selected=0
fi
advance_clock() {
  amount="\${FAKE_TIMEOUT_ADVANCE:-0}"
  [ "$amount" = "0" ] && return 0
  current="$(cat "$FAKE_DATE_OFFSET_FILE" 2>/dev/null || printf '0')"
  printf '%s\\n' $(( current + amount )) > "$FAKE_DATE_OFFSET_FILE"
}
shift 3
if [ "$selected" != "0" ]; then
  advance_clock
  exit "$selected"
fi
"$@"
status=$?
advance_clock
exit "$status"
`;
}

function fakeAptGet() {
  return `#!/bin/sh
printf 'apt-get' >> "$FAKE_LOG"
for arg in "$@"; do printf ' %s' "$arg" >> "$FAKE_LOG"; done
printf '\\n' >> "$FAKE_LOG"
pick_rc() {
  list="$1"
  state="$2"
  index="$(cat "$state" 2>/dev/null || printf '0')"
  printf '%s\\n' $(( index + 1 )) > "$state"
  value=0
  if [ -n "$list" ]; then
    value="$(printf '%s\\n' "$list" | cut -d, -f$(( index + 1 )))"
    [ -n "$value" ] || value=0
  fi
  printf '%s\\n' "$value"
}
mode=""
saw_install=0
archives=""
for arg in "$@"; do
  case "$arg" in
    update) mode=update ;;
    check) mode=check ;;
    install) saw_install=1 ;;
    --download-only) mode=download ;;
    Dir::Cache::archives=*) archives="\${arg#Dir::Cache::archives=}" ;;
  esac
done
if [ -z "$mode" ] && [ "$saw_install" = "1" ]; then
  mode=install
fi
case "$mode" in
  update) rc="$(pick_rc "\${FAKE_APT_UPDATE_RC_SEQUENCE:-}" "$FAKE_APT_UPDATE_STATE")" ;;
  download)
    rc="$(pick_rc "\${FAKE_APT_DOWNLOAD_RC_SEQUENCE:-}" "$FAKE_APT_DOWNLOAD_STATE")"
    if [ "$rc" = "0" ] && [ -n "$archives" ]; then
      mkdir -p "$archives"
      : > "$archives/fake-package.deb"
    fi
    ;;
  install) rc="$(pick_rc "\${FAKE_APT_INSTALL_RC_SEQUENCE:-}" "$FAKE_APT_INSTALL_STATE")" ;;
  check) rc="$(pick_rc "\${FAKE_APT_CHECK_RC_SEQUENCE:-}" "$FAKE_APT_CHECK_STATE")" ;;
  *) rc=0 ;;
esac
exit "$rc"
`;
}

function fakeDpkg() {
  return `#!/bin/sh
printf 'dpkg' >> "$FAKE_LOG"
for arg in "$@"; do printf ' %s' "$arg" >> "$FAKE_LOG"; done
printf '\\n' >> "$FAKE_LOG"
args=" $* "
case "$args" in
  *" --audit "*)
    [ -n "\${FAKE_DPKG_AUDIT_OUTPUT:-}" ] && printf '%s\\n' "$FAKE_DPKG_AUDIT_OUTPUT"
    exit "\${FAKE_DPKG_AUDIT_RC:-0}"
    ;;
  *" --configure "*)
    exit "\${FAKE_DPKG_CONFIGURE_RC:-0}"
    ;;
esac
exit 0
`;
}

function fakeDpkgQuery() {
  return `#!/bin/sh
printf 'dpkg-query' >> "$FAKE_LOG"
for arg in "$@"; do printf ' %s' "$arg" >> "$FAKE_LOG"; done
printf '\\n' >> "$FAKE_LOG"
package=""
for arg in "$@"; do package="$arg"; done
if [ -n "\${FAKE_DPKG_QUERY_FAIL_PACKAGE:-}" ] && [ "$package" = "$FAKE_DPKG_QUERY_FAIL_PACKAGE" ]; then
  printf '%s\\n' "\${FAKE_DPKG_QUERY_FAIL_STATUS:-install ok unpacked}"
  exit 0
fi
printf '%s\\n' "\${FAKE_DPKG_QUERY_STATUS:-install ok installed}"
exit 0
`;
}

function writeFake(binDir, name, contents) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, contents, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wayland-apt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, "bin");
  const workRoot = path.join(root, "work");
  const cacheDir = path.join(root, "cache", "wayland-apt-debs");
  const stateDir = path.join(root, "state");
  const logFile = path.join(root, "commands.log");
  const osReleaseFile = path.join(root, "os-release");
  const keyringFile = path.join(root, "ubuntu-archive-keyring.gpg");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(osReleaseFile, 'NAME="Ubuntu"\nVERSION_CODENAME=noble\n');
  fs.writeFileSync(keyringFile, "");
  fs.writeFileSync(logFile, "");

  writeFake(binDir, "sudo", fakeSudo());
  writeFake(binDir, "date", fakeDate());
  writeFake(binDir, "timeout", fakeTimeout());
  writeFake(binDir, "apt-get", fakeAptGet());
  writeFake(binDir, "dpkg", fakeDpkg());
  writeFake(binDir, "dpkg-query", fakeDpkgQuery());

  const stateFiles = {
    DATE_OFFSET: path.join(stateDir, "date-offset"),
    TIMEOUT: path.join(stateDir, "timeout"),
    APT_UPDATE: path.join(stateDir, "apt-update"),
    APT_DOWNLOAD: path.join(stateDir, "apt-download"),
    APT_INSTALL: path.join(stateDir, "apt-install"),
    APT_CHECK: path.join(stateDir, "apt-check"),
  };
  for (const file of Object.values(stateFiles)) fs.writeFileSync(file, "0\n");

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_LOG: logFile,
    FAKE_DATE_OFFSET_FILE: stateFiles.DATE_OFFSET,
    FAKE_DATE_START: "1000",
    FAKE_TIMEOUT_STATE: stateFiles.TIMEOUT,
    FAKE_APT_UPDATE_STATE: stateFiles.APT_UPDATE,
    FAKE_APT_DOWNLOAD_STATE: stateFiles.APT_DOWNLOAD,
    FAKE_APT_INSTALL_STATE: stateFiles.APT_INSTALL,
    FAKE_APT_CHECK_STATE: stateFiles.APT_CHECK,
    FAKE_APT_UPDATE_RC_SEQUENCE: "",
    FAKE_APT_DOWNLOAD_RC_SEQUENCE: "",
    FAKE_APT_INSTALL_RC_SEQUENCE: "",
    FAKE_APT_CHECK_RC_SEQUENCE: "",
    FAKE_TIMEOUT_RC_SEQUENCE: "",
    FAKE_TIMEOUT_ADVANCE: "0",
    FAKE_DPKG_AUDIT_OUTPUT: "",
    FAKE_DPKG_AUDIT_RC: "0",
    FAKE_DPKG_CONFIGURE_RC: "0",
    FAKE_DPKG_QUERY_STATUS: "install ok installed",
    FAKE_DPKG_QUERY_FAIL_PACKAGE: "",
    FAKE_DPKG_QUERY_FAIL_STATUS: "install ok unpacked",
    WAYLAND_APT_OS_RELEASE: osReleaseFile,
    WAYLAND_APT_KEYRING: keyringFile,
    WAYLAND_APT_WORK_ROOT: workRoot,
    WAYLAND_APT_PACKAGES_FILE: PACKAGES_FILE,
    WAYLAND_APT_PRIMARY_MIRROR: "azure.archive.ubuntu.com",
    WAYLAND_APT_TOTAL_BUDGET: "540",
  };

  return { root, binDir, workRoot, cacheDir, logFile, osReleaseFile, keyringFile, env };
}

function logLines(harness) {
  return fs.readFileSync(harness.logFile, "utf8").split("\n").filter(Boolean);
}

function runScript(harness, args, overrides = {}) {
  const result = spawnSync(TEST_BASH, [INSTALL_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...harness.env, ...overrides },
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
    log: logLines(harness),
  };
}

function workDirectory(harness) {
  const entries = fs.readdirSync(harness.workRoot).filter((name) =>
    name.startsWith("wayland-apt-")
  );
  assert.equal(entries.length, 1, `expected one work directory, got ${entries.join(", ")}`);
  return path.join(harness.workRoot, entries[0]);
}

function generatedSources(harness) {
  return fs.readFileSync(
    path.join(workDirectory(harness), "sources.list.d", "ubuntu.sources"),
    "utf8"
  );
}

function assertNetworkCommandsUseSudoTimeout(log) {
  const network = log.filter(
    (line) =>
      line.startsWith("sudo ") &&
      (line.includes("apt-get update") ||
        (line.includes("apt-get install") && line.includes("--download-only")) ||
        line.includes("dpkg --configure -a"))
  );
  assert.ok(network.length > 0, "expected at least one network command");
  for (const line of network) {
    assert.ok(
      line.startsWith("sudo timeout -k 10 "),
      `network command must run through sudo timeout: ${line}`
    );
  }
  assert.ok(!log.some((line) => line.startsWith("sudo apt-get update")));
  assert.ok(
    !log.some(
      (line) => line.startsWith("sudo apt-get install") && line.includes("--download-only")
    )
  );
  assert.ok(!log.some((line) => line.startsWith("sudo dpkg --configure")));
}

function addCachedDeb(harness, name = "cached.deb") {
  fs.mkdirSync(harness.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(harness.cacheDir, name), "");
}

test("Wayland workflows parse and share one apt cache key and path", () => {
  const smokeText = fs.readFileSync(SMOKE_WORKFLOW, "utf8");
  const cacheText = fs.readFileSync(CACHE_WORKFLOW, "utf8");
  const smoke = yaml.load(smokeText);
  const cache = yaml.load(cacheText);

  assert.ok(smoke.jobs, "wayland-smoke.yml must parse as a workflow");
  assert.ok(cache.jobs, "wayland-apt-cache.yml must parse as a workflow");
  assert.equal(countOccurrences(smokeText, `key: ${CACHE_KEY}`), 3);
  assert.equal(countOccurrences(cacheText, `key: ${CACHE_KEY}`), 2);
  assert.equal(countOccurrences(smokeText, `path: ${CACHE_PATH}`), 3);
  assert.equal(countOccurrences(cacheText, `path: ${CACHE_PATH}`), 2);
});

test("Wayland smoke jobs restore the cache and install from the script", () => {
  const smoke = yaml.load(fs.readFileSync(SMOKE_WORKFLOW, "utf8"));
  const jobNames = ["xwayland-smoke", "native-wayland-contract", "appimage-claude-hooks"];

  for (const jobName of jobNames) {
    const steps = smoke.jobs[jobName].steps;
    const restore = steps.find((step) => step.uses === "actions/cache/restore@v4");
    const install = steps.find((step) => step.name === "Install isolated headless Wayland stack");
    assert.ok(restore, `${jobName} must restore the apt package cache`);
    assert.equal(restore.with.path, CACHE_PATH);
    assert.equal(restore.with.key, CACHE_KEY);
    assert.equal(restore.if, "steps.apt-key.outputs.skip != 'true'");
    assert.ok(install, `${jobName} must install the Wayland stack`);
    assert.equal(install["timeout-minutes"], 10);
    assert.match(install.run, /ci\/install-wayland-deps\.sh install "\$HOME\/\.cache\/wayland-apt-debs"/);
    assert.ok(!steps.some((step) => step.uses === "actions/cache/save@v4"));
  }
});

test("Wayland cache warm-up only saves after a successful publish", () => {
  const cache = yaml.load(fs.readFileSync(CACHE_WORKFLOW, "utf8"));
  const workflow = fs.readFileSync(CACHE_WORKFLOW, "utf8");
  const steps = cache.jobs["warm-cache"].steps;
  const lookup = steps.find((step) => step.id === "cache");
  const publish = steps.find((step) => step.name === "Publish apt packages into the cache");
  const save = steps.find((step) => step.uses === "actions/cache/save@v4");

  assert.equal(cache.jobs["warm-cache"].if, "github.ref == 'refs/heads/main'");
  assert.equal(lookup.uses, "actions/cache/restore@v4");
  assert.equal(lookup.with["lookup-only"], true);
  assert.match(publish.run, /install-wayland-deps\.sh publish/);
  assert.equal(save["continue-on-error"], true);
  assert.equal(
    save.if,
    "steps.apt-key.outputs.skip != 'true' && steps.cache.outputs.cache-hit != 'true'"
  );
  assert.match(workflow, /group: wayland-apt-cache/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("Wayland apt package list matches the smoke stack", () => {
  const packages = fs
    .readFileSync(PACKAGES_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(packages, [
    "dbus-x11",
    "weston",
    "xwayland",
    "libfuse2t64",
    "x11-utils",
    "xdotool",
  ]);
});

test(
  "Wayland apt install generates a deb822 Ubuntu source for the primary mirror",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);

    const result = runScript(harness, ["install", harness.cacheDir]);
    assert.equal(result.status, 0, result.output);

    const sources = generatedSources(harness);
    assert.match(sources, /^Types: deb$/m);
    assert.match(sources, /^URIs: http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/$/m);
    assert.match(sources, /^Suites: noble noble-updates noble-security$/m);
    assert.match(sources, /^Components: main restricted universe multiverse$/m);
    assert.ok(sources.includes(`Signed-By: ${harness.keyringFile}`));
    assert.match(result.output, /generated .*ubuntu\.sources/);
    assertNetworkCommandsUseSudoTimeout(result.log);
  }
);

test(
  "Wayland apt install uses the cache without touching the network",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    addCachedDeb(harness);

    const result = runScript(harness, ["install", harness.cacheDir]);
    assert.equal(result.status, 0, result.output);

    const apt = result.log.filter((line) => line.startsWith("apt-get "));
    assert.ok(apt.some((line) => line.includes(harness.cacheDir) && line.includes("--no-download")));
    assert.ok(
      apt.some((line) =>
        line.includes(`Dir::Cache::archives=${harness.cacheDir}`)
      )
    );
    assert.ok(apt.some((line) => line.includes(" check")));
    assert.ok(!apt.some((line) => line.includes(" update")));
    assert.ok(!apt.some((line) => line.includes("--download-only")));
    assert.match(result.output, /cache hit/);
  }
);

test(
  "Wayland apt install falls back to a download after a failed cache install",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    addCachedDeb(harness);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_APT_INSTALL_RC_SEQUENCE: "1,0",
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /cache hit but offline install failed/);

    const installs = result.log.filter(
      (line) => line.startsWith("apt-get install") && !line.includes("--download-only")
    );
    assert.equal(installs.length, 2);
    assert.ok(
      installs[0].includes(`Dir::Cache::archives=${harness.cacheDir}`)
    );
    assert.ok(
      installs[1].includes(`Dir::Cache::archives=${workDirectory(harness)}/archives`)
    );
    assert.ok(result.log.some((line) => line.startsWith("apt-get update")));
    assert.ok(result.log.some((line) => line.includes("--download-only")));
    assert.ok(!result.log.some((line) => line === "dpkg --configure -a"));
    assertNetworkCommandsUseSudoTimeout(result.log);
  }
);

test(
  "Wayland apt install repairs interrupted dpkg state before downloading",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    addCachedDeb(harness);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_APT_INSTALL_RC_SEQUENCE: "1,0",
      FAKE_DPKG_AUDIT_OUTPUT: "iU  weston  amd64",
    });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.log.includes("dpkg --audit"));
    assert.ok(result.log.includes("dpkg --configure -a"));
    assertNetworkCommandsUseSudoTimeout(result.log);
  }
);

test(
  "Wayland apt install switches to the fallback mirror after a timeout",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_TIMEOUT_RC_SEQUENCE: "0,124",
    });
    assert.equal(result.status, 0, result.output);

    const timeouts = result.log.filter((line) => line.startsWith("timeout "));
    assert.equal(timeouts.length, 4);
    assert.match(timeouts[0], /apt-get update/);
    assert.match(timeouts[1], /--download-only/);
    assert.match(timeouts[2], /apt-get update/);
    assert.match(timeouts[3], /--download-only/);

    const sources = generatedSources(harness);
    assert.match(sources, /^URIs: http:\/\/archive\.ubuntu\.com\/ubuntu\/$/m);
    assert.doesNotMatch(sources, /azure\.archive\.ubuntu\.com/);
    assertNetworkCommandsUseSudoTimeout(result.log);
  }
);

test(
  "Wayland apt install fails when VERSION_CODENAME is missing",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    fs.writeFileSync(harness.osReleaseFile, 'NAME="Ubuntu"\n');

    const result = runScript(harness, ["install", harness.cacheDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /cannot read VERSION_CODENAME/);
    assert.ok(!result.log.some((line) => line.startsWith("apt-get update")));
  }
);

test(
  "Wayland apt install fails when the Ubuntu archive keyring is missing",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    fs.rmSync(harness.keyringFile);

    const result = runScript(harness, ["install", harness.cacheDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Ubuntu archive keyring not found/);
    assert.ok(!result.log.some((line) => line.startsWith("apt-get update")));
  }
);

test(
  "Wayland apt install fails when both download rounds fail",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_APT_DOWNLOAD_RC_SEQUENCE: "1,1",
    });
    assert.notEqual(result.status, 0);
    const downloads = result.log.filter(
      (line) => line.startsWith("apt-get ") && line.includes("--download-only")
    );
    assert.equal(downloads.length, 2, "both rounds must attempt a download");
    assert.match(result.output, /round 2 download from archive\.ubuntu\.com failed/);
    assertNetworkCommandsUseSudoTimeout(result.log);
  }
);

test(
  "Wayland apt publish leaves the cache empty when validation fails",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    fs.mkdirSync(harness.cacheDir, { recursive: true });

    const result = runScript(harness, ["publish", harness.cacheDir], {
      FAKE_APT_INSTALL_RC_SEQUENCE: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /publish validation failed/);
    assert.deepEqual(fs.readdirSync(harness.cacheDir), []);
  }
);

test(
  "Wayland apt publish copies only verified .deb files into an empty cache",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    fs.mkdirSync(harness.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(harness.cacheDir, "stale.txt"), "old");

    const result = runScript(harness, ["publish", harness.cacheDir]);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(fs.readdirSync(harness.cacheDir), ["fake-package.deb"]);
  }
);

test(
  "Wayland apt publish refuses a cache path with the wrong basename",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    const badDir = path.join(harness.root, "not-the-cache");
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, "keep.txt"), "keep");

    const result = runScript(harness, ["publish", badDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /must end with wayland-apt-debs/);
    assert.deepEqual(fs.readdirSync(badDir), ["keep.txt"]);
    assert.ok(!result.log.some((line) => line.startsWith("apt-get update")));
  }
);

test(
  "Wayland apt install rejects a package that is not fully installed",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    addCachedDeb(harness);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_DPKG_QUERY_FAIL_PACKAGE: "weston",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /package weston is not installed/);
    assert.ok(!result.log.some((line) => line.startsWith("apt-get check")));
  }
);

test(
  "Wayland apt install fails when apt-get check fails",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);
    addCachedDeb(harness);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_APT_CHECK_RC_SEQUENCE: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /apt-get check failed/);
    assert.ok(result.log.some((line) => line.startsWith("apt-get check")));
  }
);

test(
  "Wayland apt install does not start a network command when the reserve leaves too little",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);

    const result = runScript(harness, ["install", harness.cacheDir], {
      WAYLAND_APT_TOTAL_BUDGET: "100",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /network time budget exhausted/);
    assert.equal(result.log.filter((line) => line.startsWith("timeout ")).length, 0);
    assert.equal(result.log.filter((line) => line.startsWith("apt-get update")).length, 0);
    assert.equal(result.log.filter((line) => line.includes("--download-only")).length, 0);
  }
);

test(
  "Wayland apt install does not start round two when the budget is spent",
  SHIM_OPTIONS,
  (t) => {
    const harness = createHarness(t);

    const result = runScript(harness, ["install", harness.cacheDir], {
      FAKE_APT_DOWNLOAD_RC_SEQUENCE: "1",
      FAKE_TIMEOUT_ADVANCE: "300",
      WAYLAND_APT_TOTAL_BUDGET: "540",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /network time budget exhausted after round 1/);
    assert.equal(result.log.filter((line) => line.startsWith("apt-get update")).length, 1);
    assert.equal(
      result.log.filter(
        (line) => line.startsWith("apt-get ") && line.includes("--download-only")
      ).length,
      1
    );

    const sources = generatedSources(harness);
    assert.match(sources, /^URIs: http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/$/m);
    assertNetworkCommandsUseSudoTimeout(result.log);
  }
);
