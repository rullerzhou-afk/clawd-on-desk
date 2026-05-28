"use strict";

// Telegram bot token storage abstraction.
//
// Plan §298-304 invariant: the Clawd source must NEVER read the bot-token
// environment variable from the host process. The token lives only at
// `userData/telegram-approval.env` (the same file the Go sidecar reads through
// CLAWD_TG_BOT_TOKEN_FILE). This module exposes a TelegramTokenStore interface
// so that callers (native client, sidecar bootstrap) take the store as a
// dependency rather than touching the env file directly.
//
// Spike scope: only `envFileTokenStore` is implemented. Tests can use any
// object matching the interface.

const fsDefault = require("fs");
const pathDefault = require("path");
const { writeTokenEnvFile } = require("./telegram-approval-settings");

const TOKEN_LINE_RE = /^\s*CLAWD_TG_BOT_TOKEN\s*=\s*(.+?)\s*$/m;
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

function isValidToken(value) {
  return typeof value === "string" && BOT_TOKEN_RE.test(value);
}

function parseTokenFromEnvFileText(text) {
  if (typeof text !== "string" || !text) return null;
  const match = text.match(TOKEN_LINE_RE);
  if (!match) return null;
  const token = match[1].trim();
  return isValidToken(token) ? token : null;
}

function buildEnvFileText(token) {
  return `CLAWD_TG_BOT_TOKEN=${token}\n`;
}

// Factory: returns a store backed by the env file at `filePath`.
// Caller (typically the Electron main process) passes the resolved absolute
// path and may inject `fs` for testing.
function envFileTokenStore({
  filePath,
  fs = fsDefault,
  path: pathModule = pathDefault,
  platform = process.platform,
} = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new TypeError("envFileTokenStore: filePath is required");
  }
  if (!fs || typeof fs.readFileSync !== "function") {
    throw new TypeError("envFileTokenStore: fs must implement readFileSync");
  }

  function readText() {
    try {
      return String(fs.readFileSync(filePath, { encoding: "utf8" }) || "");
    } catch {
      return "";
    }
  }

  return {
    kind: "envFile",
    filePath,

    async getToken() {
      return parseTokenFromEnvFileText(readText());
    },

    async hasToken() {
      return parseTokenFromEnvFileText(readText()) !== null;
    },

    async writeToken(token) {
      if (!isValidToken(token)) {
        throw new Error("envFileTokenStore: refusing to write invalid bot token");
      }
      // Delegate to the existing temp+rename atomic writer in
      // telegram-approval-settings — that path already covers Windows
      // (mode is best-effort POSIX, ACL inherits from userData) and POSIX
      // chmod 0600. Reusing it avoids a half-written env file on crash.
      const result = writeTokenEnvFile({
        fs,
        path: pathModule,
        filePath,
        token,
        platform,
      });
      if (!result || result.status !== "ok") {
        throw new Error(
          `envFileTokenStore: writeTokenEnvFile failed (${result && result.message ? result.message : "unknown"})`,
        );
      }
    },

    async deleteToken() {
      if (typeof fs.unlinkSync !== "function") return;
      try {
        fs.unlinkSync(filePath);
      } catch {
        // missing file is fine; other errors silently ignored at spike scope.
      }
    },
  };
}

module.exports = {
  envFileTokenStore,
  parseTokenFromEnvFileText,
  buildEnvFileText,
  isValidToken,
};
