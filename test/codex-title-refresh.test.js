const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { runCodexHook } = require("../hooks/codex-hook");
const {
  CODEX_INTERNAL_THREAD_TITLE_REFRESH,
  isCodexTitleRefreshPrompt,
} = require("../hooks/codex-internal-worker");

// Audited Desktop 26.1016 adaptive-title caller, with synthetic titles only.
function titleRefresh(title) {
  return `Keep the current chat title ${JSON.stringify(title)} if it still fits the conversation.\n`
    + "If the focus has changed, write a more useful title in the user's language, up to 24 characters.\n"
    + 'Reply only with JSON: {"title":"...","description":"a search summary, up to 100 characters"}. Do not use tools.';
}

describe("Codex Desktop title-refresh classification", () => {
  for (const title of ["Analysis", "分析", "", 'quoted "title"\\line\nnext', "💡".repeat(30)]) {
    it(`recognizes the complete template with a canonical JSON title ${JSON.stringify(title)}`, () => {
      assert.equal(isCodexTitleRefreshPrompt(titleRefresh(title)), true);
    });
  }

  for (const prompt of [
    undefined, null, {}, [], "", "分析", "Please generate a title for this conversation.",
    'Keep the current chat title "Analysis"',
    titleRefresh("Analysis").replace("24 characters", "36 characters"),
    titleRefresh("Analysis").replace('"Analysis"', '"\\u0041nalysis"'),
    titleRefresh("Analysis").replace('"Analysis"', "null"),
    titleRefresh("Analysis").replace('"Analysis"', "42"),
    titleRefresh("Analysis").replace('"Analysis"', '"unterminated'),
    `Explain this prompt:\n${titleRefresh("Analysis")}`,
    `${titleRefresh("Analysis")}\nAnd explain your answer.`,
  ]) {
    it(`leaves unknown, quoted, or changed requests visible (${JSON.stringify(prompt)})`, () => {
      assert.equal(isCodexTitleRefreshPrompt(prompt), false);
    });
  }

  const clientEnv = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" };
  const resolvePid = () => ({ stablePid: 123, agentPid: 456, pidChain: [456, 123] });
  async function submit(extra = {}, env = clientEnv) {
    const posted = [];
    await runCodexHook({
      hook_event_name: "UserPromptSubmit", session_id: "title-refresh-fixture",
      prompt: titleRefresh("synthetic private title"), ...extra,
    }, {
      env, platform: "linux", resolvePid,
      postState(body, _options, callback) {
        posted.push(JSON.parse(body)); callback(true, 23333);
      },
      async runAutoStart() { throw new Error("unexpected auto-start"); },
    });
    assert.equal(posted.length, 1);
    return posted[0];
  }

  it("tags only the client-ephemeral prompt and never forwards its text/title", async () => {
    const body = await submit();
    assert.equal(body.codex_internal_thread, CODEX_INTERNAL_THREAD_TITLE_REFRESH);
    assert.equal(body.source_pid, 123);
    assert.equal(body.agent_pid, 456);
    assert.equal(Object.hasOwn(body, "prompt"), false);
    assert.equal(JSON.stringify(body).includes("synthetic private title"), false);
    assert.equal(JSON.stringify(body).includes("Keep the current chat title"), false);
  });

  it("keeps a transcript-backed conversation which pastes the same template", async () => {
    const body = await submit({ transcript_path: "/missing/synthetic-rollout.jsonl" });
    assert.equal(body.codex_internal_thread, undefined);
  });

  it("keeps an ephemeral CLI request without the client environment marker", async () => {
    const body = await submit({}, {});
    assert.equal(body.codex_internal_thread, undefined);
  });

  it("keeps a normal no-tool side chat with an ordinary user prompt", async () => {
    const body = await submit({ prompt: "请只回复 OK，不运行工具" });
    assert.equal(body.codex_internal_thread, undefined);
    assert.equal(body.state, "thinking");
  });

  it("does not classify other hook events by a prompt-shaped extra field", async () => {
    const body = await submit({ hook_event_name: "Stop" });
    assert.equal(body.codex_internal_thread, undefined);
    assert.equal(body.state, "idle");
  });
});
