#!/usr/bin/env node
"use strict";

const { performance } = require("node:perf_hooks");
const {
  createWindowsProcessQuery,
  createWindowsToolhelpSnapshot,
  walkProcessAncestry,
} = require("../src/win-process-ancestry");

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function summarize(values) {
  const round = (value) => value == null ? null : Number(value.toFixed(3));
  return {
    samples: values.length,
    minMs: round(values.length ? Math.min(...values) : null),
    p50Ms: round(percentile(values, 0.50)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(values.length ? Math.max(...values) : null),
  };
}

function parseIterations(value, fallback) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? Math.min(count, 10000) : fallback;
}

function createHandleCounter() {
  try {
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const GetCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");
    const GetProcessHandleCount = kernel32.func("bool __stdcall GetProcessHandleCount(void *hProcess, _Out_ uint32 *pdwHandleCount)");
    const current = GetCurrentProcess();
    return () => {
      const count = [0];
      return GetProcessHandleCount(current, count) ? count[0] : null;
    };
  } catch {
    return () => null;
  }
}

function runNtQuery(iterations) {
  const query = createWindowsProcessQuery();
  const durations = [];
  const statuses = new Map();
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    const result = walkProcessAncestry(process.pid, { queryProcess: query, maxDepth: 8 });
    durations.push(performance.now() - started);
    const key = `${result.status}:${result.reason}`;
    statuses.set(key, (statuses.get(key) || 0) + 1);
  }
  return { timing: summarize(durations), statuses: Object.fromEntries(statuses), abi: query.abi };
}

function runToolhelp(iterations) {
  const durations = [];
  const statuses = new Map();
  let abi = null;
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    const snapshot = createWindowsToolhelpSnapshot();
    let result = snapshot;
    try {
      if (snapshot.query) {
        abi = snapshot.abi;
        result = walkProcessAncestry(process.pid, { queryProcess: snapshot.query, maxDepth: 8 });
      }
    } finally {
      snapshot.close();
    }
    durations.push(performance.now() - started);
    const key = `${result.status}:${result.reason}`;
    statuses.set(key, (statuses.get(key) || 0) + 1);
  }
  return { timing: summarize(durations), statuses: Object.fromEntries(statuses), abi };
}

if (process.platform !== "win32") {
  process.stderr.write("windows-process-chain-benchmark requires Windows\n");
  process.exitCode = 1;
} else {
  const ntIterations = parseIterations(process.argv[2], 1000);
  const toolhelpIterations = parseIterations(process.argv[3], 100);
  const countHandles = createHandleCounter();
  const handlesBefore = countHandles();
  const ntQuery = runNtQuery(ntIterations);
  const handlesAfterNtQuery = countHandles();
  const toolhelp = runToolhelp(toolhelpIterations);
  const handlesAfterToolhelp = countHandles();
  const report = {
    generatedAt: new Date().toISOString(),
    arch: process.arch,
    node: process.version,
    pid: process.pid,
    ntQuery,
    toolhelp,
    handleCounts: {
      before: handlesBefore,
      afterNtQuery: handlesAfterNtQuery,
      afterToolhelp: handlesAfterToolhelp,
      ntQueryDelta: handlesBefore == null || handlesAfterNtQuery == null ? null : handlesAfterNtQuery - handlesBefore,
      toolhelpDelta: handlesAfterNtQuery == null || handlesAfterToolhelp == null ? null : handlesAfterToolhelp - handlesAfterNtQuery,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
