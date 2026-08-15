const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "remote-deploy.sh");
const HOOKS_DIR = path.join(__dirname, "..", "hooks");
const { HOOK_FILES } = require("../src/remote-ssh-deploy");

function parseDeployedFiles() {
  return [...HOOK_FILES];
}

function findRelativeRequires(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const matches = [...content.matchAll(/require\(["'](\.\.?\/[^"')]+)["']\)/g)];
  return matches.map((match) => match[1]);
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
