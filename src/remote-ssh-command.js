"use strict";

const { Buffer } = require("node:buffer");

const MULTILINE_RX = /[\r\n]/;
const ENCODED_COMMAND_RX = /^sh -c "\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 --decode\)"$/;

// Some audited SSH gateways reject a remote-command argument that contains
// literal line breaks even though OpenSSH and the remote shell support it.
// Decode the script inside command substitution so the argument itself stays
// one line. Stdin is not consumed, which preserves commands that read a JSON
// or binary frame after starting.
function encodeMultilineShellCommand(command) {
  if (typeof command !== "string") {
    throw new TypeError("encodeMultilineShellCommand: command must be a string");
  }
  if (!MULTILINE_RX.test(command)) return command;
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `sh -c "$(printf %s '${encoded}' | base64 --decode)"`;
}

// buildSshArgs() always puts the destination before the optional remote
// command. Only transform that final ssh argument and leave one-line commands,
// scp targets, interactive invocations, and option values untouched.
function encodeSshCommandArguments(tool, args) {
  if (tool !== "ssh" || !Array.isArray(args) || args.length === 0) return args;
  const remoteCommand = args[args.length - 1];
  const encoded = encodeMultilineShellCommand(remoteCommand);
  if (encoded === remoteCommand) return args;
  return [...args.slice(0, -1), encoded];
}

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
  decodeMultilineShellCommand,
  decodeSshCommandArguments,
  encodeMultilineShellCommand,
  encodeSshCommandArguments,
};
