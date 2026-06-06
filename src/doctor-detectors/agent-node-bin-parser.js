"use strict";

const fs = require("fs");
const path = require("path");

const HOOK_COMMAND_FRAGMENT_MAX = 128;
const POWERSHELL_ENCODED_COMMAND_FLAGS = new Set(["-encodedcommand", "-enc", "-e"]);

function stripCmdWrapper(command) {
  const match = String(command || "").trim().match(/^cmd \/d \/s \/c "(.+)"$/i);
  return match ? match[1] : String(command || "").trim();
}

function stripPowerShellEnvPrefix(command) {
  return String(command || "").replace(
    /^\s*(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'(?:''|[^'])*'|[^;]+)\s*;\s*)*/i,
    ""
  );
}

function stripPosixEnvPrefix(command) {
  return String(command || "").replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "");
}

function stripPowerShellCallOperator(command) {
  return String(command || "").replace(/^\s*&\s+/, "");
}

function isPowerShellExecutable(token) {
  const name = path.basename(String(token || "").replace(/\\/g, "/")).toLowerCase();
  return name === "powershell.exe" || name === "powershell" || name === "pwsh.exe" || name === "pwsh";
}

function decodePowerShellEncodedArgument(value) {
  const encoded = String(value || "").trim();
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf16le").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function tokenizeCommand(command) {
  const input = String(command || "");
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    const quote = input[i] === '"' || input[i] === "'" ? input[i] : null;
    let token = "";
    if (quote) {
      i++;
      let closed = false;
      while (i < input.length) {
        const ch = input[i];
        if (
          ch === "\\"
          && quote === '"'
          && i + 1 < input.length
          && (input[i + 1] === '"' || input[i + 1] === "\\")
        ) {
          token += input[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          closed = true;
          i++;
          break;
        }
        token += ch;
        i++;
      }
      if (!closed) return null;
      tokens.push(token);
      continue;
    }

    while (i < input.length && !/\s/.test(input[i])) {
      token += input[i];
      i++;
    }
    if (token) tokens.push(token);
  }

  return tokens;
}

function looksLikeNodeCandidate(value) {
  const text = String(value || "");
  const base = path.basename(text.replace(/\\/g, "/")).toLowerCase();
  return base === "node" || base === "node.exe";
}

function looksLikeHookScriptToken(value) {
  return typeof value === "string" && /\.js$/i.test(value);
}

function looksLikePrimaryHookScriptToken(value) {
  return typeof value === "string" && /(?:^|[\\/])[^\\/]*hook\.js$/i.test(value);
}

function extractQuotedTokens(command) {
  const tokens = [];
  const quotedRe = /'((?:''|[^'])*)'|"((?:\\"|[^"])*)"/g;
  let match;
  while ((match = quotedRe.exec(String(command || "")))) {
    if (match[1] !== undefined) tokens.push(match[1].replace(/''/g, "'"));
    else tokens.push(match[2].replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
  }
  return tokens;
}

function parseNodeScriptPairFromTokens(tokens) {
  if (!Array.isArray(tokens)) return null;
  const skip = new Set(["&", "=", "try", "{", "}", ";"]);
  // A token consumed by a preload flag (--require/--import/--loader X) is NOT
  // the hook script even when it ends in hook.js (e.g. a "pre-hook.js" preload).
  const preloadFlags = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
  const consumed = new Set();
  for (let k = 0; k < tokens.length - 1; k++) {
    if (preloadFlags.has(tokens[k])) consumed.add(k + 1);
  }
  const pick = (pred) => tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => !consumed.has(index) && pred(token));
  let scriptIndexes = pick(looksLikePrimaryHookScriptToken);
  if (!scriptIndexes.length) scriptIndexes = pick(looksLikeHookScriptToken);
  // Prefer the LAST matching script: the real hook script is the final
  // positional argument, after any preload modules.
  for (let s = scriptIndexes.length - 1; s >= 0; s--) {
    const i = scriptIndexes[s].index;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = tokens[j];
      if (!candidate || skip.has(candidate) || candidate.startsWith("$")) continue;
      if (!looksLikeNodeCandidate(candidate)) continue;
      return {
        ok: true,
        nodeBin: candidate,
        scriptPath: tokens[i],
      };
    }
  }
  return null;
}

function parseNodeScriptPairFromQuotedText(command) {
  return parseNodeScriptPairFromTokens(extractQuotedTokens(command));
}

function extractPowerShellSingleQuotedAssignment(command, name) {
  const pattern = new RegExp(`\\$psi\\.${name}\\s*=\\s*'((?:''|[^'])*)'`, "i");
  const match = String(command || "").match(pattern);
  return match ? match[1].replace(/''/g, "'") : null;
}

function parseProcessStartInfoNodePair(command) {
  const nodeBin = extractPowerShellSingleQuotedAssignment(command, "FileName");
  const args = extractPowerShellSingleQuotedAssignment(command, "Arguments");
  if (!looksLikeNodeCandidate(nodeBin) || !args) return null;
  const argTokens = tokenizeCommand(args);
  if (!argTokens) return null;
  const scriptToken = argTokens.find((token) => looksLikeHookScriptToken(token));
  if (!scriptToken) return null;
  return {
    ok: true,
    nodeBin,
    scriptPath: scriptToken,
  };
}

function decodePowerShellEncodedCommand(command) {
  const withoutCmd = stripCmdWrapper(command);
  const withoutPsEnv = stripPowerShellEnvPrefix(withoutCmd);
  const withoutPosixEnv = stripPosixEnvPrefix(withoutPsEnv);
  const normalized = stripPowerShellCallOperator(withoutPosixEnv).trim();
  const tokens = tokenizeCommand(normalized);
  if (!tokens || tokens.length < 3 || !isPowerShellExecutable(tokens[0])) return null;

  const encodedIndex = tokens.findIndex((token) =>
    POWERSHELL_ENCODED_COMMAND_FLAGS.has(String(token || "").toLowerCase())
  );
  if (encodedIndex === -1 || encodedIndex + 1 >= tokens.length) return null;
  return decodePowerShellEncodedArgument(tokens[encodedIndex + 1]);
}

function commandContainsFragment(command, fragment) {
  if (typeof fragment !== "string" || !fragment) return false;
  const text = String(command || "");
  if (text.includes(fragment)) return true;
  const decoded = decodePowerShellEncodedCommand(text);
  return !!(decoded && decoded.includes(fragment));
}

function parseHookCommand(command, depth = 0) {
  const withoutCmd = stripCmdWrapper(command);
  const withoutPsEnv = stripPowerShellEnvPrefix(withoutCmd);
  const quotedSource = stripPowerShellCallOperator(withoutPsEnv).trim();
  const withoutPosixEnv = stripPosixEnvPrefix(withoutPsEnv);
  const normalized = stripPowerShellCallOperator(withoutPosixEnv).trim();
  const tokens = tokenizeCommand(normalized);
  if (!tokens || tokens.length < 2) {
    return {
      ok: false,
      issue: "parse-failed",
      fragment: String(command || "").slice(0, HOOK_COMMAND_FRAGMENT_MAX),
    };
  }

  const processStartInfoPair = parseProcessStartInfoNodePair(quotedSource);
  if (processStartInfoPair) {
    return {
      ...processStartInfoPair,
      normalizedCommand: normalized,
    };
  }
  const quotedPair = parseNodeScriptPairFromQuotedText(quotedSource);
  if (quotedPair) {
    return {
      ...quotedPair,
      normalizedCommand: normalized,
    };
  }
  const parsedPair = parseNodeScriptPairFromTokens(tokens);
  if (parsedPair) {
    return {
      ...parsedPair,
      normalizedCommand: normalized,
    };
  }

  if (depth < 2 && isPowerShellExecutable(tokens[0])) {
    const decoded = decodePowerShellEncodedCommand(command);
    if (decoded) {
      const parsed = parseHookCommand(decoded, depth + 1);
      if (parsed.ok) {
        return {
          ...parsed,
          wrapperCommand: normalized,
          decodedCommand: decoded,
        };
      }
      return parsed;
    }
  }

  const executableIndex = tokens.findIndex((token) => token && !token.startsWith("-"));
  if (executableIndex === -1 || executableIndex + 1 >= tokens.length) {
    return {
      ok: false,
      issue: "parse-failed",
      fragment: String(command || "").slice(0, HOOK_COMMAND_FRAGMENT_MAX),
    };
  }

  return {
    ok: true,
    nodeBin: tokens[executableIndex],
    scriptPath: tokens[executableIndex + 1],
    normalizedCommand: normalized,
  };
}

function isAbsoluteAnyPlatform(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function validateHookCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs || fs;
  const parsed = parseHookCommand(command);
  if (!parsed.ok) return parsed;

  const { nodeBin, scriptPath } = parsed;
  if (platform === "win32") {
    if (String(nodeBin).toLowerCase() !== "node") {
      if (!isAbsoluteAnyPlatform(nodeBin) || !fsImpl.existsSync(nodeBin)) {
        return { ok: false, issue: "nodeBin-invalid", nodeBin, scriptPath };
      }
    }
  } else {
    if (!path.posix.isAbsolute(nodeBin)) {
      return { ok: false, issue: "nodeBin-invalid", nodeBin, scriptPath };
    }
    try {
      fsImpl.accessSync(nodeBin, fs.constants.X_OK);
    } catch {
      return { ok: false, issue: "nodeBin-invalid", nodeBin, scriptPath };
    }
  }

  if (!isAbsoluteAnyPlatform(scriptPath) || !fsImpl.existsSync(scriptPath)) {
    return { ok: false, issue: "scriptPath-missing", nodeBin, scriptPath };
  }

  return { ok: true, nodeBin, scriptPath };
}

module.exports = {
  commandContainsFragment,
  decodePowerShellEncodedCommand,
  parseHookCommand,
  validateHookCommand,
  __test: {
    decodePowerShellEncodedArgument,
    isPowerShellExecutable,
    stripCmdWrapper,
    stripPowerShellEnvPrefix,
    stripPosixEnvPrefix,
    stripPowerShellCallOperator,
    tokenizeCommand,
  },
};
