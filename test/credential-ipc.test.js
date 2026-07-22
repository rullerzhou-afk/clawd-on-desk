"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { registerCredentialIpc } = require("../src/credential-ipc");

function makeIpc() {
  const handlers = {};
  return { handle: (ch, fn) => { handlers[ch] = fn; }, invoke: (ch, ...a) => handlers[ch]({}, ...a), channels: () => Object.keys(handlers) };
}

test("registers the three credential channels", () => {
  const ipc = makeIpc();
  registerCredentialIpc({ ipcMain: ipc, clipboard: { writeText() {} } });
  assert.deepStrictEqual(ipc.channels().sort(), ["credentials:copy", "credentials:read-all", "credentials:reveal"]);
});

test("copy writes the raw token to clipboard and does not return it", async () => {
  const ipc = makeIpc();
  let copied = null;
  registerCredentialIpc({
    ipcMain: ipc,
    clipboard: { writeText: (t) => { copied = t; } },
    reader: {
      readAllCredentials: () => [],
      revealAgentToken: (id) => ({ agentId: id, token: "sk-secret-token", found: true }),
    },
  });
  const res = await ipc.invoke("credentials:copy", "claude-code");
  assert.strictEqual(copied, "sk-secret-token");
  assert.deepStrictEqual(res, { ok: true });
});

test("copy returns ok:false when no token is found", async () => {
  const ipc = makeIpc();
  registerCredentialIpc({
    ipcMain: ipc,
    clipboard: { writeText() { throw new Error("should not be called"); } },
    reader: { readAllCredentials: () => [], revealAgentToken: () => ({ token: null, found: false }) },
  });
  assert.deepStrictEqual(await ipc.invoke("credentials:copy", "x"), { ok: false });
});

test("read-all never leaks a raw token", async () => {
  const ipc = makeIpc();
  registerCredentialIpc({
    ipcMain: ipc,
    clipboard: { writeText() {} },
    reader: { readAllCredentials: () => [{ agentId: "claude-code", hasToken: true, tokenMasked: "sk-a…9999" }], revealAgentToken: () => ({}) },
  });
  const rows = await ipc.invoke("credentials:read-all");
  assert.strictEqual("token" in rows[0], false);
  assert.strictEqual(rows[0].tokenMasked, "sk-a…9999");
});
