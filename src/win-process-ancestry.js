"use strict";

const path = require("path");

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_BASIC_INFORMATION_CLASS = 0;
const IMAGE_NAME_BUFFER_CHARS = 32768;
const DEFAULT_MAX_DEPTH = 8;
const MAX_PID = 0xffffffff;
const TH32CS_SNAPPROCESS = 0x00000002;
const MAX_PATH = 260;
const ERROR_BAD_LENGTH = 24;
const ERROR_NO_MORE_FILES = 18;
const DEFAULT_TOOLHELP_RETRIES = 3;
const processQueryFfiByKoffi = new WeakMap();
const toolhelpFfiByKoffi = new WeakMap();

function normalizePid(value) {
  let numeric = value;
  if (typeof numeric === "bigint") {
    if (numeric <= 0n || numeric > BigInt(MAX_PID)) return null;
    numeric = Number(numeric);
  }
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > MAX_PID) return null;
  return numeric;
}

function normalizeParentPid(value) {
  if (value === 0 || value === 0n || value === null) return 0;
  return normalizePid(value);
}

function normalizeCreationTime(value) {
  if (!value || typeof value !== "object") return null;
  const high = Number(value.high ?? value.dwHighDateTime);
  const low = Number(value.low ?? value.dwLowDateTime);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return { high: high >>> 0, low: low >>> 0 };
}

function compareCreationTime(left, right) {
  const a = normalizeCreationTime(left);
  const b = normalizeCreationTime(right);
  if (!a || !b) return null;
  if (a.high !== b.high) return a.high < b.high ? -1 : 1;
  if (a.low !== b.low) return a.low < b.low ? -1 : 1;
  return 0;
}

function normalizeProcessName(value) {
  if (typeof value !== "string" || !value) return "";
  return path.win32.basename(value).toLowerCase();
}

function utf16BufferToString(buffer, length) {
  const count = Math.max(0, Math.min(Number(length) || 0, buffer.length));
  let out = "";
  for (let i = 0; i < count; i++) out += String.fromCharCode(buffer[i]);
  return out;
}

function classifyWin32Error(code) {
  switch (Number(code) >>> 0) {
    case 5: return "access-denied";
    case 6: return "invalid-handle";
    case 87: return "invalid-parameter";
    case 299: return "partial-copy";
    case 1168: return "not-found";
    default: return "win32-error";
  }
}

function classifyNtStatus(status) {
  switch (Number(status) >>> 0) {
    case 0xc0000008: return "invalid-handle";
    case 0xc000000b: return "process-exited";
    case 0xc0000022: return "access-denied";
    default: return "ntstatus-error";
  }
}

function unavailable(stage, errorKind, errorCode = null) {
  return {
    ok: false,
    status: "unavailable",
    stage,
    errorKind,
    errorCode: Number.isInteger(errorCode) ? (errorCode >>> 0) : null,
  };
}

function buildKoffiFfi(koffi) {
  const kernel32 = koffi.load("kernel32.dll");
  const ntdll = koffi.load("ntdll.dll");

  const FileTime = koffi.struct("ClawdProcessFILETIME", {
    low: "uint32",
    high: "uint32",
  });
  const ProcessBasicInformation = koffi.struct("ClawdPROCESS_BASIC_INFORMATION", {
    ExitStatus: "int32",
    PebBaseAddress: "void *",
    AffinityMask: "uintptr_t",
    BasePriority: "int32",
    UniqueProcessId: "uintptr_t",
    InheritedFromUniqueProcessId: "uintptr_t",
  });

  return {
    OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)"),
    QueryFullProcessImageNameW: kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)"),
    GetProcessTimes: kernel32.func("bool __stdcall GetProcessTimes(void *hProcess, _Out_ ClawdProcessFILETIME *lpCreationTime, _Out_ ClawdProcessFILETIME *lpExitTime, _Out_ ClawdProcessFILETIME *lpKernelTime, _Out_ ClawdProcessFILETIME *lpUserTime)"),
    CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *hObject)"),
    GetLastError: kernel32.func("uint32 __stdcall GetLastError()"),
    NtQueryInformationProcess: ntdll.func("int32 __stdcall NtQueryInformationProcess(void *ProcessHandle, uint32 ProcessInformationClass, _Out_ ClawdPROCESS_BASIC_INFORMATION *ProcessInformation, uint32 ProcessInformationLength, _Out_ uint32 *ReturnLength)"),
    processBasicInformationSize: koffi.sizeof(ProcessBasicInformation),
    fileTimeSize: koffi.sizeof(FileTime),
    pointerSize: koffi.sizeof("void *"),
    processBasicInformationOffsets: Object.freeze({
      ExitStatus: koffi.offsetof(ProcessBasicInformation, "ExitStatus"),
      PebBaseAddress: koffi.offsetof(ProcessBasicInformation, "PebBaseAddress"),
      AffinityMask: koffi.offsetof(ProcessBasicInformation, "AffinityMask"),
      BasePriority: koffi.offsetof(ProcessBasicInformation, "BasePriority"),
      UniqueProcessId: koffi.offsetof(ProcessBasicInformation, "UniqueProcessId"),
      InheritedFromUniqueProcessId: koffi.offsetof(ProcessBasicInformation, "InheritedFromUniqueProcessId"),
    }),
    fileTimeOffsets: Object.freeze({
      low: koffi.offsetof(FileTime, "low"),
      high: koffi.offsetof(FileTime, "high"),
    }),
  };
}

function buildToolhelpKoffiFfi(koffi) {
  const kernel32 = koffi.load("kernel32.dll");
  const FileTime = koffi.struct("ClawdToolhelpFILETIME", {
    low: "uint32",
    high: "uint32",
  });
  const ProcessEntry = koffi.struct("ClawdPROCESSENTRY32W", {
    dwSize: "uint32",
    cntUsage: "uint32",
    th32ProcessID: "uint32",
    th32DefaultHeapID: "uintptr_t",
    th32ModuleID: "uint32",
    cntThreads: "uint32",
    th32ParentProcessID: "uint32",
    pcPriClassBase: "int32",
    dwFlags: "uint32",
    szExeFile: koffi.array("uint16", MAX_PATH),
  });
  return {
    CreateToolhelp32Snapshot: kernel32.func("void * __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)"),
    Process32FirstW: kernel32.func("bool __stdcall Process32FirstW(void *hSnapshot, _Inout_ ClawdPROCESSENTRY32W *lppe)"),
    Process32NextW: kernel32.func("bool __stdcall Process32NextW(void *hSnapshot, _Inout_ ClawdPROCESSENTRY32W *lppe)"),
    OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)"),
    GetProcessTimes: kernel32.func("bool __stdcall GetProcessTimes(void *hProcess, _Out_ ClawdToolhelpFILETIME *lpCreationTime, _Out_ ClawdToolhelpFILETIME *lpExitTime, _Out_ ClawdToolhelpFILETIME *lpKernelTime, _Out_ ClawdToolhelpFILETIME *lpUserTime)"),
    CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *hObject)"),
    GetLastError: kernel32.func("uint32 __stdcall GetLastError()"),
    processEntrySize: koffi.sizeof(ProcessEntry),
    fileTimeSize: koffi.sizeof(FileTime),
    pointerSize: koffi.sizeof("void *"),
    processEntryOffsets: Object.freeze({
      th32ProcessID: koffi.offsetof(ProcessEntry, "th32ProcessID"),
      th32DefaultHeapID: koffi.offsetof(ProcessEntry, "th32DefaultHeapID"),
      th32ParentProcessID: koffi.offsetof(ProcessEntry, "th32ParentProcessID"),
      szExeFile: koffi.offsetof(ProcessEntry, "szExeFile"),
    }),
    fileTimeOffsets: Object.freeze({
      low: koffi.offsetof(FileTime, "low"),
      high: koffi.offsetof(FileTime, "high"),
    }),
    // Koffi represents non-null pointers as External objects. In particular,
    // INVALID_HANDLE_VALUE is truthy and must be compared by address rather
    // than by JS object identity or primitive -1 checks.
    pointerAddress: (handle) => koffi.address(handle),
  };
}

function getOrCreateKoffiBindings(cache, koffi, build) {
  const cached = cache.get(koffi);
  if (cached) return cached;
  const ffi = build(koffi);
  cache.set(koffi, ffi);
  return ffi;
}

function expectedProcessQueryAbi(pointerSize) {
  if (pointerSize === 8) {
    return {
      processBasicInformationSize: 48,
      fileTimeSize: 8,
      processBasicInformationOffsets: {
        ExitStatus: 0,
        PebBaseAddress: 8,
        AffinityMask: 16,
        BasePriority: 24,
        UniqueProcessId: 32,
        InheritedFromUniqueProcessId: 40,
      },
      fileTimeOffsets: { low: 0, high: 4 },
    };
  }
  if (pointerSize === 4) {
    return {
      processBasicInformationSize: 24,
      fileTimeSize: 8,
      processBasicInformationOffsets: {
        ExitStatus: 0,
        PebBaseAddress: 4,
        AffinityMask: 8,
        BasePriority: 12,
        UniqueProcessId: 16,
        InheritedFromUniqueProcessId: 20,
      },
      fileTimeOffsets: { low: 0, high: 4 },
    };
  }
  return null;
}

function expectedToolhelpAbi(pointerSize) {
  if (pointerSize === 8) {
    return {
      processEntrySize: 568,
      fileTimeSize: 8,
      processEntryOffsets: {
        th32ProcessID: 8,
        th32DefaultHeapID: 16,
        th32ParentProcessID: 32,
        szExeFile: 44,
      },
      fileTimeOffsets: { low: 0, high: 4 },
    };
  }
  if (pointerSize === 4) {
    return {
      processEntrySize: 556,
      fileTimeSize: 8,
      processEntryOffsets: {
        th32ProcessID: 8,
        th32DefaultHeapID: 12,
        th32ParentProcessID: 24,
        szExeFile: 36,
      },
      fileTimeOffsets: { low: 0, high: 4 },
    };
  }
  return null;
}

function abiMatches(actual, expected) {
  if (!actual || !expected) return false;
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (expectedValue && typeof expectedValue === "object") {
      if (!abiMatches(actualValue, expectedValue)) return false;
    } else if (Number(actualValue) !== expectedValue) {
      return false;
    }
  }
  return true;
}

function processQueryAbi(ffi) {
  return Object.freeze({
    pointerSize: Number(ffi.pointerSize) || null,
    processBasicInformationSize: Number(ffi.processBasicInformationSize) || null,
    fileTimeSize: Number(ffi.fileTimeSize) || null,
    processBasicInformationOffsets: ffi.processBasicInformationOffsets || null,
    fileTimeOffsets: ffi.fileTimeOffsets || null,
  });
}

function toolhelpAbi(ffi) {
  return Object.freeze({
    pointerSize: Number(ffi.pointerSize) || null,
    processEntrySize: Number(ffi.processEntrySize) || null,
    fileTimeSize: Number(ffi.fileTimeSize) || null,
    processEntryOffsets: ffi.processEntryOffsets || null,
    fileTimeOffsets: ffi.fileTimeOffsets || null,
  });
}

function isInvalidSnapshotHandle(handle, ffi) {
  if (!handle) return true;
  if (handle === -1 || handle === -1n || handle === 0xffffffff || handle === 0xffffffffffffffffn) return true;
  if (ffi && typeof ffi.pointerAddress === "function") {
    try {
      const address = ffi.pointerAddress(handle);
      return address === -1 || address === -1n || address === 0xffffffff || address === 0xffffffffffffffffn;
    } catch {}
  }
  return false;
}

function nullTerminatedUtf16(value) {
  if (!value || typeof value.length !== "number") return "";
  let length = 0;
  while (length < value.length && value[length] !== 0) length++;
  return utf16BufferToString(value, length);
}

// B0 comparison candidate: materialize only PID/name/parent from one bounded
// Toolhelp snapshot, then query creation time per PID through a short-lived
// PROCESS_QUERY_LIMITED_INFORMATION handle. The full process table remains an
// in-memory map owned by this one request and is never returned or logged.
function createWindowsToolhelpSnapshot(options = {}) {
  const isWin = options.isWin != null ? options.isWin === true : process.platform === "win32";
  if (!isWin) return { status: "unavailable", reason: "off-windows", query: null, close() {}, abi: null };

  let ffi;
  try {
    if (options.ffi) ffi = options.ffi;
    else ffi = getOrCreateKoffiBindings(
      toolhelpFfiByKoffi,
      options.koffi || require("koffi"),
      buildToolhelpKoffiFfi,
    );
  } catch (err) {
    if (typeof options.onInitError === "function") options.onInitError(err);
    return { status: "unavailable", reason: "ffi-unavailable", query: null, close() {}, abi: null };
  }
  const abi = toolhelpAbi(ffi);
  if (!abiMatches(abi, expectedToolhelpAbi(abi.pointerSize))) {
    return { status: "unavailable", reason: "abi-mismatch", query: null, close() {}, abi };
  }
  const getLastError = () => {
    try { return Number(ffi.GetLastError()) >>> 0; } catch { return null; }
  };
  const retries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? Math.min(options.maxRetries, 10)
    : DEFAULT_TOOLHELP_RETRIES;
  let snapshotHandle = null;
  let snapshotError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      snapshotHandle = ffi.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    } catch {
      snapshotHandle = null;
    }
    if (!isInvalidSnapshotHandle(snapshotHandle, ffi)) break;
    snapshotHandle = null;
    snapshotError = getLastError();
    if (snapshotError !== ERROR_BAD_LENGTH || attempt === retries) break;
  }
  if (!snapshotHandle) {
    return {
      status: "unavailable",
      reason: classifyWin32Error(snapshotError),
      errorCode: snapshotError,
      query: null,
      close() {},
      abi: null,
    };
  }

  const processes = new Map();
  try {
    const entry = { dwSize: Number(ffi.processEntrySize) };
    let ok = ffi.Process32FirstW(snapshotHandle, entry);
    if (!ok) {
      const code = getLastError();
      try { ffi.CloseHandle(snapshotHandle); } catch {}
      return {
        status: "unavailable",
        reason: classifyWin32Error(code),
        errorCode: code,
        query: null,
        close() {},
        abi: null,
      };
    }
    while (ok) {
      const pid = normalizePid(entry.th32ProcessID);
      const parentPid = normalizeParentPid(entry.th32ParentProcessID);
      const name = normalizeProcessName(nullTerminatedUtf16(entry.szExeFile));
      if (pid && parentPid !== null && name) processes.set(pid, { pid, parentPid, name });
      entry.dwSize = Number(ffi.processEntrySize);
      ok = ffi.Process32NextW(snapshotHandle, entry);
    }
    const enumerationError = getLastError();
    if (enumerationError !== ERROR_NO_MORE_FILES) {
      try { ffi.CloseHandle(snapshotHandle); } catch {}
      return {
        status: "unavailable",
        reason: classifyWin32Error(enumerationError),
        stage: "enumeration",
        errorCode: enumerationError,
        query: null,
        close() {},
        abi,
      };
    }
  } catch (err) {
    try { ffi.CloseHandle(snapshotHandle); } catch {}
    if (typeof options.onCallError === "function") options.onCallError(err);
    return { status: "unavailable", reason: "ffi-exception", query: null, close() {}, abi: null };
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    processes.clear();
    try { ffi.CloseHandle(snapshotHandle); } catch {}
  };
  const query = (rawPid) => {
    if (closed) return unavailable("snapshot", "snapshot-closed");
    const pid = normalizePid(rawPid);
    if (!pid) return unavailable("input", "invalid-pid");
    const processEntry = processes.get(pid);
    if (!processEntry) return unavailable("snapshot", "not-found", 1168);
    let processHandle = null;
    try {
      processHandle = ffi.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!processHandle) {
        const code = getLastError();
        return unavailable("open", classifyWin32Error(code), code);
      }
      const creation = {};
      if (!ffi.GetProcessTimes(processHandle, creation, {}, {}, {})) {
        const code = getLastError();
        return unavailable("creation-time", classifyWin32Error(code), code);
      }
      const creationTime = normalizeCreationTime(creation);
      if (!creationTime) return unavailable("creation-time", "invalid-filetime");
      return { ok: true, status: "ok", ...processEntry, creationTime };
    } catch (err) {
      if (typeof options.onCallError === "function") options.onCallError(err);
      return unavailable("call", "ffi-exception");
    } finally {
      if (processHandle) {
        try { ffi.CloseHandle(processHandle); } catch {}
      }
    }
  };
  return {
    status: "ok",
    reason: null,
    query,
    close,
    abi,
    processCount: processes.size,
  };
}

function createWindowsProcessQuery(options = {}) {
  const isWin = options.isWin != null ? options.isWin === true : process.platform === "win32";
  if (!isWin) {
    const query = () => unavailable("init", "off-windows");
    query.available = false;
    query.abi = null;
    return query;
  }

  let ffi;
  try {
    if (options.ffi) {
      ffi = options.ffi;
    } else {
      // Koffi named structs are scoped to the Koffi registry object. Reuse
      // bindings for the same default or explicitly injected registry while
      // keeping different test/dedicated registries isolated.
      ffi = getOrCreateKoffiBindings(
        processQueryFfiByKoffi,
        options.koffi || require("koffi"),
        buildKoffiFfi,
      );
    }
  } catch (err) {
    if (typeof options.onInitError === "function") options.onInitError(err);
    const query = () => unavailable("init", "ffi-unavailable");
    query.available = false;
    query.abi = null;
    return query;
  }

  const abi = processQueryAbi(ffi);
  if (!abiMatches(abi, expectedProcessQueryAbi(abi.pointerSize))) {
    const query = () => unavailable("init", "abi-mismatch");
    query.available = false;
    query.abi = abi;
    return query;
  }

  const getLastError = () => {
    try { return Number(ffi.GetLastError()) >>> 0; } catch { return null; }
  };

  const query = (rawPid) => {
    const pid = normalizePid(rawPid);
    if (!pid) return unavailable("input", "invalid-pid");

    let handle = null;
    try {
      handle = ffi.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!handle) {
        const code = getLastError();
        return unavailable("open", classifyWin32Error(code), code);
      }

      const basic = {};
      const returnLength = [0];
      const ntstatus = Number(ffi.NtQueryInformationProcess(
        handle,
        PROCESS_BASIC_INFORMATION_CLASS,
        basic,
        ffi.processBasicInformationSize,
        returnLength
      )) | 0;
      if (ntstatus !== 0) {
        return unavailable("parent", classifyNtStatus(ntstatus), ntstatus);
      }
      if (Number(returnLength[0]) !== Number(ffi.processBasicInformationSize)) {
        return unavailable("parent", "invalid-return-length");
      }
      const parentPid = normalizeParentPid(basic.InheritedFromUniqueProcessId);
      if (parentPid === null) return unavailable("parent", "invalid-parent-pid");

      const imageBuffer = new Uint16Array(IMAGE_NAME_BUFFER_CHARS);
      const imageLength = [IMAGE_NAME_BUFFER_CHARS];
      if (!ffi.QueryFullProcessImageNameW(handle, 0, imageBuffer, imageLength)) {
        const code = getLastError();
        return unavailable("image", classifyWin32Error(code), code);
      }
      const name = normalizeProcessName(utf16BufferToString(imageBuffer, imageLength[0]));
      if (!name) return unavailable("image", "empty-image-name");

      const creation = {};
      const exit = {};
      const kernel = {};
      const user = {};
      if (!ffi.GetProcessTimes(handle, creation, exit, kernel, user)) {
        const code = getLastError();
        return unavailable("creation-time", classifyWin32Error(code), code);
      }
      const creationTime = normalizeCreationTime(creation);
      if (!creationTime) return unavailable("creation-time", "invalid-filetime");

      return {
        ok: true,
        status: "ok",
        pid,
        parentPid,
        name,
        creationTime,
      };
    } catch (err) {
      if (typeof options.onCallError === "function") options.onCallError(err);
      return unavailable("call", "ffi-exception");
    } finally {
      if (handle) {
        try { ffi.CloseHandle(handle); } catch { /* best effort */ }
      }
    }
  };

  query.available = true;
  query.abi = abi;
  return query;
}

function walkProcessAncestry(startPid, options = {}) {
  const hookPid = normalizePid(startPid);
  if (!hookPid) {
    return { status: "unavailable", reason: "invalid-hook-pid", hook: null, nodes: [], depth: 0 };
  }
  const queryProcess = options.queryProcess;
  if (typeof queryProcess !== "function") {
    return { status: "unavailable", reason: "query-unavailable", hook: null, nodes: [], depth: 0 };
  }
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0
    ? Math.min(options.maxDepth, 64)
    : DEFAULT_MAX_DEPTH;
  const boundaryNames = options.systemBoundary instanceof Set
    ? options.systemBoundary
    : new Set();

  const hook = queryProcess(hookPid);
  if (!hook || hook.ok !== true) {
    return {
      status: "unavailable",
      reason: "hook-query-failed",
      hook: null,
      nodes: [],
      depth: 0,
      failure: hook || unavailable("hook", "query-failed"),
    };
  }

  const nodes = [];
  const visited = new Set([hookPid]);
  let child = hook;
  let nextPid = normalizeParentPid(hook.parentPid);
  let stopReason = "parent-boundary";

  for (let depth = 0; depth < maxDepth && nextPid && nextPid > 1; depth++) {
    if (visited.has(nextPid)) {
      return { status: "unavailable", reason: "cycle", hook, nodes, depth: nodes.length };
    }
    visited.add(nextPid);

    const current = queryProcess(nextPid);
    if (!current || current.ok !== true) {
      return {
        status: "partial",
        reason: "ancestor-query-failed",
        hook,
        nodes,
        depth: nodes.length,
        failure: current || unavailable("ancestor", "query-failed"),
      };
    }

    const timeOrder = compareCreationTime(current.creationTime, child.creationTime);
    if (timeOrder === null) {
      return { status: "unavailable", reason: "creation-time-unavailable", hook, nodes, depth: nodes.length };
    }
    if (timeOrder > 0) {
      return { status: "unavailable", reason: "pid-reuse", hook, nodes, depth: nodes.length };
    }

    nodes.push(current);
    if (boundaryNames.has(current.name)) {
      stopReason = "system-boundary";
      break;
    }

    child = current;
    const parentPid = normalizeParentPid(current.parentPid);
    if (!parentPid || parentPid <= 1 || parentPid === current.pid) {
      stopReason = parentPid === current.pid ? "self-parent" : "parent-boundary";
      break;
    }
    nextPid = parentPid;

    if (depth === maxDepth - 1) stopReason = "max-depth";
  }

  return {
    status: "ok",
    reason: stopReason,
    hook,
    nodes,
    depth: nodes.length,
  };
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  MAX_PID,
  PROCESS_QUERY_LIMITED_INFORMATION,
  TH32CS_SNAPPROCESS,
  ERROR_BAD_LENGTH,
  classifyNtStatus,
  classifyWin32Error,
  buildToolhelpKoffiFfi,
  compareCreationTime,
  createWindowsToolhelpSnapshot,
  createWindowsProcessQuery,
  normalizeCreationTime,
  normalizePid,
  walkProcessAncestry,
};
