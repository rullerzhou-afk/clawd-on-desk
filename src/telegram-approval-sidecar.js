"use strict";

const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { TelegramApprovalClient } = require("./telegram-approval-client");

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_STOP_GRACE_MS = 2000;
const DEFAULT_RESTART_WINDOW_MS = 60000;
const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_BACKOFF_MS = 1000;
const MAX_HANDSHAKE_BUFFER = 8192;
const SIDECAR_ENV_CONFIG = "CLAWD_BRIDGE_CONFIG";
const SIDECAR_ENV_TOKEN_FILE = "CLAWD_TG_BOT_TOKEN_FILE";
const SIDECAR_PATH_ENV = "CLAWD_CC_CONNECT_CLAWD_PATH";
const SIDECAR_BINARY_BASENAME = "cc-connect-clawd";
const SIDECAR_RESOURCE_ROOT = path.join("sidecars", "cc-connect-clawd");
const DEV_FETCH_TARGETS = new Set(["windows-x64", "windows-arm64", "darwin-x64", "darwin-arm64", "linux-x64"]);
// Note: the sidecar reads the token from the env-file at SIDECAR_ENV_TOKEN_FILE
// (which itself contains a line like `CLAWD_TG_BOT_TOKEN=<token>`). Clawd's
// main process MUST NOT pipe a token into the child env directly — that path
// was removed so the token can only live on disk at the userData env-file.

const WINDOWS_ENV_ALLOWLIST = [
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
];

const POSIX_ENV_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TMPDIR",
];

function redactText(text, secrets = []) {
  let out = String(text == null ? "" : text);
  for (const secret of secrets) {
    const value = String(secret == null ? "" : secret).trim();
    if (value) out = out.split(value).join("<redacted>");
  }
  out = out.replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, "<redacted:telegram-token>");
  out = out.replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, "<redacted:token>");
  out = out.replace(/\b(?:telegram:)?-?\d{7,}(?::\d+){0,2}\b/g, "<redacted:id>");
  return out;
}

function summarizeError(err) {
  if (!err) return "";
  return err.message ? String(err.message) : String(err);
}

function parseHandshakeLine(line) {
  const text = String(line || "").trim();
  const match = text.match(/^SIDECAR_LISTEN=(127\.0\.0\.1:(\d{1,5}))\s+SIDECAR_TOKEN=([a-f0-9]{32,128})$/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    listen: match[1],
    token: match[3],
  };
}

function splitLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  return {
    lines: lines.slice(0, -1),
    rest: lines[lines.length - 1] || "",
  };
}

function buildSidecarEnv(options = {}) {
  const baseEnv = options.baseEnv || process.env;
  const platform = options.platform || process.platform;
  const allowlist = platform === "win32" ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  const env = {};
  for (const key of allowlist) {
    if (baseEnv[key] != null && baseEnv[key] !== "") env[key] = String(baseEnv[key]);
  }
  if (options.configPath) env[SIDECAR_ENV_CONFIG] = String(options.configPath);
  if (options.tokenEnvFilePath) env[SIDECAR_ENV_TOKEN_FILE] = String(options.tokenEnvFilePath);
  return env;
}

function sidecarExecutableName(platform = process.platform) {
  return platform === "win32" ? `${SIDECAR_BINARY_BASENAME}.exe` : SIDECAR_BINARY_BASENAME;
}

function sidecarPlatformName(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return String(platform || "").trim() || "unknown";
}

function sidecarArchName(arch = process.arch) {
  return String(arch || "").trim() || "unknown";
}

function sidecarPlatformArchDir(options = {}) {
  return `${sidecarPlatformName(options.platform)}-${sidecarArchName(options.arch)}`;
}

function sidecarResourceRelativePath(options = {}) {
  return path.join(
    SIDECAR_RESOURCE_ROOT,
    sidecarPlatformArchDir(options),
    sidecarExecutableName(options.platform)
  );
}

function devSidecarFetchHint(options = {}) {
  const target = sidecarPlatformArchDir(options);
  if (DEV_FETCH_TARGETS.has(target)) {
    return `For source checkouts, run: npm run fetch:sidecars -- --target ${target}`;
  }
  return `No pinned Telegram approval sidecar is available for ${target}; set ${SIDECAR_PATH_ENV} to a compatible sidecar executable.`;
}

function resolveOverrideBinaryPath(rawValue, options = {}) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  const platform = options.platform || process.platform;
  const fsModule = options.fs || fs;
  try {
    if (fsModule && typeof fsModule.statSync === "function") {
      const stat = fsModule.statSync(value);
      if (stat && typeof stat.isDirectory === "function" && stat.isDirectory()) {
        return path.join(value, sidecarExecutableName(platform));
      }
    }
  } catch {
    // Fall through to treating the override as an executable path.
  }
  if (/[\\/]$/.test(value)) return path.join(value, sidecarExecutableName(platform));
  return value;
}

function resolveSidecarBinary(options = {}) {
  if (options.binaryPath) {
    return { path: options.binaryPath, source: "explicit" };
  }
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (env[SIDECAR_PATH_ENV]) {
    return {
      path: resolveOverrideBinaryPath(env[SIDECAR_PATH_ENV], { platform, fs: options.fs }),
      source: "env",
    };
  }

  const resourceRoot = options.resourcesPath || (options.isPackaged ? process.resourcesPath : "");
  if (resourceRoot && options.isPackaged === true) {
    return {
      path: path.join(resourceRoot, sidecarResourceRelativePath({ platform, arch })),
      source: "packaged",
    };
  }

  return {
    path: path.join(__dirname, "..", "bin", "cc-connect-clawd", sidecarPlatformArchDir({ platform, arch }), sidecarExecutableName(platform)),
    source: "dev",
  };
}

function resolveSidecarBinaryPath(options = {}) {
  return resolveSidecarBinary(options).path;
}

function defaultConfigPath(userDataDir) {
  return userDataDir ? path.join(userDataDir, "cc-connect-clawd", "clawd-bridge.toml") : "";
}

function defaultTokenEnvFilePath(userDataDir) {
  return userDataDir ? path.join(userDataDir, "telegram-approval.env") : "";
}

class TelegramApprovalSidecar extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn || childProcess.spawn;
    this.fs = options.fs || fs;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.now = options.now || (() => Date.now());
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.baseEnv = options.baseEnv || process.env;
    this.startupTimeoutMs = options.startupTimeoutMs == null ? DEFAULT_STARTUP_TIMEOUT_MS : Number(options.startupTimeoutMs);
    this.stopGraceMs = options.stopGraceMs == null ? DEFAULT_STOP_GRACE_MS : Number(options.stopGraceMs);
    this.restartWindowMs = options.restartWindowMs == null ? DEFAULT_RESTART_WINDOW_MS : Number(options.restartWindowMs);
    this.restartLimit = options.restartLimit == null ? DEFAULT_RESTART_LIMIT : Number(options.restartLimit);
    this.restartBackoffMs = options.restartBackoffMs == null ? DEFAULT_RESTART_BACKOFF_MS : Number(options.restartBackoffMs);
    this.autoRestart = options.autoRestart !== false;
    this.httpRequest = options.httpRequest;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.redactionSecrets = Array.isArray(options.redactionSecrets) ? options.redactionSecrets.slice() : [];
    const binary = resolveSidecarBinary({
      binaryPath: options.binaryPath,
      env: options.env || this.baseEnv,
      platform: this.platform,
      arch: this.arch,
      resourcesPath: options.resourcesPath,
      isPackaged: options.isPackaged,
      fs: this.fs,
    });
    this.binaryPath = binary.path;
    this.binaryPathSource = binary.source;
    this.skipBinaryExistsCheck = options.skipBinaryExistsCheck === true || binary.source === "explicit";
    const userDataDir = options.userDataDir || "";
    this.configPath = options.configPath || defaultConfigPath(userDataDir);
    this.tokenEnvFilePath = options.tokenEnvFilePath || defaultTokenEnvFilePath(userDataDir);
    this.status = { status: "stopped" };
    this.child = null;
    this.client = null;
    this.startPromise = null;
    this.startupTimer = null;
    this.restartTimer = null;
    this.stopTimer = null;
    this.restartAttempts = [];
    this.requestedStop = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.readySettled = false;
  }

  getStatus() {
    return { ...this.status, binaryPathSource: this.binaryPathSource };
  }

  isRunning() {
    return this.status.status === "running" && !!this.client;
  }

  getClient() {
    return this.client;
  }

  requestApproval(payload, options = {}) {
    if (!this.client) return Promise.resolve(null);
    return this.client.requestApproval(payload, options);
  }

  start() {
    if (this.client && this.status.status === "running") return Promise.resolve(this.client);
    if (this.startPromise) return this.startPromise;
    const binaryError = this._getBinaryAvailabilityError();
    if (binaryError) {
      const message = this._redact(binaryError);
      this._setStatus({ status: "failed", message });
      return Promise.reject(new Error(message));
    }
    this.requestedStop = false;
    this._clearRestartTimer();
    this._setStatus({ status: "starting" });

    this.startPromise = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.binaryPath, this._buildArgs(), {
          env: this._buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        this.startPromise = null;
        const message = `spawn failed: ${summarizeError(err)}`;
        this._setStatus({ status: "failed", message: this._redact(message) });
        reject(new Error(this._redact(message)));
        return;
      }

      this.child = child;
      this.client = null;
      this.readySettled = false;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";

      const failStartup = (err) => {
        if (this.readySettled) return;
        this.readySettled = true;
        this._clearStartupTimer();
        this.startPromise = null;
        const message = this._redact(summarizeError(err) || "sidecar startup failed");
        this._setStatus({ status: "failed", message });
        this._killChild(child, "SIGTERM");
        reject(new Error(message));
      };

      const finishReady = (handshake) => {
        if (this.readySettled) return;
        this.readySettled = true;
        this._clearStartupTimer();
        this.client = new TelegramApprovalClient(handshake, {
          httpRequest: this.httpRequest,
          requestTimeoutMs: this.requestTimeoutMs,
        });
        this.startPromise = null;
        this._setStatus({ status: "running", listen: handshake.listen });
        resolve(this.client);
      };

      this.startupTimer = this.setTimer(() => {
        failStartup(new Error("sidecar startup timed out waiting for handshake"));
      }, Math.max(1, this.startupTimeoutMs));

      if (child.stdout) {
        if (typeof child.stdout.setEncoding === "function") child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          this._handleStdout(chunk, finishReady, failStartup);
        });
      }
      if (child.stderr) {
        if (typeof child.stderr.setEncoding === "function") child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          this._handleStderr(chunk);
        });
      }
      child.on("error", failStartup);
      child.on("exit", (code, signal) => {
        this._handleExit(child, code, signal, failStartup);
      });
    });
    return this.startPromise;
  }

  stop() {
    this.requestedStop = true;
    this._clearRestartTimer();
    this._clearStartupTimer();
    const child = this.child;
    this.startPromise = null;
    this.client = null;
    if (!child) {
      this._setStatus({ status: "stopped" });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._clearStopTimer();
        if (this.child === child) this.child = null;
        this._setStatus({ status: "stopped" });
        resolve();
      };
      child.once("exit", finish);
      // On Windows, Node maps SIGTERM to TerminateProcess for child processes,
      // so the Go sidecar may not run its graceful signal handler there. The
      // grace window mainly covers POSIX and console-driven Windows exits; a
      // hard kill is still safe because pending approvals are in-memory.
      this._killChild(child, "SIGTERM");
      this.stopTimer = this.setTimer(() => {
        this._killChild(child, "SIGKILL");
        finish();
      }, Math.max(1, this.stopGraceMs));
    });
  }

  cleanup() {
    return this.stop();
  }

  _buildArgs() {
    const args = [];
    if (this.configPath) args.push("--config", this.configPath);
    if (this.tokenEnvFilePath) args.push("--env-file", this.tokenEnvFilePath);
    return args;
  }

  _buildEnv() {
    return buildSidecarEnv({
      baseEnv: this.baseEnv,
      platform: this.platform,
      configPath: this.configPath,
      tokenEnvFilePath: this.tokenEnvFilePath,
    });
  }

  _getBinaryAvailabilityError() {
    if (this.skipBinaryExistsCheck) return "";
    if (!this.binaryPath) return "telegram approval sidecar binary path is empty";
    if (!this.fs || typeof this.fs.existsSync !== "function") {
      return "telegram approval sidecar binary availability check is unavailable";
    }
    try {
      if (this.fs.existsSync(this.binaryPath)) return "";
    } catch {}
    const message = `telegram approval sidecar binary not found: ${this.binaryPath}`;
    if (this.binaryPathSource === "dev") {
      return `${message}. ${devSidecarFetchHint({ platform: this.platform, arch: this.arch })}`;
    }
    return message;
  }

  _handleStdout(chunk, finishReady, failStartup) {
    if (this.readySettled) return;
    this.stdoutBuffer += String(chunk || "");
    if (this.stdoutBuffer.length > MAX_HANDSHAKE_BUFFER) {
      failStartup(new Error("sidecar handshake output exceeded limit"));
      return;
    }
    const split = splitLines(this.stdoutBuffer);
    this.stdoutBuffer = split.rest;
    for (const line of split.lines) {
      const handshake = parseHandshakeLine(line);
      if (handshake) {
        finishReady(handshake);
        return;
      }
    }
  }

  // Line-buffer stderr before redacting. Node hands us arbitrary TCP chunks,
  // so a token like "123:ABC...xyz" can be split mid-string — chunk-level
  // regex/secret replacement would then leak half the token to the log. We
  // hold the trailing partial line in stderrBuffer until the next newline (or
  // exit, see _flushStderr) and only redact on complete lines.
  _handleStderr(chunk) {
    this.stderrBuffer += String(chunk || "");
    // Cap the buffer so a sidecar emitting megabytes of unterminated output
    // can't blow up Clawd memory. Once the cap trips we flush what we have as
    // a single (redacted) line — better to log a slightly-truncated message
    // than to retain unbounded raw bytes that might contain a half-token.
    if (this.stderrBuffer.length > MAX_HANDSHAKE_BUFFER) {
      const flushed = this.stderrBuffer;
      this.stderrBuffer = "";
      this._logStderrLine(flushed);
      return;
    }
    const split = splitLines(this.stderrBuffer);
    this.stderrBuffer = split.rest;
    for (const line of split.lines) {
      this._logStderrLine(line);
    }
  }

  _logStderrLine(line) {
    const text = this._redact(line);
    if (text.trim()) this.log("debug", "telegram approval sidecar stderr", { text });
  }

  _flushStderr() {
    if (!this.stderrBuffer) return;
    const remaining = this.stderrBuffer;
    this.stderrBuffer = "";
    this._logStderrLine(remaining);
  }

  _handleExit(child, code, signal, failStartup) {
    if (this.child === child) this.child = null;
    this._clearStartupTimer();
    this._clearStopTimer();
    // Drain any trailing partial line so a sidecar that crashed without a
    // final newline still gets redacted-and-logged.
    this._flushStderr();
    const wasReady = this.readySettled && this.client;
    if (!this.readySettled) {
      failStartup(new Error(`sidecar exited before handshake (${formatExit(code, signal)})`));
      return;
    }
    this.client = null;
    this.startPromise = null;
    if (this.requestedStop) {
      this._setStatus({ status: "stopped" });
      return;
    }
    const message = `sidecar exited (${formatExit(code, signal)})`;
    this._setStatus({ status: "failed", message });
    if (wasReady && this.autoRestart) this._scheduleRestart();
  }

  _scheduleRestart() {
    const now = this.now();
    this.restartAttempts = this.restartAttempts.filter((ts) => now - ts < this.restartWindowMs);
    if (this.restartAttempts.length >= this.restartLimit) {
      this._setStatus({ status: "failed", message: "sidecar restart rate limit reached" });
      return;
    }
    this.restartAttempts.push(now);
    this._clearRestartTimer();
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.start().catch((err) => {
        this.log("warn", "telegram approval sidecar restart failed", { error: this._redact(summarizeError(err)) });
      });
    }, Math.max(1, this.restartBackoffMs));
  }

  _killChild(child, signal) {
    if (!child || typeof child.kill !== "function" || child.killed) return;
    try {
      child.kill(signal);
    } catch {
      // Ignore process teardown races.
    }
  }

  _setStatus(status) {
    this.status = { ...status };
    this.emit("status-changed", this.getStatus());
  }

  _clearStartupTimer() {
    if (this.startupTimer) this.clearTimer(this.startupTimer);
    this.startupTimer = null;
  }

  _clearRestartTimer() {
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  _clearStopTimer() {
    if (this.stopTimer) this.clearTimer(this.stopTimer);
    this.stopTimer = null;
  }

  _redact(text) {
    const secrets = this.redactionSecrets.slice();
    if (this.configPath) secrets.push(this.configPath);
    if (this.tokenEnvFilePath) secrets.push(this.tokenEnvFilePath);
    return redactText(text, secrets);
  }
}

function formatExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `code ${code == null ? "unknown" : code}`;
}

function createTelegramApprovalSidecar(options = {}) {
  return new TelegramApprovalSidecar(options);
}

module.exports = {
  TelegramApprovalSidecar,
  createTelegramApprovalSidecar,
  parseHandshakeLine,
  buildSidecarEnv,
  resolveSidecarBinary,
  resolveSidecarBinaryPath,
  resolveOverrideBinaryPath,
  sidecarExecutableName,
  sidecarPlatformName,
  sidecarArchName,
  sidecarPlatformArchDir,
  sidecarResourceRelativePath,
  devSidecarFetchHint,
  defaultConfigPath,
  defaultTokenEnvFilePath,
  redactText,
  SIDECAR_ENV_CONFIG,
  SIDECAR_ENV_TOKEN_FILE,
  SIDECAR_PATH_ENV,
  SIDECAR_RESOURCE_ROOT,
};
