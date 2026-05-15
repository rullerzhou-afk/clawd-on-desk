const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");

const pluginDir = path.join(__dirname, "..", "hooks", "hermes-plugin");

function readPluginSource() {
  return fs.readFileSync(path.join(pluginDir, "__init__.py"), "utf8");
}

function readManifestHooks() {
  const text = fs.readFileSync(path.join(pluginDir, "plugin.yaml"), "utf8");
  const hooks = [];
  let inHooks = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^hooks:\s*$/.test(line)) {
      inHooks = true;
      continue;
    }
    if (inHooks && /^\S/.test(line)) break;
    const match = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*$/);
    if (inHooks && match) hooks.push(match[1]);
  }
  return hooks;
}

function runPluginPython(code) {
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(pythonCmd, ["-"], {
    cwd: path.join(__dirname, ".."),
    input: code,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(
    result.status,
    0,
    `${pythonCmd} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
}

describe("Hermes plugin", () => {
  it("keeps manifest hook declarations aligned with registered hooks", () => {
    const source = readPluginSource();
    const hooks = readManifestHooks();
    for (const hook of hooks) {
      assert.match(source, new RegExp(`"${hook}"\\s*:`), `${hook} should be mapped in HOOK_TO_STATE`);
    }
    assert.ok(hooks.includes("on_session_finalize"));
    assert.ok(hooks.includes("on_session_reset"));
    assert.ok(!hooks.includes("subagent_stop"));
    assert.ok(!hooks.includes("pre_approval_request"));
    assert.ok(!hooks.includes("post_approval_response"));
  });

  it("maps verified Hermes session boundary hooks to Clawd lifecycle events", () => {
    const source = readPluginSource();
    assert.match(source, /"on_session_finalize": \("sleeping", "SessionEnd"\)/);
    assert.match(source, /"on_session_reset": \("idle", "SessionStart"\)/);
    assert.match(source, /def _finish_session_boundary/);
  });

  it("clears stale tool mappings on reset and drops orphan post-tool events", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

posts = []
def fake_post_state(payload):
    posts.append(dict(payload))
def fake_append_log(*args, **kwargs):
    return None

mod._post_state = fake_post_state
mod._append_log = fake_append_log
mod._active_session_id = ""
mod._task_session_ids.clear()
mod._known_session_ids.clear()
mod._session_platforms.clear()

mod._handle_hook("pre_llm_call", session_id="old-session")
mod._handle_hook("pre_tool_call", task_id="old-task", tool_name="terminal")
assert posts[-1]["session_id"] == "old-session"
assert "old-task" in mod._task_session_ids

mod._handle_hook("on_session_reset", session_id="new-session")
assert posts[-1]["event"] == "SessionStart"
assert posts[-1]["session_id"] == "new-session"
assert mod._active_session_id == "new-session"
assert mod._task_session_ids == {}

count = len(posts)
mod._handle_hook("post_tool_call", task_id="old-task", tool_name="terminal", result='{"exit_code": 0}')
assert len(posts) == count

mod._handle_hook("on_session_finalize", session_id="new-session")
assert posts[-1]["event"] == "SessionEnd"
assert mod._active_session_id == ""

print(json.dumps([{"event": item["event"], "session_id": item["session_id"]} for item in posts]))
`);
    const events = JSON.parse(output);
    assert.deepStrictEqual(events, [
      { event: "UserPromptSubmit", session_id: "old-session" },
      { event: "PreToolUse", session_id: "old-session" },
      { event: "SessionStart", session_id: "new-session" },
      { event: "SessionEnd", session_id: "new-session" },
    ]);
  });

  it("uses WebUI task ids as session ids for tool hooks before active-session fallback", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

posts = []
mod._post_state = lambda payload: posts.append(dict(payload))
mod._append_log = lambda *args, **kwargs: None
mod._active_session_id = ""
mod._task_session_ids.clear()
mod._known_session_ids.clear()
mod._session_platforms.clear()
mod._process_meta_resolved = True
mod._process_meta = {"source_pid": 40, "pid_chain": [10, 20, 40], "editor": "code"}

mod._handle_hook("pre_llm_call", session_id="web-a", platform="webui", model="gpt-5.4")
mod._handle_hook("pre_llm_call", session_id="web-b", platform="webui", model="claude-sonnet-4-6")
mod._handle_hook("pre_tool_call", task_id="web-a", tool_name="terminal")

print(json.dumps(posts, sort_keys=True))
`);
    const posts = JSON.parse(output);
    assert.strictEqual(posts[0].session_id, "web-a");
    assert.strictEqual(posts[0].platform, "webui");
    assert.strictEqual(posts[0].model, "gpt-5.4");
    assert.strictEqual(posts[1].session_id, "web-b");
    assert.strictEqual(posts[2].session_id, "web-a");
    assert.strictEqual(posts[2].platform, "webui");
    assert.strictEqual(posts[2].tool_name, "terminal");
    assert.strictEqual(posts[2].source_pid, undefined);
    assert.strictEqual(posts[2].editor, undefined);
  });

  it("prefers WebUI thread-local environment for cwd and session key", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import os
import sys
import types

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

api_mod = types.ModuleType("api")
api_mod.__path__ = []
config_mod = types.ModuleType("api.config")
config_mod._thread_ctx = types.SimpleNamespace(env={
    "TERMINAL_CWD": "/workspace/from-thread",
    "HERMES_SESSION_KEY": "thread-session",
})
sys.modules["api"] = api_mod
sys.modules["api.config"] = config_mod

posts = []
mod._post_state = lambda payload: posts.append(dict(payload))
mod._append_log = lambda *args, **kwargs: None
mod._active_session_id = "wrong-active"
mod._task_session_ids.clear()
mod._known_session_ids.clear()
mod._session_platforms.clear()
os.environ["TERMINAL_CWD"] = "/workspace/from-process"

mod._handle_hook("pre_tool_call", task_id="thread-task", tool_name="read_file")

print(json.dumps(posts[-1], sort_keys=True))
`);
    const payload = JSON.parse(output);
    assert.strictEqual(payload.session_id, "thread-session");
    assert.strictEqual(payload.cwd, "/workspace/from-thread");
    assert.strictEqual(payload.tool_name, "read_file");
  });

  it("keeps CLI tool hooks on the active-session fallback", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

posts = []
mod._post_state = lambda payload: posts.append(dict(payload))
mod._append_log = lambda *args, **kwargs: None
mod._active_session_id = "cli-session"
mod._task_session_ids.clear()
mod._known_session_ids.clear()
mod._session_platforms.clear()
os.environ["TERMINAL_CWD"] = "/workspace/cli"

mod._handle_hook("pre_tool_call", task_id="random-task-id", tool_name="terminal")

print(json.dumps(posts[-1], sort_keys=True))
`);
    const payload = JSON.parse(output);
    assert.strictEqual(payload.session_id, "cli-session");
    assert.strictEqual(payload.cwd, "/workspace/cli");
    assert.strictEqual(payload.tool_name, "terminal");
    assert.strictEqual(payload.platform, undefined);
  });

  it("resolves Hermes process metadata without guessing wrapper-only chains", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
cases = {}

def run_case(tree, start):
    def fake_query(pid):
        row = tree.get(pid)
        if not row:
            return None
        name, parent = row
        return {"pid": pid, "parent_pid": parent, "name": name, "path": "", "cmdline": ""}
    mod._query_process_info = fake_query
    return mod._resolve_process_metadata(start)

cases["terminal"] = run_case({
    10: ("python.exe", 20),
    20: ("uv.exe", 30),
    30: ("hermes.exe", 40),
    40: ("pwsh.exe", 50),
    50: ("WindowsTerminal.exe", 60),
    60: ("explorer.exe", 4),
}, 10)

cases["editor"] = run_case({
    10: ("python.exe", 20),
    20: ("hermes.exe", 30),
    30: ("pwsh.exe", 40),
    40: ("Cursor.exe", 50),
    50: ("explorer.exe", 4),
}, 10)

cases["wrapper_only"] = run_case({
    10: ("python.exe", 20),
    20: ("uv.exe", 30),
    30: ("hermes.exe", 40),
    40: ("explorer.exe", 4),
}, 10)

cases["failure"] = run_case({}, 10)

print(json.dumps(cases, sort_keys=True))
`);
    const cases = JSON.parse(output);
    assert.strictEqual(cases.terminal.source_pid, 50);
    assert.deepStrictEqual(cases.terminal.pid_chain, [10, 20, 30, 40, 50, 60]);
    assert.strictEqual(cases.editor.source_pid, 40);
    assert.strictEqual(cases.editor.editor, "cursor");
    assert.deepStrictEqual(cases.editor.pid_chain, [10, 20, 30, 40, 50]);
    assert.strictEqual(cases.wrapper_only.source_pid, undefined);
    assert.deepStrictEqual(cases.wrapper_only.pid_chain, [10, 20, 30, 40]);
    assert.deepStrictEqual(cases.failure, {});
  });

  it("uses one PowerShell CIM snapshot for Windows process metadata", () => {
    // Concatenate so this file does not match the project-wide deprecated-tool grep.
    const deprecatedProcessTool = "w" + "mic";
    const deprecatedProcessToolPattern = new RegExp(`\\b${deprecatedProcessTool}\\b`, "i");
    assert.doesNotMatch(readPluginSource(), deprecatedProcessToolPattern);
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys
import types

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
calls = []
snapshot = [
    {"ProcessId": 10, "Name": "python.exe", "ParentProcessId": 20, "ExecutablePath": "", "CommandLine": ""},
    {"ProcessId": 20, "Name": "hermes.exe", "ParentProcessId": 30, "ExecutablePath": "", "CommandLine": ""},
    {"ProcessId": 30, "Name": "pwsh.exe", "ParentProcessId": 40, "ExecutablePath": "", "CommandLine": ""},
    {"ProcessId": 40, "Name": "WindowsTerminal.exe", "ParentProcessId": 50, "ExecutablePath": "", "CommandLine": ""},
    {"ProcessId": 50, "Name": "explorer.exe", "ParentProcessId": 4, "ExecutablePath": "", "CommandLine": ""},
]

def fake_run(args, timeout=0.8):
    calls.append({"args": list(args), "timeout": timeout})
    joined = " ".join(args).lower()
    # Concatenate so this test file itself does not match the project-wide grep.
    assert ("w" + "mic") not in joined
    assert args[0] == "powershell.exe"
    assert "Get-CimInstance Win32_Process" in args[-1]
    return types.SimpleNamespace(returncode=0, stdout=json.dumps(snapshot))

mod._run_process_command = fake_run
meta = mod._resolve_process_metadata(10)

print(json.dumps({"calls": calls, "meta": meta}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.strictEqual(result.calls.length, 1);
    assert.match(result.calls[0].args.join(" "), /Get-CimInstance Win32_Process/);
    assert.doesNotMatch(result.calls[0].args.join(" "), deprecatedProcessToolPattern);
    assert.strictEqual(result.meta.source_pid, 40);
    assert.deepStrictEqual(result.meta.pid_chain, [10, 20, 30, 40, 50]);
  });

  it("falls back to per-PID CIM lookups when the Windows snapshot is unavailable", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import re
import sys
import types

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
tree = {
    10: {"ProcessId": 10, "Name": "python.exe", "ParentProcessId": 20, "ExecutablePath": "", "CommandLine": ""},
    20: {"ProcessId": 20, "Name": "hermes.exe", "ParentProcessId": 30, "ExecutablePath": "", "CommandLine": ""},
    30: {"ProcessId": 30, "Name": "pwsh.exe", "ParentProcessId": 40, "ExecutablePath": "", "CommandLine": ""},
    40: {"ProcessId": 40, "Name": "Code.exe", "ParentProcessId": 50, "ExecutablePath": "", "CommandLine": ""},
    50: {"ProcessId": 50, "Name": "explorer.exe", "ParentProcessId": 4, "ExecutablePath": "", "CommandLine": ""},
}
calls = []

def fake_run(args, timeout=0.8):
    calls.append({"args": list(args), "timeout": timeout})
    script = args[-1]
    joined = " ".join(args).lower()
    assert ("w" + "mic") not in joined
    assert args[0] == "powershell.exe"
    assert "Get-CimInstance Win32_Process" in script
    if "-Filter" not in script:
        return types.SimpleNamespace(returncode=0, stdout="[]")
    match = re.search(r"ProcessId=(\d+)", script)
    assert match
    row = tree.get(int(match.group(1)))
    return types.SimpleNamespace(returncode=0, stdout=json.dumps(row or {}))

mod._run_process_command = fake_run
meta = mod._resolve_process_metadata(10)

print(json.dumps({"calls": calls, "meta": meta}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.strictEqual(result.calls.length, 6);
    assert.doesNotMatch(result.calls[0].args.join(" "), /-Filter/);
    assert.deepStrictEqual(result.calls.map((call) => call.timeout), [3, 3, 3, 3, 3, 3]);
    assert.deepStrictEqual(
      result.calls.slice(1).map((call) => call.args.join(" ").match(/ProcessId=(\d+)/)[1]),
      ["10", "20", "30", "40", "50"]
    );
    assert.strictEqual(result.meta.source_pid, 40);
    assert.strictEqual(result.meta.editor, "code");
    assert.deepStrictEqual(result.meta.pid_chain, [10, 20, 30, 40, 50]);
  });

  it("attaches cached Hermes process metadata to state payloads without hot-path lookups", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
tree = {
    10: ("python.exe", 20),
    20: ("hermes.exe", 30),
    30: ("pwsh.exe", 40),
    40: ("Code.exe", 50),
    50: ("explorer.exe", 4),
}
calls = []
def fake_query(pid):
    calls.append(pid)
    row = tree.get(pid)
    if not row:
        return None
    name, parent = row
    return {"pid": pid, "parent_pid": parent, "name": name, "path": "", "cmdline": ""}

posts = []
mod._query_process_info = fake_query
mod._append_log = lambda *args, **kwargs: None
mod._post_state = lambda payload: posts.append(dict(payload))
mod.os.getpid = lambda: 10

mod._resolve_process_meta_background()
resolved_calls = list(calls)

mod._handle_hook("pre_llm_call", session_id="cached-session")
mod._handle_hook("post_llm_call", session_id="cached-session")

print(json.dumps({
    "resolved_calls": resolved_calls,
    "all_calls": calls,
    "posts": [{
        "event": item["event"],
        "source_pid": item.get("source_pid"),
        "pid_chain": item.get("pid_chain"),
        "editor": item.get("editor"),
        "agent_pid": item.get("agent_pid"),
    } for item in posts],
}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.resolved_calls, [10, 20, 30, 40, 50]);
    assert.deepStrictEqual(result.all_calls, result.resolved_calls);
    assert.deepStrictEqual(result.posts, [
      {
        event: "UserPromptSubmit",
        source_pid: 40,
        pid_chain: [10, 20, 30, 40, 50],
        editor: "code",
        agent_pid: 10,
      },
      {
        event: "Stop",
        source_pid: 40,
        pid_chain: [10, 20, 30, 40, 50],
        editor: "code",
        agent_pid: 10,
      },
    ]);
  });
});
