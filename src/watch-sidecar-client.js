"use strict";

const childProcess = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");

function splitLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  return { lines: lines.slice(0, -1), rest: lines[lines.length - 1] || "" };
}

class WatchSidecarClient {
  constructor(options = {}) {
    this.command = options.command || "python3";
    this.args = options.args || [];
    this.spawnOptions = options.spawnOptions || {};
    this.log = options.log || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onDevices = options.onDevices || (() => {});
    this.onError = options.onError || (() => {});
    this.onTransportStateChanged = options.onTransportStateChanged || (() => {});
    this.onApprovalResponse = options.onApprovalResponse || (() => {});

    this.proc = null;
    this.started = false;
    this._stopping = false;
    this._stdoutBuf = "";
    this._stderrBuf = "";

    this.transport = {
      connected: false,
      secure: false,
      send: (payload) => {
        if (payload && payload.type === "approval_request") {
          this._writeStdin(payload);
        } else {
          this._writeStdin({ type: "snapshot", payload });
        }
      },
    };
  }

  start() {
    if (this.started) return;
    if (this.proc) {
      try { this.proc.kill("SIGKILL"); } catch (_) {}
      this.proc = null;
    }
    const env = { ...process.env, PYTHONIOENCODING: "utf-8:replace", ...(this.spawnOptions.env || {}) };
    this.proc = childProcess.spawn(this.command, this.args, {
      ...this.spawnOptions,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.started = true;
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stderr.setEncoding("utf-8");

    this.proc.stdout.on("data", (chunk) => {
      this._stdoutBuf += chunk;
      const { lines, rest } = splitLines(this._stdoutBuf);
      this._stdoutBuf = rest;
      for (const line of lines) this._handleLine(line);
    });

    this.proc.stderr.on("data", (chunk) => {
      this._stderrBuf += chunk;
      const { lines, rest } = splitLines(this._stderrBuf);
      this._stderrBuf = rest;
      for (const line of lines) this.log("warn", `bridge stderr: ${line}`);
    });

    this.proc.on("exit", (code, signal) => {
      if (this._stopping) { this._stopping = false; return; }
      this.started = false;
      const wasConnected = this.transport.connected;
      this.transport.connected = false;
      this.transport.secure = false;
      this.log("info", `sidecar exited code=${code} signal=${signal}`);
      this.onTransportStateChanged({ connected: false, previous: { connected: wasConnected } });
    });

    this.proc.on("error", (err) => {
      if (this._stopping) return;
      this.started = false;
      this.onError(err);
    });
  }

  stop() {
    if (!this.proc) return;
    this._stopping = true;
    this._writeStdin({ type: "stop" });
    try { this.proc.kill("SIGTERM"); } catch (_) {}
    this.proc = null;
    this.started = false;
    this.transport.connected = false;
    this.transport.secure = false;
  }

  connect(target) {
    const address = typeof target === "string" ? target : (target && target.address) || "";
    if (address) this._writeStdin({ type: "connect", address });
  }

  scan() {
    this._writeStdin({ type: "scan" });
  }

  _writeStdin(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
    } catch (_) {}
  }

  _handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    const type = msg.type || "";

    if (type === "status") {
      const wasConnected = this.transport.connected;
      this.transport.connected = !!msg.connected;
      this.transport.secure = !!msg.connected;
      this.onStatus(msg);
      if (wasConnected !== this.transport.connected) {
        this.onTransportStateChanged({
          connected: this.transport.connected,
          secure: this.transport.secure,
          previous: { connected: wasConnected },
        });
      }
    } else if (type === "devices") {
      this.onDevices(msg.items || []);
    } else if (type === "approval_response") {
      this.onApprovalResponse(msg);
    } else if (type === "error") {
      this.onError({ code: msg.code || "SIDECAR_ERROR", message: msg.message || "" });
    }
  }
}

module.exports = { WatchSidecarClient };
