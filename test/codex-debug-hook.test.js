const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runSpawnedHook } = require("./helpers/spawned-hook");
const {
  appendDebugEntry,
  buildDebugEntry,
  parsePayload,
} = require("../hooks/codex-debug-hook");

const tempDirs = [];

function makeTempDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-debug-hook-"));
  tempDirs.push(tmpDir);
  return tmpDir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Codex debug hook", () => {
  it("parses valid JSON payloads", () => {
    assert.deepStrictEqual(parsePayload('{"hook_event_name":"Stop"}'), {
      hook_event_name: "Stop",
    });
  });

  it("builds a compact debug entry around the raw payload", () => {
    const entry = buildDebugEntry(
      JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/repo",
        transcript_path: "/tmp/rollout.jsonl",
        permission_mode: "default",
        source: "startup",
        stop_hook_active: false,
        tool_name: "Bash",
        tool_input: { command: "ls", description: "Run command" },
      }),
      new Date("2026-04-26T00:00:00.000Z")
    );

    assert.strictEqual(entry.captured_at, "2026-04-26T00:00:00.000Z");
    assert.strictEqual(entry.hook_event_name, "PermissionRequest");
    assert.strictEqual(entry.session_id, "session-1");
    assert.strictEqual(entry.turn_id, "turn-1");
    assert.strictEqual(entry.permission_mode, "default");
    assert.strictEqual(entry.source, "startup");
    assert.strictEqual(entry.stop_hook_active, false);
    assert.strictEqual(entry.tool_name, "Bash");
    assert.strictEqual(entry.tool_input_description, "Run command");
    assert.deepStrictEqual(entry.tool_input_keys, ["command", "description"]);
    assert.strictEqual(entry.parse_ok, true);
    assert.strictEqual(entry.payload.tool_input.description, "Run command");
  });

  it("captures raw payload when JSON parse fails", () => {
    const entry = buildDebugEntry("not valid json", new Date("2026-04-26T00:00:00.000Z"));

    assert.strictEqual(entry.parse_ok, false);
    assert.strictEqual(entry.payload, "not valid json");
    assert.strictEqual(entry.hook_event_name, null);
  });

  it("appends JSONL entries", () => {
    const logPath = path.join(makeTempDir(), "codex-hook-debug.jsonl");
    appendDebugEntry({ a: 1 }, logPath);
    appendDebugEntry({ b: 2 }, logPath);

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepStrictEqual(lines, [{ a: 1 }, { b: 2 }]);
  });

  it("writes no stdout and exits 0 when run as a command hook", () => {
    const tmpDir = makeTempDir();
    const logPath = path.join(tmpDir, "debug.jsonl");
    const scriptPath = path.resolve(__dirname, "..", "hooks", "codex-debug-hook.js");
    const result = runSpawnedHook({
      script: scriptPath,
      payload: { hook_event_name: "Stop", session_id: "session-1" },
      httpContract: "expect-none",
      env: { CLAWD_CODEX_DEBUG_LOG: logPath },
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    const line = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.strictEqual(line.hook_event_name, "Stop");
    assert.strictEqual(line.session_id, "session-1");
  });
});
