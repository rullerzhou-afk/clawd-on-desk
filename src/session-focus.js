"use strict";

const { CODEX_THREAD_ID_RE, getCodexThreadId } = require("./codex-thread-id");
const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOsPlatform(options) {
  if (!options || typeof options !== "object") return "";
  return normalizeString(options.osPlatform || options.focusHostPlatform).toLowerCase();
}

function getCodexThreadUrl(entry) {
  const originator = entry && (entry.codexOriginator || entry.originator);
  if (!isCodexDesktopOriginator(originator)) return null;
  const threadId = getCodexThreadId(entry);
  // `codex queue --thread` accepts exact saved names, but the Desktop deep-link
  // contract is only established for UUIDs. Keep focus narrower than delivery
  // instead of assuming queue selectors are also valid URL route parameters.
  return threadId && CODEX_THREAD_ID_RE.test(threadId)
    ? `codex://threads/${threadId}`
    : null;
}

// A DSH session is the desktop carrier only when the bridge said so (state or
// approval). This checks identity alone; whether the host can open the app is
// decided by getDshDesktopFocusUrl below.
function isDshDesktopSession(entry) {
  return !!entry
    && entry.agentId === "deepseek-harness"
    && entry.dshCarrier === "desktop";
}

function getDshDesktopFocusUrl(entry, options) {
  if (!isDshDesktopSession(entry)) return null;
  const osPlatform = normalizeOsPlatform(options);
  return osPlatform === "darwin" || osPlatform === "win32" ? "dsh://open" : null;
}

function hasSupportedOrcaPaneTarget(entry, options = {}) {
  const paneKey = normalizeString(entry && entry.orcaPaneKey);
  if (!paneKey || paneKey.length > 256) return false;
  if (!/^[\w-]+:[\w-]+$/.test(paneKey)) return false;
  const osPlatform = normalizeOsPlatform(options);
  return osPlatform === "darwin" || osPlatform === "win32";
}

// herdr (#1139) only ever ships a pane id from a hook running inside a local
// herdr pane (HERDR_ENV, no nested terminal, never remote; the server strips it
// for Remote SSH and WSL as well), and only macOS / Linux can run the CLI. The
// focus path still needs the local source PID to raise the terminal, so a pane
// id alone does not make a session focusable.
function hasSupportedHerdrPaneTarget(entry, options = {}) {
  if (!entry || entry.host || !entry.sourcePid) return false;
  const paneId = normalizeString(entry.herdrPaneId);
  if (!paneId || paneId.length > 256 || paneId.startsWith("-")) return false;
  if (!/^[\w-]+:[\w-]+$/.test(paneId)) return false;
  const osPlatform = normalizeOsPlatform(options);
  return osPlatform === "darwin" || osPlatform === "linux";
}

function getSessionFocusTarget(entry, options = {}) {
  if (!entry || !entry.id) return { canFocus: false, type: null, url: null };
  if (entry.platform === "webui") return { canFocus: false, type: null, url: null };

  // Orca forwards its local pane identity into managed SSH PTYs. That key can
  // target the local Orca UI without treating the remote process PID as local.
  // Keep the exception narrow: supported host OS, strict pane-key shape, and
  // terminal focus only. Every other remote session remains unfocusable.
  const hasOrcaPaneTarget = hasSupportedOrcaPaneTarget(entry, options);
  if (entry.host && !hasOrcaPaneTarget) return { canFocus: false, type: null, url: null };
  if (hasOrcaPaneTarget) return { canFocus: true, type: "terminal", url: null };

  // Ahead of the Codex Desktop deep link for the same reason as Orca: the pane id
  // comes from the agent process's own environment, while the Desktop originator
  // is a label Codex inherits from CODEX_INTERNAL_ORIGINATOR_OVERRIDE. A codex
  // started inside a herdr pane whose server was launched from a Codex Desktop
  // shell carries both, and lives in the pane, not in the Desktop window.
  if (hasSupportedHerdrPaneTarget(entry, options)) return { canFocus: true, type: "terminal", url: null };

  const codexThreadUrl = getCodexThreadUrl(entry);
  if (codexThreadUrl) {
    return { canFocus: true, type: "codex-thread", url: codexThreadUrl };
  }

  const dshDesktopUrl = getDshDesktopFocusUrl(entry, options);
  if (dshDesktopUrl) {
    return { canFocus: true, type: "dsh-desktop", url: dshDesktopUrl };
  }

  if (entry.sourcePid) {
    return { canFocus: true, type: "terminal", url: null };
  }

  return { canFocus: false, type: null, url: null };
}

// A Codex Desktop deep link can select the application window, but the OS
// foreground check cannot prove which of its conversations owns the composer.
// Direct Send must therefore keep Desktop out of the paste path even when the
// session still carries a sourcePid. Navigation callers continue to use the
// regular target above and can open the thread URL normally.
function getDirectSendFocusTarget(entry, options = {}) {
  const isCodexDesktop = !!entry
    && entry.agentId === "codex"
    && isCodexDesktopOriginator(entry.codexOriginator || entry.originator);
  if (isCodexDesktop) {
    return {
      canFocus: false,
      type: "codex-thread",
      url: getCodexThreadUrl(entry),
      reason: "codex_desktop_requires_manual_paste",
    };
  }

  // The desktop app window can be opened, but the OS foreground check cannot
  // prove which conversation owns the composer, and the app is not a terminal
  // that accepts injected text. Direct Send must therefore stay off this target.
  if (isDshDesktopSession(entry)) {
    return {
      canFocus: false,
      type: "dsh-desktop",
      url: "dsh://open",
      reason: "dsh_desktop_requires_manual_paste",
    };
  }

  const target = getSessionFocusTarget(entry, options);
  return target;
}

function isFocusableLocalHudSession(entry, options = {}) {
  return !!entry
    && getSessionFocusTarget(entry, options).canFocus
    && !entry.headless
    && entry.state !== "sleeping"
    && !entry.hiddenFromHud
    && !entry.host;
}

function getFocusableLocalHudSessionIds(snapshot, options = {}) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions
    .filter((entry) => isFocusableLocalHudSession(entry, options))
    .map((entry) => entry.id);
}

module.exports = {
  getCodexThreadId,
  getCodexThreadUrl,
  getDirectSendFocusTarget,
  getFocusableLocalHudSessionIds,
  getSessionFocusTarget,
  isDshDesktopSession,
  isFocusableLocalHudSession,
};
