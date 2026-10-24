"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { spawn } = require("child_process");
const { identifier } = require("./library-catalog.cjs");
function protocolFor(items, start = 0) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 15000 ||
    !Number.isInteger(start) ||
    start < 0 ||
    start >= items.length
  )
    throw Error("播放队列无效");
  const ordered = [...items.slice(start), ...items.slice(0, start)];
  for (const item of ordered) {
    identifier(item.id);
    if (!Number.isInteger(item.type) || item.type < 0 || item.type > 255)
      throw Error("歌曲类型无效，请刷新歌单");
  }
  // Same playsong protocol emitted by QQ Music's own y.qq.com player.
  return (
    "version==1173&&from==y.qq.com&&cmd_count==1&&cmd_0==playsong&&id_0==" +
    ordered.map((v) => v.id).join("|") +
    "&&songtype_0==" +
    ordered.map((v) => v.type).join("|") +
    "&&info_0==&&quality_0==0"
  );
}
function createPlayer({
  executable,
  storageRoot,
  helperPath,
  spawnProcess = spawn,
}) {
  executable = path.resolve(executable);
  let busy = false,
    disposed = false,
    guardChild = null;
  let guard = null,
    guardAt = 0;
  function quiet() {
    if (disposed)
      return Promise.reject(Error("QQ Music integration is disabled"));
    if (!helperPath) return Promise.resolve();
    if (guard && Date.now() - guardAt < 1000) return guard;
    guardAt = Date.now();
    guard = new Promise((resolve, reject) => {
      const child = spawnProcess(helperPath, ["quiet-guard"], {
        windowsHide: true,
        env: { ...process.env, CLAWD_QQMUSIC_EXECUTABLE: executable },
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        cwd: path.dirname(helperPath),
      });
      guardChild = child;
      let buffer = "",
        ready = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("后台切歌保护未就绪，请重试"));
      }, 1800);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (!ready && buffer.includes("READY")) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        guard = null;
        if (guardChild === child) guardChild = null;
        if (!ready) reject(Error("后台切歌保护未就绪，请重试"));
      });
    });
    return guard;
  }
  async function dispatch(args) {
    await quiet();
    if (disposed) throw Error("QQ Music integration is disabled");
    return new Promise((resolve, reject) => {
      const child = spawnProcess(executable, ["/silent", ...args], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
        cwd: path.dirname(executable),
      });
      const timer = setTimeout(
        () => reject(Error("播放命令已发出，请先查看当前歌曲再重试")),
        8000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(Error("QQ 音乐未接受播放请求，请稍后重试"));
      });
    });
  }
  return {
    dispose() {
      disposed = true;
      guardChild?.kill();
      guardChild = null;
    },
    async play(items, start = 0) {
      if (disposed) throw Error("QQ Music integration is disabled");
      const protocol = protocolFor(items, start);
      if (busy) throw Error("正在切换歌曲，请稍候");
      busy = true;
      try {
        const root = path.join(storageRoot, "music-commands");
        fs.mkdirSync(root, { recursive: true });
        const file = path.join(
          root,
          crypto.createHash("sha256").update(protocol).digest("hex") + ".txt",
        );
        // The native file entry point avoids the Windows argument length limit
        // for personal playlists containing thousands of songs.
        // QQ Music reads this entry point as raw WCHAR data, without a BOM.
        fs.writeFileSync(file, protocol, "utf16le");
        await dispatch(["/tencentprotocolfile", file]);
        return {
          dispatched: true,
          ordered: [...items.slice(start), ...items.slice(0, start)],
        };
      } finally {
        busy = false;
      }
    },
    async select(item) {
      if (disposed) throw Error("QQ Music integration is disabled");
      identifier(item?.id);
      if (!Number.isInteger(item.type) || item.type < 0 || item.type > 255)
        throw Error("歌曲类型无效，请刷新歌单");
      if (busy) throw Error("正在切换歌曲，请稍候");
      busy = true;
      try {
        await dispatch([
          "/playbysongid",
          "cmd_count==1&&id_0==" + item.id + "&&songtype_0==" + item.type,
        ]);
        return { dispatched: true };
      } finally {
        busy = false;
      }
    },
  };
}
module.exports = { createPlayer, protocolFor };
