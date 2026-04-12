const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "remote-deploy.sh");
const HOOKS_DIR = path.join(__dirname, "..", "hooks");

function parseDeployedFiles() {
  const script = fs.readFileSync(SCRIPT_PATH, "utf8");
  const block = script.match(/FILES=\(\s*\n([\s\S]*?)\n\s*\)/);
  if (!block) throw new Error("FILES=() block not found in remote-deploy.sh");
  const entries = [...block[1].matchAll(/"\$HOOKS_DIR\/([^"]+)"/g)];
  return entries.map((m) => m[1]);
}

function findRelativeRequires(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const matches = [...content.matchAll(/require\(["']\.\/([^"')]+)["']\)/g)];
  return matches.map((m) => (m[1].endsWith(".js") ? m[1] : `${m[1]}.js`));
}

describe("scripts/remote-deploy.sh FILES manifest", () => {
  it("ships every relative require target of every listed file", () => {
    const deployed = parseDeployedFiles();
    assert.ok(deployed.length > 0, "FILES array parsed as empty");
    const deployedSet = new Set(deployed);

    for (const name of deployed) {
      const absPath = path.join(HOOKS_DIR, name);
      assert.ok(fs.existsSync(absPath), `listed file missing: hooks/${name}`);

      const deps = findRelativeRequires(absPath);
      for (const dep of deps) {
        assert.ok(
          deployedSet.has(dep),
          `hooks/${name} requires './${dep.replace(/\.js$/, "")}' but ${dep} is not in scripts/remote-deploy.sh FILES — add it or the remote deploy will ship a broken subset`
        );
      }
    }
  });
});
