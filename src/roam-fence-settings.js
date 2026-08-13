"use strict";

const defaultFs = require("fs");
const defaultOs = require("os");
const defaultPath = require("path");

const FRACTION_PRECISION = 6;

function normalizeFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Number(value.toFixed(FRACTION_PRECISION));
}

function normalizeFence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const left = normalizeFraction(value.left);
  const top = normalizeFraction(value.top);
  const right = normalizeFraction(value.right);
  const bottom = normalizeFraction(value.bottom);
  if ([left, top, right, bottom].some((edge) => edge === null)) return null;
  if (!(left < right) || !(top < bottom)) return null;
  return { enabled: true, left, top, right, bottom };
}

function publicStatus(state) {
  if (!state) return { status: "unknown", active: null, fence: null };
  if (!state.active) return { status: "ok", active: false, fence: null };
  return {
    status: "ok",
    active: true,
    fence: {
      left: state.left,
      top: state.top,
      right: state.right,
      bottom: state.bottom,
    },
  };
}

function statusMatchesFence(status, fence) {
  return !!status
    && status.active === true
    && !!status.fence
    && status.fence.left === fence.left
    && status.fence.top === fence.top
    && status.fence.right === fence.right
    && status.fence.bottom === fence.bottom;
}

function createRoamFenceSettings(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const loader = options.loader;
  if (!loader || typeof loader.refresh !== "function" || typeof loader.get !== "function") {
    throw new Error("roam fence settings requires the live roam fence loader");
  }
  const filePath = options.filePath
    || loader.filePath
    || path.join((options.os || defaultOs).homedir(), ".clawd", "roam-area.json");
  const platform = options.platform || process.platform;
  let writeSerial = Promise.resolve();

  async function refreshStatus() {
    await loader.refresh();
    return publicStatus(loader.get());
  }

  async function writeAtomic(body) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tmpPath = path.join(
      dir,
      `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.writeFile(tmpPath, body, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (platform !== "win32" && typeof fs.promises.chmod === "function") {
        await fs.promises.chmod(tmpPath, 0o600).catch(() => {});
      }
      await fs.promises.rename(tmpPath, filePath);
      if (platform !== "win32" && typeof fs.promises.chmod === "function") {
        await fs.promises.chmod(filePath, 0o600).catch(() => {});
      }
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  function enqueueWrite(task) {
    const result = writeSerial.then(task, task);
    writeSerial = result.catch(() => {});
    return result;
  }

  function saveFence(value) {
    const fence = normalizeFence(value);
    if (!fence) {
      return Promise.resolve({ status: "error", message: "invalid roam fence rectangle" });
    }
    return enqueueWrite(async () => {
      try {
        await writeAtomic(`${JSON.stringify(fence, null, 2)}\n`);
        const status = await refreshStatus();
        if (!statusMatchesFence(status, fence)) {
          return { status: "error", message: "saved roam fence was not accepted" };
        }
        return status;
      } catch (err) {
        return { status: "error", message: (err && err.message) || String(err) };
      }
    });
  }

  function clearFence() {
    return enqueueWrite(async () => {
      try {
        // Keep a valid, explicit disabled record instead of deleting the file:
        // the loader can apply this in one refresh, while deletion intentionally
        // needs two consecutive ENOENT observations to survive atomic saves.
        await writeAtomic(`${JSON.stringify({ enabled: false }, null, 2)}\n`);
        const status = await refreshStatus();
        if (status.active !== false) {
          return { status: "error", message: "disabled roam fence was not accepted" };
        }
        return status;
      } catch (err) {
        return { status: "error", message: (err && err.message) || String(err) };
      }
    });
  }

  return {
    filePath,
    getStatus: refreshStatus,
    saveFence,
    clearFence,
  };
}

module.exports = createRoamFenceSettings;
module.exports.normalizeFence = normalizeFence;
module.exports.publicStatus = publicStatus;
