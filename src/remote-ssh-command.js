"use strict";

const { Buffer } = require("node:buffer");

const MULTILINE_RX = /[\r\n]/;
// 125 distinguishes decoder failure from the remote script's ordinary errors.
const REMOTE_COMMAND_DECODE_EXIT = 125;
const WINDOWS_COMMAND_LENGTH_LIMIT = 32000;
const ENCODED_COMMAND_RX = /^sh -c 'd=([A-Za-z0-9+/=]+); for o in -d -D --decode;/;

// Audited gateways may reject literal newlines in SSH's remote command. The
// outer single quotes also work with login shells that do not understand $().
function encodeMultilineShellCommand(command) {
  if (typeof command !== "string") {
    throw new TypeError("encodeMultilineShellCommand: command must be a string");
  }
  if (!MULTILINE_RX.test(command)) return command;
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `sh -c 'd=${encoded}; for o in -d -D --decode; do s=$(printf %s "$d" | base64 $o 2>/dev/null) && [ -n "$s" ] && exec sh -c "$s"; done; echo "Clawd: cannot decode remote command (base64 -d/-D/--decode)" >&2; exit ${REMOTE_COMMAND_DECODE_EXIT}'`;
}

// buildSshArgs puts the destination before the remote command, so only the
// final argument may be wrapped; earlier SSH options must stay untouched.
function encodeSshCommandArguments(tool, args) {
  if (tool !== "ssh" || !Array.isArray(args) || args.length === 0) return args;
  const remoteCommand = args[args.length - 1];
  const encoded = encodeMultilineShellCommand(remoteCommand);
  if (encoded === remoteCommand) return args;
  return [...args.slice(0, -1), encoded];
}

// Only POSIX profiles in jump host mode need this command compatibility layer.
function prepareSshCommandArguments(tool, args, { profile, platform = process.platform } = {}) {
  if (!profile || profile.tunnelMode !== "stdio" || profile.remotePlatform === "win32") return args;
  const encoded = encodeSshCommandArguments(tool, args);
  if (encoded !== args && platform === "win32") {
    // Account for CreateProcess quoting, doubled backslashes and separators.
    const commandLength = [tool, ...encoded].reduce((length, arg) => {
      const escaped = String(arg)
        .replace(/(\\*)"/g, "$1$1\\\"")
        .replace(/(\\+)$/g, "$1$1");
      return length + escaped.length + 3;
    }, 0);
    if (commandLength > WINDOWS_COMMAND_LENGTH_LIMIT) {
      throw new Error("Jump host command exceeds the Windows SSH command length limit. Use a shorter remote home path or disable jump host mode if reverse forwarding is available.");
    }
  }
  return encoded;
}

// Decoding is only used by tests that inspect the script inside the wrapper.
function decodeMultilineShellCommand(command) {
  if (typeof command !== "string") return command;
  const match = ENCODED_COMMAND_RX.exec(command);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : command;
}

function decodeSshCommandArguments(tool, args) {
  if (tool !== "ssh" || !Array.isArray(args) || args.length === 0) return args;
  const decoded = decodeMultilineShellCommand(args[args.length - 1]);
  if (decoded === args[args.length - 1]) return args;
  return [...args.slice(0, -1), decoded];
}

module.exports = {
  REMOTE_COMMAND_DECODE_EXIT,
  WINDOWS_COMMAND_LENGTH_LIMIT,
  decodeMultilineShellCommand,
  decodeSshCommandArguments,
  encodeMultilineShellCommand,
  encodeSshCommandArguments,
  prepareSshCommandArguments,
};
