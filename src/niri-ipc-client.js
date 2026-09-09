"use strict";

const net = require("net");

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_LINE_LIMIT = 1024 * 1024;

class NiriIpcError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "NiriIpcError";
    this.code = code;
    this.poisoned = options.poisoned === true;
  }
}

function decodeReply(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new NiriIpcError("invalid-json", "niri returned invalid JSON", { poisoned: true });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NiriIpcError("invalid-reply", "niri returned an invalid reply envelope", { poisoned: true });
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "Err")) {
    const message = typeof parsed.Err === "string" ? parsed.Err : "niri returned an error";
    throw new NiriIpcError("niri-error", message);
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "Ok")) {
    throw new NiriIpcError("invalid-reply", "niri reply omitted Ok/Err", { poisoned: true });
  }
  return parsed.Ok;
}

function decodeTaggedResponse(response, tag) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new NiriIpcError("unexpected-response", `niri response was not ${tag}`);
  }
  if (!Object.prototype.hasOwnProperty.call(response, tag)) {
    throw new NiriIpcError("unexpected-response", `niri response omitted ${tag}`);
  }
  return response[tag];
}

class NiriIpcClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath;
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    this.lineLimit = Number.isFinite(options.lineLimit)
      ? Math.max(256, options.lineLimit)
      : DEFAULT_LINE_LIMIT;
    this.createConnection = options.createConnection || ((socketPath) => net.createConnection(socketPath));

    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.pending = null;
    this.connectPromise = null;
    this.closed = false;
    this.poisoned = false;
  }

  request(payload) {
    if (this.closed) {
      return Promise.reject(new NiriIpcError("closed", "niri IPC client is closed"));
    }
    if (this.poisoned) {
      return Promise.reject(new NiriIpcError("poisoned", "niri IPC client is poisoned", { poisoned: true }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this._pump();
    });
  }

  version() {
    return this.request("Version").then((response) => {
      const value = decodeTaggedResponse(response, "Version");
      if (typeof value !== "string") {
        throw new NiriIpcError("unexpected-response", "niri Version response was not a string");
      }
      return value;
    });
  }

  windows() {
    return this.request("Windows").then((response) => {
      const value = decodeTaggedResponse(response, "Windows");
      if (!Array.isArray(value)) {
        throw new NiriIpcError("unexpected-response", "niri Windows response was not an array");
      }
      return value;
    });
  }

  screenshotWindow(options = {}) {
    const id = options.id;
    const filePath = options.path;
    if (!Number.isSafeInteger(id) || id < 0) {
      return Promise.reject(new NiriIpcError("invalid-request", "ScreenshotWindow requires a safe window id"));
    }
    if (typeof filePath !== "string" || !filePath.startsWith("/")) {
      return Promise.reject(new NiriIpcError("invalid-request", "ScreenshotWindow requires an absolute path"));
    }
    return this.request({
      Action: {
        ScreenshotWindow: {
          id,
          write_to_disk: true,
          show_pointer: false,
          path: filePath,
        },
      },
    }).then((response) => {
      if (response !== "Handled") {
        throw new NiriIpcError("unexpected-response", "niri ScreenshotWindow was not Handled");
      }
      return true;
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new NiriIpcError("closed", "niri IPC client closed");
    this._rejectAll(error);
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
    }
    this.socket = null;
    this.connected = false;
  }

  _connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.socket && this.connected) return Promise.resolve();
    this.connectPromise = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = this.createConnection(this.socketPath);
      } catch (err) {
        reject(new NiriIpcError("connect", `could not connect to niri: ${err && err.message ? err.message : err}`));
        return;
      }
      this.socket = socket;
      let settled = false;
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanupConnectListeners();
        this.connected = true;
        this._wireSocket(socket);
        resolve();
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanupConnectListeners();
        this.socket = null;
        this.connected = false;
        reject(new NiriIpcError("connect", `could not connect to niri: ${err && err.message ? err.message : err}`));
      };
      const cleanupConnectListeners = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  _wireSocket(socket) {
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => this._poison("socket-error", err && err.message ? err.message : "niri socket error"));
    socket.on("end", () => this._poison("eof", "niri socket closed"));
    socket.on("close", () => {
      if (!this.closed && !this.poisoned) this._poison("eof", "niri socket closed");
    });
  }

  _pump() {
    if (this.pending || this.closed || this.poisoned || this.queue.length === 0) return;
    this._connect().then(() => {
      if (this.pending || this.closed || this.poisoned || this.queue.length === 0) return;
      const item = this.queue.shift();
      let encoded;
      try {
        encoded = `${JSON.stringify(item.payload)}\n`;
      } catch (err) {
        item.reject(new NiriIpcError("invalid-request", err && err.message ? err.message : "request is not serializable"));
        this._pump();
        return;
      }
      const timer = setTimeout(() => {
        this._poison("timeout", "niri IPC request timed out");
      }, this.timeoutMs);
      this.pending = { ...item, timer };
      try {
        this.socket.write(encoded, (err) => {
          if (err) this._poison("write", err.message || "niri IPC write failed");
        });
      } catch (err) {
        this._poison("write", err && err.message ? err.message : "niri IPC write failed");
      }
    }).catch((err) => {
      const item = this.queue.shift();
      if (item) item.reject(err);
      this._pump();
    });
  }

  _onData(chunk) {
    if (this.poisoned || this.closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, incoming]);
    if (this.buffer.length > this.lineLimit && this.buffer.indexOf(0x0A) < 0) {
      this._poison("oversize", "niri IPC reply exceeded the line limit");
      return;
    }
    while (!this.poisoned) {
      const newline = this.buffer.indexOf(0x0A);
      if (newline < 0) break;
      if (newline > this.lineLimit) {
        this._poison("oversize", "niri IPC reply exceeded the line limit");
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) {
        this._poison("invalid-reply", "niri IPC returned an empty line");
        return;
      }
      if (!this.pending) {
        this._poison("desync", "niri IPC returned an unsolicited reply");
        return;
      }
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      try {
        pending.resolve(decodeReply(line));
      } catch (err) {
        pending.reject(err);
        if (err && err.poisoned) {
          this._poison(err.code || "invalid-reply", err.message, { rejectPending: false });
          return;
        }
      }
      this._pump();
    }
    if (
      !this.poisoned
      && this.buffer.length > this.lineLimit
      && this.buffer.indexOf(0x0A) < 0
    ) {
      this._poison("oversize", "niri IPC reply exceeded the line limit");
    }
  }

  _poison(code, message, options = {}) {
    if (this.poisoned || this.closed) return;
    this.poisoned = true;
    const error = new NiriIpcError(code, message, { poisoned: true });
    if (options.rejectPending !== false && this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    while (this.queue.length) this.queue.shift().reject(error);
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
    }
    this.socket = null;
    this.connected = false;
  }

  _rejectAll(error) {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    while (this.queue.length) this.queue.shift().reject(error);
  }
}

function createNiriIpcClient(options) {
  return new NiriIpcClient(options);
}

module.exports = {
  NiriIpcClient,
  NiriIpcError,
  createNiriIpcClient,
  decodeReply,
};
