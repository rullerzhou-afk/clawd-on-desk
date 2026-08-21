"use strict";

const { getEntryDisplaySessionTag } = require("./state-session-snapshot");

const {
  clipUtf16Safe,
  concatTelegramParts,
  renderTelegramMarkdown,
} = require("./telegram-message-format");

// R1a: Telegram "session finished" notifications.
//
// Driven off the session-snapshot fanout (main.js broadcastSessionSnapshot).
// The snapshot is the existing observer stream — single-direction, already
// fanned out to dashboard / HUD / hardware buddy. This module watches it for
// sessions that reach a done/interrupted badge on a completion event and
// pushes one short message per session to Telegram via the native runner.
//
// Design constraints (see docs/connections/audit-telegram-companion-...):
//   - The snapshot carries no `prev`, so dedupe state lives here.
//   - onSnapshot runs inside the synchronous updateSession broadcast path, so
//     it must be sync + fire sends without awaiting + never throw.
//   - The fanout re-broadcasts the same completion (ack, stale-cleanup, remote
//     Codex retention), so dedupe by `id:rawEvent:at` is mandatory.
//   - First snapshot only primes the dedupe map (no backlog re-ping on start).

// Scope limitation (R1a): only the "Stop" naming family is covered. Copilot
// CLI signals completion with `agentStop`, which deriveSessionBadge does NOT
// map to a done badge, so the desktop HUD badge never lights for it either —
// adding it here alone would do nothing (the badge gate below filters first).
// Covering Copilot needs a deriveSessionBadge change (affects desktop), tracked
// as a follow-up. See docs limitations note.
const COMPLETION_EVENTS = new Set([
  "Stop",
  "StopFailure",
  "ApiError",
  "event_msg:task_complete",
]);
const DONE_BADGES = new Set(["done", "interrupted"]);
const COMPLETION_OUTPUT_MODES = new Set(["off", "full"]);
const OUTPUT_FULL_MAX = 2600;
const NOTIFICATION_TEXT_MAX = 3600;

const NOTIFICATION_LOCALES = Object.freeze({
  en: {
    session: "session",
    done: "done",
    interrupted: "interrupted",
    assistantOutput: "Assistant output",
    truncated: "truncated",
    wrapStatus: (status) => `(${status})`,
  },
  zh: {
    session: "会话",
    done: "已完成",
    interrupted: "已中断",
    assistantOutput: "Assistant 输出",
    truncated: "已截断",
    wrapStatus: (status) => `（${status}）`,
  },
  "zh-TW": {
    session: "工作階段",
    done: "已完成",
    interrupted: "已中斷",
    assistantOutput: "Assistant 輸出",
    truncated: "已截斷",
    wrapStatus: (status) => `（${status}）`,
  },
  ko: {
    session: "세션",
    done: "완료",
    interrupted: "중단됨",
    assistantOutput: "Assistant 출력",
    truncated: "잘림",
    wrapStatus: (status) => `(${status})`,
  },
  ja: {
    session: "セッション",
    done: "完了",
    interrupted: "中断",
    assistantOutput: "Assistant 出力",
    truncated: "省略",
    wrapStatus: (status) => `（${status}）`,
  },
  "pt-BR": {
    session: "sessão",
    done: "concluída",
    interrupted: "interrompida",
    assistantOutput: "Saída do assistente",
    truncated: "truncado",
    wrapStatus: (status) => `(${status})`,
  },
  es: {
    session: "sesión",
    done: "completada",
    interrupted: "interrumpida",
    assistantOutput: "Salida del asistente",
    truncated: "truncada",
    wrapStatus: (status) => `(${status})`,
  },
});

function dedupeKey(entry) {
  const le = entry && entry.lastEvent;
  return `${entry.id}:${le ? le.rawEvent : ""}:${le ? le.at : ""}`;
}

function isCompletion(entry) {
  if (!entry || !DONE_BADGES.has(entry.badge)) return false;
  const le = entry.lastEvent;
  return !!(le && COMPLETION_EVENTS.has(le.rawEvent));
}

// cwd may be POSIX or Windows (remote hosts), so split on both separators.
function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function entryFolderName(entry) {
  if (!entry || typeof entry !== "object") return "";
  // Snapshot producers use an explicit empty displayFolder to suppress opaque
  // internal workspace ids. Only legacy payloads without the field may fall
  // back to cwd.
  if (Object.prototype.hasOwnProperty.call(entry, "displayFolder")) {
    return folderName(entry.displayFolder);
  }
  return folderName(entry.cwd);
}

function getNotificationLocale(lang) {
  return NOTIFICATION_LOCALES[lang] || NOTIFICATION_LOCALES.en;
}

function normalizeCompletionOutputMode(value) {
  if (value === "tail") return "full";
  return typeof value === "string" && COMPLETION_OUTPUT_MODES.has(value) ? value : "off";
}

function redactAssistantOutputText(value) {
  let text = typeof value === "string" ? value : "";
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!text) return "";
  text = text.replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, "<redacted:telegram-token>");
  text = text.replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, "<redacted:token>");
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted:aws-key>");
  text = text.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>");
  text = text.replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, "<redacted:secretish>");
  return text;
}

function truncateWithMiddle(text, maxLen) {
  if (text.length <= maxLen) return { text, truncated: false };
  const marker = "\n...[truncated]...\n";
  if (maxLen <= marker.length + 20) {
    return { text: clipUtf16Safe(text, maxLen), truncated: true };
  }
  const keep = maxLen - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const safeHead = clipUtf16Safe(text, head);
  let safeTail = "";
  let safeTailLength = 0;
  for (const character of Array.from(text).reverse()) {
    if (safeTailLength + character.length > tail) break;
    safeTail = `${character}${safeTail}`;
    safeTailLength += character.length;
  }
  return {
    text: `${safeHead}${marker}${safeTail}`,
    truncated: true,
  };
}

function prepareAssistantOutput(entry, mode) {
  const outputMode = normalizeCompletionOutputMode(mode);
  if (outputMode === "off") return null;
  const raw = entry && typeof entry.assistantLastOutput === "string" ? entry.assistantLastOutput : "";
  const redacted = redactAssistantOutputText(raw);
  if (!redacted) return null;
  const limited = truncateWithMiddle(redacted, OUTPUT_FULL_MAX);
  return {
    text: limited.text,
    truncated: limited.truncated || !!(entry && entry.assistantLastOutputTruncated === true),
  };
}

function formatAssistantOutputSection(entry, mode, locale) {
  const prepared = prepareAssistantOutput(entry, mode);
  if (!prepared) return "";
  const label = locale.assistantOutput || NOTIFICATION_LOCALES.en.assistantOutput;
  const suffix = prepared.truncated
    ? ` (${locale.truncated || NOTIFICATION_LOCALES.en.truncated})`
    : "";
  return `\n\n${label}${suffix}:\n${prepared.text}`;
}

function hasAssistantOutputSection(entry, mode) {
  const outputMode = normalizeCompletionOutputMode(mode);
  if (outputMode === "off") return false;
  const raw = entry && typeof entry.assistantLastOutput === "string" ? entry.assistantLastOutput : "";
  return !!redactAssistantOutputText(raw);
}

function truncateNotificationText(text, locale) {
  if (text.length <= NOTIFICATION_TEXT_MAX) return text;
  const marker = `\n... ${locale.truncated || NOTIFICATION_LOCALES.en.truncated}`;
  return `${clipUtf16Safe(text, Math.max(0, NOTIFICATION_TEXT_MAX - marker.length))}${marker}`;
}

// Privacy note: displayTitle is the same session title shown on the desktop
// HUD / tray (it can derive from the user's prompt first line via
// sessionTitle). The message carries the title + identity fields only when
// bare completion pings are enabled, or when assistant output is present.
// The Telegram carrier itself (screenshots / forwarding / server storage) is
// the added exposure vs. the desktop.
function formatNotification(entry, options = {}) {
  if (!entry) return "";
  const locale = getNotificationLocale(options.lang);
  const completionOutputMode = normalizeCompletionOutputMode(options.completionOutputMode);
  const outputSection = formatAssistantOutputSection(entry, completionOutputMode, locale);
  if (!outputSection && options.includeBare === false) return "";
  const interrupted = entry.badge === "interrupted";
  const icon = interrupted ? "⚠️" : "✅"; // ⚠️ / ✅
  const status = interrupted ? locale.interrupted : locale.done;
  const title = entry.displayTitle || locale.session;
  const displaySessionTag = getEntryDisplaySessionTag(entry);
  const meta = [];
  if (entry.agentId) meta.push(entry.agentId);
  const folder = entryFolderName(entry);
  if (folder) meta.push(folder);
  if (entry.host) meta.push(entry.host);
  if (displaySessionTag) meta.push(`#${displaySessionTag}`);
  const wrapStatus = typeof locale.wrapStatus === "function"
    ? locale.wrapStatus(status)
    : `(${status})`;
  const head = `${icon} ${title} ${wrapStatus}`;
  const base = meta.length ? `${head}\n${meta.join(" · ")}` : head; // " · "
  const withOutput = `${base}${outputSection}`;
  return truncateNotificationText(withOutput, locale);
}

function formatTelegramNotificationMessage(entry, options = {}) {
  if (!entry) return null;
  const locale = getNotificationLocale(options.lang);
  const completionOutputMode = normalizeCompletionOutputMode(options.completionOutputMode);
  const prepared = prepareAssistantOutput(entry, completionOutputMode);
  if (!prepared && options.includeBare === false) return null;

  const interrupted = entry.badge === "interrupted";
  const icon = interrupted ? "⚠️" : "✅";
  const status = interrupted ? locale.interrupted : locale.done;
  const title = entry.displayTitle || locale.session;
  const displaySessionTag = getEntryDisplaySessionTag(entry);
  const meta = [];
  if (entry.agentId) meta.push(entry.agentId);
  const folder = entryFolderName(entry);
  if (folder) meta.push(folder);
  if (entry.host) meta.push(entry.host);
  if (displaySessionTag) meta.push(`#${displaySessionTag}`);
  const wrapStatus = typeof locale.wrapStatus === "function"
    ? locale.wrapStatus(status)
    : `(${status})`;
  const baseParts = [
    `${icon} `,
    { text: title, bold: true, neutralizeMentions: true },
    ` ${wrapStatus}`,
  ];
  if (meta.length) {
    baseParts.push("\n", { text: meta.join(" · "), neutralizeMentions: true });
  }
  const truncationText = locale.truncated || NOTIFICATION_LOCALES.en.truncated;
  const truncationMarker = `\n... ${truncationText}`;
  if (!prepared) {
    return concatTelegramParts(baseParts, {
      maxLength: NOTIFICATION_TEXT_MAX,
      truncationMarker,
    });
  }

  const label = locale.assistantOutput || NOTIFICATION_LOCALES.en.assistantOutput;
  function composeOutput(showTruncated) {
    const suffix = showTruncated ? ` (${truncationText})` : "";
    const headParts = [
      ...baseParts,
      "\n\n",
      { text: `${label}${suffix}:`, bold: true },
      "\n",
    ];
    const head = concatTelegramParts(headParts, {
      maxLength: NOTIFICATION_TEXT_MAX,
      truncationMarker,
    });
    const outputBudget = Math.max(0, Math.min(
      OUTPUT_FULL_MAX,
      NOTIFICATION_TEXT_MAX - head.budgetLength,
    ));
    const output = renderTelegramMarkdown(prepared.text, {
      maxLength: outputBudget,
      truncationMarker,
    });
    return { head, headParts, output };
  }

  let showTruncated = prepared.truncated === true;
  let composed = composeOutput(showTruncated);
  if (!showTruncated && (composed.head.truncated || composed.output.truncated)) {
    showTruncated = true;
    composed = composeOutput(true);
  }
  const truncated = prepared.truncated === true
    || composed.head.truncated
    || composed.output.truncated;
  return concatTelegramParts([...composed.headParts, composed.output], {
    maxLength: NOTIFICATION_TEXT_MAX,
    truncationMarker,
    reportedTruncated: truncated,
  });
}

function createTelegramCompanion({
  getClient,
  isEnabled,
  log = () => {},
  getLang = () => "en",
  getCompletionOutputMode = () => "off",
  getNotifyOnComplete = () => false,
  formatText = null,
  onNotificationSent = null,
} = {}) {
  const lastNotified = new Map(); // id -> last dedupe key
  let primed = false;

  // log ultimately does a synchronous file write that can throw; these calls
  // run on the fire-and-forget async chain (outside the caller's sync
  // try/catch), so a throw here would become an unhandled rejection.
  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function onSnapshot(snapshot) {
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const enabled = typeof isEnabled === "function" ? !!isEnabled() : true;
    const priming = !primed;
    const seenIds = new Set();
    const toSend = [];

    for (const entry of sessions) {
      if (!entry || !entry.id) continue;
      seenIds.add(entry.id);
      if (!isCompletion(entry)) continue;
      const key = dedupeKey(entry);
      if (lastNotified.get(entry.id) === key) continue;
      // Record the key even when priming/disabled so toggling on later does
      // not backfill completions the user never asked to be notified about.
      lastNotified.set(entry.id, key);
      if (priming || !enabled) continue;
      toSend.push(entry);
    }

    // Forget sessions that dropped out of the snapshot so the map stays bounded
    // over long runs. A removed-then-reappearing session with an identical
    // event timestamp is the only re-notify edge, and stale-cleanup does not
    // resurrect ended sessions with the same `at`.
    for (const id of Array.from(lastNotified.keys())) {
      if (!seenIds.has(id)) lastNotified.delete(id);
    }

    primed = true;
    if (!toSend.length) return;

    const client = typeof getClient === "function" ? getClient() : null;
    if (!client || typeof client.sendNotification !== "function") return;

    for (const entry of toSend) {
      let lang = "en";
      try {
        const value = typeof getLang === "function" ? getLang() : "";
        if (typeof value === "string" && value) lang = value;
      } catch {}
      let completionOutputMode = "off";
      try {
        completionOutputMode = normalizeCompletionOutputMode(
          typeof getCompletionOutputMode === "function" ? getCompletionOutputMode() : "off"
        );
      } catch {}
      let includeBare = true;
      try {
        includeBare = typeof getNotifyOnComplete === "function" ? getNotifyOnComplete() === true : true;
      } catch {}
      if (!includeBare && !hasAssistantOutputSection(entry, completionOutputMode)) continue;
      const message = typeof formatText === "function"
        ? formatText(entry, { lang, completionOutputMode, includeBare })
        : formatTelegramNotificationMessage(entry, { lang, completionOutputMode, includeBare });
      if (!message) continue;
      // Fire-and-forget: do NOT await — we are on the synchronous broadcast
      // path. sendNotification never throws, but guard anyway.
      Promise.resolve()
        .then(() => client.sendNotification(message))
        .then((res) => {
          if (res && res.ok === false) {
            safeLog("warn", "completion notification not delivered", {
              id: entry.id, errorClass: res.errorClass,
            });
            return;
          }
          const messageId = res && res.messageId;
          if (messageId != null && typeof onNotificationSent === "function") {
            try { onNotificationSent({ entry, messageId }); } catch (err) {
              safeLog("warn", "completion notification mapping callback failed", {
                id: entry.id, error: err && err.message,
              });
            }
          }
        })
        .catch((err) => {
          safeLog("warn", "completion notification threw", {
            id: entry.id, error: err && err.message,
          });
        });
    }
  }

  return {
    onSnapshot,
    _lastNotified: lastNotified,
  };
}

module.exports = {
  createTelegramCompanion,
  formatNotification,
  formatTelegramNotificationMessage,
  formatAssistantOutputSection,
  redactAssistantOutputText,
  isCompletion,
  dedupeKey,
  COMPLETION_EVENTS,
};
