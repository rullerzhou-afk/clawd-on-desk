"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildStateBody, extractSessionTitleFromTranscript } = require("../hooks/clawd-hook.js");

describe("extractSessionTitleFromTranscript", () => {
  it("returns the latest renamed title from transcript tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      JSON.stringify({ type: "custom-title", customTitle: "First Title" }),
      JSON.stringify({ type: "agent-name", agentName: "Renamed Session" }),
    ].join("\n") + "\n");

    assert.strictEqual(extractSessionTitleFromTranscript(file), "Renamed Session");
  });

  it("supports title fields used by transcript repair tools", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "custom-title", title: "Recovered Title" })}\n`);

    assert.strictEqual(extractSessionTitleFromTranscript(file), "Recovered Title");
  });
});

describe("buildStateBody", () => {
  it("prefers payload session title fields over transcript lookup", () => {
    const body = buildStateBody("SessionStart", {
      session_id: "sid-1",
      cwd: "/tmp/project",
      session_title: "Payload Title",
      transcript_path: "/does/not/matter.jsonl",
    }, () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] }));

    assert.strictEqual(body.session_title, "Payload Title");
    assert.strictEqual(body.session_id, "sid-1");
    assert.strictEqual(body.cwd, "/tmp/project");
  });
});
