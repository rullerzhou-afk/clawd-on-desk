import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import coreModule from "./pi-extension-core.js";

const core = ((coreModule as any).default || coreModule) as any;

const CLAWD_SERVER_ID = "clawd-on-desk";
const CLAWD_SERVER_HEADER = "x-clawd-server";
const STATE_PATH = "/state";
const PERMISSION_PATH = "/permission";
const DEFAULT_SERVER_PORT = 23333;
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd", "runtime.json");
const HTTP_TIMEOUT_MS = 150;
const PERMISSION_TIMEOUT_MS = 590000;
const PROCESS_METADATA_TTL_MS = 2000;

type ProcessMetadata = {
  cwd?: string;
  sourcePid?: number;
  pidChain?: number[];
  editor?: "code" | "cursor";
};

type PermissionDecision = {
  behavior: "allow" | "deny" | "no-decision";
  message?: string;
};

type ProcessInfo = {
  pid: number;
  ppid: number;
  name: string;
  rawName?: string;
};

const TERMINAL_NAMES_WIN = [
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
];
const TERMINAL_NAMES_MAC = [
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
];
const TERMINAL_NAMES_LINUX = [
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
];

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);

const EDITOR_BY_PROCESS_WIN = new Map<string, "code" | "cursor">([
  ["code.exe", "code"],
  ["cursor.exe", "cursor"],
]);
const EDITOR_BY_PROCESS_MAC = new Map<string, "code" | "cursor">([
  ["code", "code"],
  ["cursor", "cursor"],
]);
const EDITOR_BY_PROCESS_LINUX = new Map<string, "code" | "cursor">([
  ["code", "code"],
  ["code-insiders", "code"],
  ["cursor", "cursor"],
]);

const EDITOR_PATH_CHECKS: Array<[string, "code" | "cursor"]> = [
  ["visual studio code", "code"],
  ["cursor.app", "cursor"],
];

function getPlatformProcessConfig() {
  if (process.platform === "win32") {
    return {
      terminalNames: new Set(TERMINAL_NAMES_WIN),
      systemBoundary: SYSTEM_BOUNDARY_WIN,
      editorByProcess: EDITOR_BY_PROCESS_WIN,
    };
  }
  if (process.platform === "linux") {
    return {
      terminalNames: new Set(TERMINAL_NAMES_LINUX),
      systemBoundary: SYSTEM_BOUNDARY_LINUX,
      editorByProcess: EDITOR_BY_PROCESS_LINUX,
    };
  }
  return {
    terminalNames: new Set(TERMINAL_NAMES_MAC),
    systemBoundary: SYSTEM_BOUNDARY_MAC,
    editorByProcess: EDITOR_BY_PROCESS_MAC,
  };
}

let processMetadataCache: { at: number; value: ProcessMetadata } | null = null;

function normalizePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && SERVER_PORTS.includes(port) ? port : null;
}

function readRuntimePort(): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    return normalizePort(raw && raw.port);
  } catch {
    return null;
  }
}

function getPortCandidates(): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();
  const add = (port: number | null) => {
    if (!port || seen.has(port)) return;
    seen.add(port);
    ports.push(port);
  };
  add(readRuntimePort());
  add(DEFAULT_SERVER_PORT);
  for (const port of SERVER_PORTS) add(port);
  return ports;
}

function readHeader(res: http.IncomingMessage, headerName: string): string | undefined {
  const value = res.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

function isClawdResponse(res: http.IncomingMessage, body: string): boolean {
  if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) return true;
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed && parsed.app === CLAWD_SERVER_ID;
  } catch {
    return false;
  }
}

function postStateToPort(port: number, payload: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: STATE_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 256) body += chunk;
        });
        res.on("end", () => resolve(isClawdResponse(res, body)));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(payload);
  });
}

function probeClawdPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: STATE_PATH, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 256) body += chunk;
        });
        res.on("end", () => resolve(isClawdResponse(res, body)));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function postState(payload: Record<string, unknown>): Promise<boolean> {
  const body = JSON.stringify(payload);
  for (const port of getPortCandidates()) {
    if (await postStateToPort(port, body)) return true;
  }
  return false;
}

function parsePermissionDecision(body: string, statusCode: number): PermissionDecision {
  if (statusCode === 204) return { behavior: "no-decision" };
  if (statusCode < 200 || statusCode >= 300 || !body) return { behavior: "no-decision" };
  try {
    const parsed = JSON.parse(body);
    const decision = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.decision;
    const behavior = decision && decision.behavior;
    if (behavior !== "allow" && behavior !== "deny") return { behavior: "no-decision" };
    const out: PermissionDecision = { behavior };
    if (behavior === "deny" && typeof decision.message === "string" && decision.message) {
      out.message = decision.message;
    }
    return out;
  } catch {
    return { behavior: "no-decision" };
  }
}

function postPermissionToPort(port: number, payload: string): Promise<PermissionDecision | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: PERMISSION_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: PERMISSION_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 262144) body += chunk;
        });
        res.on("end", () => {
          if (readHeader(res, CLAWD_SERVER_HEADER) !== CLAWD_SERVER_ID) {
            resolve(null);
            return;
          }
          resolve(parsePermissionDecision(body, res.statusCode || 0));
        });
      }
    );
    req.on("error", () => resolve({ behavior: "no-decision" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ behavior: "no-decision" });
    });
    req.end(payload);
  });
}

async function postPermission(payload: Record<string, unknown>): Promise<PermissionDecision> {
  const body = JSON.stringify(payload);
  for (const port of getPortCandidates()) {
    if (!(await probeClawdPort(port))) continue;
    const decision = await postPermissionToPort(port, body);
    if (decision) return decision;
  }
  return { behavior: "no-decision" };
}

function normalizeProcessName(name: string): string {
  return path.basename(String(name || "").trim()).toLowerCase();
}

function detectEditor(name: string, editorByProcess: Map<string, "code" | "cursor">): "code" | "cursor" | undefined {
  const normalized = normalizeProcessName(name);
  const mapped = editorByProcess.get(normalized);
  if (mapped) return mapped;
  const lower = String(name || "").toLowerCase();
  for (const [pattern, editor] of EDITOR_PATH_CHECKS) {
    if (lower.includes(pattern)) return editor;
  }
  return undefined;
}

type WinProcessRecord = { name: string; rawName: string; ppid: number };

function getWindowsProcessSnapshot(): Map<number, WinProcessRecord> {
  try {
    const raw = childProcess.execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const trimmed = (raw || "").trim();
    if (!trimmed) return new Map();
    const parsed = JSON.parse(trimmed);
    const list: any[] = Array.isArray(parsed) ? parsed : [parsed];
    const map = new Map<number, WinProcessRecord>();
    for (const proc of list) {
      const pid = Number(proc && proc.ProcessId);
      if (!Number.isFinite(pid)) continue;
      const rawName = typeof proc.Name === "string" ? proc.Name : "";
      const ppid = Number(proc.ParentProcessId) || 0;
      if (!rawName) continue;
      map.set(pid, { rawName, name: normalizeProcessName(rawName), ppid: Math.floor(ppid) });
    }
    return map;
  } catch {
    return new Map();
  }
}

function getUnixProcessInfo(pid: number): ProcessInfo | null {
  try {
    const raw = childProcess.execFileSync(
      "ps",
      ["-o", "ppid=", "-o", "comm=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1000, windowsHide: true }
    ).trim();
    if (!raw) return null;
    const match = raw.match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    const ppid = Number(match[1]);
    if (!Number.isFinite(ppid) || ppid <= 0) return null;
    const rawName = match[2].trim();
    return { pid, ppid: Math.floor(ppid), name: normalizeProcessName(rawName), rawName };
  } catch {
    return null;
  }
}

function getProcessMetadata(): ProcessMetadata {
  const now = Date.now();
  if (processMetadataCache && now - processMetadataCache.at < PROCESS_METADATA_TTL_MS) {
    return processMetadataCache.value;
  }

  const pidChain: number[] = [];
  let sourcePid = 0;
  let editor: "code" | "cursor" | undefined;
  let pid = process.pid;
  const { terminalNames, systemBoundary, editorByProcess } = getPlatformProcessConfig();
  const isWin = process.platform === "win32";
  const winSnapshot = isWin ? getWindowsProcessSnapshot() : null;

  for (let depth = 0; depth < 12; depth++) {
    let info: ProcessInfo | null;
    if (isWin) {
      const snap = winSnapshot!.get(pid);
      info = snap && snap.ppid > 0
        ? { pid, ppid: snap.ppid, name: snap.name, rawName: snap.rawName }
        : null;
    } else {
      info = getUnixProcessInfo(pid);
    }
    if (!info) break;
    pidChain.push(info.pid);

    const editorName = detectEditor(info.rawName || info.name, editorByProcess);
    if (!editor && editorName) editor = editorName;
    if (!sourcePid && (terminalNames.has(info.name) || editorName)) {
      sourcePid = info.pid;
    }

    if (systemBoundary.has(info.name)) break;
    if (!info.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }

  const value: ProcessMetadata = {
    cwd: process.cwd(),
    sourcePid: sourcePid || undefined,
    pidChain: pidChain.length > 0 ? pidChain : [process.pid],
    editor,
  };
  processMetadataCache = { at: now, value };
  return value;
}

function truncateForPrompt(value: string, max = 600): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function formatPermissionDetail(payload: Record<string, unknown>): string {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
  const input = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input as Record<string, unknown>
    : {};
  if (typeof input.command === "string" && input.command) {
    return `$ ${truncateForPrompt(input.command)}`;
  }
  const pathValue = input.path ?? input.file_path ?? input.filePath;
  if (typeof pathValue === "string" && pathValue) {
    return `${toolName}: ${truncateForPrompt(pathValue)}`;
  }
  try {
    return truncateForPrompt(JSON.stringify(input));
  } catch {
    return toolName;
  }
}

async function confirmPermission(
  payload: Record<string, unknown>,
  _nativeEvent: ExtensionEvent,
  ctx: ExtensionContext
): Promise<PermissionDecision> {
  if (!ctx || !ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== "function") {
    return {
      behavior: "deny",
      message: "Pi terminal confirmation was unavailable; blocked by Clawd.",
    };
  }

  try {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
    const ok = await ctx.ui.confirm(
      "Clawd permission",
      `Allow Pi to run ${toolName}?\n\n${formatPermissionDetail(payload)}`
    );
    return ok
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Denied in Pi terminal confirmation." };
  } catch {
    return {
      behavior: "deny",
      message: "Pi terminal confirmation was unavailable; blocked by Clawd.",
    };
  }
}

export default function clawdPiExtension(pi: ExtensionAPI): void {
  core.attach(pi, {
    shouldReport: (ctx: ExtensionContext) => core.shouldReport(ctx),
    buildPayload: ({ state, event, nativeEvent, ctx }: {
      state: string;
      event: string;
      nativeEvent: ExtensionEvent;
      ctx: ExtensionContext;
    }) => core.buildPayload({
      state,
      event,
      nativeEvent,
      ctx,
      metadata: getProcessMetadata(),
      agentPid: process.pid,
    }),
    buildPermissionPayload: ({ nativeEvent, ctx }: {
      nativeEvent: ExtensionEvent;
      ctx: ExtensionContext;
    }) => core.buildPermissionPayload({
      nativeEvent,
      ctx,
      metadata: getProcessMetadata(),
      agentPid: process.pid,
    }),
    postState,
    postPermission,
    confirmPermission,
  });
}
