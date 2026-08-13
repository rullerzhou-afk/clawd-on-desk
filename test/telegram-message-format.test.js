"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendTelegramStatus,
  assertTelegramHtmlAllowlist,
  buildTelegramApprovalMessage,
  clipUtf16Safe,
  isTelegramHtmlParseError,
  neutralizeTelegramMentions,
  plainTelegramText,
  renderTelegramMarkdown,
  sanitizeTelegramUrl,
} = require("../src/telegram-message-format");

test("renders a conservative Telegram HTML subset and readable plain fallback", () => {
  const message = renderTelegramMarkdown([
    "# Heading",
    "",
    "**bold** *italic* ~~strike~~ and `x < y`",
    "",
    "```js",
    "const tag = '<b>not html</b>';",
    "```",
  ].join("\n"));

  assert.match(message.html, /^<b>Heading<\/b>/);
  assert.match(message.html, /<b>bold<\/b>/);
  assert.match(message.html, /<i>italic<\/i>/);
  assert.match(message.html, /<s>strike<\/s>/);
  assert.match(message.html, /<code>x &lt; y<\/code>/);
  assert.match(message.html, /<pre><code>const tag = '&lt;b&gt;not html&lt;\/b&gt;';<\/code><\/pre>/);
  assert.match(message.plainText, /^Heading\n\nbold italic strike and x < y/);
  assert.match(message.plainText, /const tag = '<b>not html<\/b>';/);
  assert.equal(assertTelegramHtmlAllowlist(message.html), true);
});

test("redaction placeholders and raw Telegram tags remain escaped literal text", () => {
  const markers = [
    "<redacted:telegram-token>",
    "<redacted:token>",
    "<redacted:aws-key>",
    "<redacted:secretish>",
  ];
  const message = renderTelegramMarkdown(`${markers.join(" ")} <tg-time unix="1">now</tg-time> <script>x</script>`);

  for (const marker of markers) {
    assert.match(message.html, new RegExp(marker.replace(/[<>]/g, (value) => value === "<" ? "&lt;" : "&gt;")));
  }
  assert.doesNotMatch(message.html, /<a\b/);
  assert.match(message.html, /&lt;tg-time unix="1"&gt;now&lt;\/tg-time&gt;/);
  assert.match(message.html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test("allows only credential-free HTTP links and visibly degrades rejected links and images", () => {
  const safe = renderTelegramMarkdown("[docs](https://example.com/a?x=1&y=2)");
  assert.match(safe.html, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2">docs<\/a> \(example\.com\)/);
  assert.match(safe.plainText, /docs \(https:\/\/example\.com\/a\?x=1&y=2\)/);

  const mentionPath = renderTelegramMarkdown("[profile](https://example.com/@username)");
  assert.match(mentionPath.html, /href="https:\/\/example\.com\/@username"/);
  assert.match(mentionPath.plainText, /https:\/\/example\.com\/＠username/);
  assert.doesNotMatch(mentionPath.plainText, /\/@username/);

  const rejected = renderTelegramMarkdown([
    "[script](javascript:alert(1))",
    "[mention](tg://user?id=1)",
    "[unsafe mention](javascript:@username)",
    "[credential](https://user:secret@example.com/private)",
    "![alt](https://example.com/@username/image.png)",
  ].join("\n"));
  assert.doesNotMatch(rejected.html, /<a\b/);
  assert.match(rejected.plainText, /script \(javascript:alert\(1\)\)/);
  assert.match(rejected.plainText, /mention \(tg:\/\/user\?id=1\)/);
  assert.match(rejected.plainText, /unsafe mention \(javascript:＠username\)/);
  assert.doesNotMatch(rejected.plainText, /user:secret/);
  assert.match(rejected.plainText, /🖼 alt \(https:\/\/example\.com\/＠username\/image\.png\)/);

  assert.equal(sanitizeTelegramUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(sanitizeTelegramUrl("mailto:user@example.com"), null);
  assert.equal(sanitizeTelegramUrl("https://user:secret@example.com/x"), null);
});

test("maps breaks, tables, lists, and nested blockquotes without unsupported tags", () => {
  const message = renderTelegramMarkdown([
    "soft",
    "break",
    "",
    "hard  ",
    "break",
    "",
    "> outer",
    "> > inner",
    "",
    "1. one",
    "2. two",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n"));

  assert.doesNotMatch(message.html, /<br\b/i);
  assert.match(message.html, /soft\nbreak/);
  assert.match(message.html, /hard\nbreak/);
  assert.equal((message.html.match(/<blockquote>/g) || []).length, 1);
  assert.equal((message.html.match(/<\/blockquote>/g) || []).length, 1);
  assert.match(message.plainText, /> outer/);
  assert.match(message.plainText, /> inner/);
  assert.match(message.plainText, /1\. one\n2\. two/);
  assert.match(message.html, /<pre>A \| B\n1 \| 2<\/pre>/);

  const combined = renderTelegramMarkdown("> - item\n>\n> ```js\n> const x = '<tag>';\n> ```");
  assert.equal((combined.html.match(/<blockquote>/g) || []).length, 1);
  assert.doesNotMatch(combined.html, /<blockquote>[\s\S]*<pre>/, "block entities must not nest inside blockquotes");
  assert.match(combined.html, /• item/);
  assert.match(combined.html, /const x = '&lt;tag&gt;';/);
});

test("neutralizes username mentions only when requested and preserves code copy text", () => {
  assert.equal(neutralizeTelegramMentions("ping @username, email test@example.com"), "ping ＠username, email test@example.com");
  const message = renderTelegramMarkdown("ping @username, code `@username`, email test@example.com");
  assert.match(message.html, /ping ＠username/);
  assert.match(message.html, /<code>@username<\/code>/);
  assert.match(message.plainText, /code @username/);

  const fixed = plainTelegramText("fixed @username", { neutralizeMentions: false });
  assert.equal(fixed.plainText, "fixed @username");
});

test("budgets HTML-visible and plain representations independently without splitting surrogate pairs", () => {
  const quote = renderTelegramMarkdown("> one\n> two");
  assert.ok(quote.plainVisibleLength > quote.htmlVisibleLength);
  assert.equal(quote.budgetLength, quote.plainVisibleLength);

  const dense = Array.from({ length: 20 }, (_, index) => (
    `[L${index}](https://example.com/${"x".repeat(30)}/${index})`
  )).join(" ");
  const bounded = renderTelegramMarkdown(dense, { maxLength: 180, truncationMarker: "\n..." });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.htmlVisibleLength <= 180);
  assert.ok(bounded.plainVisibleLength <= 180);
  assert.equal(bounded.budgetLength, Math.max(bounded.htmlVisibleLength, bounded.plainVisibleLength));
  assert.doesNotMatch(bounded.html, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);

  assert.equal(clipUtf16Safe("ab😀cd", 3), "ab");
  assert.equal(clipUtf16Safe("ab😀cd", 4), "ab😀");
});

test("malformed Markdown and middle-cut fences always produce balanced allowlisted HTML", () => {
  const fixtures = [
    "**open [link](https://example.com",
    "| table | without |\n| closing",
    "```js\nconst x = '<tag>'",
    "before\n```\ncut in the middle of a fence\n`",
  ];
  for (const fixture of fixtures) {
    const message = renderTelegramMarkdown(fixture, { maxLength: 80 });
    assert.equal(assertTelegramHtmlAllowlist(message.html), true);
    for (const tag of ["b", "i", "s", "code", "pre", "blockquote", "a"]) {
      assert.equal(
        (message.html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g")) || []).length,
        (message.html.match(new RegExp(`</${tag}>`, "g")) || []).length,
        `tag ${tag} must stay balanced`,
      );
    }
  }
});

test("approval builder keeps dynamic fields escaped and appends status through the same contract", () => {
  const message = buildTelegramApprovalMessage({
    title: "Agent <b>asks</b> @username",
    fields: [
      { label: "Tool", value: "Bash <script>" },
      { label: "Summary", value: "open tg://user?id=1" },
    ],
  });
  assert.match(message.html, /^<b>Agent &lt;b&gt;asks&lt;\/b&gt; ＠username<\/b>/);
  assert.match(message.html, /<b>Tool:<\/b> Bash &lt;script&gt;/);
  assert.doesNotMatch(message.html, /<script>|<a\b/);

  const resolved = appendTelegramStatus(message, "✅ Allowed");
  assert.match(resolved.html, /<b>✅ Allowed<\/b>$/);
  assert.match(resolved.plainText, /✅ Allowed$/);
  assert.ok(resolved.budgetLength <= 3800);

  const longBase = plainTelegramText("x".repeat(100), { maxLength: 100, truncationMarker: "..." });
  const longResolved = appendTelegramStatus(longBase, "✅ Allowed", {
    maxLength: 100,
    truncationMarker: "...",
  });
  assert.equal(longResolved.truncated, true);
  assert.ok(longResolved.budgetLength <= 100);
  assert.match(longResolved.html, /<b>✅ Allowed<\/b>$/);
  assert.match(longResolved.plainText, /✅ Allowed$/);
});

test("HTML parse fallback classifier is narrow", () => {
  assert.equal(isTelegramHtmlParseError({ status: 400, description: "Bad Request: can't parse entities: Unsupported start tag" }), true);
  assert.equal(isTelegramHtmlParseError({ code: "400", message: "BAD REQUEST: CAN'T PARSE ENTITIES at byte offset 7" }), true);
  assert.equal(isTelegramHtmlParseError({ status: 400, description: "Bad Request: message is too long" }), false);
  assert.equal(isTelegramHtmlParseError({ status: 400, description: "Bad Request: message is not modified" }), false);
  assert.equal(isTelegramHtmlParseError({ status: 403, description: "can't parse entities" }), false);
});

test("hard allowlist assertion rejects unsupported tags and attributes", () => {
  assert.throws(() => assertTelegramHtmlAllowlist("<br>"), /disallowed tag/);
  assert.throws(() => assertTelegramHtmlAllowlist("<b class=\"x\">x</b>"), /attributes/);
  assert.throws(() => assertTelegramHtmlAllowlist("<a onclick=\"x\">x</a>"), /link attribute/);
});
