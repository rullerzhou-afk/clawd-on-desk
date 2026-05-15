"""Clawd on Desk plugin for Hermes Agent.

This is intentionally stdlib-only. It forwards conservative Hermes state events
to Clawd's local /state endpoint when Clawd is running and never raises out of
a Hermes hook callback.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib import request
from urllib.error import URLError

AGENT_ID = "hermes"
CLAWD_SERVER_HEADER = "x-clawd-server"
CLAWD_SERVER_ID = "clawd-on-desk"
SERVER_PORTS = (23333, 23334, 23335, 23336, 23337)
POST_TIMEOUT_SECONDS = 0.25
NO_SERVER_COOLDOWN_SECONDS = 2.0
TASK_SESSION_TTL_SECONDS = 10 * 60
MAX_TASK_SESSION_IDS = 256
MAX_STRING = 2000
MAX_LIST = 20
MAX_DICT = 60
MAX_DEPTH = 4

HOOK_TO_STATE: Dict[str, Tuple[str, str]] = {
    "on_session_start": ("idle", "SessionStart"),
    "pre_llm_call": ("thinking", "UserPromptSubmit"),
    "post_llm_call": ("attention", "Stop"),
    "pre_tool_call": ("working", "PreToolUse"),
    "post_tool_call": ("working", "PostToolUse"),
    # Hermes on_session_end fires at the end of every run_conversation turn,
    # not only when the CLI exits, so Clawd should treat it like turn stop.
    "on_session_end": ("attention", "Stop"),
    # Hermes on_session_finalize is the real boundary for session rotation and
    # gateway eviction; one-shot `hermes -z` did not emit it in local QA.
    "on_session_finalize": ("sleeping", "SessionEnd"),
    "on_session_reset": ("idle", "SessionStart"),
}

HOOKS = tuple(HOOK_TO_STATE.keys())
TOOL_HOOKS = {"pre_tool_call", "post_tool_call"}

TERMINAL_NAMES = {
    "win32": {
        "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
        "alacritty.exe", "wezterm-gui.exe", "mintty.exe", "conemu64.exe",
        "conemu.exe", "hyper.exe", "tabby.exe", "antigravity.exe",
        "warp.exe", "ghostty.exe",
    },
    "darwin": {"terminal", "iterm2", "alacritty", "wezterm-gui", "kitty", "hyper", "tabby", "warp", "ghostty"},
    "linux": {
        "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
        "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
        "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
    },
}
SYSTEM_BOUNDARY = {
    "win32": {"explorer.exe", "services.exe", "winlogon.exe", "svchost.exe", "system", "idle"},
    "darwin": {"launchd", "init", "systemd"},
    "linux": {"systemd", "init"},
}
EDITOR_NAMES = {
    "win32": {"code.exe": "code", "cursor.exe": "cursor"},
    "darwin": {"code": "code", "cursor": "cursor"},
    "linux": {"code": "code", "cursor": "cursor", "code-insiders": "code"},
}
EDITOR_PATH_CHECKS = (("visual studio code", "code"), ("cursor.app", "cursor"))
PROCESS_TREE_MAX_DEPTH = 8
PROCESS_QUERY_TIMEOUT_SECONDS = 0.8

_cached_port: Optional[int] = None
_no_server_until = 0.0
_log_lock = threading.Lock()
_session_lock = threading.Lock()
_process_meta_lock = threading.Lock()
_active_session_id = ""
_task_session_ids: Dict[str, Tuple[str, float]] = {}
_known_session_ids: Dict[str, float] = {}
_session_platforms: Dict[str, str] = {}
_process_meta_started = False
_process_meta_resolved = False
_process_meta: Dict[str, Any] = {}


def _debug_enabled() -> bool:
    value = os.environ.get("CLAWD_HERMES_DEBUG", "").strip().lower()
    return value in ("1", "true", "yes", "on")


def _hermes_home() -> Path:
    value = os.environ.get("HERMES_HOME", "").strip()
    if value:
        return Path(value)

    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        candidate = Path(local) / "hermes"
        if (candidate / "config.yaml").exists():
            return candidate

    return Path.home() / ".hermes"


def _log_path() -> Path:
    return _hermes_home() / "logs" / "clawd-hermes-plugin.jsonl"


def _runtime_path() -> Path:
    return Path.home() / ".clawd" / "runtime.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _is_secret_key(key: Any) -> bool:
    text = str(key).lower()
    return any(part in text for part in ("token", "secret", "api_key", "apikey", "authorization"))


def _safe_value(value: Any, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return f"<{type(value).__name__}>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            return value[:MAX_STRING] + f"...<truncated {len(value) - MAX_STRING} chars>"
        return value
    if isinstance(value, bytes):
        return f"<bytes {len(value)}>"
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        out = [_safe_value(item, depth + 1) for item in items[:MAX_LIST]]
        if len(items) > MAX_LIST:
            out.append(f"<truncated {len(items) - MAX_LIST} items>")
        return out
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        items = list(value.items())
        for key, entry in items[:MAX_DICT]:
            key_text = str(key)
            out[key_text] = "<redacted>" if _is_secret_key(key_text) else _safe_value(entry, depth + 1)
        if len(items) > MAX_DICT:
            out["<truncated>"] = len(items) - MAX_DICT
        return out
    return repr(value)[:MAX_STRING]


def _append_log(record: Dict[str, Any], force: bool = False) -> None:
    if not force and not _debug_enabled():
        return
    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, default=str)
        with _log_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except Exception:
        # Hooks must never interfere with Hermes.
        pass


def _read_runtime_port() -> Optional[int]:
    try:
        data = json.loads(_runtime_path().read_text(encoding="utf-8"))
        port = int(data.get("port"))
        if port in SERVER_PORTS:
            return port
    except Exception:
        return None
    return None


def _port_candidates() -> list[int]:
    ports: list[int] = []
    seen = set()

    def add(port: Optional[int]) -> None:
        if port in SERVER_PORTS and port not in seen:
            seen.add(port)
            ports.append(int(port))

    add(_cached_port)
    if _cached_port is None:
        add(_read_runtime_port())
    for port in SERVER_PORTS:
        add(port)
    return ports


def _post_state(body: Dict[str, Any]) -> None:
    global _cached_port, _no_server_until
    now = time.monotonic()
    if _cached_port is None and _no_server_until > now:
        _append_log({
            "ts": _utc_now(),
            "event": "post_state_skipped_no_server",
            "cooldown_ms": int((_no_server_until - now) * 1000),
        })
        return

    payload = json.dumps(body).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(payload)),
    }
    for port in _port_candidates():
        req = request.Request(
            f"http://127.0.0.1:{port}/state",
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=POST_TIMEOUT_SECONDS) as response:
                if response.headers.get(CLAWD_SERVER_HEADER) == CLAWD_SERVER_ID:
                    _cached_port = port
                    _no_server_until = 0.0
                    try:
                        response.read()
                    except Exception:
                        pass
                    return
                _append_log({
                    "ts": _utc_now(),
                    "event": "post_state_header_mismatch",
                    "port": port,
                    "header": response.headers.get(CLAWD_SERVER_HEADER),
                })
        except (OSError, URLError) as exc:
            _append_log({
                "ts": _utc_now(),
                "event": "post_state_failed",
                "port": port,
                "error": str(exc),
            })
            continue
        except Exception as exc:
            _append_log({
                "ts": _utc_now(),
                "event": "post_state_error",
                "port": port,
                "error": str(exc),
            })
            continue
    _cached_port = None
    _no_server_until = time.monotonic() + NO_SERVER_COOLDOWN_SECONDS


def _platform_key() -> str:
    if sys.platform.startswith("win"):
        return "win32"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


def _normalize_process_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip().replace("\\", "/")
    if not text:
        return ""
    return Path(text).name.lower()


def _int_pid(value: Any) -> Optional[int]:
    try:
        pid = int(value)
    except Exception:
        return None
    return pid if pid > 0 else None


def _run_process_command(args: list[str], timeout: float = PROCESS_QUERY_TIMEOUT_SECONDS) -> Optional[subprocess.CompletedProcess]:
    kwargs: Dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "timeout": timeout,
    }
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        return subprocess.run(args, **kwargs)
    except Exception:
        return None


def _process_info(pid: int, name: Any, parent_pid: Any, path: Any = "", cmdline: Any = "") -> Optional[Dict[str, Any]]:
    parent = _int_pid(parent_pid)
    if not parent:
        return None
    normalized = _normalize_process_name(name or path)
    if not normalized:
        return None
    return {
        "pid": pid,
        "parent_pid": parent,
        "name": normalized,
        "path": path if isinstance(path, str) else "",
        "cmdline": cmdline if isinstance(cmdline, str) else "",
    }


def _windows_process_info_from_row(row: Any, fallback_pid: Optional[int] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None
    pid = _int_pid(row.get("ProcessId"))
    if not pid:
        pid = _int_pid(fallback_pid)
    if not pid:
        return None
    return _process_info(
        pid,
        row.get("Name"),
        row.get("ParentProcessId"),
        row.get("ExecutablePath") or "",
        row.get("CommandLine") or "",
    )


def _query_windows_process_snapshot() -> Dict[int, Dict[str, Any]]:
    script = (
        "Get-CimInstance Win32_Process | "
        "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | "
        "ConvertTo-Json -Compress"
    )
    result = _run_process_command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], timeout=3.0)
    if not result or result.returncode != 0 or not result.stdout.strip():
        return {}
    try:
        parsed = json.loads(result.stdout)
    except Exception:
        return {}
    rows = parsed if isinstance(parsed, list) else [parsed]
    snapshot: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        info = _windows_process_info_from_row(row)
        if info:
            snapshot[info["pid"]] = info
    return snapshot


def _query_windows_process_info(pid: int, snapshot: Optional[Dict[int, Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    if snapshot is not None:
        return snapshot.get(pid)

    script = (
        f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction SilentlyContinue; "
        "if ($p) { $p | Select-Object ProcessId,Name,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress }"
    )
    result = _run_process_command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], timeout=3.0)
    if result and result.returncode == 0 and result.stdout.strip():
        try:
            row = json.loads(result.stdout)
            if isinstance(row, list):
                row = row[0] if row else {}
            info = _windows_process_info_from_row(row, pid)
            if info:
                return info
        except Exception:
            pass

    # PowerShell 7 exposes a Parent property on Get-Process. This is a useful
    # fallback when Win32_Process CIM is unavailable. Windows PowerShell 5.1
    # may return no Parent; that is fine.
    get_process_script = (
        f"$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; "
        "if ($p) { "
        "$name=$p.ProcessName + '.exe'; "
        "if ($p.Path) { $name=[IO.Path]::GetFileName($p.Path) }; "
        "$parentId=0; "
        "if ($p.Parent) { $parentId=$p.Parent.Id }; "
        f"[pscustomobject]@{{ProcessId={pid};Name=$name;ParentProcessId=$parentId;ExecutablePath=$p.Path;CommandLine=''}} | ConvertTo-Json -Compress "
        "}"
    )
    for shell in ("pwsh.exe", "powershell.exe"):
        result = _run_process_command([shell, "-NoProfile", "-NonInteractive", "-Command", get_process_script], timeout=2.5)
        if not result or result.returncode != 0 or not result.stdout.strip():
            continue
        try:
            row = json.loads(result.stdout)
            if isinstance(row, list):
                row = row[0] if row else {}
            info = _windows_process_info_from_row(row, pid)
            if info:
                return info
        except Exception:
            continue
    return None


def _query_linux_process_info(pid: int) -> Optional[Dict[str, Any]]:
    proc_dir = Path("/proc") / str(pid)
    try:
        stat_text = (proc_dir / "stat").read_text(encoding="utf-8", errors="replace")
        after_comm = stat_text.rsplit(")", 1)[1].strip().split()
        parent_pid = int(after_comm[1])
        name = (proc_dir / "comm").read_text(encoding="utf-8", errors="replace").strip()
        try:
            raw_cmdline = (proc_dir / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace")
        except Exception:
            raw_cmdline = ""
        return _process_info(pid, name, parent_pid, "", raw_cmdline)
    except Exception:
        return None


def _query_posix_process_info(pid: int) -> Optional[Dict[str, Any]]:
    if _platform_key() == "linux" and Path("/proc").exists():
        info = _query_linux_process_info(pid)
        if info:
            return info
    result = _run_process_command(["ps", "-o", "ppid=,comm=", "-p", str(pid)], timeout=0.8)
    if not result or result.returncode != 0:
        return None
    line = result.stdout.strip().splitlines()
    if not line:
        return None
    parts = line[-1].strip().split(None, 1)
    if len(parts) < 2:
        return None
    return _process_info(pid, parts[1], parts[0], parts[1], "")


def _query_process_info(pid: int) -> Optional[Dict[str, Any]]:
    if _platform_key() == "win32":
        return _query_windows_process_info(pid)
    return _query_posix_process_info(pid)


_DEFAULT_QUERY_PROCESS_INFO = _query_process_info


def _detect_editor(platform: str, info: Dict[str, Any]) -> str:
    name = _normalize_process_name(info.get("name"))
    editor = EDITOR_NAMES.get(platform, EDITOR_NAMES["linux"]).get(name)
    if editor:
        return editor
    text = f"{info.get('path') or ''} {info.get('cmdline') or ''}".lower()
    for pattern, candidate in EDITOR_PATH_CHECKS:
        if pattern in text:
            return candidate
    return ""


def _resolve_process_metadata(start_pid: Optional[int] = None) -> Dict[str, Any]:
    platform = _platform_key()
    terminal_names = TERMINAL_NAMES.get(platform, TERMINAL_NAMES["linux"])
    boundaries = SYSTEM_BOUNDARY.get(platform, SYSTEM_BOUNDARY["linux"])
    pid = _int_pid(start_pid if start_pid is not None else os.getpid())
    if not pid:
        return {}

    pid_chain: list[int] = []
    seen = set()
    terminal_pid: Optional[int] = None
    editor_pid: Optional[int] = None
    detected_editor = ""
    query_process_info = _query_process_info
    windows_snapshot: Optional[Dict[int, Dict[str, Any]]] = None
    if platform == "win32" and query_process_info is _DEFAULT_QUERY_PROCESS_INFO:
        windows_snapshot = _query_windows_process_snapshot()

        if windows_snapshot:
            def query_process_info(snapshot_pid: int) -> Optional[Dict[str, Any]]:
                return _query_windows_process_info(snapshot_pid, windows_snapshot)

    for _ in range(PROCESS_TREE_MAX_DEPTH):
        if pid in seen:
            break
        seen.add(pid)
        info = query_process_info(pid)
        if not info:
            break
        current_pid = _int_pid(info.get("pid")) or pid
        name = _normalize_process_name(info.get("name"))
        parent_pid = _int_pid(info.get("parent_pid"))
        pid_chain.append(current_pid)

        if not detected_editor:
            editor = _detect_editor(platform, info)
            if editor:
                detected_editor = editor
                editor_pid = current_pid

        if name in terminal_names:
            terminal_pid = current_pid
        if name in boundaries:
            break
        if not parent_pid or parent_pid == current_pid or parent_pid <= 1:
            break
        pid = parent_pid

    source_pid = editor_pid or terminal_pid
    meta: Dict[str, Any] = {}
    if source_pid:
        meta["source_pid"] = source_pid
    if pid_chain:
        meta["pid_chain"] = pid_chain
    if detected_editor:
        meta["editor"] = detected_editor
    return meta


def _resolve_process_meta_background() -> None:
    global _process_meta, _process_meta_resolved
    try:
        meta = _resolve_process_metadata()
        _append_log({"ts": _utc_now(), "event": "process_meta_resolved", "process_meta": meta})
    except Exception as exc:
        meta = {}
        _append_log({"ts": _utc_now(), "event": "process_meta_error", "error": str(exc)}, force=True)
    with _process_meta_lock:
        _process_meta = meta
        _process_meta_resolved = True


def _ensure_process_meta_resolver_started() -> None:
    global _process_meta_started, _process_meta_resolved
    with _process_meta_lock:
        if _process_meta_started:
            return
        _process_meta_started = True
    try:
        thread = threading.Thread(target=_resolve_process_meta_background, name="clawd-hermes-process-meta", daemon=True)
        thread.start()
    except Exception as exc:
        with _process_meta_lock:
            _process_meta_resolved = True
        _append_log({"ts": _utc_now(), "event": "process_meta_thread_error", "error": str(exc)}, force=True)


def _cached_process_meta() -> Dict[str, Any]:
    with _process_meta_lock:
        if not _process_meta_resolved or not _process_meta:
            return {}
        return dict(_process_meta)


def _add_process_meta(payload: Dict[str, Any]) -> None:
    meta = _cached_process_meta()
    source_pid = _int_pid(meta.get("source_pid"))
    if source_pid:
        payload["source_pid"] = source_pid
    pid_chain = meta.get("pid_chain")
    if isinstance(pid_chain, list):
        safe_chain = [_int_pid(pid) for pid in pid_chain]
        safe_chain = [pid for pid in safe_chain if pid]
        if safe_chain:
            payload["pid_chain"] = safe_chain
    editor = meta.get("editor")
    if editor in ("code", "cursor"):
        payload["editor"] = editor


def _first_string(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _thread_env_string(name: str) -> str:
    try:
        # Hermes WebUI keeps per-run env in its internal api.config._thread_ctx.
        # If that module layout changes, fall back to process env for CLI safety.
        config = sys.modules.get("api.config")
        if config is None:
            return ""
        _thread_ctx = getattr(config, "_thread_ctx", None)
        env = getattr(_thread_ctx, "env", None)
        if isinstance(env, dict):
            return _first_string(env.get(name))
    except Exception:
        return ""
    return ""


def _runtime_cwd() -> str:
    return _first_string(
        _thread_env_string("TERMINAL_CWD"),
        os.environ.get("TERMINAL_CWD"),
        os.environ.get("PWD"),
        os.getcwd(),
    )


def _prune_task_session_ids(now: Optional[float] = None) -> None:
    if now is None:
        now = time.time()
    stale = [
        task_id for task_id, (_, seen_at) in _task_session_ids.items()
        if now - seen_at > TASK_SESSION_TTL_SECONDS
    ]
    for task_id in stale:
        _task_session_ids.pop(task_id, None)
    if len(_task_session_ids) <= MAX_TASK_SESSION_IDS:
        return
    overflow = len(_task_session_ids) - MAX_TASK_SESSION_IDS
    oldest = sorted(_task_session_ids.items(), key=lambda item: item[1][1])[:overflow]
    for task_id, _ in oldest:
        _task_session_ids.pop(task_id, None)


def _prune_known_session_ids(now: Optional[float] = None) -> None:
    if now is None:
        now = time.time()
    stale = [
        session_id for session_id, seen_at in _known_session_ids.items()
        if now - seen_at > TASK_SESSION_TTL_SECONDS
    ]
    for session_id in stale:
        _known_session_ids.pop(session_id, None)
        _session_platforms.pop(session_id, None)
    if len(_known_session_ids) <= MAX_TASK_SESSION_IDS:
        return
    overflow = len(_known_session_ids) - MAX_TASK_SESSION_IDS
    oldest = sorted(_known_session_ids.items(), key=lambda item: item[1])[:overflow]
    for session_id, _ in oldest:
        _known_session_ids.pop(session_id, None)
        _session_platforms.pop(session_id, None)


def _remember_known_session(session_id: str, platform: str = "") -> None:
    if not session_id:
        return
    _prune_known_session_ids()
    _known_session_ids[session_id] = time.time()
    if platform:
        _session_platforms[session_id] = platform


def _is_known_session(session_id: str) -> bool:
    if not session_id:
        return False
    _prune_known_session_ids()
    return session_id in _known_session_ids


def _remember_task_session(task_id: str, session_id: str) -> None:
    if not task_id or not session_id:
        return
    _prune_task_session_ids()
    _task_session_ids[task_id] = (session_id, time.time())


def _lookup_task_session(task_id: str) -> str:
    if not task_id:
        return ""
    entry = _task_session_ids.get(task_id)
    if not entry:
        return ""
    session_id, seen_at = entry
    if time.time() - seen_at > TASK_SESSION_TTL_SECONDS:
        _task_session_ids.pop(task_id, None)
        return ""
    return session_id


def _forget_task_session(event_name: str, kwargs: Dict[str, Any]) -> None:
    if event_name != "post_tool_call":
        return
    task_id = _first_string(kwargs.get("task_id"))
    if task_id:
        _task_session_ids.pop(task_id, None)


def _forget_session_task_mappings(session_id: str) -> None:
    if not session_id:
        return
    stale = [
        task_id for task_id, (mapped_session_id, _) in _task_session_ids.items()
        if mapped_session_id == session_id
    ]
    for task_id in stale:
        _task_session_ids.pop(task_id, None)


def _session_id(event_name: str, kwargs: Dict[str, Any]) -> str:
    explicit = _first_string(kwargs.get("session_id"), kwargs.get("session_key"))
    thread_session = _thread_env_string("HERMES_SESSION_KEY")
    task_id = _first_string(kwargs.get("task_id"))
    parent_id = _first_string(kwargs.get("parent_session_id"))
    if explicit:
        return explicit

    with _session_lock:
        remembered = _lookup_task_session(task_id)
        if remembered:
            return remembered
        # WebUI calls run_conversation(task_id=session_id), but Hermes Agent's
        # pre_tool_call helper currently omits session_id. Prefer that stable
        # session key over the process-global active-session fallback.
        if event_name in TOOL_HOOKS and task_id and _is_known_session(task_id):
            _remember_task_session(task_id, task_id)
            return task_id
        if event_name in TOOL_HOOKS and thread_session:
            _remember_known_session(thread_session)
            if task_id:
                _remember_task_session(task_id, thread_session)
            return thread_session
        if event_name == "pre_tool_call" and task_id and _active_session_id:
            _remember_task_session(task_id, _active_session_id)
            return _active_session_id
        if parent_id:
            return parent_id
        if event_name == "post_tool_call" and task_id:
            return ""
        if _active_session_id:
            return _active_session_id

    if event_name in TOOL_HOOKS:
        return ""

    return task_id or "hermes:default"


def _remember_session(event_name: str, kwargs: Dict[str, Any]) -> None:
    global _active_session_id
    explicit = _first_string(kwargs.get("session_id"), kwargs.get("session_key"))
    task_id = _first_string(kwargs.get("task_id"))
    if not explicit:
        return
    platform = _first_string(kwargs.get("platform"))
    with _session_lock:
        if event_name == "on_session_reset":
            _task_session_ids.clear()
        _remember_known_session(explicit, platform)
        if event_name in (
            "on_session_start",
            "pre_llm_call",
            "post_llm_call",
            "on_session_end",
            "on_session_reset",
        ):
            _active_session_id = explicit
        if task_id:
            _remember_task_session(task_id, explicit)


def _finish_session_boundary(event_name: str, payload: Dict[str, Any]) -> None:
    global _active_session_id
    if event_name != "on_session_finalize":
        return
    session_id = _first_string(payload.get("session_id"))
    if not session_id:
        return
    with _session_lock:
        if _active_session_id == session_id:
            _active_session_id = ""
        _forget_session_task_mappings(session_id)
        _known_session_ids.pop(session_id, None)
        _session_platforms.pop(session_id, None)


def _session_platform(session_id: str, kwargs: Dict[str, Any]) -> str:
    platform = _first_string(kwargs.get("platform"))
    if platform:
        return platform
    if not session_id:
        return ""
    with _session_lock:
        return _session_platforms.get(session_id, "")


def _event_extra(event_name: str, kwargs: Dict[str, Any], session_id: str = "") -> Dict[str, Any]:
    extra: Dict[str, Any] = {}
    tool_name = _first_string(kwargs.get("tool_name"))
    if tool_name:
        extra["tool_name"] = tool_name
    tool_call_id = _first_string(kwargs.get("tool_call_id"))
    if tool_call_id:
        extra["tool_use_id"] = tool_call_id
    platform = _session_platform(session_id, kwargs)
    if platform:
        extra["platform"] = platform
    model = _first_string(kwargs.get("model"))
    if model:
        extra["model"] = model
    provider = _first_string(kwargs.get("provider"))
    if provider:
        extra["provider"] = provider
    return extra


def _state_payload(event_name: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    state, clawd_event = HOOK_TO_STATE[event_name]
    if event_name == "post_tool_call" and _tool_result_has_error(kwargs.get("result")):
        state, clawd_event = "error", "PostToolUseFailure"
    if event_name == "on_session_end":
        completed = kwargs.get("completed")
        interrupted = kwargs.get("interrupted")
        if completed is False and interrupted is not True:
            state, clawd_event = "error", "StopFailure"

    session_id = _session_id(event_name, kwargs)
    platform = _session_platform(session_id, kwargs)
    payload: Dict[str, Any] = {
        "agent_id": AGENT_ID,
        "hook_source": "hermes-plugin",
        "state": state,
        "event": clawd_event,
        "session_id": session_id,
        "cwd": _runtime_cwd(),
        "agent_pid": os.getpid(),
    }
    if platform != "webui":
        _add_process_meta(payload)
    payload.update(_event_extra(event_name, kwargs, session_id))
    return payload


def _tool_result_has_error(result: Any) -> bool:
    if isinstance(result, dict):
        exit_code = result.get("exit_code")
        return bool(result.get("error")) or (isinstance(exit_code, int) and exit_code != 0)
    if not isinstance(result, str):
        return False
    text = result.strip()
    if not text:
        return False
    try:
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            return False
        exit_code = parsed.get("exit_code")
        return bool(parsed.get("error")) or (isinstance(exit_code, int) and exit_code != 0)
    except Exception:
        return '"error"' in text[:500].lower()


def _handle_hook(event_name: str, **kwargs: Any) -> None:
    started = time.time()
    try:
        _remember_session(event_name, kwargs)
        payload = _state_payload(event_name, kwargs)
        if not payload.get("session_id"):
            _append_log({
                "ts": _utc_now(),
                "event": event_name,
                "dropped": "missing_session_id",
                "pid": os.getpid(),
                "kwargs": _safe_value(kwargs),
            })
            return
        if _debug_enabled():
            _append_log({
                "ts": _utc_now(),
                "event": event_name,
                "pid": os.getpid(),
                "cwd": os.getcwd(),
                "state_payload": payload,
                "kwargs": _safe_value(kwargs),
            })
        _post_state(payload)
        _finish_session_boundary(event_name, payload)
    except Exception as exc:
        _append_log({
            "ts": _utc_now(),
            "event": event_name,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }, force=True)
    finally:
        with _session_lock:
            _forget_task_session(event_name, kwargs)
        elapsed_ms = int((time.time() - started) * 1000)
        if elapsed_ms > 100:
            _append_log({"ts": _utc_now(), "event": event_name, "slow_ms": elapsed_ms})


def _make_callback(event_name: str):
    def callback(**kwargs: Any) -> None:
        _handle_hook(event_name, **kwargs)
        return None

    callback.__name__ = f"clawd_{event_name}"
    return callback


def register(ctx) -> None:
    _ensure_process_meta_resolver_started()
    for hook_name in HOOKS:
        ctx.register_hook(hook_name, _make_callback(hook_name))
    _append_log({
        "ts": _utc_now(),
        "event": "plugin_registered",
        "pid": os.getpid(),
        "hermes_home": str(_hermes_home()),
        "cwd": os.getcwd(),
        "hooks": list(HOOKS),
    })
