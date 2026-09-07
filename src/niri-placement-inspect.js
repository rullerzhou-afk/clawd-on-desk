"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const {
  cleanupCaptureTarget,
  createCaptureTarget,
  scanNativeImage,
  waitForCompletePng,
} = require("./niri-inspect-artifact");
const { createNiriIpcClient } = require("./niri-ipc-client");

const execFileAsync = promisify(execFile);
const POINTER_DWELL_MS = 80;
const POINTER_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 5000;
const WINDOWS_TIMEOUT_MS = 3000;
const EDGE_MARGIN = 100;

const TRANSITIONS = Object.freeze({
  off: new Set(["inspecting"]),
  inspecting: new Set(["parent-coupled-candidate", "unavailable", "faulted"]),
  "parent-coupled-candidate": new Set(["faulted"]),
  unavailable: new Set(),
  faulted: new Set(),
});

function resolveNiriInspectRequest(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const platform = options.platform || process.platform;
  if (env.CLAWD_WINDOW_PLACEMENT !== "niri-ipc") {
    return { requested: false, enabled: false, reason: "default-off", stage: null };
  }
  const stage = env.CLAWD_NIRI_STAGE || "inspect";
  if (stage !== "inspect") {
    return { requested: true, enabled: false, reason: `stage-${stage}-not-implemented`, stage };
  }
  if (platform !== "linux") return { requested: true, enabled: false, reason: "not-linux", stage };
  if (!argv.includes("--ozone-platform=x11")) {
    return { requested: true, enabled: false, reason: "not-canonical-x11", stage };
  }
  if (typeof env.NIRI_SOCKET !== "string" || !env.NIRI_SOCKET.trim()) {
    return { requested: true, enabled: false, reason: "missing-niri-socket", stage };
  }
  if (env.CLAWD_DISABLE_EDGE_VIRTUALIZATION !== "1") {
    return { requested: true, enabled: false, reason: "edge-virtualization-enabled", stage };
  }
  return {
    requested: true,
    enabled: true,
    reason: null,
    stage,
    socketPath: env.NIRI_SOCKET.trim(),
  };
}

function matchesNiri2604Release(raw) {
  if (typeof raw !== "string") return false;
  return /^26\.04(?:\.\d+)?(?: \([^\r\n()]+\))?$/.test(raw.trim());
}

function rectsNear(a, b, tolerance = 2) {
  if (!a || !b) return false;
  return ["x", "y", "width", "height"].every((key) => (
    Number.isFinite(a[key])
    && Number.isFinite(b[key])
    && Math.abs(a[key] - b[key]) <= tolerance
  ));
}

function isWindowInterior(windowInfo, display, margin = EDGE_MARGIN) {
  const layout = windowInfo && windowInfo.layout;
  const pos = layout && layout.tile_pos_in_workspace_view;
  const size = layout && layout.tile_size;
  const workArea = display && display.workArea;
  if (!Array.isArray(pos) || pos.length !== 2 || !Array.isArray(size) || size.length !== 2) return false;
  if (!workArea || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)) return false;
  const [x, y] = pos;
  const [width, height] = size;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  return x >= margin
    && y >= margin
    && x + width <= workArea.width - margin
    && y + height <= workArea.height - margin;
}

async function queryX11TitleCounts(titles, options = {}) {
  const exec = options.execFile || execFileAsync;
  const result = await exec("xwininfo", ["-root", "-tree"], {
    timeout: 2500,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  const stdout = typeof result === "string" ? result : result.stdout;
  const lines = String(stdout || "").split(/\r?\n/);
  const counts = {};
  for (const title of titles) {
    const quoted = `"${title}"`;
    const matches = lines.filter((line) => line.includes(quoted));
    counts[title] = {
      count: matches.length,
      sizes: matches.map((line) => {
        const geometry = line.match(/\b(\d+)x(\d+)[+-]\d+[+-]\d+/);
        return geometry
          ? { width: Number(geometry[1]), height: Number(geometry[2]) }
          : null;
      }),
    };
  }
  return counts;
}

function windowTitle(role, pid, generation, loadEpoch) {
  return `Clawd niri ${role} ${pid}-${generation}-${loadEpoch}`;
}

function tombstoneTitle(role, pid, generation, loadEpoch) {
  return `Clawd niri ${role} loading ${pid}-${generation}-${loadEpoch}`;
}

function safeWindow(win) {
  return !!win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
}

function safeContents(win) {
  return safeWindow(win)
    && win.webContents
    && (typeof win.webContents.isDestroyed !== "function" || !win.webContents.isDestroyed());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NiriPlacementInspect {
  constructor(options = {}) {
    this.config = options.config || resolveNiriInspectRequest(options);
    this.ipcMain = options.ipcMain;
    this.screen = options.screen;
    this.nativeImage = options.nativeImage;
    this.pid = Number.isSafeInteger(options.pid) ? options.pid : process.pid;
    this.appId = options.appId || "clawd-on-desk";
    this.isTrustedEvent = options.isTrustedEvent || (() => false);
    this.getRenderWindow = options.getRenderWindow || (() => null);
    this.getHitWindow = options.getHitWindow || (() => null);
    this.getExpectedHitBounds = options.getExpectedHitBounds || (() => null);
    this.getLogicalRenderBounds = options.getLogicalRenderBounds || (() => null);
    this.getPhysicalRenderBounds = options.getPhysicalRenderBounds || (() => null);
    this.getViewportOffsets = options.getViewportOffsets || (() => ({ x: 0, y: 0 }));
    this.checkDynamicPrerequisites = options.checkDynamicPrerequisites || (() => ({ ok: true }));
    this.ensureHitWindow = options.ensureHitWindow || (() => null);
    this.showDeferredHit = options.showDeferredHit || (() => {});
    this.startMainTick = options.startMainTick || (() => {});
    this.setVisualLease = options.setVisualLease || (() => {});
    this.logger = options.logger || ((line) => console.log(line));
    this.clientFactory = options.clientFactory || ((clientOptions) => createNiriIpcClient(clientOptions));
    this.queryX11Titles = options.queryX11Titles || queryX11TitleCounts;
    this.createCaptureTarget = options.createCaptureTarget || createCaptureTarget;
    this.waitForCompletePng = options.waitForCompletePng || waitForCompletePng;
    this.cleanupCaptureTarget = options.cleanupCaptureTarget || cleanupCaptureTarget;
    this.delay = options.delay || delay;
    this.pointerDwellMs = options.pointerDwellMs || POINTER_DWELL_MS;
    this.pointerTimeoutMs = options.pointerTimeoutMs || POINTER_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;
    this.windowsTimeoutMs = options.windowsTimeoutMs || WINDOWS_TIMEOUT_MS;

    this.state = "off";
    this.generation = Number.isSafeInteger(options.generation) && options.generation > 0
      ? options.generation
      : 1;
    this.renderLoadEpoch = 0;
    this.hitLoadEpoch = 0;
    this.renderReady = false;
    this.hitReady = false;
    this.pointerInside = false;
    this.pointerSample = null;
    this.acceptPointer = false;
    this.pointerWaiter = null;
    this.legacyReleased = false;
    this.legacyReleaseBlocked = false;
    this.renderInputSafetyReleased = false;
    this.visualLease = false;
    this.started = false;
    this.disposed = false;
    this.client = null;
    this.disposers = [];
    this.result = null;
    this.invalidReason = null;
    this.hitInitialShowPending = false;
  }

  shouldDeferHitMapping() {
    return this.config.enabled === true;
  }

  registerIpc() {
    if (!this.config.enabled || !this.ipcMain || typeof this.ipcMain.on !== "function") return;
    const onReady = (event, payload) => this._onRendererReady(event, payload);
    const onPointer = (event, payload) => this._onRenderPointer(event, payload);
    this.ipcMain.on("niri-inspect-renderer-ready", onReady);
    this.ipcMain.on("niri-inspect-render-pointer", onPointer);
    this.disposers.push(() => this.ipcMain.removeListener("niri-inspect-renderer-ready", onReady));
    this.disposers.push(() => this.ipcMain.removeListener("niri-inspect-render-pointer", onPointer));
    if (this.screen && typeof this.screen.on === "function") {
      const invalidateTopology = () => this._invalidate("display-topology-changed");
      this.screen.on("display-added", invalidateTopology);
      this.screen.on("display-removed", invalidateTopology);
      this.screen.on("display-metrics-changed", invalidateTopology);
      this.disposers.push(() => this.screen.removeListener("display-added", invalidateTopology));
      this.disposers.push(() => this.screen.removeListener("display-removed", invalidateTopology));
      this.disposers.push(() => this.screen.removeListener("display-metrics-changed", invalidateTopology));
    }
  }

  attachRenderWindow(win) {
    if (!this.config.enabled || !safeContents(win)) return;
    this._attachIdentityLifecycle(win, "render");
  }

  attachHitWindow(win) {
    if (!this.config.enabled || !safeContents(win)) return;
    this.hitInitialShowPending = typeof win.isVisible === "function" && !win.isVisible();
    this._attachIdentityLifecycle(win, "hit");
  }

  async start() {
    if (!this.config.enabled || this.started || this.disposed) return null;
    this.started = true;
    this._transition("inspecting");
    try {
      await this._waitUntil(() => this.renderReady, this.readyTimeoutMs, "render-marker-ready-timeout");
      this._checkPrerequisites();
      this.client = this.clientFactory({ socketPath: this.config.socketPath });
      const version = await this.client.version();
      this._checkPrerequisites();
      if (!matchesNiri2604Release(version)) throw this._unavailable("unsupported-niri-version");
      this._checkPrerequisites();
      this._setVisualLease(true);
      this.acceptPointer = true;
      this.pointerInside = false;
      this.pointerSample = null;
      this.logger("Clawd niri inspect: this run will request one compositor screenshot; save clipboard contents first and allow the notification to clear naturally.");
      this.logger("Clawd niri inspect: move the pointer onto the visible pet and keep it still until the hit window maps.");
      const pointer = await this._waitForPointerDwell();
      this._checkPrerequisites();
      const createdHit = this.ensureHitWindow();
      if (!safeContents(createdHit)) throw this._unavailable("hit-window-create-failed");
      await this._waitUntil(() => this.hitReady, this.readyTimeoutMs, "hit-marker-ready-timeout");
      this._checkPrerequisites();
      this.acceptPointer = false;
      this._releaseToLegacy();
      if (!this.legacyReleased) throw this._unavailable("hit-geometry-mismatch");
      const topology = await this._inspectTopology();
      this._checkPrerequisites();
      const marker = await this._inspectMarkers(topology.render.id);
      this._checkPrerequisites();
      if (!marker.render || !marker.hit) throw this._unavailable("marker-oracle-ambiguous");
      this._transition("parent-coupled-candidate");
      this.result = Object.freeze({
        stage: "inspect",
        verdict: "parent-coupled-candidate",
        version,
        handshake: { screenX: pointer.screenX, screenY: pointer.screenY },
        render: {
          id: topology.render.id,
          workspaceId: topology.render.workspace_id,
          isFloating: topology.render.is_floating === true,
          layout: topology.render.layout,
        },
        hit: {
          managed: false,
          expectedBounds: topology.expectedHitBounds,
          electronBounds: topology.actualHitBounds,
        },
        logicalRenderBounds: topology.logicalRenderBounds,
        physicalRenderBounds: topology.physicalRenderBounds,
        workArea: topology.workArea,
        viewportOffsets: topology.viewportOffsets,
        scaleFactor: topology.scaleFactor,
        markers: marker,
      });
      this.logger(`Clawd niri inspect artifact: ${JSON.stringify(this.result)}`);
      return this.result;
    } catch (err) {
      const reason = err && err.code ? err.code : "inspect-failed";
      if (this.state === "inspecting") this._transition(err && err.faulted ? "faulted" : "unavailable");
      this.result = Object.freeze({ stage: "inspect", verdict: this.state, reason });
      this.logger(`Clawd niri inspect unavailable: ${reason}`);
      return this.result;
    } finally {
      this.acceptPointer = false;
      this._clearPointerWaiter();
      this._releaseToLegacy();
      this._setVisualLease(false);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidReason = this.invalidReason || "disposed";
    this._rejectPointerWaiter(this._unavailable(this.invalidReason));
    while (this.disposers.length) {
      try { this.disposers.pop()(); } catch {}
    }
    if (this.client) this.client.close();
    this.client = null;
    this._setVisualLease(false);
  }

  _attachIdentityLifecycle(win, role) {
    const onStart = () => {
      if (role === "render") {
        this.renderLoadEpoch += 1;
        this.renderReady = false;
      } else {
        this.hitLoadEpoch += 1;
        this.hitReady = false;
      }
      const epoch = role === "render" ? this.renderLoadEpoch : this.hitLoadEpoch;
      try { win.setTitle(tombstoneTitle(role, this.pid, this.generation, epoch)); } catch {}
      if (this.started && this.state === "inspecting") {
        this._invalidate(`${role}-reload`);
      }
    };
    const onFinish = () => {
      const epoch = role === "render" ? this.renderLoadEpoch : this.hitLoadEpoch;
      try { win.setTitle(windowTitle(role, this.pid, this.generation, epoch)); } catch {}
    };
    const onPageTitle = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
    };
    win.webContents.on("did-start-loading", onStart);
    win.webContents.on("did-finish-load", onFinish);
    if (typeof win.on === "function") win.on("page-title-updated", onPageTitle);
    const onGone = () => this._invalidate(`${role}-renderer-gone`);
    const onClosed = () => this._invalidate(`${role}-closed`);
    const onHide = () => this._invalidate(`${role}-hidden`);
    const onShow = () => {
      if (role === "hit" && this.hitInitialShowPending) {
        this.hitInitialShowPending = false;
        return;
      }
      this._invalidate(`${role}-shown`);
    };
    win.webContents.on("render-process-gone", onGone);
    if (typeof win.on === "function") {
      win.on("closed", onClosed);
      win.on("hide", onHide);
      win.on("show", onShow);
    }
    this.disposers.push(() => win.webContents.removeListener("did-start-loading", onStart));
    this.disposers.push(() => win.webContents.removeListener("did-finish-load", onFinish));
    this.disposers.push(() => win.webContents.removeListener("render-process-gone", onGone));
    if (typeof win.removeListener === "function") {
      this.disposers.push(() => win.removeListener("page-title-updated", onPageTitle));
      this.disposers.push(() => win.removeListener("closed", onClosed));
      this.disposers.push(() => win.removeListener("hide", onHide));
      this.disposers.push(() => win.removeListener("show", onShow));
    }
  }

  _onRendererReady(event, payload) {
    if (!payload || (payload.role !== "render" && payload.role !== "hit")) return;
    const win = payload.role === "render" ? this.getRenderWindow() : this.getHitWindow();
    if (!safeContents(win) || !this.isTrustedEvent(event, win.webContents)) return;
    if (payload.role === "render") this.renderReady = true;
    else this.hitReady = true;
  }

  _onRenderPointer(event, payload) {
    const win = this.getRenderWindow();
    if (!safeContents(win) || !this.isTrustedEvent(event, win.webContents)) return;
    if (!payload || payload.role !== "render" || !this.acceptPointer) return;
    if (payload.inside !== true) {
      const establishedLease = this.pointerInside && !this.pointerWaiter;
      this.pointerInside = false;
      this.pointerSample = null;
      this._cancelPointerDwell();
      if (establishedLease) this._invalidate("pointer-left-before-hit-map");
      return;
    }
    if (!Number.isFinite(payload.screenX) || !Number.isFinite(payload.screenY)) return;
    this.pointerInside = true;
    this.pointerSample = { screenX: payload.screenX, screenY: payload.screenY };
    this._beginPointerDwell();
  }

  _beginPointerDwell() {
    if (!this.pointerWaiter || this.pointerWaiter.dwellTimer) return;
    this.pointerWaiter.dwellTimer = setTimeout(() => {
      if (!this.pointerWaiter || !this.pointerInside || !this.pointerSample) return;
      const waiter = this.pointerWaiter;
      this.pointerWaiter = null;
      clearTimeout(waiter.timeoutTimer);
      if (waiter.prerequisiteTimer) clearInterval(waiter.prerequisiteTimer);
      waiter.resolve({ ...this.pointerSample });
    }, this.pointerDwellMs);
  }

  _cancelPointerDwell() {
    if (!this.pointerWaiter || !this.pointerWaiter.dwellTimer) return;
    clearTimeout(this.pointerWaiter.dwellTimer);
    this.pointerWaiter.dwellTimer = null;
  }

  _waitForPointerDwell() {
    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        if (this.pointerWaiter && this.pointerWaiter.prerequisiteTimer) {
          clearInterval(this.pointerWaiter.prerequisiteTimer);
        }
        this.pointerWaiter = null;
        reject(this._unavailable("pointer-handshake-timeout"));
      }, this.pointerTimeoutMs);
      const prerequisiteTimer = setInterval(() => {
        try {
          this._checkPrerequisites();
        } catch (err) {
          this._rejectPointerWaiter(err);
        }
      }, 50);
      this.pointerWaiter = { resolve, reject, timeoutTimer, dwellTimer: null, prerequisiteTimer };
    });
  }

  _clearPointerWaiter() {
    if (!this.pointerWaiter) return;
    clearTimeout(this.pointerWaiter.timeoutTimer);
    if (this.pointerWaiter.dwellTimer) clearTimeout(this.pointerWaiter.dwellTimer);
    if (this.pointerWaiter.prerequisiteTimer) clearInterval(this.pointerWaiter.prerequisiteTimer);
    this.pointerWaiter = null;
  }

  _rejectPointerWaiter(error) {
    if (!this.pointerWaiter) return;
    const waiter = this.pointerWaiter;
    this._clearPointerWaiter();
    waiter.reject(error);
  }

  _checkPrerequisites() {
    if (this.invalidReason) throw this._unavailable(this.invalidReason);
    const displays = this.screen && typeof this.screen.getAllDisplays === "function"
      ? this.screen.getAllDisplays()
      : [];
    if (!Array.isArray(displays) || displays.length !== 1) throw this._unavailable("requires-single-output");
    const result = this.checkDynamicPrerequisites();
    if (!result || result.ok !== true) {
      throw this._unavailable(result && result.reason ? result.reason : "dynamic-prerequisite-failed");
    }
  }

  async _inspectTopology() {
    const renderTitle = windowTitle("render", this.pid, this.generation, this.renderLoadEpoch);
    const hitTitle = windowTitle("hit", this.pid, this.generation, this.hitLoadEpoch);
    const deadline = Date.now() + this.windowsTimeoutMs;
    let windows = [];
    while (Date.now() <= deadline) {
      this._checkPrerequisites();
      windows = await this.client.windows();
      this._checkPrerequisites();
      const renderMatches = windows.filter((entry) => entry && entry.title === renderTitle);
      const hitMatches = windows.filter((entry) => entry && entry.title === hitTitle);
      if (hitMatches.length > 0) throw this._unavailable("hit-is-managed-toplevel");
      if (renderMatches.length === 1) break;
      if (renderMatches.length > 1) throw this._unavailable("render-title-not-unique");
      await this.delay(50);
    }
    this._checkPrerequisites();
    const renderMatches = windows.filter((entry) => entry && entry.title === renderTitle);
    if (renderMatches.length !== 1) throw this._unavailable("render-window-not-found");
    const render = renderMatches[0];
    if (render.app_id !== this.appId) throw this._unavailable("render-app-id-mismatch");
    if (render.is_floating !== true) throw this._unavailable("render-not-floating");

    const displays = this.screen.getAllDisplays();
    if (!isWindowInterior(render, displays[0])) throw this._unavailable("render-near-output-edge");

    const titleCounts = await this.queryX11Titles([renderTitle, hitTitle]);
    this._checkPrerequisites();
    const renderX11 = titleCounts[renderTitle];
    const hitX11 = titleCounts[hitTitle];
    if (
      !renderX11
      || !hitX11
      || renderX11.count !== 1
      || hitX11.count !== 1
      || !renderX11.sizes[0]
      || !hitX11.sizes[0]
      || renderX11.sizes[0].width <= 0
      || renderX11.sizes[0].height <= 0
      || hitX11.sizes[0].width <= 0
      || hitX11.sizes[0].height <= 0
    ) {
      throw this._unavailable("x11-title-identity-mismatch");
    }

    const hitWin = this.getHitWindow();
    const expectedHitBounds = this.getExpectedHitBounds();
    const actualHitBounds = this._getActualHitBounds(hitWin);
    if (!rectsNear(expectedHitBounds, actualHitBounds)) throw this._unavailable("hit-geometry-mismatch");

    const scaleFactor = displays[0] && Number.isFinite(displays[0].scaleFactor)
      ? displays[0].scaleFactor
      : null;
    return {
      render,
      expectedHitBounds,
      actualHitBounds,
      logicalRenderBounds: this.getLogicalRenderBounds(),
      physicalRenderBounds: this.getPhysicalRenderBounds(),
      workArea: displays[0] && displays[0].workArea ? { ...displays[0].workArea } : null,
      viewportOffsets: this.getViewportOffsets(),
      scaleFactor,
    };
  }

  async _inspectMarkers(renderId) {
    this._checkPrerequisites();
    const renderWin = this.getRenderWindow();
    const hitWin = this.getHitWindow();
    if (!safeContents(renderWin) || !safeContents(hitWin)) throw this._unavailable("window-destroyed");
    const [renderSelfImage, hitSelfImage] = await Promise.all([
      renderWin.webContents.capturePage(),
      hitWin.webContents.capturePage(),
    ]);
    this._checkPrerequisites();
    const renderSelf = scanNativeImage(renderSelfImage);
    const hitSelf = scanNativeImage(hitSelfImage);
    if (!renderSelf.render) throw this._unavailable("render-marker-not-painted");
    if (renderSelf.hit) throw this._unavailable("render-marker-not-isolated");
    if (!hitSelf.hit) throw this._unavailable("hit-marker-not-painted");
    if (hitSelf.render) throw this._unavailable("hit-marker-not-isolated");

    const target = this.createCaptureTarget();
    try {
      this._checkPrerequisites();
      await this.client.screenshotWindow({ id: renderId, path: target.filePath });
      this._checkPrerequisites();
      const png = await this.waitForCompletePng(target.filePath);
      this._checkPrerequisites();
      const image = this.nativeImage.createFromBuffer(png);
      const combined = scanNativeImage(image);
      return Object.freeze({
        renderSelf: renderSelf.render,
        hitSelf: hitSelf.hit,
        render: combined.render,
        hit: combined.hit,
      });
    } finally {
      try { this.cleanupCaptureTarget(target); } catch {}
    }
  }

  _setVisualLease(active) {
    const next = active === true;
    if (this.visualLease === next) return;
    this.visualLease = next;
    try { this.setVisualLease(next); } catch {}
  }

  _releaseToLegacy() {
    if (this.legacyReleased || this.disposed) return;
    if (!this.renderInputSafetyReleased) {
      try {
        this.startMainTick();
        this.renderInputSafetyReleased = true;
      } catch {
        this.legacyReleaseBlocked = true;
        this.logger("Clawd niri inspect: could not restore render click-through safety; quit and restart without the experiment variables.");
        return;
      }
    }
    if (this.legacyReleaseBlocked) return;
    let hitWin = null;
    try { hitWin = this.ensureHitWindow(); } catch {}
    if (!safeContents(hitWin)) {
      this.legacyReleaseBlocked = true;
      this.logger("Clawd niri inspect: could not restore the input window; quit and restart without the experiment variables.");
      return;
    }
    if (!rectsNear(this.getExpectedHitBounds(), this._getActualHitBounds(hitWin))) {
      this.legacyReleaseBlocked = true;
      this.logger("Clawd niri inspect: the input window geometry is not trustworthy; it will remain hidden. Quit and restart without the experiment variables.");
      return;
    }
    try { this.showDeferredHit(); } catch {}
    this.legacyReleased = true;
  }

  _waitUntil(predicate, timeoutMs, code) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (this.invalidReason) {
          reject(this._unavailable(this.invalidReason));
          return;
        }
        if (predicate()) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(this._unavailable(code));
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  _transition(next) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.has(next)) throw new Error(`invalid niri inspect transition ${this.state} -> ${next}`);
    this.state = next;
  }

  _unavailable(code) {
    const error = new Error(code);
    error.code = code;
    error.faulted = false;
    return error;
  }

  _getActualHitBounds(hitWin = this.getHitWindow()) {
    return safeWindow(hitWin) && typeof hitWin.getBounds === "function"
      ? hitWin.getBounds()
      : null;
  }

  _invalidate(reason) {
    if (this.disposed || this.invalidReason) return;
    this.invalidReason = reason;
    this._rejectPointerWaiter(this._unavailable(reason));
  }
}

function createNiriPlacementInspect(options) {
  return new NiriPlacementInspect(options);
}

module.exports = {
  EDGE_MARGIN,
  NiriPlacementInspect,
  TRANSITIONS,
  createNiriPlacementInspect,
  isWindowInterior,
  matchesNiri2604Release,
  queryX11TitleCounts,
  rectsNear,
  resolveNiriInspectRequest,
  windowTitle,
};
