"use strict";

const { spawn: defaultSpawn } = require("child_process");

const RESULT_PREFIX = "__CLAWD_CONSOLE_INPUT_RESULT__ ";
const READY_PREFIX = "__CLAWD_CONSOLE_INPUT_READY__";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const DEFAULT_FORCE_KILL_GRACE_MS = 1000;
const MAX_BLOCKED_PIDS = 128;

function normalizePid(value) {
  const numeric = Number(value);
  // 0xffffffff is AttachConsole's ATTACH_PARENT_PROCESS sentinel, not a PID.
  return Number.isInteger(numeric) && numeric > 0 && numeric < 0xffffffff
    ? numeric
    : null;
}

function selectPidList(values, excludedPid = null) {
  if (!Array.isArray(values)) return { pids: [], overflow: false };
  const excluded = normalizePid(excludedPid);
  const out = [];
  for (const value of values) {
    const pid = normalizePid(value);
    if (!pid || pid === excluded || out.includes(pid)) continue;
    if (out.length >= MAX_BLOCKED_PIDS) return { pids: out, overflow: true };
    out.push(pid);
  }
  return { pids: out, overflow: false };
}

function normalizePidList(values, excludedPid = null) {
  return selectPidList(values, excludedPid).pids;
}

function buildWindowsConsoleInputScript() {
  const payloadSetup = `
Write-Output '${READY_PREFIX}'
[Console]::Out.Flush()
$payloadLine = [Console]::In.ReadLine()
$inputPayload = $payloadLine | ConvertFrom-Json
$promptText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$inputPayload.promptBase64))
[uint32]$targetPid = [uint32]$inputPayload.targetPid
[uint32[]]$blockedPids = @($inputPayload.blockedPids | ForEach-Object { [uint32]$_ })`;

  return `
Add-Type @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ClawdConsoleInput {
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const ushort KEY_EVENT = 0x0001;
    private const uint MAX_CONSOLE_PROCESS_IDS = 4096;
    private const int MAX_CONSOLE_PROCESS_LIST_ATTEMPTS = 4;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode, Size = 16)]
    public struct KEY_EVENT_RECORD {
        [FieldOffset(0)] public int KeyDown;
        [FieldOffset(4)] public ushort RepeatCount;
        [FieldOffset(6)] public ushort VirtualKeyCode;
        [FieldOffset(8)] public ushort VirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint ControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode, Size = 20)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList([Out] uint[] processList, uint processCount);

    [DllImport("kernel32.dll", EntryPoint = "WriteConsoleInputW", SetLastError = true)]
    private static extern bool WriteConsoleInput(
        IntPtr consoleInput,
        [In] INPUT_RECORD[] buffer,
        uint length,
        out uint written
    );

    private static INPUT_RECORD Key(char value, bool down, ushort virtualKeyCode) {
        return new INPUT_RECORD {
            EventType = KEY_EVENT,
            KeyEvent = new KEY_EVENT_RECORD {
                KeyDown = down ? 1 : 0,
                RepeatCount = 1,
                VirtualKeyCode = virtualKeyCode,
                VirtualScanCode = 0,
                UnicodeChar = value,
                ControlKeyState = 0
            }
        };
    }

    private static HashSet<uint> ReadConsoleProcessIds() {
        uint[] ids = new uint[64];
        for (int attempt = 0; attempt < MAX_CONSOLE_PROCESS_LIST_ATTEMPTS; attempt++) {
            uint count = GetConsoleProcessList(ids, (uint)ids.Length);
            if (count == 0) {
                throw new InvalidOperationException("console_process_list_failed:" + Marshal.GetLastWin32Error());
            }
            if (count > ids.Length) {
                if (count > MAX_CONSOLE_PROCESS_IDS) {
                    throw new InvalidOperationException("console_process_list_unstable");
                }
                uint doubled = Math.Min(MAX_CONSOLE_PROCESS_IDS, (uint)ids.Length * 2);
                uint nextSize = Math.Max(count, doubled);
                ids = new uint[(int)nextSize];
                continue;
            }

            var result = new HashSet<uint>();
            for (int i = 0; i < (int)count; i++) {
                if (ids[i] != 0) result.Add(ids[i]);
            }
            return result;
        }

        throw new InvalidOperationException("console_process_list_unstable");
    }

    private static void EnsureSafeConsoleMembership(uint targetPid, uint[] blockedPids) {
        var consolePids = ReadConsoleProcessIds();
        if (!consolePids.Contains(targetPid)) {
            throw new InvalidOperationException("target_left_console");
        }
        if (blockedPids == null) return;
        foreach (uint blockedPid in blockedPids) {
            if (blockedPid != 0 && consolePids.Contains(blockedPid)) {
                throw new InvalidOperationException("console_ambiguous:" + blockedPid);
            }
        }
    }

    public static int Send(uint targetPid, string text, uint[] blockedPids) {
        if (targetPid == 0) throw new InvalidOperationException("invalid_target_pid");
        if (String.IsNullOrEmpty(text)) throw new InvalidOperationException("empty_prompt");

        FreeConsole();
        if (!AttachConsole(targetPid)) {
            throw new InvalidOperationException("attach_console_failed:" + Marshal.GetLastWin32Error());
        }

        IntPtr input = INVALID_HANDLE_VALUE;
        try {
            EnsureSafeConsoleMembership(targetPid, blockedPids);

            input = CreateFileW(
                "CONIN$",
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                0,
                IntPtr.Zero
            );
            if (input == INVALID_HANDLE_VALUE) {
                throw new InvalidOperationException("console_open_failed:" + Marshal.GetLastWin32Error());
            }

            var records = new INPUT_RECORD[(text.Length * 2) + 2];
            int offset = 0;
            foreach (char value in text) {
                records[offset++] = Key(value, true, 0);
                records[offset++] = Key(value, false, 0);
            }
            records[offset++] = Key('\\r', true, 0x0D);
            records[offset++] = Key('\\r', false, 0x0D);

            // Re-read immediately before the write. GetConsoleProcessList has
            // no snapshot handle, so a peer can attach while CONIN$ is opened
            // or the input records are being assembled.
            EnsureSafeConsoleMembership(targetPid, blockedPids);

            uint written = 0;
            bool writeSucceeded = WriteConsoleInput(input, records, (uint)records.Length, out written);
            if (!writeSucceeded && written != 0) {
                throw new InvalidOperationException("partial_console_write:" + written + ":" + records.Length);
            }
            if (!writeSucceeded) {
                throw new InvalidOperationException("console_write_failed:" + Marshal.GetLastWin32Error());
            }
            if (written != records.Length) {
                throw new InvalidOperationException("partial_console_write:" + written + ":" + records.Length);
            }
            return (int)written;
        } finally {
            if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
            FreeConsole();
        }
    }
}
"@

$result = [ordered]@{ ok = $false; errorClass = 'console_input_failed'; written = 0 }
try {
    ${payloadSetup}
    $written = [ClawdConsoleInput]::Send($targetPid, $promptText, $blockedPids)
    $result = [ordered]@{ ok = $true; errorClass = $null; written = $written }
} catch {
    $detail = [string]$_.Exception.Message
    $known = @(
        'invalid_target_pid',
        'empty_prompt',
        'attach_console_failed',
        'console_process_list_failed',
        'console_process_list_unstable',
        'target_left_console',
        'console_ambiguous',
        'console_open_failed',
        'console_write_failed',
        'partial_console_write'
    )
    $errorClass = 'console_input_failed'
    foreach ($candidate in $known) {
        if ($detail.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $errorClass = $candidate
            break
        }
    }
    $result = [ordered]@{ ok = $false; errorClass = $errorClass; written = 0 }
}
Write-Output ('${RESULT_PREFIX}' + ($result | ConvertTo-Json -Compress))
`;
}

function parseConsoleInputResult(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith(RESULT_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
      return {
        ok: parsed && parsed.ok === true,
        errorClass: parsed && typeof parsed.errorClass === "string" && parsed.errorClass
          ? parsed.errorClass
          : null,
        written: Number.isInteger(parsed && parsed.written) && parsed.written >= 0
          ? parsed.written
          : 0,
      };
    } catch {
      return null;
    }
  }
  return null;
}

async function runTargetValidation(validateBeforeInput) {
  if (typeof validateBeforeInput !== "function") return { ok: true, errorClass: null };
  try {
    const result = await validateBeforeInput();
    if (result === true || result == null || (result && result.ok === true)) {
      return {
        ok: true,
        errorClass: null,
        otherSessionAgentPids: result && Array.isArray(result.otherSessionAgentPids)
          ? result.otherSessionAgentPids
          : null,
      };
    }
    return {
      ok: false,
      errorClass: result && typeof result.errorClass === "string" && result.errorClass
        ? result.errorClass
        : "target_validation_failed",
    };
  } catch {
    return { ok: false, errorClass: "target_validation_failed" };
  }
}

function runConsoleInputHelper({
  spawn,
  targetPid,
  promptText,
  blockedPids,
  validateBeforeInput,
  timeoutMs,
  signal = null,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  forceKillGraceMs = DEFAULT_FORCE_KILL_GRACE_MS,
  onTerminationUnconfirmed = null,
}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ ok: false, errorClass: "direct_send_cancelled", written: 0 });
      return;
    }
    const script = buildWindowsConsoleInputScript();
    let child;
    try {
      child = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, errorClass: "console_input_helper_failed", written: 0 });
      return;
    }

    let settled = false;
    let ready = false;
    let payloadSent = false;
    let stdoutBuffer = "";
    let closed = false;
    let exited = false;
    let terminationResult = null;
    let onAbort = null;
    const effectiveTimeoutMs = Math.max(250, Math.min(10000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const effectiveTerminationGraceMs = Math.max(
      25,
      Math.min(5000, Number(terminationGraceMs) || DEFAULT_TERMINATION_GRACE_MS),
    );
    const effectiveForceKillGraceMs = Math.max(
      25,
      Math.min(5000, Number(forceKillGraceMs) || DEFAULT_FORCE_KILL_GRACE_MS),
    );
    let timer = null;
    let terminationTimer = null;
    let forceKillTimer = null;
    let resolveExit;
    const exitPromise = new Promise((resolveExitPromise) => {
      resolveExit = resolveExitPromise;
    });
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (signal && onAbort && typeof signal.removeEventListener === "function") {
        try { signal.removeEventListener("abort", onAbort); } catch {}
      }
      resolve(result);
    };
    const markExited = () => {
      if (!exited) {
        exited = true;
        resolveExit();
      }
      if (terminationResult) settle(terminationResult);
    };
    const requestKill = (killSignal) => {
      if (!child || typeof child.kill !== "function" || exited || child.exitCode != null) return;
      try {
        const requested = killSignal ? child.kill(killSignal) : child.kill();
        if (requested === false && child.exitCode != null) markExited();
      } catch {
        // A later exit/close event or the force-kill deadline determines
        // whether the adapter must remain quarantined.
      }
    };
    const finish = (result, terminate = false) => {
      if (settled || terminationResult) return;
      if (!terminate) {
        settle(result);
        return;
      }
      terminationResult = result;
      if (timer) clearTimeout(timer);
      if (!child || typeof child.on !== "function" || closed || exited || child.exitCode != null) {
        settle(result);
        return;
      }
      if (typeof child.kill !== "function") {
        settle(result);
        return;
      }
      requestKill();
      if (settled || exited) return;
      terminationTimer = setTimeout(() => {
        if (settled || exited) return;
        requestKill("SIGKILL");
        if (settled || exited) return;
        forceKillTimer = setTimeout(() => {
          if (settled || exited) return;
          if (payloadSent && typeof onTerminationUnconfirmed === "function") {
            try { onTerminationUnconfirmed(exitPromise); } catch {}
          } else if (!payloadSent && typeof child?.stdin?.end === "function") {
            // No payload crossed stdin, so EOF cannot trigger Console input.
            try { child.stdin.end(); } catch {}
          }
          settle(result);
        }, effectiveForceKillGraceMs);
        if (typeof forceKillTimer.unref === "function") forceKillTimer.unref();
      }, effectiveTerminationGraceMs);
      if (typeof terminationTimer.unref === "function") terminationTimer.unref();
    };
    const missingResult = () => ({
      ok: false,
      errorClass: payloadSent ? "console_input_result_unknown" : "console_input_helper_failed",
      written: 0,
    });
    const cancelledResult = () => ({
      ok: false,
      // Once the payload has crossed stdin, the helper may already be inside
      // WriteConsoleInputW. Treat cancellation as an uncertain write so the
      // caller consumes the mapping and never retries into the same prompt.
      errorClass: payloadSent ? "console_input_result_unknown" : "direct_send_cancelled",
      written: 0,
    });
    timer = setTimeout(() => finish(missingResult(), true), effectiveTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    if (child && typeof child.on === "function") {
      child.on("error", () => finish(missingResult(), true));
      child.on("exit", markExited);
      child.on("close", () => {
        closed = true;
        markExited();
        if (terminationResult) settle(terminationResult);
        else finish(missingResult());
      });
    }

    if (typeof child?.stdin?.on === "function") child.stdin.on("error", () => finish(missingResult(), true));
    if (typeof child?.stdout?.on === "function") child.stdout.on("error", () => finish(missingResult(), true));
    if (typeof child?.stderr?.on === "function") child.stderr.on("error", () => finish(missingResult(), true));
    if (typeof child?.stdout?.setEncoding === "function") child.stdout.setEncoding("utf8");
    if (typeof child?.stderr?.resume === "function") child.stderr.resume();

    if (signal && typeof signal.addEventListener === "function") {
      onAbort = () => finish(cancelledResult(), true);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    if (!child || !child.stdin || !child.stdout) {
      finish(missingResult(), true);
      return;
    }

    const handleLine = (line) => {
      const text = String(line || "").trim();
      if (!text) return;
      if (text === READY_PREFIX) {
        if (ready) return;
        ready = true;
        Promise.resolve(runTargetValidation(validateBeforeInput)).then((validation) => {
          if (settled || terminationResult) return;
          if (signal && signal.aborted) {
            finish(cancelledResult(), true);
            return;
          }
          if (!validation.ok) {
            finish({ ok: false, errorClass: validation.errorClass, written: 0 }, true);
            return;
          }
          const latestBlockedPids = Array.isArray(validation.otherSessionAgentPids)
            ? validation.otherSessionAgentPids
            : blockedPids;
          const selectedPids = selectPidList(latestBlockedPids, targetPid);
          if (selectedPids.overflow) {
            finish({ ok: false, errorClass: "peer_pid_overflow", written: 0 }, true);
            return;
          }
          if (signal && signal.aborted) {
            finish(cancelledResult(), true);
            return;
          }
          const input = JSON.stringify({
            targetPid,
            promptBase64: Buffer.from(promptText, "utf8").toString("base64"),
            blockedPids: selectedPids.pids,
          });
          payloadSent = true;
          try {
            child.stdin.end(`${input}\n`, "utf8");
          } catch {
            finish(missingResult(), true);
          }
        });
        return;
      }
      const result = parseConsoleInputResult(text);
      if (result) finish(result);
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
      if (stdoutBuffer.length > 8192) stdoutBuffer = stdoutBuffer.slice(-4096);
    });
    child.stdout.on("end", () => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      stdoutBuffer = "";
    });
  });
}

function createWindowsConsoleInputDeliveryAdapter({
  spawn = defaultSpawn,
  osPlatform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  forceKillGraceMs = DEFAULT_FORCE_KILL_GRACE_MS,
} = {}) {
  let terminationQuarantine = null;
  const quarantineUntilExit = (exitPromise) => {
    const token = {};
    terminationQuarantine = token;
    Promise.resolve(exitPromise).then(() => {
      if (terminationQuarantine === token) terminationQuarantine = null;
    });
  };
  return {
    requiresFocus: false,
    requiresMappedAgentPid: true,
    async deliver(payload = {}) {
      const promptText = typeof payload.promptText === "string" ? payload.promptText : "";
      if (osPlatform !== "win32") {
        return { status: "failed", delivered: false, autoEnter: false, errorClass: "platform_unsupported" };
      }
      if (!promptText) {
        return { status: "failed", delivered: false, autoEnter: false, errorClass: "empty_prompt" };
      }
      if (/[\r\n]/.test(promptText)) {
        return { status: "failed", delivered: false, autoEnter: false, errorClass: "multiline_unsupported" };
      }
      if (terminationQuarantine) {
        return {
          status: "failed",
          delivered: false,
          autoEnter: false,
          errorClass: "console_input_helper_quarantined",
        };
      }

      const targetPid = normalizePid(payload.entry && payload.entry.agentPid);
      if (!targetPid) {
        return { status: "failed", delivered: false, autoEnter: false, errorClass: "agent_pid_unavailable" };
      }
      const selectedPids = selectPidList(payload.otherSessionAgentPids, targetPid);
      if (selectedPids.overflow) {
        return { status: "failed", delivered: false, autoEnter: false, errorClass: "peer_pid_overflow" };
      }
      const result = await runConsoleInputHelper({
        spawn,
        targetPid,
        promptText,
        blockedPids: selectedPids.pids,
        validateBeforeInput: payload.validateBeforeInput,
        timeoutMs,
        signal: payload.signal,
        terminationGraceMs,
        forceKillGraceMs,
        onTerminationUnconfirmed: quarantineUntilExit,
      });
      const expectedWritten = (promptText.length * 2) + 2;
      if (result.ok && result.written !== expectedWritten) {
        return {
          status: "failed",
          delivered: false,
          autoEnter: false,
          errorClass: "console_input_result_unknown",
        };
      }
      if (!result.ok) {
        return {
          status: "failed",
          delivered: false,
          autoEnter: false,
          errorClass: result.errorClass || "console_input_failed",
        };
      }
      return {
        status: "sent_with_enter",
        delivered: true,
        autoEnter: true,
        errorClass: null,
      };
    },
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  READY_PREFIX,
  RESULT_PREFIX,
  buildWindowsConsoleInputScript,
  createWindowsConsoleInputDeliveryAdapter,
  normalizePid,
  normalizePidList,
  parseConsoleInputResult,
  runConsoleInputHelper,
};
