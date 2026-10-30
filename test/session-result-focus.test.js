"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSessionResultFocus } = require("../src/session-result-focus");
const desktop = {
  id: "019f0000-1234-7000-8000-123456789abc", rawSessionId: "019f0000-1234-7000-8000-123456789abc",
  agentId: "codex", codexOriginator: "Codex Desktop",
};
test("deleted CLI sessions never use saved PIDs, and dead/local scope is rechecked on click", async () => {
  let session = { agentId: "kimi-cli", sourcePid: 456 };
  let alive = true;
  let called = 0;
  const focus = createSessionResultFocus({
    getSession: () => session, processKill: () => { if (!alive) throw new Error("dead"); },
    openExternal: () => assert.fail("no URL"),
    focusTerminalSession: () => { called++; return { confirmed: true }; }, platform: "win32",
  });
  const card = { sessionId: "s", agentId: "kimi-cli", sourcePid: 999 };
  assert.equal(focus.canOpen(card), true);
  alive = false;
  assert.equal(await focus.open(card), "unavailable");
  alive = true;
  session.host = "remote";
  assert.equal(focus.canOpen(card), false);
  delete session.host;
  assert.equal(await focus.open(card), "opened");
  assert.equal(called, 1);
  session = null;
  assert.equal(await focus.open(card), "unavailable");
});
test("macOS/Linux submitted and truthy unconfirmed Windows results do not acknowledge", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const focus = createSessionResultFocus({
      getSession: () => ({ agentId: "kimi-cli", sourcePid: 12 }), processKill: () => {},
      openExternal: () => {}, focusTerminalSession: async () => ({ status: "unconfirmed", confirmed: false }),
      platform,
    });
    assert.equal(await focus.open({ sessionId: "s", agentId: "kimi-cli" }), "unconfirmed");
  }
});
test("Codex Desktop needs exact validated UUID/originator and waits for deep-link handoff", async () => {
  const urls = [];
  let finish;
  const focus = createSessionResultFocus({
    getSession: () => null,
    openExternal: url => { urls.push(url); return new Promise(resolve => { finish = resolve; }); },
  });
  const card = { sessionId: desktop.id, agentId: "codex", desktopIdentity: desktop };
  assert.equal(focus.canOpen(card), true);
  let settled = false;
  const promise = focus.open(card).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish();
  assert.equal(await promise, "opened");
  assert.deepEqual(urls, ["codex://threads/" + desktop.id]);
  assert.equal(focus.canOpen({ ...card, desktopIdentity: { ...desktop, id: "arbitrary", rawSessionId: "arbitrary" } }), false);
  assert.equal(focus.canOpen({ ...card, desktopIdentity: { ...desktop, codexOriginator: "codex_cli_rs" } }), false);
});
