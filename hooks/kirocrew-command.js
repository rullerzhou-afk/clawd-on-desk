"use strict";

// KiroCrew hooks.json has no ownership field. Treat only the exact simple
// launcher shapes Clawd writes as ours; a marker
// substring in another command is not proof of ownership.

function parseTwoTokenCommand(command) {
  if (typeof command !== "string" || !command.trim() || /[\r\n\0]/.test(command)) return null;
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && /\s/.test(command[index])) index++;
    if (index >= command.length) break;
    let token = "";
    if (command[index] === '"') {
      index++;
      const start = index;
      while (index < command.length && command[index] !== '"') index++;
      if (index >= command.length) return null;
      token = command.slice(start, index);
      index++;
      if (!token || /[$`%!]/.test(token) || (index < command.length && !/\s/.test(command[index]))) return null;
    } else {
      const start = index;
      while (index < command.length && !/\s/.test(command[index])) {
        // Only path/token characters are accepted. This rejects shell
        // composition, substitutions, quoting, redirection and escapes.
        if (!/[A-Za-z0-9_./:\\-]/.test(command[index])) return null;
        index++;
      }
      token = command.slice(start, index);
    }
    tokens.push(token);
    if (tokens.length > 2) return null;
  }
  return tokens.length === 2 ? tokens : null;
}

function parseKiroCrewCommand(command) {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  const cmdPrefix = /^cmd\s+\/d\s+\/s\s+\/c\s+"([\s\S]*)"$/i.exec(trimmed);
  if (cmdPrefix) {
    // The regex consumes cmd's outer quote pair; preserve the two quotes that
    // belong to the executable and script arguments themselves.
    const tokens = parseTwoTokenCommand(cmdPrefix[1]);
    if (tokens && tokens.some((token) => /[&|<>^;()]/.test(token))) return null;
    return tokens;
  }
  return parseTwoTokenCommand(trimmed);
}

function isOwnedKiroCrewCommand(command) {
  const tokens = parseKiroCrewCommand(command);
  if (!tokens) return false;
  const nodeName = tokens[0].replace(/\\/g, "/").split("/").pop();
  const scriptName = tokens[1].replace(/\\/g, "/").split("/").pop();
  return /^node(?:\.exe)?$/i.test(nodeName) && scriptName.toLowerCase() === "kirocrew-hook.js";
}

module.exports = { isOwnedKiroCrewCommand, parseKiroCrewCommand };
