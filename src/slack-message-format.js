"use strict";

// Slack Block Kit message builders for the one-way notifier. Kept dependency-free
// on purpose: Slack messages are plain JSON (`{ text, blocks }`), so unlike the
// Telegram formatter this needs no markdown engine. `text` is the notification
// fallback (shown in the OS/Slack push preview); `blocks` is the rich card.
//
// Every user/agent-derived string is run through redactSecrets before it leaves
// the desktop, matching the Telegram/Feishu renderers.

const { redactSecrets } = require("./secret-redact");
const { getEntryDisplaySessionTag } = require("./state-session-snapshot");

// Slack hard limits: header plain_text <= 150, section mrkdwn <= 3000. Stay a
// little under. Assistant output is middle-truncated so both ends survive.
const HEADER_MAX = 150;
const SECTION_MAX = 2900;
const OUTPUT_MAX = 2600;
const FALLBACK_MAX = 3000;
const DISPLAY_SESSION_TAG_RE = /^[0-9a-f]{10}$/i;

const SLACK_LOCALES = Object.freeze({
  en: {
    session: "session",
    done: "done",
    interrupted: "interrupted",
    assistantOutput: "Assistant output",
    truncated: "truncated",
    permissionTitle: "Permission needed",
    permissionHint: "Approve or deny in the desktop app.",
    permissionHintRemote: "Approve or deny in your remote approval channel (Telegram or Feishu).",
    questionTitle: "Answer needed",
    questionHint: "Answer in the desktop app.",
    questionHintRemote: "Answer in your remote approval channel (Telegram or Feishu).",
    questionNumber: "Question {n}",
    andMore: "+{n} more",
    tool: "Tool",
    folder: "Folder",
    agent: "Agent",
    host: "Host",
    testTitle: "Slack notifications connected",
    testBody: "This is a test message from Clawd on Desk. If you can read this, notifications are working.",
    wrapStatus: (status) => `(${status})`,
  },
  zh: {
    session: "会话",
    done: "已完成",
    interrupted: "已中断",
    assistantOutput: "Assistant 输出",
    truncated: "已截断",
    permissionTitle: "需要审批",
    permissionHint: "请在桌面 App 中批准或拒绝。",
    permissionHintRemote: "请在远程审批渠道（Telegram 或飞书）中批准或拒绝。",
    questionTitle: "需要回答",
    questionHint: "请在桌面 App 中回答。",
    questionHintRemote: "请在远程审批渠道（Telegram 或飞书）中回答。",
    questionNumber: "问题 {n}",
    andMore: "还有 {n} 项",
    tool: "工具",
    folder: "目录",
    agent: "Agent",
    host: "主机",
    testTitle: "Slack 通知已连接",
    testBody: "这是来自 Clawd on Desk 的测试消息。如果你能看到它，说明通知已正常工作。",
    wrapStatus: (status) => `（${status}）`,
  },
  "zh-TW": {
    session: "工作階段",
    done: "已完成",
    interrupted: "已中斷",
    assistantOutput: "Assistant 輸出",
    truncated: "已截斷",
    permissionTitle: "需要審批",
    permissionHint: "請在桌面 App 中核准或拒絕。",
    permissionHintRemote: "請在遠端審批管道（Telegram 或飛書）中核准或拒絕。",
    questionTitle: "需要回答",
    questionHint: "請在桌面 App 中回答。",
    questionHintRemote: "請在遠端審批管道（Telegram 或飛書）中回答。",
    questionNumber: "問題 {n}",
    andMore: "還有 {n} 項",
    tool: "工具",
    folder: "目錄",
    agent: "Agent",
    host: "主機",
    testTitle: "Slack 通知已連線",
    testBody: "這是來自 Clawd on Desk 的測試訊息。如果你能看到它，代表通知已正常運作。",
    wrapStatus: (status) => `（${status}）`,
  },
  ko: {
    session: "세션",
    done: "완료",
    interrupted: "중단됨",
    assistantOutput: "Assistant 출력",
    truncated: "잘림",
    permissionTitle: "승인 필요",
    permissionHint: "데스크톱 앱에서 승인하거나 거부하세요.",
    permissionHintRemote: "원격 승인 채널(Telegram 또는 Feishu)에서 승인하거나 거부하세요.",
    questionTitle: "답변 필요",
    questionHint: "데스크톱 앱에서 답변하세요.",
    questionHintRemote: "원격 승인 채널(Telegram 또는 Feishu)에서 답변하세요.",
    questionNumber: "질문 {n}",
    andMore: "외 {n}개",
    tool: "도구",
    folder: "폴더",
    agent: "Agent",
    host: "호스트",
    testTitle: "Slack 알림 연결됨",
    testBody: "Clawd on Desk에서 보낸 테스트 메시지입니다. 이 메시지가 보이면 알림이 정상 작동합니다.",
    wrapStatus: (status) => `(${status})`,
  },
  ja: {
    session: "セッション",
    done: "完了",
    interrupted: "中断",
    assistantOutput: "Assistant 出力",
    truncated: "省略",
    permissionTitle: "承認が必要",
    permissionHint: "デスクトップアプリで承認または拒否してください。",
    permissionHintRemote: "リモート承認チャンネル（Telegram または Feishu）で承認または拒否してください。",
    questionTitle: "回答が必要",
    questionHint: "デスクトップアプリで回答してください。",
    questionHintRemote: "リモート承認チャンネル（Telegram または Feishu）で回答してください。",
    questionNumber: "質問 {n}",
    andMore: "ほか {n} 件",
    tool: "ツール",
    folder: "フォルダ",
    agent: "Agent",
    host: "ホスト",
    testTitle: "Slack 通知が接続されました",
    testBody: "Clawd on Desk からのテストメッセージです。これが表示されていれば通知は正常に動作しています。",
    wrapStatus: (status) => `（${status}）`,
  },
  "pt-BR": {
    session: "sessão",
    done: "concluída",
    interrupted: "interrompida",
    assistantOutput: "Saída do assistente",
    truncated: "truncado",
    permissionTitle: "Aprovação necessária",
    permissionHint: "Aprove ou recuse no aplicativo de desktop.",
    permissionHintRemote: "Aprove ou recuse no seu canal remoto de aprovação (Telegram ou Feishu).",
    questionTitle: "Resposta necessária",
    questionHint: "Responda no aplicativo de desktop.",
    questionHintRemote: "Responda no seu canal remoto de aprovação (Telegram ou Feishu).",
    questionNumber: "Pergunta {n}",
    andMore: "+{n} restantes",
    tool: "Ferramenta",
    folder: "Pasta",
    agent: "Agente",
    host: "Host",
    testTitle: "Notificações do Slack conectadas",
    testBody: "Esta é uma mensagem de teste do Clawd on Desk. Se você consegue ler isto, as notificações estão funcionando.",
    wrapStatus: (status) => `(${status})`,
  },
  es: {
    session: "sesión",
    done: "completada",
    interrupted: "interrumpida",
    assistantOutput: "Salida del asistente",
    truncated: "truncado",
    permissionTitle: "Se necesita aprobación",
    permissionHint: "Aprueba o rechaza en la aplicación de escritorio.",
    permissionHintRemote: "Aprueba o rechaza en tu canal remoto de aprobación (Telegram o Feishu).",
    questionTitle: "Se necesita respuesta",
    questionHint: "Responde en la aplicación de escritorio.",
    questionHintRemote: "Responde en tu canal remoto de aprobación (Telegram o Feishu).",
    questionNumber: "Pregunta {n}",
    andMore: "+{n} más",
    tool: "Herramienta",
    folder: "Carpeta",
    agent: "Agente",
    host: "Host",
    testTitle: "Notificaciones de Slack conectadas",
    testBody: "Este es un mensaje de prueba de Clawd on Desk. Si puedes leerlo, las notificaciones funcionan.",
    wrapStatus: (status) => `(${status})`,
  },
});

function getLocale(lang) {
  return SLACK_LOCALES[lang] || SLACK_LOCALES.en;
}

function safeText(value) {
  return (typeof value === "string" ? value : String(value == null ? "" : value))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ");
}

// Slack mrkdwn only requires &, <, > to be escaped; everything else is literal.
// Escaping < is what stops an agent-derived string containing `<!channel>` or
// `<@U123>` from turning a notification into a real broadcast/mention — Slack
// renders the entities back as literal text.
function escapeMrkdwn(value) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Two sanitizers, because Slack treats the two text types differently:
//
//   - `plain_text` fields (header blocks) are NOT mrkdwn. Escaping there would
//     surface a literal "&amp;", and no mention syntax is interpreted — so they
//     need redaction only.
//   - `mrkdwn` fields AND the top-level fallback `text` ARE parsed (`mrkdwn`
//     defaults to true), so they need redaction *and* escaping.
//
// Every user/agent-derived string — session title, folder, host, agent id, tool
// name, detail, assistant output, and the fallback text built from them — goes
// through one of these before it leaves the desktop.
function redactPlain(value) {
  return redactSecrets(safeText(value));
}

function redactMrkdwn(value) {
  return escapeMrkdwn(redactSecrets(safeText(value)));
}

function formatDisplaySessionTag(entry) {
  const tag = getEntryDisplaySessionTag(entry);
  if (!DISPLAY_SESSION_TAG_RE.test(tag)) return "";
  return `#${escapeMrkdwn(tag.toLowerCase())}`;
}

function shortenedIdentifierCandidate(value) {
  const text = safeText(value);
  if (!text) return "";
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

function identifierFallbackTitleCandidates(entry) {
  const candidates = new Set();
  if (!entry || typeof entry !== "object") return candidates;
  const ids = [entry.rawSessionId, entry.id];
  for (const value of ids) {
    const raw = safeText(value);
    if (!raw) continue;
    candidates.add(shortenedIdentifierCandidate(raw));
    for (const prefix of ["qoderwork:", "qwenwork:"]) {
      if (raw.startsWith(prefix)) {
        candidates.add(shortenedIdentifierCandidate(raw.slice(prefix.length) || raw));
      }
    }
  }
  return candidates;
}

function completionDisplayTitle(entry, locale) {
  const fallback = locale.session;
  const title = entry && typeof entry.displayTitle === "string" ? entry.displayTitle : "";
  if (!title.trim()) return fallback;
  if (identifierFallbackTitleCandidates(entry).has(title)) return fallback;
  return title;
}

function clip(value, maxLength) {
  const text = safeText(value);
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  let result = "";
  let length = 0;
  for (const character of text) {
    if (length + character.length > maxLength) break;
    result += character;
    length += character.length;
  }
  return result;
}

function truncateMiddle(text, maxLen) {
  const value = safeText(text);
  if (value.length <= maxLen) return { text: value, truncated: false };
  const marker = "\n...[truncated]...\n";
  if (maxLen <= marker.length + 20) {
    return { text: clip(value, maxLen), truncated: true };
  }
  const keep = maxLen - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const safeHead = clip(value, head);
  let safeTail = "";
  let safeTailLength = 0;
  for (const character of Array.from(value).reverse()) {
    if (safeTailLength + character.length > tail) break;
    safeTail = `${character}${safeTail}`;
    safeTailLength += character.length;
  }
  return { text: `${safeHead}${marker}${safeTail}`, truncated: true };
}

function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function entryFolderName(entry) {
  if (!entry || typeof entry !== "object") return "";
  // An explicit empty displayFolder is meaningful: snapshot construction uses
  // it to suppress opaque QwenWork/QoderWork workspace ids. Falling back with
  // `entry.displayFolder || folderName(entry.cwd)` would reintroduce the leak.
  if (Object.prototype.hasOwnProperty.call(entry, "displayFolder")) {
    return folderName(entry.displayFolder);
  }
  // Compatibility for direct formatter callers and older cached snapshots.
  return folderName(entry.cwd);
}

// Clipping escaped text can land inside an entity ("...&am"), which Slack would
// render as literal garbage instead of the character it stands for. Escaping is
// what makes <!channel> inert, so dropping the half-entity is the safe end:
// worst case one character of content is lost. A complete "&amp;" ends in ";"
// and is left alone.
function clipMrkdwn(value, maxLength) {
  return clip(value, maxLength).replace(/&[A-Za-z]{0,4}$/, "");
}


// Questions arrive raw from the agent — buildRemoteElicitationPayload passes
// toolInput.questions straight through, and Telegram and Feishu each sanitise
// on their own side. Slack has to do the same: redact, escape, and clamp.
// The counts match the other channels so one agent cannot flood a card.
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 5;
const QUESTION_MAX = 240;
const QUESTION_HEADER_MAX = 80;
const OPTION_LABEL_MAX = 80;

function renderQuestions(rawQuestions, locale) {
  const questions = Array.isArray(rawQuestions)
    ? rawQuestions.filter((question) => question && typeof question === "object")
    : [];
  const shown = questions.slice(0, MAX_QUESTIONS);
  const omittedQuestions = questions.length - shown.length;
  const sections = [];
  shown.forEach((question, index) => {
    const header = clipMrkdwn(redactMrkdwn(question.header || "").trim(), QUESTION_HEADER_MAX)
      || interpolate(locale.questionNumber, "{n}", String(index + 1));
    const body = clipMrkdwn(redactMrkdwn(question.question || ""), QUESTION_MAX);
    const options = Array.isArray(question.options) ? question.options : [];
    const optionLabels = options.map((option) => {
      const label = option && typeof option === "object" ? option.label : option;
      return clipMrkdwn(redactMrkdwn(label || "").trim(), OPTION_LABEL_MAX);
    }).filter(Boolean);
    const optionLines = [];
    const baseLines = [`*${header}*`, body].filter(Boolean);
    const questionOmission = index === shown.length - 1 && omittedQuestions > 0
      ? interpolate(locale.andMore, "{n}", String(omittedQuestions))
      : "";
    for (const label of optionLabels.slice(0, MAX_OPTIONS)) {
      const candidate = `  • ${label}`;
      const omittedAfterCandidate = optionLabels.length - optionLines.length - 1;
      const optionOmission = omittedAfterCandidate > 0
        ? `  • ${interpolate(locale.andMore, "{n}", String(omittedAfterCandidate))}`
        : "";
      const candidateLines = [...baseLines, ...optionLines, candidate];
      if (optionOmission) candidateLines.push(optionOmission);
      if (questionOmission) candidateLines.push("", questionOmission);
      if (candidateLines.join("\n").length > SECTION_MAX) {
        break;
      }
      optionLines.push(candidate);
    }
    const omittedOptions = optionLabels.length - optionLines.length;
    if (omittedOptions > 0) {
      optionLines.push(`  • ${interpolate(locale.andMore, "{n}", String(omittedOptions))}`);
    }
    // A question owns its section block. The admission check above reserves
    // room for every omission marker, so sectionBlock never has to cut through
    // an option line just because earlier questions consumed a shared budget.
    const sectionLines = [...baseLines, ...optionLines];
    if (questionOmission) sectionLines.push("", questionOmission);
    sections.push(sectionLines.join("\n"));
  });
  return sections;
}

function interpolate(template, token, value) {
  return String(template == null ? "" : template).split(token).join(value);
}

function headerBlock(text) {
  return { type: "header", text: { type: "plain_text", text: clip(text, HEADER_MAX) || " ", emoji: true } };
}

function sectionBlock(mrkdwnText) {
  return { type: "section", text: { type: "mrkdwn", text: clipMrkdwn(mrkdwnText, SECTION_MAX) } };
}

function contextBlock(mrkdwnText) {
  return { type: "context", elements: [{ type: "mrkdwn", text: clipMrkdwn(mrkdwnText, SECTION_MAX) }] };
}

// Break any embedded ``` so it can't close our fenced code block early.
function neutralizeFences(text) {
  return safeText(text).replace(/`/g, "`\u200b");
}

function prepareAssistantOutput(entry) {
  const raw = entry && typeof entry.assistantLastOutput === "string" ? entry.assistantLastOutput : "";
  let text = safeText(raw).replace(/[ \t]+\n/g, "\n").trim();
  if (!text) return null;
  text = redactSecrets(text);
  const limited = truncateMiddle(text, OUTPUT_MAX);
  return {
    text: limited.text,
    truncated: limited.truncated || !!(entry && entry.assistantLastOutputTruncated === true),
  };
}

function metaLine(entry) {
  const meta = [];
  if (entry.agentId) meta.push(redactMrkdwn(entry.agentId));
  const folder = entryFolderName(entry);
  if (folder) meta.push(redactMrkdwn(folder));
  if (entry.host) meta.push(redactMrkdwn(entry.host));
  const displaySessionTag = formatDisplaySessionTag(entry);
  if (displaySessionTag) meta.push(displaySessionTag);
  return meta.join(" · ");
}

// Completion ping. `includeOutput` mirrors the Telegram companion's
// outputMode === "full"; when false, only the title + metadata are sent.
function buildCompletionMessage(entry, options = {}) {
  if (!entry) return null;
  const locale = getLocale(options.lang);
  const interrupted = entry.badge === "interrupted";
  const icon = interrupted ? "⚠️" : "✅";
  const status = interrupted ? locale.interrupted : locale.done;
  // The session title is derived from the user's own prompt, so it gets the
  // same treatment as assistant output — redacted everywhere, and escaped in
  // the two mrkdwn-parsed places (there are none in a header block).
  const rawTitle = completionDisplayTitle(entry, locale);
  const wrapStatus = typeof locale.wrapStatus === "function" ? locale.wrapStatus(status) : `(${status})`;

  const blocks = [headerBlock(`${icon} ${redactPlain(rawTitle)}`)];
  const meta = metaLine(entry);
  const statusLine = `*${escapeMrkdwn(status)}*${meta ? `  ·  ${meta}` : ""}`;
  blocks.push(sectionBlock(statusLine));

  const prepared = options.includeOutput ? prepareAssistantOutput(entry) : null;
  if (prepared) {
    // Slack still parses &, < and > inside a fenced block, so escape there too —
    // a code fence is not a mention-proof container.
    const body = escapeMrkdwn(neutralizeFences(prepared.text));
    const clipped = clipMrkdwn(body, SECTION_MAX - 8);
    // Escaping expands: one "<" becomes four characters. Text that fit the raw
    // budget can therefore overflow the block limit and lose its tail here,
    // long after prepareAssistantOutput decided whether it was truncated. Ask
    // the final string, not the intermediate one, or the label tells the reader
    // an answer is complete when most of it was dropped.
    const truncated = prepared.truncated || clipped.length < body.length;
    const label = truncated ? `${locale.assistantOutput} (${locale.truncated})` : locale.assistantOutput;
    blocks.push(sectionBlock(`*${escapeMrkdwn(label)}:*`));
    blocks.push(sectionBlock("```\n" + clipped + "\n```"));
  }

  const fallbackFolder = redactMrkdwn(entryFolderName(entry));
  const fallbackTag = formatDisplaySessionTag(entry);
  const fallbackMeta = [];
  if (fallbackFolder) fallbackMeta.push(fallbackFolder);
  if (fallbackTag) fallbackMeta.push(fallbackTag);
  const fallback = clipMrkdwn(
    `${icon} ${redactMrkdwn(rawTitle)} ${wrapStatus}${fallbackMeta.length ? ` — ${fallbackMeta.join(" · ")}` : ""}`,
    FALLBACK_MAX
  );
  return { text: fallback, blocks };
}

// Read-only "permission needed" heads-up. Slack cannot resolve the approval in
// this build, so the message tells the user to act in the desktop app.
function buildPermissionMessage(payload, options = {}) {
  const locale = getLocale(options.lang);
  const p = payload && typeof payload === "object" ? payload : {};

  // Two axes, carried from the route rather than guessed here:
  //   kind          — is this a decision, or a question the agent asked?
  //   actionTarget  — where the human actually acts.
  // An AskUserQuestion has capabilities.allowDeny === false, so Allow/Deny
  // wording is not merely wrong for it, it describes an action that does not
  // exist. And a remote-only entry has no desktop bubble by construction, so
  // pointing at the app sends the reader somewhere empty.
  const isQuestion = p.kind === "question";
  const remote = p.actionTarget === "remote";
  const title = isQuestion ? locale.questionTitle : locale.permissionTitle;
  const icon = isQuestion ? "❓" : "⏳";
  const hint = isQuestion
    ? (remote ? locale.questionHintRemote : locale.questionHint)
    : (remote ? locale.permissionHintRemote : locale.permissionHint);

  const rawTitle = safeText(p.title).trim() || title;
  const blocks = [headerBlock(`${icon} ${title}`)];

  // The elicitation payload's title is a hardcoded English `${agent} needs
  // input`, and it repeats what the header and the Agent field already say — so
  // a question card drops it rather than dropping an English sentence into a
  // translated card.
  const lines = isQuestion ? [] : [`*${redactMrkdwn(rawTitle)}*`];
  const fields = [];
  // A question has no tool to approve; naming one invites the reader to think
  // there is something to allow.
  if (!isQuestion && p.toolName) fields.push(`*${escapeMrkdwn(locale.tool)}:* ${redactMrkdwn(p.toolName)}`);
  if (p.agentId) fields.push(`*${escapeMrkdwn(locale.agent)}:* ${redactMrkdwn(p.agentId)}`);
  const folder = folderName(p.folder || p.cwd);
  if (folder) fields.push(`*${escapeMrkdwn(locale.folder)}:* ${redactMrkdwn(folder)}`);
  if (fields.length) lines.push(fields.join("\n"));

  if (isQuestion) {
    // The whole point: show what was actually asked. The approval summary
    // builder can never find a description for an AskUserQuestion, so it
    // always produced "No description available" here.
    const questionSections = renderQuestions(p.questions, locale);
    if (lines.length) blocks.push(sectionBlock(lines.join("\n\n")));
    for (const questionSection of questionSections) {
      blocks.push(sectionBlock(questionSection));
    }
  } else {
    const detail = safeText(p.detail || p.summary).trim();
    if (detail) lines.push(redactMrkdwn(detail));
    blocks.push(sectionBlock(lines.join("\n\n")));
  }
  blocks.push(contextBlock(`ℹ️ ${escapeMrkdwn(hint)}`));

  const subject = isQuestion ? redactMrkdwn(p.agentId || "") : redactMrkdwn(rawTitle);
  const fallback = subject ? `${icon} ${title}: ${subject}` : `${icon} ${title}`;
  return { text: clipMrkdwn(fallback, FALLBACK_MAX), blocks };
}

function buildTestMessage(options = {}) {
  const locale = getLocale(options.lang);
  return {
    text: locale.testTitle,
    blocks: [headerBlock(`🦀 ${locale.testTitle}`), sectionBlock(escapeMrkdwn(locale.testBody))],
  };
}

module.exports = {
  buildCompletionMessage,
  buildPermissionMessage,
  buildTestMessage,
  prepareAssistantOutput,
  neutralizeFences,
  escapeMrkdwn,
  redactPlain,
  redactMrkdwn,
  truncateMiddle,
  getLocale,
  SLACK_LOCALES,
  HEADER_MAX,
  SECTION_MAX,
  OUTPUT_MAX,
};
