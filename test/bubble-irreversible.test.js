const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { detectIrreversible } = require("../src/bubble-format");

const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");
const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");
const bubbleCss = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.css"), "utf8");

describe("detectIrreversible — destructive shell commands get a hint", () => {
  const hits = [
    ["force push", "git push origin main --force", "force-push"],
    ["force push -f", "git push -f origin main", "force-push"],
    ["force-with-lease", "git push --force-with-lease origin main", "force-push"],
    ["remote branch delete", "git push origin --delete feature/x", "remote-delete"],
    ["local branch -D", "git branch -D feature/x", "branch-delete"],
    ["reset --hard", "git reset --hard HEAD~3", "history-rewrite"],
    ["filter-branch", "git filter-branch --tree-filter 'rm secret' HEAD", "history-rewrite"],
    ["rm -rf", "rm -rf build/", "file-delete"],
    ["rm -r", "rm -r old_dir", "file-delete"],
    ["git clean -fd", "git clean -fd", "git-clean"],
    ["npm publish", "npm publish --access public", "publish"],
    ["twine upload", "twine upload dist/*", "publish"],
    ["gh repo delete", "gh repo delete owner/repo --yes", "repo-delete"],
    ["go public", "gh repo edit owner/repo --visibility public", "go-public"],
    ["DROP TABLE", "psql -c 'DROP TABLE users'", "db-destroy"],
    ["terraform destroy", "terraform destroy -auto-approve", "infra-destroy"],
  ];
  for (const [label, cmd, tag] of hits) {
    it(`flags: ${label}`, () => {
      const r = detectIrreversible("Bash", { command: cmd });
      assert.ok(r, `expected hit for: ${cmd}`);
      assert.strictEqual(r.tag, tag);
    });
  }

  it("flags explicit file-delete tools", () => {
    assert.ok(detectIrreversible("delete_file", { path: "/tmp/x" }));
  });
});

describe("detectIrreversible — ordinary commands stay quiet (precision over recall)", () => {
  const misses = [
    ["plain push", "git push origin main"],
    ["pull", "git pull --rebase"],
    ["status", "git status"],
    ["ls", "ls -la"],
    ["npm install", "npm install --save-dev jest"],
    ["npm run publish-docs script name", "npm run docs"],
    ["mkdir", "mkdir -p out"],
    ["rm without -r/-f", "rm notes.txt"],
    ["gh repo view", "gh repo view owner/repo"],
    ["kubectl get", "kubectl get pods"],
  ];
  for (const [label, cmd] of misses) {
    it(`quiet: ${label}`, () => {
      assert.strictEqual(detectIrreversible("Bash", { command: cmd }), null, cmd);
    });
  }

  it("non-shell, non-delete tools stay quiet (delete_draft-like MCP names too)", () => {
    assert.strictEqual(detectIrreversible("Write", { file_path: "/tmp/a" }), null);
    assert.strictEqual(detectIrreversible("mcp__mail__delete_draft", { id: "1" }), null);
  });

  it("missing/garbage input stays quiet, never throws", () => {
    assert.strictEqual(detectIrreversible("Bash", {}), null);
    assert.strictEqual(detectIrreversible("Bash", null), null);
    assert.strictEqual(detectIrreversible(null, null), null);
  });
});

describe("bubble wiring — badge is display-only", () => {
  it("renderer defines localized hint for all 5 bubble locales", () => {
    const count = (bubbleRenderer.match(/irreversibleHint:/g) || []).length;
    assert.strictEqual(count, 5);
  });
  it("badge element exists and starts hidden", () => {
    assert.match(bubbleHtml, /id="irreversibleBadge" style="display:none"/);
  });
  it("badge uses textContent only (never innerHTML)", () => {
    assert.match(bubbleRenderer, /irreversibleBadge\.textContent =/);
    assert.doesNotMatch(bubbleRenderer, /irreversibleBadge\.innerHTML/);
  });
  it("badge never touches decide()/Allow/Deny semantics", () => {
    // the badge block must not call bubbleAPI.decide — display-only invariant
    const block = bubbleRenderer.slice(
      bubbleRenderer.indexOf("Irreversible-action hint"),
      bubbleRenderer.indexOf("Button labels"));
    assert.ok(block.length > 0);
    assert.doesNotMatch(block, /bubbleAPI\.decide/);
  });
  it("badge style exists", () => {
    assert.match(bubbleCss, /\.irreversible-badge \{/);
  });
  it("badge is cleared by resetBubbleContent (no leakage into the next bubble)", () => {
    const reset = bubbleRenderer.slice(
      bubbleRenderer.indexOf("function resetBubbleContent"),
      bubbleRenderer.indexOf("function show"));
    assert.match(reset, /irreversibleBadge\.style\.display = "none"/);
    assert.match(reset, /irreversibleBadge\.textContent = ""/);
  });
  it("badge text makes a defensible claim (no 'cannot be undone' overclaim)", () => {
    // force-push / branch -D are reflog-recoverable — the hint must not overclaim.
    assert.doesNotMatch(bubbleRenderer, /cannot be undone/);
    assert.match(bubbleRenderer, /may not be recoverable/);
  });
});

describe("detectIrreversible — command-position anchoring (quoted/echoed text never flags)", () => {
  // ★cross-family 감사 Medium 회귀잠금: 어디서나-매칭이던 v1은 인용 인자/echo 텍스트를 오탐.
  // v2는 세그먼트 명령-위치 앵커링 — 인자는 명령이 아니므로 구조적으로 못 flag.
  const quiet = [
    ["quoted in commit message", 'git commit -m "git push --force"'],
    ["echoed force-push", "echo git push --force"],
    ["echoed publish", "echo npm publish docs"],
    ["node string literal", 'node -e "console.log(\'npm publish\')"'],
    ["echoed SQL", "echo 'DROP TABLE users'"],
  ];
  for (const [label, cmd] of quiet) {
    it(`quiet: ${label}`, () => {
      assert.strictEqual(detectIrreversible("Bash", { command: cmd }), null, cmd);
    });
  }
  const hits = [
    ["wrapper: sudo", "sudo rm -rf /var/tmp/x", "file-delete"],
    ["wrapper: env assignment", "FOO=1 git push --force", "force-push"],
    ["second segment after &&", 'node -e "x" && npm publish', "publish"],
    ["db client with SQL", 'psql -c "DROP TABLE users"', "db-destroy"],
  ];
  for (const [label, cmd, tag] of hits) {
    it(`flags: ${label}`, () => {
      const r = detectIrreversible("Bash", { command: cmd });
      assert.ok(r && r.tag === tag, `${cmd} → ${r && r.tag}`);
    });
  }
});

describe("detectIrreversible — separators inside quotes never create fake segments", () => {
  // ★cross-family R2 블로커 회귀잠금: 나이브 분할이 인용부 안의 &&/;/|에서 쪼개면
  // 인용 텍스트가 가짜 명령-위치가 되어 오탐. quote-aware 스캐너로 봉쇄.
  const quiet = [
    ["&& inside double quotes", 'git commit -m "docs && git push --force"'],
    ["; inside double quotes", 'git commit -m "release; npm publish"'],
    ["; inside echo quotes", 'echo "note; rm -rf build"'],
    ["| inside nested quotes", 'node -e "console.log(\'x | kubectl delete pods\')"'],
    ["newline inside single quotes", "printf 'hello\nnpm publish\n'"],
    ["unbalanced quote stays quiet", 'git commit -m "unclosed && rm -rf x'],
  ];
  for (const [label, cmd] of quiet) {
    it(`quiet: ${label}`, () => {
      assert.strictEqual(detectIrreversible("Bash", { command: cmd }), null, cmd);
    });
  }
  it("flags: separator OUTSIDE quotes still splits (quoted arg + real force-push)", () => {
    const r = detectIrreversible("Bash", { command: 'git commit -m "msg" && git push --force' });
    assert.ok(r && r.tag === "force-push");
  });
  it("quiet: escaped separators outside quotes are literal (R3 lock)", () => {
    // shell은 \;를 리터럴로 취급 — 분할하면 인용-오탐과 같은 클래스의 가짜 세그먼트
    assert.strictEqual(detectIrreversible("Bash", { command: "echo docs\\; npm publish" }), null);
    assert.strictEqual(detectIrreversible("Bash", { command: "echo docs\\| kubectl delete pods" }), null);
  });
  it("flags: unescaped separator still splits", () => {
    const r = detectIrreversible("Bash", { command: "echo docs; npm publish" });
    assert.ok(r && r.tag === "publish");
  });
  it("quote-bomb input is fast", () => {
    const t0 = process.hrtime.bigint();
    detectIrreversible("Bash", { command: '"a;'.repeat(60000) });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 100, `took ${ms}ms`);
  });
});

describe("detectIrreversible — input robustness (attacker-influenced string)", () => {
  it("repeated-prefix adversarial input is fast (quadratic-stall regression lock)", () => {
    // ★cross-family 감사 High 회귀잠금: 비앵커 + [^\n]* 조합이 'git push '.repeat(40k)에서
    // ~12초 stall(권한 버블 = 도구 실행 블로킹 표면). 4KB 캡 + 세그먼트 앵커로 봉쇄.
    const t0 = process.hrtime.bigint();
    detectIrreversible("Bash", { command: "git push ".repeat(40000) });
    detectIrreversible("Bash", { command: "gh repo edit ".repeat(40000) });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 100, `took ${ms}ms`);
  });
  it("throwing property accessor never propagates (display-only helper must not break the bubble)", () => {
    const evil = { get command() { throw new Error("boom"); } };
    assert.strictEqual(detectIrreversible("Bash", evil), null);
  });

  it("compound commands are caught anywhere in the chain", () => {
    const r = detectIrreversible("Bash", { command: "cd repo && rm -rf build && echo done" });
    assert.ok(r);
    assert.strictEqual(r.tag, "file-delete");
  });
  it("megabyte input returns quickly and does not throw (4KB scan cap)", () => {
    const huge = "a ".repeat(500000) + "git push --force";  // hit beyond cap → quiet is fine
    const t0 = process.hrtime.bigint();
    const r = detectIrreversible("Bash", { command: huge });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `took ${ms}ms`);
    assert.strictEqual(r, null);   // beyond the cap — precision-first: quiet, never slow
  });
  it("destructive prefix within the cap is still caught on huge input", () => {
    const huge = "rm -rf / --no-preserve-root " + "x".repeat(1000000);
    const r = detectIrreversible("Bash", { command: huge });
    assert.ok(r && r.tag === "file-delete");
  });
});
