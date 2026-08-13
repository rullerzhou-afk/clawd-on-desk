"use strict";

const MarkdownIt = require("markdown-it");

const DEFAULT_MAX_LENGTH = 3800;
const DEFAULT_TRUNCATION_MARKER = "\n...[truncated]...";
const MESSAGE_SEGMENTS = Symbol("telegram-message-segments");
const ALLOWED_TAGS = new Set(["a", "b", "blockquote", "code", "i", "pre", "s"]);

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});
// `linkify` controls bare-URL recognition. CommonMark `<scheme:value>`
// autolinks are a separate rule, and redaction placeholders such as
// `<redacted:token>` satisfy that grammar unless this rule is disabled.
markdown.disable(["autolink"]);
// Let the token layer expose every explicit Markdown destination. The custom
// renderer below applies the real allowlist and degrades rejected schemes to
// visible, non-clickable text; no markdown-it-generated href is ever emitted.
markdown.validateLink = () => true;

function safeText(value) {
  return (typeof value === "string" ? value : String(value == null ? "" : value))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ");
}

function escapeTelegramHtml(value) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTelegramAttribute(value) {
  return escapeTelegramHtml(value).replace(/"/g, "&quot;");
}

function neutralizeTelegramMentions(value) {
  return safeText(value).replace(
    /(^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{5,32})\b/gu,
    (_match, prefix, username) => `${prefix}＠${username}`,
  );
}

function sanitizeTelegramUrl(value) {
  const raw = safeText(value).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

function displayRejectedDestination(value) {
  const raw = safeText(value).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString().slice(0, 500);
    }
  } catch {}
  return raw.slice(0, 500);
}

function clipUtf16Safe(value, maxLength) {
  if (maxLength <= 0) return "";
  const text = safeText(value);
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

function tagOpen(name, attributes = "") {
  if (!ALLOWED_TAGS.has(name)) throw new Error("Telegram formatter tag is not allowed");
  return { kind: "open", html: `<${name}${attributes}>`, closeHtml: `</${name}>` };
}

function tagClose(name) {
  if (!ALLOWED_TAGS.has(name)) throw new Error("Telegram formatter tag is not allowed");
  return { kind: "close", html: `</${name}>` };
}

function textSegment(htmlText, plainText = htmlText, options = {}) {
  return {
    kind: "text",
    htmlText: safeText(htmlText),
    plainText: safeText(plainText),
    atomic: options.atomic === true,
  };
}

function rawMessageSegment(message) {
  if (!isFormattedTelegramMessage(message)) {
    throw new Error("Telegram formatted message contract is required");
  }
  return {
    kind: "raw-message",
    html: message.html,
    plainText: message.plainText,
    htmlVisibleLength: message.htmlVisibleLength,
    plainVisibleLength: message.plainVisibleLength,
    truncated: message.truncated === true,
  };
}

function measureSegments(segments) {
  let htmlVisibleLength = 0;
  let plainVisibleLength = 0;
  for (const segment of segments) {
    if (segment.kind === "text") {
      htmlVisibleLength += segment.htmlText.length;
      plainVisibleLength += segment.plainText.length;
    } else if (segment.kind === "raw-message") {
      htmlVisibleLength += segment.htmlVisibleLength;
      plainVisibleLength += segment.plainVisibleLength;
    }
  }
  return { htmlVisibleLength, plainVisibleLength };
}

function assertTelegramHtmlAllowlist(html) {
  const source = String(html || "");
  const tagRe = /<\/?([a-z][a-z0-9-]*)([^>]*)>/gi;
  let match;
  while ((match = tagRe.exec(source))) {
    const name = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) throw new Error("Telegram formatter emitted a disallowed tag");
    const closing = source[match.index + 1] === "/";
    const attributes = match[2] || "";
    if (closing && attributes.trim()) throw new Error("Telegram formatter emitted invalid closing-tag attributes");
    if (name === "a" && !closing) {
      if (!/^ href="(?:[^"<>&]|&amp;|&quot;|&lt;|&gt;)*"$/.test(attributes)) {
        throw new Error("Telegram formatter emitted a disallowed link attribute");
      }
    } else if (attributes.trim()) {
      throw new Error("Telegram formatter emitted disallowed tag attributes");
    }
  }
  return true;
}

function materializeSegments(rawSegments, options = {}) {
  const segments = Array.isArray(rawSegments) ? rawSegments.slice() : [];
  const maxLength = Number.isFinite(options.maxLength) && options.maxLength >= 0
    ? Math.floor(options.maxLength)
    : DEFAULT_MAX_LENGTH;
  const marker = safeText(options.truncationMarker == null
    ? DEFAULT_TRUNCATION_MARKER
    : options.truncationMarker);
  const measured = measureSegments(segments);
  const needsTruncation = measured.htmlVisibleLength > maxLength
    || measured.plainVisibleLength > maxLength;
  const contentLimit = needsTruncation ? Math.max(0, maxLength - marker.length) : maxLength;
  let html = "";
  let plainText = "";
  let htmlVisibleLength = 0;
  let plainVisibleLength = 0;
  const openTags = [];
  let truncated = false;

  for (const segment of segments) {
    if (segment.kind === "open") {
      html += segment.html;
      openTags.push(segment.closeHtml);
      continue;
    }
    if (segment.kind === "close") {
      html += segment.html;
      if (openTags.length) openTags.pop();
      continue;
    }
    if (segment.kind === "raw-message") {
      const htmlRemaining = contentLimit - htmlVisibleLength;
      const plainRemaining = contentLimit - plainVisibleLength;
      if (
        segment.htmlVisibleLength <= htmlRemaining
        && segment.plainVisibleLength <= plainRemaining
      ) {
        html += segment.html;
        plainText += segment.plainText;
        htmlVisibleLength += segment.htmlVisibleLength;
        plainVisibleLength += segment.plainVisibleLength;
        continue;
      }
      truncated = true;
      break;
    }
    if (segment.kind !== "text") continue;

    const htmlRemaining = contentLimit - htmlVisibleLength;
    const plainRemaining = contentLimit - plainVisibleLength;
    const fits = segment.htmlText.length <= htmlRemaining
      && segment.plainText.length <= plainRemaining;
    if (fits) {
      html += escapeTelegramHtml(segment.htmlText);
      plainText += segment.plainText;
      htmlVisibleLength += segment.htmlText.length;
      plainVisibleLength += segment.plainText.length;
      continue;
    }

    if (!segment.atomic && segment.htmlText === segment.plainText) {
      const clipped = clipUtf16Safe(segment.htmlText, Math.max(0, Math.min(htmlRemaining, plainRemaining)));
      if (clipped) {
        html += escapeTelegramHtml(clipped);
        plainText += clipped;
        htmlVisibleLength += clipped.length;
        plainVisibleLength += clipped.length;
      }
    }
    truncated = true;
    break;
  }

  if (needsTruncation || truncated) {
    while (openTags.length) html += openTags.pop();
    const htmlMarker = clipUtf16Safe(marker, Math.max(0, maxLength - htmlVisibleLength));
    const plainMarker = clipUtf16Safe(marker, Math.max(0, maxLength - plainVisibleLength));
    html += escapeTelegramHtml(htmlMarker);
    plainText += plainMarker;
    htmlVisibleLength += htmlMarker.length;
    plainVisibleLength += plainMarker.length;
    truncated = true;
  }

  assertTelegramHtmlAllowlist(html);
  const frozenSegments = Object.freeze(segments.map((segment) => Object.freeze({ ...segment })));
  const message = {
    html,
    plainText,
    htmlVisibleLength,
    plainVisibleLength,
    budgetLength: Math.max(htmlVisibleLength, plainVisibleLength),
    truncated: truncated
      || options.reportedTruncated === true
      || segments.some((segment) => segment.kind === "raw-message" && segment.truncated === true),
  };
  Object.defineProperty(message, MESSAGE_SEGMENTS, { value: frozenSegments });
  return Object.freeze(message);
}

function isFormattedTelegramMessage(value) {
  return !!(
    value
    && typeof value === "object"
    && typeof value.html === "string"
    && typeof value.plainText === "string"
    && Array.isArray(value[MESSAGE_SEGMENTS])
  );
}

class SegmentWriter {
  constructor() {
    this.segments = [];
    this.quoteDepth = 0;
    this.plainLineStart = true;
    this.plainTail = "";
  }

  _pushText(htmlText, plainText, options = {}) {
    const segment = textSegment(htmlText, plainText, options);
    this.segments.push(segment);
    this.plainLineStart = segment.plainText.endsWith("\n");
    this.plainTail = `${this.plainTail}${segment.plainText}`.slice(-4);
  }

  write(value, options = {}) {
    const raw = safeText(value);
    const neutralize = options.neutralizeMentions !== false;
    const prepared = neutralize ? neutralizeTelegramMentions(raw) : raw;
    const chunks = prepared.split(/(\n)/);
    for (const chunk of chunks) {
      if (!chunk) continue;
      if (chunk === "\n") {
        this._pushText("\n", "\n");
        continue;
      }
      if (this.plainLineStart && this.quoteDepth > 0) {
        this._pushText("", "> ", { atomic: true });
      }
      this._pushText(chunk, chunk, options);
    }
  }

  writePair(htmlText, plainText, options = {}) {
    let htmlValue = safeText(htmlText);
    let plainValue = safeText(plainText);
    if (options.neutralizeMentions !== false) {
      htmlValue = neutralizeTelegramMentions(htmlValue);
      plainValue = neutralizeTelegramMentions(plainValue);
    }
    if (this.plainLineStart && this.quoteDepth > 0 && plainValue && plainValue !== "\n") {
      this._pushText("", "> ", { atomic: true });
    }
    this._pushText(htmlValue, plainValue, { atomic: options.atomic !== false });
  }

  open(name, attributes = "") {
    this.segments.push(tagOpen(name, attributes));
  }

  close(name) {
    this.segments.push(tagClose(name));
  }

  trailingNewlines() {
    const match = this.plainTail.match(/\n+$/);
    return match ? match[0].length : 0;
  }

  ensureNewlines(count) {
    const missing = Math.max(0, count - this.trailingNewlines());
    if (missing) this.write("\n".repeat(missing), { neutralizeMentions: false });
  }
}

function tokensToTree(tokens) {
  const root = { type: "root", children: [] };
  const stack = [root];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { type: token.type, token, children: [] };
    stack[stack.length - 1].children.push(node);
    if (Array.isArray(token.children) && token.children.length) {
      node.children = tokensToTree(token.children).children;
    }
    if (token.nesting === 1) stack.push(node);
  }
  return root;
}

function collectNodeText(node) {
  if (!node) return "";
  if (node.type === "text" || node.type === "code_inline" || node.type === "code_block" || node.type === "fence") {
    return safeText(node.token && node.token.content);
  }
  if (node.type === "softbreak" || node.type === "hardbreak") return "\n";
  if (node.type === "image") return safeText((node.token && node.token.content) || "");
  if (node.type === "html_inline" || node.type === "html_block") return safeText(node.token && node.token.content);
  return (node.children || []).map(collectNodeText).join("");
}

function tableRows(node) {
  const rows = [];
  function visit(current) {
    if (!current) return;
    if (current.type === "tr_open") {
      const cells = (current.children || [])
        .filter((child) => child.type === "th_open" || child.type === "td_open")
        .map((cell) => collectNodeText(cell).replace(/\s+/g, " ").trim());
      rows.push(cells);
      return;
    }
    for (const child of current.children || []) visit(child);
  }
  visit(node);
  return rows;
}

function renderNodes(nodes, writer, context = {}) {
  for (const node of nodes || []) renderNode(node, writer, context);
}

function renderLink(node, writer, context) {
  const href = node.token && typeof node.token.attrGet === "function" ? node.token.attrGet("href") : "";
  const normalized = sanitizeTelegramUrl(href);
  const label = collectNodeText(node).trim();
  if (!normalized) {
    renderNodes(node.children, writer, context);
    const destination = displayRejectedDestination(href);
    if (destination && destination !== label) {
      writer.write(` (${destination})`);
    }
    return;
  }

  writer.open("a", ` href="${escapeTelegramAttribute(normalized)}"`);
  renderNodes(node.children, writer, context);
  writer.close("a");
  let hostname = "";
  try { hostname = new URL(normalized).hostname; } catch {}
  const labelLower = label.toLowerCase();
  if (hostname && !labelLower.includes(hostname.toLowerCase()) && label !== normalized) {
    writer.writePair(` (${hostname})`, ` (${normalized})`, {
      atomic: true,
    });
  }
}

function renderImage(node, writer) {
  const source = node.token && typeof node.token.attrGet === "function" ? node.token.attrGet("src") : "";
  const alt = safeText((node.token && node.token.content) || "").trim();
  const destination = sanitizeTelegramUrl(source) || displayRejectedDestination(source);
  writer.write("🖼", { neutralizeMentions: false });
  if (alt || destination) writer.write(` ${alt || destination}`);
  if (alt && destination) writer.write(` (${destination})`);
}

function renderTable(node, writer, context = {}) {
  const rows = tableRows(node);
  if (!rows.length) return;
  const text = rows.map((cells) => cells.join(" | ")).join("\n");
  if (!context.inBlockquote) writer.open("pre");
  writer.write(text);
  if (!context.inBlockquote) writer.close("pre");
  writer.ensureNewlines(2);
}

function renderList(node, writer, context, ordered) {
  const items = (node.children || []).filter((child) => child.type === "list_item_open");
  let start = 1;
  if (ordered && node.token && typeof node.token.attrGet === "function") {
    const rawStart = node.token.attrGet("start");
    const parsed = Number(rawStart);
    if (rawStart != null && Number.isInteger(parsed)) start = parsed;
  }
  items.forEach((item, index) => {
    writer.write(ordered ? `${start + index}. ` : "• ", { neutralizeMentions: false });
    renderNodes(item.children, writer, { ...context, inListItem: true });
    writer.ensureNewlines(1);
  });
  writer.ensureNewlines(2);
}

function renderNode(node, writer, context = {}) {
  switch (node.type) {
    case "root":
      renderNodes(node.children, writer, context);
      break;
    case "inline":
      renderNodes(node.children, writer, context);
      break;
    case "paragraph_open":
      renderNodes(node.children, writer, context);
      writer.ensureNewlines(context.inListItem ? 1 : 2);
      break;
    case "heading_open":
      writer.open("b");
      renderNodes(node.children, writer, context);
      writer.close("b");
      writer.ensureNewlines(2);
      break;
    case "strong_open":
      writer.open("b");
      renderNodes(node.children, writer, context);
      writer.close("b");
      break;
    case "em_open":
      writer.open("i");
      renderNodes(node.children, writer, context);
      writer.close("i");
      break;
    case "s_open":
      writer.open("s");
      renderNodes(node.children, writer, context);
      writer.close("s");
      break;
    case "link_open":
      renderLink(node, writer, context);
      break;
    case "image":
      renderImage(node, writer);
      break;
    case "text":
      writer.write(node.token && node.token.content, { neutralizeMentions: !context.code });
      break;
    case "softbreak":
    case "hardbreak":
      writer.write("\n", { neutralizeMentions: false });
      break;
    case "code_inline":
      writer.open("code");
      writer.write(node.token && node.token.content, { neutralizeMentions: false });
      writer.close("code");
      break;
    case "fence":
    case "code_block":
      if (!context.inBlockquote) {
        writer.open("pre");
        writer.open("code");
      }
      writer.write(node.token && node.token.content, { neutralizeMentions: false });
      if (!context.inBlockquote) {
        writer.close("code");
        writer.close("pre");
      }
      writer.ensureNewlines(2);
      break;
    case "blockquote_open": {
      const outermost = writer.quoteDepth === 0;
      if (outermost) writer.open("blockquote");
      writer.quoteDepth += 1;
      renderNodes(node.children, writer, { ...context, inBlockquote: true });
      writer.quoteDepth -= 1;
      if (outermost) writer.close("blockquote");
      writer.ensureNewlines(2);
      break;
    }
    case "bullet_list_open":
      renderList(node, writer, context, false);
      break;
    case "ordered_list_open":
      renderList(node, writer, context, true);
      break;
    case "list_item_open":
      renderNodes(node.children, writer, { ...context, inListItem: true });
      break;
    case "table_open":
      renderTable(node, writer, context);
      break;
    case "hr":
      writer.write("────────", { neutralizeMentions: false });
      writer.ensureNewlines(2);
      break;
    case "html_inline":
    case "html_block":
      writer.write(node.token && node.token.content);
      break;
    default:
      if (node.children && node.children.length) renderNodes(node.children, writer, context);
      else if (node.token && node.token.content) writer.write(node.token.content, context);
  }
}

function trimTrailingNewlines(segments) {
  const result = segments.slice();
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const segment = result[index];
    if (segment.kind !== "text") continue;
    const htmlText = segment.htmlText.replace(/\n+$/g, "");
    const plainText = segment.plainText.replace(/\n+$/g, "");
    if (!htmlText && !plainText) {
      result.splice(index, 1);
      continue;
    }
    result[index] = { ...segment, htmlText, plainText };
    break;
  }
  return result;
}

function renderTelegramMarkdown(value, options = {}) {
  const source = safeText(value);
  const writer = new SegmentWriter();
  try {
    const tree = tokensToTree(markdown.parse(source, {}));
    renderNode(tree, writer);
  } catch {
    // The fallback deliberately reports no parser/input detail.
    return plainTelegramText(source, options);
  }
  return materializeSegments(trimTrailingNewlines(writer.segments), options);
}

function plainTelegramText(value, options = {}) {
  const writer = new SegmentWriter();
  writer.write(value, { neutralizeMentions: options.neutralizeMentions === true });
  return materializeSegments(writer.segments, options);
}

function appendPartSegments(target, part) {
  if (isFormattedTelegramMessage(part)) {
    // A formatted message has already enforced its own token-aware budget and
    // balanced its tags. Keep that result atomic when composing a larger card;
    // reopening its source segments would discard its truncation marker and
    // let the outer budget silently re-emit content the inner budget rejected.
    target.push(rawMessageSegment(part));
    return;
  }
  if (part && typeof part === "object" && Object.prototype.hasOwnProperty.call(part, "text")) {
    if (part.bold === true) target.push(tagOpen("b"));
    if (part.code === true) target.push(tagOpen("code"));
    const value = part.neutralizeMentions === true
      ? neutralizeTelegramMentions(part.text)
      : safeText(part.text);
    target.push(textSegment(value));
    if (part.code === true) target.push(tagClose("code"));
    if (part.bold === true) target.push(tagClose("b"));
    return;
  }
  target.push(textSegment(safeText(part)));
}

function concatTelegramParts(parts, options = {}) {
  const segments = [];
  for (const part of Array.isArray(parts) ? parts : []) appendPartSegments(segments, part);
  return materializeSegments(segments, options);
}

function appendTelegramStatus(message, status, options = {}) {
  if (!isFormattedTelegramMessage(message)) {
    throw new Error("Telegram formatted message contract is required");
  }
  const maxLength = Number.isFinite(options.maxLength) && options.maxLength >= 0
    ? Math.floor(options.maxLength)
    : DEFAULT_MAX_LENGTH;
  const separator = "\n\n";
  const statusMessage = concatTelegramParts([
    { text: status, bold: options.bold !== false },
  ], {
    maxLength: Math.max(0, maxLength - separator.length),
    truncationMarker: options.truncationMarker,
  });
  const baseBudget = Math.max(0, maxLength - separator.length - statusMessage.budgetLength);
  const boundedBase = materializeSegments(message[MESSAGE_SEGMENTS], {
    maxLength: baseBudget,
    truncationMarker: options.truncationMarker,
  });
  return materializeSegments([
    rawMessageSegment(boundedBase),
    textSegment(separator),
    rawMessageSegment(statusMessage),
  ], {
    maxLength,
    truncationMarker: options.truncationMarker,
    reportedTruncated: message.truncated || boundedBase.truncated || statusMessage.truncated,
  });
}

function buildTelegramApprovalMessage(payload, options = {}) {
  const title = safeText(payload && payload.title).trim();
  if (!title) return null;
  const parts = [{ text: title, bold: true, neutralizeMentions: true }];
  const fields = Array.isArray(payload && payload.fields) ? payload.fields : [];
  if (fields.length) {
    for (const field of fields) {
      const label = safeText(field && field.label).trim();
      const value = safeText(field && field.value).trim();
      if (!label || !value) continue;
      parts.push("\n\n", { text: `${label}:`, bold: true }, " ", {
        text: value,
        neutralizeMentions: true,
      });
    }
  } else {
    const detail = safeText(payload && payload.detail).trim();
    if (detail) parts.push("\n\n", { text: detail, neutralizeMentions: true });
  }
  return concatTelegramParts(parts, {
    maxLength: options.maxLength || DEFAULT_MAX_LENGTH,
    truncationMarker: options.truncationMarker,
  });
}

function isTelegramHtmlParseError(error) {
  const candidates = [
    error && error.status,
    error && error.statusCode,
    error && error.error_code,
    error && error.code,
    error && error.response && error.response.error_code,
  ];
  const is400 = candidates.some((value) => Number(value) === 400);
  if (!is400) return false;
  const description = [
    error && error.description,
    error && error.message,
    error && error.response && error.response.description,
  ].find((value) => typeof value === "string") || "";
  return /can't parse entities/i.test(description);
}

module.exports = {
  appendTelegramStatus,
  assertTelegramHtmlAllowlist,
  buildTelegramApprovalMessage,
  clipUtf16Safe,
  concatTelegramParts,
  escapeTelegramHtml,
  isFormattedTelegramMessage,
  isTelegramHtmlParseError,
  neutralizeTelegramMentions,
  plainTelegramText,
  renderTelegramMarkdown,
  sanitizeTelegramUrl,
};
