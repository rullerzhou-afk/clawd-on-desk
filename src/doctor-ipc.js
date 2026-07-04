const os = require("os");
const path = require("path");
const { runDoctorChecks } = require("./doctor");
const { getCodexHookHealth } = require("./codex-hook-health");
const { formatDiagnosticReport, redactDoctorResult } = require("./doctor-report");
const { createConnectionTestDeduper, runConnectionTest } = require("./doctor-hook-activity");
const { openClawdLog } = require("./doctor-logs");

function getDoctorRedactionOptions(app) {
  const appRoots = [path.resolve(path.join(__dirname, ".."))];
  try {
    const appPath = app.getAppPath();
    if (appPath) appRoots.push(path.resolve(appPath));
  } catch {}
  return { appRoots };
}

function normalizeDoctorObjectPayload(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function normalizeDoctorConnectionTestPayload(payload) {
  return normalizeDoctorObjectPayload(payload);
}

function normalizeDoctorOpenLogPayload(payload) {
  const safePayload = normalizeDoctorObjectPayload(payload);
  return typeof safePayload.name === "string" ? { name: safePayload.name } : {};
}

function createDoctorRunChecksDeduper(runChecks, options = {}) {
  const onResult = typeof options.onResult === "function" ? options.onResult : null;
  let pending = null;
  return function runDedupedDoctorChecks() {
    // Single-flight: concurrent IPC calls share the first run's result.
    if (pending) return pending;
    try {
      pending = Promise.resolve(runChecks())
        .then((result) => {
          if (onResult) onResult(result);
          return result;
        })
        .finally(() => {
          pending = null;
        });
    } catch (err) {
      pending = Promise.reject(err)
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

function registerDoctorIpc({
  ipcMain,
  app,
  shell,
  server,
  getPrefsSnapshot,
  getDoNotDisturb,
  getLocale,
}) {
  let lastDoctorResult = null;
  let lastDoctorConnectionTest = null;

  const runDedupedDoctorConnectionTest = createConnectionTestDeduper(
    (payload) => runConnectionTest({
      server,
      durationMs: payload && payload.durationMs,
      homeDir: os.homedir(),
    }),
    {
      onResult: (result) => {
        lastDoctorConnectionTest = result;
      },
    }
  );

  function buildDoctorResult() {
    lastDoctorResult = runDoctorChecks({
      server,
      prefs: getPrefsSnapshot(),
      doNotDisturb: getDoNotDisturb(),
    });
    return lastDoctorResult;
  }

  function buildDoctorReportResult() {
    const result = lastDoctorResult || buildDoctorResult();
    if (!lastDoctorConnectionTest) return result;
    return {
      ...result,
      connectionTest: lastDoctorConnectionTest,
    };
  }

  const runDedupedDoctorChecks = createDoctorRunChecksDeduper(buildDoctorResult);

  ipcMain.handle("doctor:run-checks", async () => (
    redactDoctorResult(await runDedupedDoctorChecks(), getDoctorRedactionOptions(app))
  ));

  // Lightweight Codex-only hook-health probe for the Agents tab badge. Reuses
  // the same per-agent integration check the Doctor uses, but skips the full
  // doctor sweep so opening the Agents tab stays cheap. Returns a render-safe
  // subset (no raw fs paths — detailText/error stay main-side).
  ipcMain.handle("doctor:codex-hook-health", () => {
    const verdict = getCodexHookHealth({ prefs: getPrefsSnapshot() });
    return {
      available: verdict.available,
      healthy: verdict.healthy,
      signature: verdict.signature,
      reasonKey: verdict.reasonKey,
      status: verdict.status,
      fixAction: verdict.fixAction,
    };
  });

  ipcMain.handle("doctor:test-connection", async (_event, payload) => {
    const result = await runDedupedDoctorConnectionTest(normalizeDoctorConnectionTestPayload(payload));
    return redactDoctorResult(result, getDoctorRedactionOptions(app));
  });

  ipcMain.handle("doctor:open-clawd-log", async (_event, payload) => {
    const safePayload = normalizeDoctorOpenLogPayload(payload);
    return openClawdLog({
      requested: safePayload.name,
      homeDir: os.homedir(),
      userDataDir: app.getPath("userData"),
      shell,
    });
  });

  ipcMain.handle("doctor:get-report", () => {
    const result = buildDoctorReportResult();
    return formatDiagnosticReport(result, {
      version: app.getVersion(),
      platform: process.platform,
      release: os.release(),
      locale: getLocale(),
      ...getDoctorRedactionOptions(app),
    });
  });
}

module.exports = {
  registerDoctorIpc,
  __test: {
    createDoctorRunChecksDeduper,
    normalizeDoctorConnectionTestPayload,
    normalizeDoctorOpenLogPayload,
  },
};
