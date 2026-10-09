"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const fmt = require("../src/slack-message-format");
const { resolveSessionIdentity } = require("../src/session-key");
const { buildSessionSnapshot, buildSessionSnapshotEntry } = require("../src/state-session-snapshot");

test("buildCompletionMessage renders a done card with fallback text", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "abc123def", displaySessionTag: "deadbeef00", displayTitle: "Build", badge: "done", cwd: "/x/proj", agentId: "claude" },
    { lang: "en" },
  );
  assert.ok(msg.text.startsWith("✅"));
  assert.equal(msg.blocks[0].type, "header");
  assert.ok(msg.blocks[0].text.text.includes("Build"));
  // metadata line and fallback text include the folder + snapshot-owned session tag
  const section = msg.blocks[1].text.text;
  assert.ok(section.includes("proj"));
  assert.ok(section.includes("#deadbeef00"));
  assert.ok(msg.text.includes("#deadbeef00"));
  assert.ok(!section.includes("#abc123"));
});

test("interrupted sessions use the warning icon", () => {
  const msg = fmt.buildCompletionMessage({ id: "s1", badge: "interrupted", displayTitle: "T" }, { lang: "en" });
  assert.ok(msg.text.startsWith("⚠️"));
});

test("includeOutput appends a fenced, redacted, fence-safe code block", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      assistantLastOutput: "token xoxb-123456789-abcdefghij and ```danger``` here",
    },
    { lang: "en", includeOutput: true },
  );
  const joined = msg.blocks.map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(joined.includes("```")); // a code block was added
  // Secret scrubbed. The marker itself is mrkdwn-escaped: Slack parses <…:…>
  // as link syntax even inside a fence, and renders &lt;…&gt; back as literal.
  assert.ok(joined.includes("&lt;redacted:token&gt;"));
  assert.ok(!joined.includes("xoxb-123456789-abcdefghij"));
  // The embedded fence must be broken so it can't terminate our block early.
  assert.ok(!joined.includes("```danger```"));
});

test("assistant output cannot smuggle a broadcast out of the code fence", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "ping <!channel> and <@U123>" },
    { lang: "en", includeOutput: true },
  );
  const joined = msg.blocks.map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(!joined.includes("<!channel>"));
  assert.ok(!joined.includes("<@U123>"));
  assert.ok(joined.includes("&lt;!channel&gt;"));
});

test("output is omitted when includeOutput is false", () => {
  const withOut = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "hello" },
    { lang: "en", includeOutput: false },
  );
  const joined = withOut.blocks.map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(!joined.includes("hello"));
});

test("buildPermissionMessage announces and points at the desktop app", () => {
  const msg = fmt.buildPermissionMessage(
    { title: "claude needs approval", toolName: "Bash", agentId: "claude", folder: "/x/proj", detail: "rm -rf" },
    { lang: "en" },
  );
  assert.ok(msg.text.startsWith("⏳"));
  const joined = msg.blocks.map((b) => {
    if (b.text) return b.text.text;
    if (b.elements) return b.elements.map((e) => e.text).join(" ");
    return "";
  }).join("\n");
  assert.ok(joined.includes("Bash"));
  assert.ok(/desktop app/i.test(joined));
});

test("mrkdwn special characters are escaped", () => {
  const msg = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "a<b>&c" }, { lang: "en" });
  const header = msg.blocks[0].text.text; // plain_text header is not escaped
  assert.ok(header.includes("a<b>&c"));
  assert.equal(fmt.escapeMrkdwn("a<b>&c"), "a&lt;b&gt;&amp;c");
});

// The session title is derived from the user's own prompt, so it is as
// untrusted as assistant output — in the header (plain_text: redact only) and
// in the top-level fallback `text`, which Slack parses as mrkdwn.
test("the session title is redacted in the header and escaped in the fallback text", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "deploy with xoxb-123456789-abcdefghij <!channel>",
      cwd: "/x/proj",
    },
    { lang: "en" },
  );
  // Header: plain_text, so the secret is gone but nothing is HTML-escaped.
  const header = msg.blocks[0].text.text;
  assert.ok(!header.includes("xoxb-123456789-abcdefghij"));
  assert.ok(header.includes("<redacted:token>"));
  // Fallback text: mrkdwn-parsed, so the secret is gone AND <!channel> is inert.
  assert.ok(!msg.text.includes("xoxb-123456789-abcdefghij"));
  assert.ok(!msg.text.includes("<!channel>"));
  assert.ok(msg.text.includes("&lt;!channel&gt;"));
});

test("session metadata (folder, host, agent) is redacted and escaped", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      agentId: "<!here>",
      cwd: "/srv/xoxb-123456789-abcdefghij",
      host: "box<&>1",
    },
    { lang: "en" },
  );
  const section = msg.blocks[1].text.text;
  assert.ok(!section.includes("xoxb-123456789-abcdefghij"));
  assert.ok(!section.includes("<!here>"));
  assert.ok(section.includes("&lt;!here&gt;"));
  assert.ok(section.includes("box&lt;&amp;&gt;1"));
});

test("the completion fallback text carries no raw folder either", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", cwd: "/srv/<!channel>" },
    { lang: "en" },
  );
  assert.ok(!msg.text.includes("<!channel>"));
  assert.ok(msg.text.includes("&lt;!channel&gt;"));
});

test("a real snapshot entry suppresses an internal workspace id end to end", () => {
  const opaqueId = "mqgw60jiigjsjcid";
  const snapshot = buildSessionSnapshot(new Map([["qwenwork:abc123", {
    state: "idle",
    updatedAt: 1,
    recentEvents: [],
    cwd: `/Users/me/.QwenWorkCN/workspace/${opaqueId}`,
    agentId: "qwenwork",
  }]]));
  const entry = {
    ...snapshot.sessions[0],
    badge: "done",
  };
  assert.equal(entry.displayFolder, "", "snapshot owns the suppression rule");

  const msg = fmt.buildCompletionMessage(entry, { lang: "en" });

  assert.ok(!JSON.stringify(msg).includes(opaqueId),
    "empty displayFolder must not fall back to raw cwd");
});

test("completion uses the snapshot display tag instead of raw or canonical id prefixes", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1.bG9jYWw.c2Vzcy16enp6eno5",
      rawSessionId: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      displaySessionTag: "deadbeef00",
      badge: "done",
    },
    { lang: "en" },
  );
  const all = JSON.stringify(msg);
  assert.match(msg.blocks[0].text.text, /session/);
  assert.match(all, /#deadbeef00/);
  assert.ok(msg.text.includes("#deadbeef00"), "fallback preview carries the safe tag");
  for (const forbidden of ["s1.bG9", "c2Vzcy", "codex:", "019e11"]) {
    assert.ok(!all.includes(forbidden), forbidden);
  }
});

test("completion does not expose qoder or qwenwork raw prefixes as Slack tags", () => {
  for (const rawId of ["qoder:abc123456", "qwenwork:xyz987654"]) {
    const msg = fmt.buildCompletionMessage(
      { id: rawId, displaySessionTag: "1122334455", badge: "done" },
      { lang: "en" },
    );
    const all = JSON.stringify(msg);
    assert.match(all, /#1122334455/);
    assert.ok(!all.includes(rawId), rawId);
    assert.ok(!all.includes(rawId.slice(0, 6)), rawId);
  }
});

test("completion drops malformed snapshot display tags instead of publishing them", () => {
  for (const displaySessionTag of [
    "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
    "not-a-tag",
    "123456789",
    "12345678901",
    "<!channel>",
  ]) {
    const msg = fmt.buildCompletionMessage(
      {
        id: "s-malformed-tag",
        displayTitle: "Build",
        displaySessionTag,
        badge: "done",
      },
      { lang: "en" },
    );
    const all = JSON.stringify(msg);
    assert.equal(msg.text, "✅ Build (done)", displaySessionTag);
    assert.equal(msg.blocks[1].text.text, "*done*", displaySessionTag);
    assert.ok(!all.includes(displaySessionTag), displaySessionTag);
    assert.ok(!all.includes("#codex:"), displaySessionTag);
    assert.ok(!all.includes("#not-a-tag"), displaySessionTag);
    assert.ok(!all.includes("<!channel>"), displaySessionTag);
  }
});

test("real Codex ids render distinct snapshot-owned Slack tags", () => {
  function entryFor(rawSessionId) {
    const identity = resolveSessionIdentity(rawSessionId);
    const entry = buildSessionSnapshotEntry(identity.sessionId, {
      rawSessionId: identity.rawSessionId,
      agentId: "codex",
      state: "idle",
      recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
    });
    return { ...entry, badge: "done" };
  }

  const first = entryFor("codex:019e115a-4df2-7ed0-b90e-8e6345aca777");
  const second = entryFor("codex:019e115b-4df2-7ed0-b90e-8e6345aca777");
  const firstText = JSON.stringify(fmt.buildCompletionMessage(first, { lang: "en" }));
  const secondText = JSON.stringify(fmt.buildCompletionMessage(second, { lang: "en" }));
  const firstTag = firstText.match(/#([0-9a-f]{10})/);
  const secondTag = secondText.match(/#([0-9a-f]{10})/);

  assert.ok(firstTag && secondTag, "both messages carry a safe tag");
  assert.equal(firstTag[1], first.displaySessionTag);
  assert.equal(secondTag[1], second.displaySessionTag);
  assert.notEqual(firstTag[1], secondTag[1]);
  for (const forbidden of ["codex:", "019e115", "s1.bG9"]) {
    assert.ok(!firstText.includes(forbidden), forbidden);
    assert.ok(!secondText.includes(forbidden), forbidden);
  }
});

test("older formatter callers without displayFolder keep the cwd basename fallback", () => {
  const msg = fmt.buildCompletionMessage({
    id: "s1",
    badge: "done",
    displayTitle: "T",
    cwd: "/srv/project",
  }, { lang: "en" });
  assert.match(JSON.stringify(msg), /project/);
});

test("permission announcements redact and escape every agent-derived field", () => {
  const msg = fmt.buildPermissionMessage(
    {
      title: "claude <!channel> needs approval for xoxb-123456789-abcdefghij",
      toolName: "Bash <@U123>",
      agentId: "claude<&>code",
      folder: "/x/<!here>",
      detail: "curl -H 'authorization: Bearer sk-ant-abcdefghijkl'",
    },
    { lang: "en" },
  );
  const joined = [msg.text, ...msg.blocks.map((b) => {
    if (b.text) return b.text.text;
    if (b.elements) return b.elements.map((e) => e.text).join(" ");
    return "";
  })].join("\n");
  assert.ok(!joined.includes("xoxb-123456789-abcdefghij"));
  assert.ok(!joined.includes("sk-ant-abcdefghijkl"));
  assert.ok(!joined.includes("<!channel>"));
  assert.ok(!joined.includes("<!here>"));
  assert.ok(!joined.includes("<@U123>"));
  // ...including the top-level fallback, which Slack renders as mrkdwn.
  assert.ok(!msg.text.includes("<!channel>"));
  assert.ok(msg.text.includes("&lt;!channel&gt;"));
});

// A cut that lands inside "&lt;" would render as literal "&l" rubbish, and the
// escape is what makes mention syntax inert — so the half-entity is dropped.
test("truncation never leaves a half-written escape entity", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      // Nothing but '<' — every escaped character is a 4-char entity, so the
      // section limit is guaranteed to fall inside one.
      assistantLastOutput: "<".repeat(2000),
    },
    { lang: "en", includeOutput: true },
  );
  for (const block of msg.blocks) {
    const text = block.text ? block.text.text : "";
    assert.ok(!/&[A-Za-z]{0,4}$/.test(text), `dangling entity in: ${text.slice(-12)}`);
  }
});

test("truncateMiddle keeps both ends and marks truncation", () => {
  const long = "A".repeat(100) + "B".repeat(100);
  const out = fmt.truncateMiddle(long, 60);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 60);
  assert.ok(out.text.startsWith("A"));
  assert.ok(out.text.endsWith("B"));
  assert.ok(out.text.includes("[truncated]"));
});

test("locales fall back to English and translate the status word", () => {
  assert.equal(fmt.getLocale("zz").done, "done");
  assert.deepEqual(Object.keys(fmt.getLocale("es")), Object.keys(fmt.getLocale("en")));
  assert.equal(typeof fmt.getLocale("es").wrapStatus, "function");
  const zh = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, { lang: "zh" });
  assert.ok(zh.blocks[1].text.text.includes("已完成"));
  const es = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, { lang: "es" });
  assert.ok(es.blocks[1].text.text.includes("completada"));
});

test("buildTestMessage produces a simple two-block card", () => {
  const msg = fmt.buildTestMessage({ lang: "en" });
  assert.equal(msg.blocks.length, 2);
  assert.equal(msg.blocks[0].type, "header");
});

test("null entry yields null (caller skips)", () => {
  assert.equal(fmt.buildCompletionMessage(null, { lang: "en" }), null);
});

// The truncation flag was computed on the raw text, but escaping happens after
// it: 2500 "<" characters are under the raw limit and 10000 characters once
// escaped, so the final clip dropped most of the output while the label still
// said it was complete. A reader cannot tell a short answer from a cut one.
test("truncation is reported after escaping and the final clip, not before", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "<".repeat(2500) },
    { lang: "en", includeOutput: true },
  );
  const texts = msg.blocks.map((b) => (b.text ? b.text.text : ""));
  const label = texts.find((t) => /Assistant output/.test(t));
  assert.match(label, /truncated/i, "content was clipped, so say so");
});

test("output that survives escaping intact is not labelled truncated", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "all fine" },
    { lang: "en", includeOutput: true },
  );
  const label = msg.blocks.map((b) => (b.text ? b.text.text : "")).find((t) => /Assistant output/.test(t));
  assert.doesNotMatch(label, /truncated/i);
});

// ── Interaction- and route-aware permission cards (review item 4) ───────────
// An AskUserQuestion ran through the ordinary approval builder, which can never
// find a description for it — so the card said "No description available" and
// told the reader to approve or deny something that is actually a question.

const QUESTION_PAYLOAD = {
  kind: "question",
  title: "claude-code needs input",
  agentId: "claude-code",
  folder: "clawd-on-desk",
  questions: [
    { header: "Rollout", question: "Which environment should I deploy to?",
      options: [{ label: "staging" }, { label: "production" }] },
    { question: "Run the migration first?", options: [{ label: "yes" }, { label: "no" }] },
  ],
};

test("a question card shows the questions, not an approval summary", () => {
  const msg = fmt.buildPermissionMessage(QUESTION_PAYLOAD, { lang: "en" });
  const all = JSON.stringify(msg);
  assert.match(all, /Which environment should I deploy to\?/);
  assert.match(all, /Run the migration first\?/);
  assert.match(all, /staging/);
  assert.match(all, /production/);
  // The header supplied by the agent is used; the one without a header falls
  // back to a numbered label rather than showing nothing.
  assert.match(all, /Rollout/);
  assert.match(all, /Question 2/);
});

test("a question card never talks about approving or denying", () => {
  // capabilities.allowDeny is false for AskUserQuestion — there is nothing to
  // approve, so Allow/Deny wording would be actively misleading.
  const msg = fmt.buildPermissionMessage(QUESTION_PAYLOAD, { lang: "en" });
  const all = JSON.stringify(msg);
  assert.doesNotMatch(all, /approve/i);
  assert.doesNotMatch(all, /deny/i);
  assert.match(all, /answer/i);
});

test("the hint names where the answer or decision actually happens", () => {
  const hintOf = (msg) => msg.blocks
    .map((b) => (b.elements ? b.elements.map((e) => e.text).join(" ") : ""))
    .join(" ");

  const localApproval = fmt.buildPermissionMessage(
    { toolName: "Bash", agentId: "claude-code", actionTarget: "desktop" }, { lang: "en" });
  assert.match(hintOf(localApproval), /desktop app/i);

  // Bubbles disabled: there is no desktop bubble to act in, by construction.
  const remoteApproval = fmt.buildPermissionMessage(
    { toolName: "Bash", agentId: "claude-code", actionTarget: "remote" }, { lang: "en" });
  assert.doesNotMatch(hintOf(remoteApproval), /desktop app/i);
  assert.match(hintOf(remoteApproval), /Telegram|Feishu/i);

  const remoteQuestion = fmt.buildPermissionMessage(
    { ...QUESTION_PAYLOAD, actionTarget: "remote" }, { lang: "en" });
  assert.match(hintOf(remoteQuestion), /Telegram|Feishu/i);
  assert.match(hintOf(remoteQuestion), /answer/i);
});

test("question text is redacted and escaped like every other agent-derived field", () => {
  // buildRemoteElicitationPayload hands the questions array through raw —
  // Telegram and Feishu each sanitise on their own side, so Slack must too.
  const msg = fmt.buildPermissionMessage({
    kind: "question",
    agentId: "claude-code",
    questions: [{
      header: "<!channel>",
      question: "deploy with xoxb-123456789-abcdefghij?",
      options: [{ label: "<!here> yes" }],
    }],
  }, { lang: "en" });

  const all = JSON.stringify(msg);
  assert.ok(!all.includes("xoxb-123456789-abcdefghij"), "a secret in a question must not reach Slack");
  assert.ok(!all.includes("<!channel>"), "mention syntax in a header must be inert");
  assert.ok(!all.includes("<!here>"), "mention syntax in an option must be inert");
});

test("question header clipping never leaves a partial mrkdwn entity", () => {
  const msg = fmt.buildPermissionMessage({
    kind: "question",
    agentId: "claude-code",
    questions: [{
      // The prefix makes the 80-character clip land inside a later &lt; entity
      // unless the entity-aware clipping path removes the incomplete suffix.
      header: `x${"<".repeat(100)}`,
      question: "Proceed?",
    }],
  }, { lang: "en" });

  const section = msg.blocks.find((block) => block.type === "section" && block.text.text.includes("Proceed?")).text.text;
  assert.ok(!/&[A-Za-z]{0,4}\*/.test(section),
    `partial entity before emphasis marker: ${section}`);
});

test("question and option counts are capped like the other channels", () => {
  const msg = fmt.buildPermissionMessage({
    kind: "question",
    agentId: "claude-code",
    questions: Array.from({ length: 9 }, (_, i) => ({
      question: `Q${i}`,
      options: Array.from({ length: 9 }, (_, j) => ({ label: `opt${i}-${j}` })),
    })),
  }, { lang: "en" });

  const all = JSON.stringify(msg);
  assert.match(all, /Q0/);
  assert.ok(!all.includes("Q8"), "questions beyond the cap are dropped, not rendered");
  assert.ok(!all.includes("opt0-8"), "options beyond the cap are dropped too");
  assert.match(all, /more/i, "and the reader is told something was omitted");
});

test("large question cards use one bounded section per complete question", () => {
  const msg = fmt.buildPermissionMessage({
    kind: "question",
    agentId: "claude-code",
    questions: Array.from({ length: 7 }, (_, i) => ({
      header: `header-${i}-${"h".repeat(90)}`,
      question: `question-${i}-${"q".repeat(300)}`,
      options: Array.from({ length: 6 }, (_, j) => ({ label: `option-${i}-${j}-${"o".repeat(90)}` })),
    })),
  }, { lang: "en" });

  const questionSections = msg.blocks.filter((block) =>
    block.type === "section" && /question-\d-/.test(block.text.text));
  assert.equal(questionSections.length, 5, "the card renders at most five complete questions");
  for (let i = 0; i < questionSections.length; i += 1) {
    const text = questionSections[i].text.text;
    assert.ok(text.length <= fmt.SECTION_MAX);
    assert.match(text, new RegExp(`question-${i}-`));
    for (let j = 0; j < 5; j += 1) assert.match(text, new RegExp(`option-${i}-${j}-`));
    assert.match(text, /\+1 more/, "each question reports its omitted options");
  }
  assert.match(questionSections[4].text.text, /\+1 more/, "the final question reports its omitted option");
  assert.match(questionSections[4].text.text, /\+2 more/, "the final section separately reports omitted questions");
  assert.ok(!JSON.stringify(msg).includes("question-5-"));
});

test("an overlong option is bounded before section admission", () => {
  const enormous = `start-${"x".repeat(fmt.SECTION_MAX)}-end`;
  const msg = fmt.buildPermissionMessage({
    kind: "question",
    questions: [{ question: "Choose one", options: [{ label: enormous }, { label: "small" }] }],
  }, { lang: "en" });
  const section = msg.blocks.find((block) =>
    block.type === "section" && block.text.text.includes("Choose one")).text.text;
  assert.ok(section.includes("start-"), "the bounded preview keeps useful leading context");
  assert.ok(!section.includes("-end"), "the exported formatter clamps labels defensively");
  assert.ok(section.includes("small"), "one oversized label cannot hide later choices");
  assert.ok(section.length <= fmt.SECTION_MAX);
});

test("an approval card is unchanged by the new fields", () => {
  const msg = fmt.buildPermissionMessage(
    { title: "claude-code requests Bash", toolName: "Bash", agentId: "claude-code",
      folder: "proj", detail: "run the tests" }, { lang: "en" });
  const all = JSON.stringify(msg);
  assert.match(all, /Bash/);
  assert.match(all, /run the tests/);
  assert.match(all, /Permission needed/);
});

test("a question card does not leak the untranslated elicitation title", () => {
  // buildRemoteElicitationPayload builds `${agentId} needs input` as a hardcoded
  // English literal. The header already says "Answer needed" and the fields
  // already name the agent, so repeating it added nothing except an English
  // sentence in the middle of a translated card.
  const zh = fmt.buildPermissionMessage(
    { ...QUESTION_PAYLOAD, title: "claude-code needs input" }, { lang: "zh" });
  const body = zh.blocks.map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(!body.includes("needs input"), "the English template must not appear in a zh card");
  assert.ok(!zh.text.includes("needs input"), "nor in the push preview");
  // The agent is still identifiable.
  assert.match(JSON.stringify(zh), /claude-code/);
});
