const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { __test: { findMissingHookDependencies } } = require("../hooks/install");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "remote-deploy.sh");
const HOOKS_DIR = path.join(__dirname, "..", "hooks");
const { HOOK_FILES } = require("../src/remote-ssh-deploy");

function parseDeployedFiles() {
  return [...HOOK_FILES];
}

function findRelativeRequires(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const matches = [...content.matchAll(/\brequire\s*\(\s*(["'])(\.\.?\/[^"'\r\n]+)\1\s*\)/g)];
  return matches.map((match) => match[2]);
}

describe("Remote SSH secure hook manifest", () => {
  it("ships every relative require target of every listed file", () => {
    const deployed = parseDeployedFiles();
    assert.ok(deployed.length > 0, "FILES array parsed as empty");
    const deployedSet = new Set(deployed);

    for (const name of deployed) {
      const absPath = path.join(HOOKS_DIR, name);
      assert.ok(fs.existsSync(absPath), `listed file missing: hooks/${name}`);

      const specs = findRelativeRequires(absPath);
      for (const spec of specs) {
        const target = path.resolve(path.dirname(absPath), spec.endsWith(".js") ? spec : `${spec}.js`);
        const relative = path.relative(HOOKS_DIR, target);
        const staysInHooks = relative !== ""
          && !path.isAbsolute(relative)
          && relative !== ".."
          && !relative.startsWith(`..${path.sep}`);
        assert.ok(
          staysInHooks,
          `hooks/${name} requires "${spec}" outside hooks/ — remote hosts receive no src/ or agents/ tree`
        );
        const dep = relative.split(path.sep).join("/");
        assert.ok(
          deployedSet.has(dep),
          `hooks/${name} requires "${spec}" but ${dep} is not in remote-ssh-deploy HOOK_FILES — add it or the remote deploy will ship a broken subset`
        );
      }
    }
  });

  // plan §4.1 guard: remote SSH hosts have NO node_modules, so no file in
  // either manifest may pull a real npm dependency — bare or subpath
  // (`jsonc-parser/lib/...` crashes there just as hard as `jsonc-parser`).
  // The relative-require closure test above cannot see bare requires, so
  // this allowlists Node builtins and rejects everything else (R8 P2).
  it("remote manifests require ONLY Node builtins; the family JSONC editor never ships", () => {
    const { builtinModules } = require("node:module");
    const builtinRoots = new Set(builtinModules.map((name) => name.split("/")[0]));

    const manifests = new Set(parseDeployedFiles());
    for (const name of manifests) {
      assert.notStrictEqual(
        name,
        "opencode-family-jsonc.js",
        "the family JSONC editor must not be deployed to dep-free remote hosts"
      );
      const content = fs.readFileSync(path.join(HOOKS_DIR, name), "utf8");
      assert.ok(
        !content.includes("opencode-family-jsonc"),
        `hooks/${name} must not reference the family JSONC editor`
      );
      for (const match of content.matchAll(/require\(["']([^."'][^"']*)["']\)/g)) {
        const spec = match[1];
        const root = (spec.startsWith("node:") ? spec.slice(5) : spec).split("/")[0];
        assert.ok(
          builtinRoots.has(root),
          `hooks/${name} requires "${spec}" — remote hosts have no node_modules, only Node builtins are deployable`
        );
      }
    }
  });

  it("keeps the retired shell entry point fail-closed", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");

    assert.match(script, /Settings -> Remote SSH -> Deploy \/ Repair Hooks/);
    assert.match(script, /\nexit 2\n$/);
    assert.doesNotMatch(script, /\bssh\b|\bscp\b|FILES=\(|RemoteForward|23333/);
  });
});

// The manual WSL instructions once pinned an explicit 13-file list that fell
// four months behind HOOK_FILES, so following the guide produced an install
// where every hook died at MODULE_NOT_FOUND while the installer reported
// success. A hand-maintained list in prose cannot be kept in sync by the
// closure test above — the only stable form is a directory-wide copy.
describe("WSL setup guide hook copy instructions", () => {
  const GUIDES = ["docs/guides/setup-guide.md", "docs/guides/setup-guide.zh-CN.md"];

  it("never hand-enumerates hook files", () => {
    for (const relative of GUIDES) {
      const content = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!content.includes("/mnt/d/animation/"), `${relative} contains an author-specific path`);
      const enumerated = content.match(/hooks\/\{[^}\n]*\}\.js/g) || [];
      assert.deepStrictEqual(
        enumerated,
        [],
        `${relative} brace-enumerates hook files; it will drift out of sync with `
          + `remote-ssh-deploy HOOK_FILES. Use a directory-wide copy instead.`
      );
    }
  });

  it("copies the whole hooks directory", () => {
    for (const relative of GUIDES) {
      const content = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.match(
        content,
        /^cp (?:"[^"\n]*hooks\/"|[^\s"\n]*hooks\/)\*\.js ~\/\.claude\/hooks\/\s*$/m,
        `${relative} must tell WSL users to copy every hook file`
      );
    }
  });
});

// Compare the CLI preflight with an independently traversed manifest closure.
// Removing each file catches a scanner that silently visits only entry points.
describe("Claude preflight and deployed dependency closure", () => {
  it("recognizes the supported literal require grammar", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-grammar-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const entry = path.join(dir, "entry.js");
    fs.writeFileSync(entry, `require ( './child.js' );
require(
 "./other"
);`);
    assert.deepStrictEqual(findRelativeRequires(entry), ["./child.js", "./other"]);
    assert.deepStrictEqual(findMissingHookDependencies(["entry.js"], { hooksDir: dir }).map((e) => e.name), ["child.js", "other.js"]);
  });

  it("reports each file removed from the Claude manifest closure", (t) => {
    const entries = ["clawd-hook.js", "claude-statusline.js"];
    const pending = [...entries];
    const closure = new Set();
    while (pending.length) {
      const name = pending.pop();
      if (closure.has(name)) continue;
      closure.add(name);
      assert.ok(HOOK_FILES.includes(name), `Claude dependency ${name} must be deployed`);
      for (const spec of findRelativeRequires(path.join(HOOKS_DIR, name))) {
        const target = path.resolve(HOOKS_DIR, path.dirname(name), path.extname(spec) ? spec : `${spec}.js`);
        pending.push(path.relative(HOOKS_DIR, target).split(path.sep).join("/"));
      }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-closure-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of closure) fs.copyFileSync(path.join(HOOKS_DIR, name), path.join(dir, name));
    assert.deepStrictEqual(findMissingHookDependencies(entries, { hooksDir: dir }), []);
    for (const name of closure) {
      fs.unlinkSync(path.join(dir, name));
      try {
        assert.ok(findMissingHookDependencies(entries, { hooksDir: dir }).some((e) => e.name === name && e.code === "ENOENT"), `preflight missed ${name}`);
      } finally { fs.copyFileSync(path.join(HOOKS_DIR, name), path.join(dir, name)); }
    }
  });
});
