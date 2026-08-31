"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const createAgentRuntimeMain = require("../src/agent-runtime-main");

describe("main Codex official hook JSONL suppression", () => {
  it("suppresses guardian_assessment for hook-active Codex sessions", () => {
    assert.ok(
      createAgentRuntimeMain.CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has("event_msg:guardian_assessment"),
      "guardian_assessment should not re-drive hook-active Codex sessions from JSONL"
    );
  });

  it("keeps official-covered tools suppressed but WebSearch on JSONL fallback", () => {
    const runtime = createAgentRuntimeMain({ codexSubagentClassifier: {} });
    runtime.markCodexOfficialHookSession("codex-1", "turn-1");

    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent(
        "codex-1",
        "working",
        "response_item:function_call",
        "turn-1",
      ),
      true,
    );
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent(
        "codex-1",
        "working",
        "response_item:function_call",
        "turn-1",
        { recapIsWebSearch: true },
      ),
      false,
    );
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent(
        "codex-1",
        "working",
        "response_item:custom_tool_call",
        "turn-1",
      ),
      true,
    );
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent(
        "codex-1",
        "working",
        "response_item:web_search_call",
        "turn-1",
      ),
      false,
    );
  });
});
