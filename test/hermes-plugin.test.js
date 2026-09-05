const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");
const { NESTED_TERMINAL_ENV } = require("../hooks/shared-process");
const { readRemoteIdentity } = require("../hooks/server-config");
const { buildRemoteIdentityDocument } = require("../src/remote-ssh-identity");

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

// Terminal-identity env consulted by _resolve_process_metadata and
// _orca_pane_key_from_env. Tests asserting an exact shape have to strip all of it
// or they only pass for a developer whose own terminal sets none of it — the
// nested-terminal markers alone cover gnome-terminal, Konsole, WezTerm, kitty,
// Alacritty, ConEmu, Windows Terminal and tmux. Taken from shared-process.js so a
// marker added there cannot silently make these tests machine-dependent again.
const TERMINAL_IDENTITY_ENV = [...NESTED_TERMINAL_ENV, "TMUX_PANE", "TERM_PROGRAM", "ORCA_PANE_KEY"];

function envWithoutTerminalIdentity() {
  const env = { ...process.env };
  for (const key of TERMINAL_IDENTITY_ENV) delete env[key];
  return env;
}

function runPluginPython(code, env = null) {
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(pythonCmd, ["-"], {
    cwd: path.join(__dirname, ".."),
    input: code,
    encoding: "utf8",
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  assert.strictEqual(
    result.status,
    0,
    `${pythonCmd} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
}

function validRemoteIdentity(overrides = {}) {
  return {
    version: 2,
    layoutVersion: 1,
    runtimeKey: "account-default",
    profileId: "secure-fixture",
    installId: "b".repeat(64),
    remotePort: 23335,
    routingNonce: "a".repeat(32),
    deployedAt: 1720000000000,
    ...overrides,
  };
}

function secureFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hermes-secure-"));
  const identityPath = path.join(root, "clawd-remote.json");
  const markerPath = path.join(root, "clawd-ssh-secure-v1");
  const hermesHome = path.join(root, "hermes-home");
  if (Object.prototype.hasOwnProperty.call(options, "identity")) {
    const body = typeof options.identity === "string"
      ? options.identity
      : JSON.stringify(options.identity);
    fs.writeFileSync(identityPath, body, "utf8");
  }
  if (options.marker) fs.writeFileSync(markerPath, "clawd-ssh-secure-v1", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    identityPath,
    markerPath,
    hermesHome,
    env: {
      ...envWithoutTerminalIdentity(),
      CLAWD_REMOTE_IDENTITY_PATH: identityPath,
      CLAWD_SSH_SECURE_MARKER_PATH: markerPath,
      HERMES_HOME: hermesHome,
    },
  };
}

const SECURE_PLUGIN_PYTHON_BOOTSTRAP = String.raw`
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class FakeHeaders(dict):
    def get(self, key, default=None):
        wanted = str(key).lower()
        for header, value in self.items():
            if str(header).lower() == wanted:
                return value
        return default

class FakeResponse:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = FakeHeaders(headers or {})
        self._body = body
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return self._body

def request_headers(req):
    return {str(key).lower(): value for key, value in req.header_items()}
`;

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

  it("falls back safely when clarify args are not a dict", () => {
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
def fail_post_permission(*args, **kwargs):
    raise AssertionError("_post_permission should not run without a valid clarify question")
mod._post_permission = fail_post_permission

for value in (None, "oops", ["x"]):
    assert mod._handle_clarify_tool(args=value, tool_name="clarify", session_id="hermes:s1") is None

print(json.dumps({"events": [item["event"] for item in posts]}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.events, ["PreToolUse", "PreToolUse", "PreToolUse"]);
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
`, envWithoutTerminalIdentity());
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

  it("carries the Orca pane key from the environment through to the payload", () => {
    // Orca's terminals hang off a detached daemon, so no ancestor in the walk
    // above identifies it and the env is the only source for the pane key.
    const script = String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
tree = {10: ("python.exe", 20), 20: ("hermes.exe", 30), 30: ("pwsh.exe", 40), 40: ("explorer.exe", 4)}

def fake_query(pid):
    row = tree.get(pid)
    if not row:
        return None
    name, parent = row
    return {"pid": pid, "parent_pid": parent, "name": name, "path": "", "cmdline": ""}

mod._query_process_info = fake_query
meta = mod._resolve_process_metadata(10)
mod._process_meta = dict(meta)
mod._process_meta_resolved = True
payload = {}
mod._add_process_meta(payload)

# Background walk unfinished (or raised): _cached_process_meta() returns {} and
# every walk-derived field drops out of the payload.
mod._process_meta = {}
mod._process_meta_resolved = False
unresolved = {}
mod._add_process_meta(unresolved)

print(json.dumps({"meta": meta, "payload": payload, "unresolved": unresolved}, sort_keys=True))
`;
    const orcaEnv = {
      ...envWithoutTerminalIdentity(),
      TERM_PROGRAM: "Orca",
      ORCA_PANE_KEY: "8ce1fff7-tab:9813824b-leaf",
    };

    const inOrca = JSON.parse(runPluginPython(script, orcaEnv));
    assert.strictEqual(inOrca.payload.orca_pane_key, "8ce1fff7-tab:9813824b-leaf");
    // Deliberately NOT a product of the walk: that result is cached and resolved
    // on a background thread, so a walk-derived key would be missing from every
    // event posted before the thread finishes and from all of them if it raised.
    assert.strictEqual(inOrca.meta.orca_pane_key, undefined);
    assert.strictEqual(inOrca.unresolved.orca_pane_key, "8ce1fff7-tab:9813824b-leaf");
    assert.strictEqual(inOrca.unresolved.source_pid, undefined);

    // A Windows Terminal shell launched from an Orca pane inherits the key while
    // genuinely living in WT; only WT sets WT_SESSION.
    const nested = JSON.parse(runPluginPython(script, { ...orcaEnv, WT_SESSION: "b3e1-nested" }));
    assert.strictEqual(nested.payload.orca_pane_key, undefined);
    assert.strictEqual(nested.unresolved.orca_pane_key, undefined);

    // A tmux server outlives the pane it was started from, so its inherited copy
    // of the key cannot be trusted either.
    const inTmux = JSON.parse(runPluginPython(script, { ...orcaEnv, TMUX: "/tmp/tmux-1000/default,7,0" }));
    assert.strictEqual(inTmux.payload.orca_pane_key, undefined);

    const malformed = JSON.parse(runPluginPython(script, { ...orcaEnv, ORCA_PANE_KEY: "no-separator" }));
    assert.strictEqual(malformed.payload.orca_pane_key, undefined);
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

  it("probes existing /state health route before the long blocking permission POST", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = []
class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)

class FakeResponse:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = FakeHeaders(headers or {})
        self._body = body
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return self._body

def fake_urlopen(req, timeout=None):
    calls.append({"url": req.full_url, "method": req.get_method(), "timeout": timeout})
    if req.full_url.endswith("/state"):
        return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})
    if req.full_url.endswith("/permission"):
        return FakeResponse(
            headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID},
            body=json.dumps({"decision": "allow"}).encode("utf-8"),
        )
    raise AssertionError(req.full_url)

mod._local_urlopen = fake_urlopen
mod._port_candidates = lambda transport=None: [23333]
mod._add_process_meta = lambda payload: None
mod._runtime_cwd = lambda: "/repo"
mod._append_log = lambda *args, **kwargs: None
mod._cached_port = None
mod._no_server_until = 0.0

result = mod._post_permission("execute_bash", {"command": "echo hi"}, "hermes:s1")
print(json.dumps({"result": result, "calls": calls, "cached_port": mod._cached_port}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.result, { decision: "allow" });
    assert.strictEqual(result.cached_port, 23333);
    assert.deepStrictEqual(result.calls.map((call) => [call.method, call.url, call.timeout]), [
      ["GET", "http://127.0.0.1:23333/state", 0.25],
      ["POST", "http://127.0.0.1:23333/permission", 600],
    ]);
  });

  it("bypasses inherited HTTP proxies for Clawd loopback state posts", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.dont_write_bytecode = True
for key in ("NO_PROXY", "no_proxy"):
    os.environ.pop(key, None)
for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ[key] = "http://127.0.0.1:1"

spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

received = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        received.append(json.loads(self.rfile.read(length).decode("utf-8")))
        self.send_response(200)
        self.send_header(mod.CLAWD_SERVER_HEADER, mod.CLAWD_SERVER_ID)
        self.end_headers()
    def log_message(self, *args):
        pass

server = HTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    mod._port_candidates = lambda transport=None: [server.server_port]
    mod._append_log = lambda *args, **kwargs: None
    mod._cached_port = None
    mod._no_server_until = 0.0
    mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "proxy-smoke"})
finally:
    server.shutdown()
    thread.join(timeout=2)
    server.server_close()

print(json.dumps({"received": received, "cached_port": mod._cached_port}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.strictEqual(result.received.length, 1);
    assert.strictEqual(result.received[0].agent_id, "hermes");
    assert.strictEqual(result.cached_port > 0, true);
  });

  it("skips process metadata on WebUI permission posts", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

meta_calls = []
permission_payloads = []
class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)

class FakeResponse:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = FakeHeaders(headers or {})
        self._body = body
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return self._body

def fake_urlopen(req, timeout=None):
    if req.full_url.endswith("/state"):
        return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})
    if req.full_url.endswith("/permission"):
        permission_payloads.append(json.loads(req.data.decode("utf-8")))
        return FakeResponse(
            headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID},
            body=json.dumps({"decision": "allow"}).encode("utf-8"),
        )
    raise AssertionError(req.full_url)

def fake_add_process_meta(payload):
    meta_calls.append(dict(payload))
    payload["source_pid"] = 1234
    payload["editor"] = "code"

mod._local_urlopen = fake_urlopen
mod._port_candidates = lambda transport=None: [23333]
mod._add_process_meta = fake_add_process_meta
mod._runtime_cwd = lambda: "/repo"
mod._append_log = lambda *args, **kwargs: None
mod._cached_port = None
mod._no_server_until = 0.0

result = mod._post_permission("execute_bash", {"command": "echo hi"}, "web-session", "webui")
print(json.dumps({
    "result": result,
    "meta_calls": meta_calls,
    "payload": permission_payloads[0],
}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.result, { decision: "allow" });
    assert.deepStrictEqual(result.meta_calls, []);
    assert.strictEqual(result.payload.source_pid, undefined);
    assert.strictEqual(result.payload.editor, undefined);
  });

  it("skips Hermes permission POST during no-server cooldown", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = []
logs = []
def fake_urlopen(*args, **kwargs):
    calls.append([str(args), kwargs])
    raise AssertionError("urlopen should not run during cooldown")

mod._local_urlopen = fake_urlopen
mod._append_log = lambda payload, **kwargs: logs.append(payload)
mod._cached_port = None
mod._no_server_until = time.monotonic() + 10

result = mod._post_permission("execute_bash", {}, "hermes:s1")
print(json.dumps({"result": result, "calls": calls, "logs": logs}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.strictEqual(result.result, null);
    assert.deepStrictEqual(result.calls, []);
    assert.strictEqual(result.logs[0].event, "post_permission_skipped_no_server");
  });

  it("fails closed when an opted-in permission tool receives no decision", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

hook_events = []
mod._post_permission = lambda *args, **kwargs: None
mod._handle_hook = lambda event_name, **kwargs: hook_events.append(event_name)
result = mod._handle_permission_request("execute_bash", args={"command": "rm -rf build"})
print(json.dumps({"result": result, "hook_events": hook_events}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.strictEqual(result.result.action, "block");
    assert.match(result.result.message, /did not return a permission decision/i);
    assert.deepStrictEqual(result.hook_events, ["pre_tool_call"]);
  });

  it("does not issue the long permission POST when the short probe is not Clawd", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = []
class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)
class FakeResponse:
    status = 200
    headers = FakeHeaders({})
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return b""

def fake_urlopen(req, timeout=None):
    calls.append({"url": req.full_url, "method": req.get_method(), "timeout": timeout})
    assert req.full_url.endswith("/state"), "permission POST should not be attempted after probe mismatch"
    return FakeResponse()

mod._local_urlopen = fake_urlopen
mod._port_candidates = lambda transport=None: [23333]
mod._append_log = lambda *args, **kwargs: None
mod._cached_port = None
mod._no_server_until = 0.0

result = mod._post_permission("execute_bash", {}, "hermes:s1")
print(json.dumps({
    "result": result,
    "calls": calls,
    "cached_port": mod._cached_port,
    "cooldown_set": mod._no_server_until > time.monotonic(),
}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.strictEqual(result.result, null);
    assert.deepStrictEqual(result.calls.map((call) => [call.method, call.url, call.timeout]), [
      ["GET", "http://127.0.0.1:23333/state", 0.25],
    ]);
    assert.strictEqual(result.cached_port, null);
    assert.strictEqual(result.cooldown_set, true);
  });
});

describe("secure remote transport", () => {
  it("uses the identity port and nonce for the secure state request only", (t) => {
    const fixture = secureFixture(t, { identity: validRemoteIdentity() });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []
logs = []

def fake_urlopen(req, timeout=None):
    calls.append({
        "url": req.full_url,
        "method": req.get_method(),
        "headers": request_headers(req),
    })
    return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: "not-clawd"})

mod._local_urlopen = fake_urlopen
mod._append_log = lambda payload, **kwargs: logs.append(payload)
mod._cached_port = 23333
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "secure-state"})

print(json.dumps({"calls": calls, "logs": logs, "cached_port": mod._cached_port}, sort_keys=True))
`}`, fixture.env);
    const result = JSON.parse(output);
    assert.strictEqual(result.calls.length, 1);
    assert.deepStrictEqual(
      [result.calls[0].method, result.calls[0].url],
      ["POST", "http://127.0.0.1:23335/state"]
    );
    assert.strictEqual(result.calls[0].headers["x-clawd-routing-nonce"], "a".repeat(32));
    assert.strictEqual(result.cached_port, 23333);
  });

  it("sends the secure nonce on both permission requests to the identity port", (t) => {
    const fixture = secureFixture(t, { identity: validRemoteIdentity({ remotePort: 23336 }) });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []

def fake_urlopen(req, timeout=None):
    calls.append({
        "url": req.full_url,
        "method": req.get_method(),
        "headers": request_headers(req),
    })
    if req.full_url.endswith("/state"):
        return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})
    return FakeResponse(
        headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID},
        body=json.dumps({"decision": "allow"}).encode("utf-8"),
    )

mod._local_urlopen = fake_urlopen
mod._append_log = lambda *args, **kwargs: None
result = mod._post_permission("execute_bash", {"command": "echo secure"}, "hermes:secure")

print(json.dumps({"result": result, "calls": calls}, sort_keys=True))
`}`, fixture.env);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.result, { decision: "allow" });
    assert.deepStrictEqual(result.calls.map((call) => [call.method, call.url]), [
      ["GET", "http://127.0.0.1:23336/state"],
      ["POST", "http://127.0.0.1:23336/permission"],
    ]);
    for (const call of result.calls) {
      assert.strictEqual(call.headers["x-clawd-routing-nonce"], "a".repeat(32));
    }
  });

  it("fails closed without network access for every invalid remote identity", (t) => {
    const invalidCases = [
      ["missing", null],
      ["unreadable-json", "{"],
      ["version", validRemoteIdentity({ version: 1 })],
      ["layout-zero", validRemoteIdentity({ layoutVersion: 0 })],
      ["layout-bool", validRemoteIdentity({ layoutVersion: true })],
      ["layout-string", validRemoteIdentity({ layoutVersion: "1" })],
      ["runtime-long", validRemoteIdentity({ runtimeKey: "r".repeat(65) })],
      ["runtime-symbol", validRemoteIdentity({ runtimeKey: "bad$key" })],
      ["profile", validRemoteIdentity({ profileId: "bad profile" })],
      ["install-id", validRemoteIdentity({ installId: "b".repeat(63) })],
      ["port-range", validRemoteIdentity({ remotePort: 23338 })],
      ["port-string", validRemoteIdentity({ remotePort: "23333x" })],
      ["port-bool", validRemoteIdentity({ remotePort: true })],
      ["nonce-short", validRemoteIdentity({ routingNonce: "a".repeat(31) })],
      ["nonce-uppercase", validRemoteIdentity({ routingNonce: "A".repeat(32) })],
      ["deployed-zero", validRemoteIdentity({ deployedAt: 0 })],
      ["deployed-negative", validRemoteIdentity({ deployedAt: -1 })],
      ["deployed-string", validRemoteIdentity({ deployedAt: "x" })],
      ["deployed-bool", validRemoteIdentity({ deployedAt: true })],
    ];

    for (const [name, identity] of invalidCases) {
      const fixture = secureFixture(t, { marker: true, ...(identity === null ? {} : { identity }) });
      const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []
logs = []
mod._local_urlopen = lambda *args, **kwargs: calls.append("network")
mod._append_log = lambda payload, **kwargs: logs.append(payload)
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "invalid"})
transport = mod._resolve_secure_transport()
print(json.dumps({
    "calls": calls,
    "logs": logs,
    "candidates": mod._port_candidates(transport),
    "reason": transport["reason"],
}, sort_keys=True))
`}`, { ...fixture.env, CLAWD_HERMES_DEBUG: "1" });
      const result = JSON.parse(output);
      assert.deepStrictEqual(result.calls, [], name);
      assert.deepStrictEqual(result.candidates, [], name);
      assert.ok(
        result.logs.some((entry) => entry.event === "post_state_skipped_no_identity"),
        `${name}: skip log missing`
      );
      assert.match(result.reason, /^identity-(missing|unreadable|invalid)$/, name);
    }
  });

  it("rejects array and string identity roots without network access", (t) => {
    for (const [name, identity] of [["array", "[]"], ["string", JSON.stringify("invalid-root")]]) {
      const fixture = secureFixture(t, { identity });
      const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []
logs = []
mod._local_urlopen = lambda *args, **kwargs: calls.append("network")
mod._append_log = lambda payload, **kwargs: logs.append(payload)
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "invalid-root"})
identity, reason = mod._read_remote_identity()
print(json.dumps({"identity": identity, "reason": reason, "calls": calls, "logs": logs}, sort_keys=True))
`}`, { ...fixture.env, CLAWD_HERMES_DEBUG: "1" });
      const result = JSON.parse(output);
      assert.strictEqual(result.identity, null, name);
      assert.strictEqual(result.reason, "identity-invalid", name);
      assert.deepStrictEqual(result.calls, [], name);
      assert.ok(
        result.logs.some((entry) => entry.event === "post_state_skipped_no_identity"),
        `${name}: skip log missing`
      );
    }
  });

  it("skips permission probe and POST when the secure identity is invalid", (t) => {
    const fixture = secureFixture(t, {
      identity: validRemoteIdentity({ routingNonce: "short" }),
    });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []
logs = []
mod._local_urlopen = lambda *args, **kwargs: calls.append("network")
mod._append_log = lambda payload, **kwargs: logs.append(payload)
result = mod._post_permission("execute_bash", {}, "hermes:invalid-permission")
print(json.dumps({"result": result, "calls": calls, "logs": logs}, sort_keys=True))
`}`, { ...fixture.env, CLAWD_HERMES_DEBUG: "1" });
    const result = JSON.parse(output);
    assert.strictEqual(result.result, null);
    assert.deepStrictEqual(result.calls, []);
    assert.ok(result.logs.some((entry) => entry.event === "post_permission_skipped_no_identity"));
  });

  it("re-reads same-mtime identity changes for every secure state request", (t) => {
    const nonceA = "1".repeat(32);
    const nonceB = "2".repeat(32);
    const fixture = secureFixture(t, {
      identity: validRemoteIdentity({ routingNonce: nonceA }),
    });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
from pathlib import Path

calls = []
identity_path = Path(os.environ["CLAWD_REMOTE_IDENTITY_PATH"])

def fake_urlopen(req, timeout=None):
    calls.append(request_headers(req))
    return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})

mod._local_urlopen = fake_urlopen
mod._append_log = lambda *args, **kwargs: None
body = {"agent_id": "hermes", "state": "thinking", "session_id": "rotate-state"}
mod._post_state(body)

before = identity_path.stat()
identity = json.loads(identity_path.read_text(encoding="utf-8"))
identity["routingNonce"] = "2" * 32
updated = json.dumps(identity, separators=(",", ":"))
original = identity_path.read_text(encoding="utf-8")
assert len(updated.encode("utf-8")) == len(original.encode("utf-8"))
identity_path.write_text(updated, encoding="utf-8")
os.utime(identity_path, ns=(before.st_atime_ns, before.st_mtime_ns))

mod._post_state(body)
print(json.dumps({"calls": calls}, sort_keys=True))
`}`, fixture.env);
    const result = JSON.parse(output);
    assert.deepStrictEqual(
      result.calls.map((headers) => headers["x-clawd-routing-nonce"]),
      [nonceA, nonceB]
    );
  });

  it("re-reads a rotated identity between permission probe and POST", (t) => {
    const nonceA = "3".repeat(32);
    const nonceB = "4".repeat(32);
    const fixture = secureFixture(t, {
      identity: validRemoteIdentity({ remotePort: 23334, routingNonce: nonceA }),
    });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
from pathlib import Path

calls = []
identity_path = Path(os.environ["CLAWD_REMOTE_IDENTITY_PATH"])

def fake_urlopen(req, timeout=None):
    calls.append({"url": req.full_url, "headers": request_headers(req)})
    if req.full_url.endswith("/state"):
        before = identity_path.stat()
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        identity["routingNonce"] = "4" * 32
        updated = json.dumps(identity, separators=(",", ":"))
        original = identity_path.read_text(encoding="utf-8")
        assert len(updated.encode("utf-8")) == len(original.encode("utf-8"))
        identity_path.write_text(updated, encoding="utf-8")
        os.utime(identity_path, ns=(before.st_atime_ns, before.st_mtime_ns))
        return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})
    return FakeResponse(
        headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID},
        body=json.dumps({"decision": "allow"}).encode("utf-8"),
    )

mod._local_urlopen = fake_urlopen
mod._append_log = lambda *args, **kwargs: None
result = mod._post_permission("execute_bash", {}, "hermes:rotate")
print(json.dumps({"result": result, "calls": calls}, sort_keys=True))
`}`, fixture.env);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.result, { decision: "allow" });
    assert.deepStrictEqual(
      result.calls.map((call) => call.headers["x-clawd-routing-nonce"]),
      [nonceA, nonceB]
    );
    assert.deepStrictEqual(result.calls.map((call) => call.url), [
      "http://127.0.0.1:23334/state",
      "http://127.0.0.1:23334/permission",
    ]);
  });

  it("fails closed when the identity port changes after the permission probe", (t) => {
    const fixture = secureFixture(t, {
      identity: validRemoteIdentity({ remotePort: 23334, routingNonce: "7".repeat(32) }),
    });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
from pathlib import Path

calls = []
logs = []
identity_path = Path(os.environ["CLAWD_REMOTE_IDENTITY_PATH"])

def fake_urlopen(req, timeout=None):
    calls.append({"url": req.full_url, "method": req.get_method()})
    if req.full_url.endswith("/state"):
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        identity["remotePort"] = 23336
        identity["routingNonce"] = "8" * 32
        identity_path.write_text(json.dumps(identity, separators=(",", ":")), encoding="utf-8")
        return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})
    raise AssertionError("permission POST must not run after the identity port changes")

mod._local_urlopen = fake_urlopen
mod._append_log = lambda payload, **kwargs: logs.append(payload)
result = mod._post_permission("execute_bash", {}, "hermes:port-change")
print(json.dumps({"result": result, "calls": calls, "logs": logs}, sort_keys=True))
`}`, { ...fixture.env, CLAWD_HERMES_DEBUG: "1" });
    const result = JSON.parse(output);
    assert.strictEqual(result.result, null);
    assert.deepStrictEqual(result.calls, [
      { method: "GET", url: "http://127.0.0.1:23334/state" },
    ]);
    const event = result.logs.find((entry) => entry.event === "post_permission_port_changed");
    assert.deepStrictEqual(
      {
        reason: event.reason,
        probed_port: event.probed_port,
        new_port: event.new_port,
      },
      {
        reason: "identity-port-changed",
        probed_port: 23334,
        new_port: 23336,
      }
    );
    assert.strictEqual(JSON.stringify(result.logs).includes("8".repeat(32)), false);
  });

  it("keeps secure mode latched after marker and identity removal", (t) => {
    const fixture = secureFixture(t, {
      identity: validRemoteIdentity({ remotePort: 23337 }),
      marker: true,
    });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
from pathlib import Path

calls = []
logs = []

def fake_urlopen(req, timeout=None):
    calls.append(req.full_url)
    return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})

mod._local_urlopen = fake_urlopen
mod._append_log = lambda payload, **kwargs: logs.append(payload)
body = {"agent_id": "hermes", "state": "thinking", "session_id": "latched"}
mod._post_state(body)
Path(os.environ["CLAWD_SSH_SECURE_MARKER_PATH"]).unlink()
Path(os.environ["CLAWD_REMOTE_IDENTITY_PATH"]).unlink()
mod._post_state(body)
transport = mod._resolve_secure_transport()

print(json.dumps({
    "calls": calls,
    "secure": transport["secure"],
    "candidates": mod._port_candidates(transport),
    "logs": logs,
}, sort_keys=True))
`}`, { ...fixture.env, CLAWD_HERMES_DEBUG: "1" });
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.calls, ["http://127.0.0.1:23337/state"]);
    assert.strictEqual(result.secure, true);
    assert.deepStrictEqual(result.candidates, []);
    assert.ok(result.logs.some((entry) => entry.event === "post_state_skipped_no_identity"));
  });

  it("honors the secure environment latch and false flag values", (t) => {
    const fixture = secureFixture(t, {});
    const inspectMode = (value) => JSON.parse(runPluginPython(
      `${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []
logs = []
mod._local_urlopen = lambda *args, **kwargs: calls.append("network")
mod._append_log = lambda payload, **kwargs: logs.append(payload)
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "env-latch"})
transport = mod._resolve_secure_transport()
print(json.dumps({
    "secure": transport["secure"],
    "calls": calls,
    "candidates": mod._port_candidates(transport),
    "logs": logs,
}, sort_keys=True))
`}`,
      { ...fixture.env, CLAWD_SSH_REMOTE: value, CLAWD_HERMES_DEBUG: "1" }
    ));

    const enabled = inspectMode("1");
    assert.strictEqual(enabled.secure, true);
    assert.deepStrictEqual(enabled.calls, []);
    assert.deepStrictEqual(enabled.candidates, []);
    assert.ok(enabled.logs.some((entry) => entry.event === "post_state_skipped_no_identity"));

    for (const value of ["0", "false"]) {
      const disabled = inspectMode(value);
      assert.strictEqual(disabled.secure, false, value);
      assert.deepStrictEqual(disabled.candidates, [23333, 23334, 23335, 23336, 23337], value);
    }
  });

  it("never writes the routing nonce to logs and redacts nonce keys", (t) => {
    const nonce = "5".repeat(32);
    const fixture = secureFixture(t, {
      identity: validRemoteIdentity({ routingNonce: nonce }),
    });
    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
from pathlib import Path
from urllib.error import URLError

def success(req, timeout=None):
    return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})

mod._local_urlopen = success
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "logged-success"})

def failure(req, timeout=None):
    raise URLError("secure request failed")

mod._local_urlopen = failure
mod._no_server_until = 0.0
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "logged-failure"})

original_state_payload = mod._state_payload
mod._state_payload = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("hook exception"))
mod._handle_hook("pre_llm_call", session_id="logged-exception", routing_nonce="5" * 32)
mod._state_payload = original_state_payload

safe = mod._safe_value({"routing_nonce": "5" * 32, "nonce": "5" * 32})
log_path = mod._log_path()
log_text = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
print(json.dumps({"log_text": log_text, "safe": safe}, sort_keys=True))
`}`, { ...fixture.env, CLAWD_HERMES_DEBUG: "1" });
    const result = JSON.parse(output);
    assert.ok(result.log_text.length > 0);
    assert.strictEqual(result.log_text.includes(nonce), false);
    assert.deepStrictEqual(result.safe, {
      routing_nonce: "<redacted>",
      nonce: "<redacted>",
    });
  });

  it("suppresses remote PID metadata and does not start its resolver", (t) => {
    const fixture = secureFixture(t, { identity: validRemoteIdentity() });
    const secureOutput = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []
permission_payloads = []
resolver_calls = []

def fake_urlopen(req, timeout=None):
    calls.append(req.full_url)
    if req.full_url.endswith("/state") and req.get_method() == "GET":
        return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})
    if req.full_url.endswith("/permission"):
        permission_payloads.append(json.loads(req.data.decode("utf-8")))
        return FakeResponse(
            headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID},
            body=json.dumps({"decision": "allow"}).encode("utf-8"),
        )
    return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})

class Context:
    def register_hook(self, *args):
        pass

mod._local_urlopen = fake_urlopen
mod._append_log = lambda *args, **kwargs: None
mod._add_process_meta = lambda payload: (_ for _ in ()).throw(AssertionError("secure metadata resolver used"))
mod._ensure_process_meta_resolver_started = lambda: resolver_calls.append("started")
state_payload = mod._state_payload("pre_llm_call", {"session_id": "secure-pid"})
mod._post_state(state_payload)
mod._post_permission("execute_bash", {}, "secure-pid")
mod.register(Context())

print(json.dumps({
    "state_payload": state_payload,
    "permission_payload": permission_payloads[0],
    "resolver_calls": resolver_calls,
}, sort_keys=True))
`}`, fixture.env);
    const secure = JSON.parse(secureOutput);
    const forbidden = [
      "agent_pid", "source_pid", "pid_chain", "editor", "tmux_socket", "tmux_client",
    ];
    for (const key of forbidden) {
      assert.strictEqual(secure.state_payload[key], undefined, `state ${key}`);
      assert.strictEqual(secure.permission_payload[key], undefined, `permission ${key}`);
    }
    assert.deepStrictEqual(secure.resolver_calls, []);

    const localFixture = secureFixture(t, {});
    const localOutput = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
mod._add_process_meta = lambda payload: None
payload = mod._state_payload("pre_llm_call", {"session_id": "local-pid"})
print(json.dumps({"agent_pid": payload.get("agent_pid")}, sort_keys=True))
`}`, { ...localFixture.env, CLAWD_SSH_REMOTE: "false" });
    const local = JSON.parse(localOutput);
    assert.strictEqual(Number.isInteger(local.agent_pid), true);
    assert.ok(local.agent_pid > 0);
  });

  it("starts the process metadata resolver only for non-secure registration", (t) => {
    const registerScript = String.raw`
calls = []
class Context:
    def register_hook(self, *args):
        pass
mod._ensure_process_meta_resolver_started = lambda: calls.append("started")
mod._append_log = lambda *args, **kwargs: None
mod.register(Context())
print(json.dumps({"calls": calls, "secure": mod._ssh_secure_mode()}, sort_keys=True))
`;

    const secureFixturePaths = secureFixture(t, { identity: validRemoteIdentity() });
    const secure = JSON.parse(runPluginPython(
      `${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${registerScript}`,
      secureFixturePaths.env
    ));
    assert.strictEqual(secure.secure, true);
    assert.deepStrictEqual(secure.calls, []);

    const localFixturePaths = secureFixture(t, {});
    const local = JSON.parse(runPluginPython(
      `${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${registerScript}`,
      { ...localFixturePaths.env, CLAWD_SSH_REMOTE: "false" }
    ));
    assert.strictEqual(local.secure, false);
    assert.deepStrictEqual(local.calls, ["started"]);
  });

  it("keeps a valid Orca pane key after the secure latch only", (t) => {
    const fixture = secureFixture(t, { identity: validRemoteIdentity() });
    const secureOutput = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
os.environ["ORCA_PANE_KEY"] = "8ce1fff7-tab:9813824b-leaf"
os.environ.pop("TERM_PROGRAM", None)
plain = mod._state_payload("pre_llm_call", {"session_id": "secure-orca"})
os.environ["WT_SESSION"] = "nested-terminal"
nested = mod._state_payload("pre_llm_call", {"session_id": "secure-orca"})
print(json.dumps({
    "plain": plain.get("orca_pane_key"),
    "nested": nested.get("orca_pane_key"),
}, sort_keys=True))
`}`, fixture.env);
    const secure = JSON.parse(secureOutput);
    assert.strictEqual(secure.plain, "8ce1fff7-tab:9813824b-leaf");
    assert.strictEqual(secure.nested, null);

    const localFixture = secureFixture(t, {});
    const localOutput = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
os.environ["ORCA_PANE_KEY"] = "8ce1fff7-tab:9813824b-leaf"
os.environ.pop("TERM_PROGRAM", None)
mod._add_process_meta = lambda payload: None
payload = mod._state_payload("pre_llm_call", {"session_id": "local-orca"})
print(json.dumps({"orca": payload.get("orca_pane_key")}, sort_keys=True))
`}`, localFixture.env);
    assert.strictEqual(JSON.parse(localOutput).orca, null);
  });

  it("accepts the shared JS remote identity document in both languages", (t) => {
    const fixture = secureFixture(t, {});
    const identity = buildRemoteIdentityDocument({
      profile: {
        id: "secure-fixture",
        layoutVersion: 1,
        runtimeKey: "account-default",
        remoteForwardPort: 23334,
        routingNonce: "6".repeat(32),
      },
      installId: "c".repeat(64),
      deployedAt: 1720000000000,
    });
    fs.writeFileSync(fixture.identityPath, JSON.stringify(identity), "utf8");
    const jsIdentity = readRemoteIdentity({ remoteIdentityPath: fixture.identityPath });
    assert.strictEqual(jsIdentity.ok, true);
    assert.strictEqual(jsIdentity.remotePort, 23334);

    const output = runPluginPython(`${SECURE_PLUGIN_PYTHON_BOOTSTRAP}${String.raw`
calls = []

def fake_urlopen(req, timeout=None):
    calls.append({"url": req.full_url, "headers": request_headers(req)})
    return FakeResponse(headers={mod.CLAWD_SERVER_HEADER: mod.CLAWD_SERVER_ID})

mod._local_urlopen = fake_urlopen
mod._append_log = lambda *args, **kwargs: None
identity, reason = mod._read_remote_identity()
mod._post_state({"agent_id": "hermes", "state": "thinking", "session_id": "cross-language"})
print(json.dumps({"identity": identity, "reason": reason, "calls": calls}, sort_keys=True))
`}`, fixture.env);
    const python = JSON.parse(output);
    assert.strictEqual(python.reason, "ok");
    assert.strictEqual(python.identity.remotePort, 23334);
    assert.deepStrictEqual(python.calls.map((call) => call.url), [
      "http://127.0.0.1:23334/state",
    ]);
    assert.strictEqual(python.calls[0].headers["x-clawd-routing-nonce"], "6".repeat(32));
  });

  it("prefers hermes_constants home and retains the environment fallback", (t) => {
    const fixture = secureFixture(t, {});
    const moduleDir = path.join(fixture.root, "python-module");
    fs.mkdirSync(moduleDir);
    fs.writeFileSync(
      path.join(moduleDir, "hermes_constants.py"),
      "def get_hermes_home():\n    return '/tmp/x'\n",
      "utf8"
    );
    const preferredOutput = runPluginPython(String.raw`
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["HERMES_CONSTANTS_FIXTURE"])
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps({"preferred": mod._hermes_home() == Path("/tmp/x")}, sort_keys=True))
`, { ...fixture.env, HERMES_CONSTANTS_FIXTURE: moduleDir, HERMES_HOME: path.join(fixture.root, "fallback") });
    assert.strictEqual(JSON.parse(preferredOutput).preferred, true);

    const fallbackFixture = secureFixture(t, {});
    const fallbackHome = path.join(fallbackFixture.root, "fallback-home");
    const fallbackOutput = runPluginPython(String.raw`
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps({"fallback": mod._hermes_home() == Path(os.environ["HERMES_HOME"])}, sort_keys=True))
`, { ...fallbackFixture.env, HERMES_HOME: fallbackHome });
    assert.strictEqual(JSON.parse(fallbackOutput).fallback, true);
  });
});
