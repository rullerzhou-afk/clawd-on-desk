"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildToolhelpKoffiFfi,
  compareCreationTime,
  createWindowsProcessQuery,
  createWindowsToolhelpSnapshot,
  normalizePid,
  walkProcessAncestry,
} = require("../src/win-process-ancestry");

function time(low) {
  return { high: 1, low };
}

const VALID_QUERY_ABI = Object.freeze({
  processBasicInformationSize: 48,
  fileTimeSize: 8,
  pointerSize: 8,
  processBasicInformationOffsets: Object.freeze({
    ExitStatus: 0,
    PebBaseAddress: 8,
    AffinityMask: 16,
    BasePriority: 24,
    UniqueProcessId: 32,
    InheritedFromUniqueProcessId: 40,
  }),
  fileTimeOffsets: Object.freeze({ low: 0, high: 4 }),
});

const VALID_TOOLHELP_ABI = Object.freeze({
  processEntrySize: 568,
  fileTimeSize: 8,
  pointerSize: 8,
  processEntryOffsets: Object.freeze({
    th32ProcessID: 8,
    th32DefaultHeapID: 16,
    th32ParentProcessID: 32,
    szExeFile: 44,
  }),
  fileTimeOffsets: Object.freeze({ low: 0, high: 4 }),
});

function graphQuery(entries) {
  return (pid) => {
    const entry = entries.get(pid);
    return entry
      ? { ok: true, status: "ok", pid, ...entry }
      : { ok: false, status: "unavailable", errorKind: "not-found" };
  };
}

describe("win-process-ancestry", () => {
  it("exposes Koffi pointer addresses so INVALID_HANDLE_VALUE External objects can be rejected", () => {
    const fakeKoffi = {
      load: () => ({ func: () => () => null }),
      struct: (name) => ({ name }),
      array: () => ({ kind: "array" }),
      sizeof: (value) => {
        if (value === "void *") return 8;
        return value && value.name === "ClawdPROCESSENTRY32W" ? 568 : 8;
      },
      offsetof: (value, member) => {
        if (value && value.name === "ClawdPROCESSENTRY32W") {
          return VALID_TOOLHELP_ABI.processEntryOffsets[member];
        }
        return VALID_TOOLHELP_ABI.fileTimeOffsets[member];
      },
      address: (handle) => handle.address,
    };
    const ffi = buildToolhelpKoffiFfi(fakeKoffi);
    const invalidExternal = { address: 0xffffffffffffffffn };
    assert.strictEqual(ffi.pointerAddress(invalidExternal), 0xffffffffffffffffn);
  });

  it("normalizes PID bounds and compares FILETIME without Number precision loss", () => {
    assert.strictEqual(normalizePid(1), 1);
    assert.strictEqual(normalizePid(0xffffffffn), 0xffffffff);
    assert.strictEqual(normalizePid(0), null);
    assert.strictEqual(normalizePid(0x100000000n), null);
    assert.strictEqual(compareCreationTime({ high: 2, low: 0 }, { high: 1, low: 0xffffffff }), 1);
    assert.strictEqual(compareCreationTime({ high: 1, low: 3 }, { high: 1, low: 4 }), -1);
  });

  it("queries one process and closes its handle exactly once", () => {
    const calls = [];
    const ffi = {
      OpenProcess: (_access, _inherit, pid) => { calls.push(["open", pid]); return { pid }; },
      NtQueryInformationProcess: (_h, _cls, basic, _size, length) => {
        basic.InheritedFromUniqueProcessId = 42;
        length[0] = 48;
        return 0;
      },
      QueryFullProcessImageNameW: (_h, _flags, buf, length) => {
        const text = "C:\\Tools\\codex.exe";
        for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i);
        length[0] = text.length;
        return true;
      },
      GetProcessTimes: (_h, creation) => {
        creation.high = 7;
        creation.low = 9;
        return true;
      },
      GetLastError: () => 0,
      CloseHandle: (handle) => { calls.push(["close", handle.pid]); return true; },
      ...VALID_QUERY_ABI,
    };
    const query = createWindowsProcessQuery({ isWin: true, ffi });
    assert.deepStrictEqual(query(99), {
      ok: true,
      status: "ok",
      pid: 99,
      parentPid: 42,
      name: "codex.exe",
      creationTime: { high: 7, low: 9 },
    });
    assert.deepStrictEqual(calls, [["open", 99], ["close", 99]]);
    assert.deepStrictEqual(query.abi, {
      processBasicInformationSize: 48,
      fileTimeSize: 8,
      pointerSize: 8,
      processBasicInformationOffsets: VALID_QUERY_ABI.processBasicInformationOffsets,
      fileTimeOffsets: VALID_QUERY_ABI.fileTimeOffsets,
    });
  });

  it("reuses per-instance Koffi bindings across explicit and default process-query factories", {
    skip: process.platform !== "win32",
  }, () => {
    const koffi = require("koffi");
    const explicitFirst = createWindowsProcessQuery({ koffi });
    const explicitSecond = createWindowsProcessQuery({ koffi });
    const defaultFirst = createWindowsProcessQuery();
    const defaultSecond = createWindowsProcessQuery();

    for (const query of [explicitFirst, explicitSecond, defaultFirst, defaultSecond]) {
      assert.strictEqual(query.available, true);
      const result = query(process.pid);
      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.pid, process.pid);
      assert.ok(result.parentPid > 0);
      assert.ok(result.name.endsWith(".exe"));
      assert.ok(result.creationTime);
    }
  });

  it("reuses per-instance Koffi bindings across explicit and default Toolhelp factories", {
    skip: process.platform !== "win32",
  }, () => {
    const koffi = require("koffi");
    const snapshots = [
      createWindowsToolhelpSnapshot({ koffi }),
      createWindowsToolhelpSnapshot({ koffi }),
      createWindowsToolhelpSnapshot(),
      createWindowsToolhelpSnapshot(),
    ];

    try {
      for (const snapshot of snapshots) {
        assert.strictEqual(snapshot.status, "ok");
        const result = snapshot.query(process.pid);
        assert.strictEqual(result.status, "ok");
        assert.strictEqual(result.pid, process.pid);
        assert.ok(result.parentPid > 0);
        assert.ok(result.name.endsWith(".exe"));
        assert.ok(result.creationTime);
      }
    } finally {
      for (const snapshot of snapshots) snapshot.close();
    }
  });

  it("fails initialization closed on a PBI ABI mismatch", () => {
    let opens = 0;
    const ffi = {
      ...VALID_QUERY_ABI,
      processBasicInformationOffsets: {
        ...VALID_QUERY_ABI.processBasicInformationOffsets,
        InheritedFromUniqueProcessId: 32,
      },
      OpenProcess: () => { opens++; return {}; },
    };
    const query = createWindowsProcessQuery({ isWin: true, ffi });
    assert.strictEqual(query.available, false);
    assert.strictEqual(query(99).errorKind, "abi-mismatch");
    assert.strictEqual(opens, 0);
  });

  it("rejects a successful NtQuery call with an invalid ReturnLength", () => {
    const closed = [];
    const ffi = {
      ...VALID_QUERY_ABI,
      OpenProcess: () => ({ pid: 99 }),
      NtQueryInformationProcess: (_h, _cls, basic, _size, length) => {
        basic.InheritedFromUniqueProcessId = 42;
        length[0] = 0;
        return 0;
      },
      GetLastError: () => 0,
      CloseHandle: (handle) => { closed.push(handle.pid); return true; },
    };
    const query = createWindowsProcessQuery({ isWin: true, ffi });
    const result = query(99);
    assert.strictEqual(result.stage, "parent");
    assert.strictEqual(result.errorKind, "invalid-return-length");
    assert.deepStrictEqual(closed, [99]);
  });

  it("samples Win32 last-error after a failed call without leaking a handle", () => {
    const order = [];
    const ffi = {
      OpenProcess: () => { order.push("open"); return null; },
      GetLastError: () => { order.push("last-error"); return 5; },
      CloseHandle: () => { order.push("close"); },
      ...VALID_QUERY_ABI,
    };
    const query = createWindowsProcessQuery({ isWin: true, ffi });
    const result = query(9);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, "open");
    assert.strictEqual(result.errorKind, "access-denied");
    assert.strictEqual(result.errorCode, 5);
    assert.deepStrictEqual(order, ["open", "last-error"]);
  });

  it("builds a bounded Toolhelp map, retries ERROR_BAD_LENGTH, and closes every handle", () => {
    const calls = [];
    let snapshotAttempts = 0;
    let lastError = 0;
    const writeEntry = (entry, value) => {
      entry.th32ProcessID = value.pid;
      entry.th32ParentProcessID = value.parentPid;
      entry.szExeFile = new Uint16Array(260);
      for (let i = 0; i < value.name.length; i++) entry.szExeFile[i] = value.name.charCodeAt(i);
    };
    const ffi = {
      CreateToolhelp32Snapshot: () => {
        snapshotAttempts++;
        if (snapshotAttempts === 1) {
          lastError = 24;
          return { kind: "invalid-external" };
        }
        lastError = 0;
        return { kind: "snapshot" };
      },
      pointerAddress: (handle) => handle.kind === "invalid-external" ? 0xffffffffffffffffn : 123n,
      GetLastError: () => lastError,
      Process32FirstW: (_snapshot, entry) => { writeEntry(entry, { pid: 99, parentPid: 42, name: "CODEX.EXE" }); return true; },
      Process32NextW: () => { lastError = 18; return false; },
      OpenProcess: (_access, _inherit, pid) => ({ kind: "process", pid }),
      GetProcessTimes: (_handle, creation) => { creation.high = 3; creation.low = 4; return true; },
      CloseHandle: (handle) => { calls.push(handle.kind === "process" ? `process:${handle.pid}` : handle.kind); return true; },
      ...VALID_TOOLHELP_ABI,
    };
    const snapshot = createWindowsToolhelpSnapshot({ isWin: true, ffi, maxRetries: 2 });
    assert.strictEqual(snapshot.status, "ok");
    assert.strictEqual(snapshotAttempts, 2);
    assert.deepStrictEqual(snapshot.abi, {
      pointerSize: 8,
      processEntrySize: 568,
      fileTimeSize: 8,
      processEntryOffsets: VALID_TOOLHELP_ABI.processEntryOffsets,
      fileTimeOffsets: VALID_TOOLHELP_ABI.fileTimeOffsets,
    });
    assert.deepStrictEqual(snapshot.query(99), {
      ok: true,
      status: "ok",
      pid: 99,
      parentPid: 42,
      name: "codex.exe",
      creationTime: { high: 3, low: 4 },
    });
    snapshot.close();
    snapshot.close();
    assert.deepStrictEqual(calls, ["process:99", "snapshot"]);
    assert.strictEqual(snapshot.query(99).errorKind, "snapshot-closed");
  });

  it("fails a Toolhelp snapshot closed when enumeration stops for a real error", () => {
    const closed = [];
    const ffi = {
      ...VALID_TOOLHELP_ABI,
      CreateToolhelp32Snapshot: () => ({ kind: "snapshot" }),
      pointerAddress: () => 123n,
      Process32FirstW: (_snapshot, entry) => {
        entry.th32ProcessID = 99;
        entry.th32ParentProcessID = 42;
        entry.szExeFile = new Uint16Array(260);
        entry.szExeFile[0] = "x".charCodeAt(0);
        return true;
      },
      Process32NextW: () => false,
      GetLastError: () => 5,
      CloseHandle: (handle) => { closed.push(handle.kind); return true; },
    };
    const snapshot = createWindowsToolhelpSnapshot({ isWin: true, ffi });
    assert.strictEqual(snapshot.status, "unavailable");
    assert.strictEqual(snapshot.stage, "enumeration");
    assert.strictEqual(snapshot.reason, "access-denied");
    assert.deepStrictEqual(closed, ["snapshot"]);
  });

  it("starts the public chain at the hook parent and includes a system boundary", () => {
    const entries = new Map([
      [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
      [90, { parentPid: 80, name: "codex.exe", creationTime: time(90) }],
      [80, { parentPid: 70, name: "pwsh.exe", creationTime: time(80) }],
      [70, { parentPid: 60, name: "explorer.exe", creationTime: time(70) }],
    ]);
    const result = walkProcessAncestry(100, {
      queryProcess: graphQuery(entries),
      systemBoundary: new Set(["explorer.exe"]),
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.reason, "system-boundary");
    assert.deepStrictEqual(result.nodes.map((entry) => entry.pid), [90, 80, 70]);
    assert.strictEqual(result.hook.pid, 100);
  });

  it("allows the eighth outward node and never counts the hook query toward maxDepth", () => {
    const entries = new Map();
    entries.set(100, { parentPid: 99, name: "node.exe", creationTime: time(100) });
    for (let pid = 99; pid >= 92; pid--) {
      entries.set(pid, {
        parentPid: pid - 1,
        name: pid === 92 ? "codex.exe" : "pwsh.exe",
        creationTime: time(pid),
      });
    }
    const result = walkProcessAncestry(100, { queryProcess: graphQuery(entries), maxDepth: 8 });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.depth, 8);
    assert.strictEqual(result.nodes[7].pid, 92);
  });

  it("fails closed for PID reuse, cycles, and partial ancestor failures", () => {
    const reuse = new Map([
      [10, { parentPid: 9, name: "node.exe", creationTime: time(10) }],
      [9, { parentPid: 8, name: "codex.exe", creationTime: time(11) }],
    ]);
    assert.strictEqual(
      walkProcessAncestry(10, { queryProcess: graphQuery(reuse) }).reason,
      "pid-reuse"
    );

    const cycle = new Map([
      [10, { parentPid: 9, name: "node.exe", creationTime: time(10) }],
      [9, { parentPid: 10, name: "codex.exe", creationTime: time(9) }],
    ]);
    assert.strictEqual(
      walkProcessAncestry(10, { queryProcess: graphQuery(cycle) }).reason,
      "cycle"
    );

    const partial = new Map([
      [10, { parentPid: 9, name: "node.exe", creationTime: time(10) }],
      [9, { parentPid: 8, name: "codex.exe", creationTime: time(9) }],
    ]);
    const partialResult = walkProcessAncestry(10, { queryProcess: graphQuery(partial) });
    assert.strictEqual(partialResult.status, "partial");
    assert.strictEqual(partialResult.reason, "ancestor-query-failed");
  });

  it("is a constant unavailable query off Windows", () => {
    const query = createWindowsProcessQuery({ isWin: false });
    assert.strictEqual(query.available, false);
    assert.strictEqual(query(123).errorKind, "off-windows");
  });
});
