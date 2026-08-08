const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  normalizeTitle,
  extractPromptTitle,
  readComposerSessionTitle,
  resolveSessionTitle,
} = require("../hooks/cursor-session-title");

describe("cursor-session-title", () => {
  it("normalizes and truncates titles", () => {
    assert.strictEqual(normalizeTitle("  hello\nworld  "), "hello world");
    assert.strictEqual(normalizeTitle(""), null);
    assert.strictEqual(normalizeTitle("x".repeat(80)).endsWith("\u2026"), true);
  });

  it("uses the first non-empty prompt line as a fallback title", () => {
    assert.strictEqual(extractPromptTitle("\n\nfix the cursor hooks\nmore"), "fix the cursor hooks");
    assert.strictEqual(extractPromptTitle("api_key=sk-secret-value"), null);
  });

  it("reads composerHeaders.name from a Cursor state.vscdb", () => {
    // Skip if node:sqlite is unavailable (older Node).
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-title-"));
    const dbPath = path.join(tmpDir, "state.vscdb");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE composerHeaders (
          composerId TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      db.prepare("INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)").run(
        "aaa-bbb",
        JSON.stringify({ name: "Claw in desk cursor issue", subtitle: "Edited hooks" })
      );
      db.close();

      assert.strictEqual(
        readComposerSessionTitle("aaa-bbb", { dbPath }),
        "Claw in desk cursor issue"
      );
      assert.strictEqual(readComposerSessionTitle("missing", { dbPath }), null);
      assert.strictEqual(
        resolveSessionTitle(
          { conversation_id: "aaa-bbb", prompt: "should not win" },
          "beforeSubmitPrompt",
          { dbPath }
        ),
        "Claw in desk cursor issue"
      );
      assert.strictEqual(
        resolveSessionTitle(
          { conversation_id: "missing", prompt: "fallback from prompt" },
          "beforeSubmitPrompt",
          { dbPath }
        ),
        "fallback from prompt"
      );
      assert.strictEqual(
        resolveSessionTitle(
          { conversation_id: "missing", prompt: "ignored on tool use" },
          "preToolUse",
          { dbPath }
        ),
        null
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
