"use strict";
const cp = require("child_process"),
  path = require("path");
module.exports = function createLyrics({
  helperRoot,
  executable,
  execFile = cp.execFile,
}) {
  let busy = false,
    disposed = false,
    child = null;
  async function request(action, value) {
    if (disposed) throw Error("QQ Music integration is disabled");
    if (!["lyrics-status", "set-lyrics"].includes(action))
      throw Error("不支持的歌词操作");
    if (action === "set-lyrics" && typeof value !== "boolean")
      throw Error("请选择显示或隐藏桌面歌词");
    if (busy) throw Error("正在读取歌词状态，请稍候");
    busy = true;
    try {
      return await new Promise((resolve, reject) => {
        child = execFile(
          path.join(helperRoot, "desktop-lyrics.exe"),
          [action === "lyrics-status" ? "status" : value ? "show" : "hide"],
          {
            windowsHide: true,
            env: { ...process.env, CLAWD_QQMUSIC_EXECUTABLE: executable },
            timeout: 6500,
            encoding: "utf8",
            maxBuffer: 16384,
          },
          (error, stdout) => {
            child = null;
            if (error)
              return reject(Error("歌词控制暂时不可用，请打开QQ音乐后重试"));
            try {
              const state = JSON.parse(stdout.trim());
              if (state.ok !== true || typeof state.visible !== "boolean")
                throw Error(state.error || "无法确认歌词状态");
              resolve(state);
            } catch (error) {
              reject(error);
            }
          },
        );
      });
    } finally {
      busy = false;
    }
  }
  return {
    request,
    dispose() {
      disposed = true;
      child?.kill();
      child = null;
    },
  };
};
