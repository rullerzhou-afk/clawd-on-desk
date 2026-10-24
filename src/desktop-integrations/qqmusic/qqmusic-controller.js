"use strict";
const { spawn } = require("child_process");
const readline = require("readline");
const ACTIONS = new Set([
  "status",
  "toggle",
  "play",
  "pause",
  "next",
  "previous",
  "seek",
  "set-volume",
  "volume-up",
  "volume-down",
  "mute",
]);
function validateCommand(action, value) {
  if (!ACTIONS.has(action)) throw Error("不支持的音乐操作");
  if (
    action === "set-volume" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100)
  )
    throw Error("音量必须在 0–100 之间");
  if (
    action === "seek" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 86400)
  )
    throw Error("播放进度必须是有效的秒数");
  return {
    action,
    ...(["set-volume", "seek"].includes(action) ? { value } : {}),
  };
}
class QQMusicController {
  constructor({ helperPath, spawnProcess = spawn, timeoutMs = 12000 }) {
    this.helperPath = helperPath;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
  }
  start() {
    if (this.worker) return;
    const worker = this.spawnProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.helperPath,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.worker = worker;
    let diagnostics = "";
    const lines = readline.createInterface({ input: worker.stdout });
    worker.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-1500);
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(message.id);
      if (message.ok === true) task.resolve(message.state);
      else task.reject(Error(message.error || "QQ 音乐控制失败"));
    });
    const failed = (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      lines.close();
      for (const task of this.pending.values()) {
        clearTimeout(task.timer);
        task.reject(
          Error(error?.message || diagnostics || "音乐服务已退出，请重试"),
        );
      }
      this.pending.clear();
    };
    worker.on("error", failed);
    worker.on("exit", () => failed());
    worker.stdin.on("error", failed);
  }
  request(action, value) {
    let command;
    try {
      command = validateCommand(action, value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pending.size >= 8)
      return Promise.reject(Error("音乐操作过于频繁，请稍后重试"));
    return new Promise((resolve, reject) => {
      this.start();
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.stop("QQ 音乐响应超时，请重试"),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.worker.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    });
  }
  stop(reason = "音乐服务已关闭") {
    const worker = this.worker;
    this.worker = null;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(Error(reason));
    }
    this.pending.clear();
    if (worker) {
      worker.stdin.end();
      worker.kill();
    }
  }
}
module.exports = { QQMusicController, validateCommand };
