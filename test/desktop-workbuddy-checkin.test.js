"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const {
  createService,
  decodeAccount,
  parseStatus,
  STATUS,
  LEGACY,
  CHECKIN,
} = require("../src/desktop-integrations/checkin/service.cjs");
function fixture(fetch) {
  const root = fs.mkdtempSync(path.join(__dirname, "test-workbuddy-checkin-")),
    id = "workbuddy_fixture";
  fs.mkdirSync(path.join(root, "workbuddy_accounts"));
  const account = {
    id,
    access_token: "fixture-access-only",
    uid: "fixture-user",
    refresh_token: "fixture-refresh-not-used",
  };
  const key = crypto.randomBytes(32),
    nonce = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(account)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const envelope = {
    version: 1,
    kind: "workbuddy",
    algorithm: "AES-256-GCM",
    key_id: "local-secure-account-storage-v1",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  fs.writeFileSync(
    path.join(root, "workbuddy_accounts", id + ".json"),
    JSON.stringify(envelope),
  );
  fs.writeFileSync(
    path.join(root, "secure-account-storage.key"),
    key.toString("base64"),
  );
  fs.writeFileSync(
    path.join(root, "workbuddy_accounts.json"),
    JSON.stringify({ accounts: [{ id, email: "fixture@example.invalid" }] }),
  );
  fs.writeFileSync(
    path.join(root, "provider_current_accounts.json"),
    JSON.stringify({ current_accounts: { workbuddy: id } }),
  );
  return {
    root,
    id,
    key,
    envelope,
    service: createService({ dataRoot: root, fetch }),
    close() {
      assert.equal(path.dirname(root), __dirname);
      assert.ok(path.basename(root).startsWith("test-workbuddy-checkin-"));
      fs.rmSync(root, { recursive: true });
      key.fill(0);
    },
  };
}
const response = (data, { status = 200, code = 0, message } = {}) =>
  new Response(JSON.stringify({ code, data, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
test("reads authenticated encrypted Cockpit records without copying or altering them", async () => {
  const calls = [],
    f = fixture(async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, "Bearer fixture-access-only");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      return response({ todayCheckedIn: true, streakDays: 3, todayCredit: 20 });
    });
  try {
    const file = path.join(f.root, "workbuddy_accounts", f.id + ".json"),
      before = fs.readFileSync(file);
    assert.deepEqual(f.service.list(), [
      { id: f.id, label: "fix***@example.invalid", current: true },
    ]);
    const result = await f.service.checkin(f.id);
    assert.equal(result.already, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith(STATUS));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(JSON.stringify(result).includes("fixture-access"), false);
  } finally {
    f.close();
  }
});
test("signs only after an explicit pending status and uses the fixed official endpoint once", async () => {
  const calls = [],
    f = fixture(async (url) => {
      calls.push(url);
      return url.endsWith(STATUS)
        ? response({ today_checked_in: false, active: true, streak_days: 2 })
        : response({ success: true, credit: 15, streak_days: 3 });
    });
  try {
    const result = await f.service.checkin(f.id);
    assert.equal(result.checked, true);
    assert.equal(result.credit, 15);
    assert.deepEqual(calls, [
      "https://www.codebuddy.cn" + STATUS,
      "https://www.codebuddy.cn" + CHECKIN,
    ]);
  } finally {
    f.close();
  }
});
test("inactive, unrecognized status and invalid account IDs never perform a check-in", async () => {
  for (const data of [{ active: false }, { unrecognized: true }]) {
    const calls = [],
      f = fixture(async (url) => {
        calls.push(url);
        return response(data);
      });
    try {
      if (data.active === false)
        assert.equal((await f.service.checkin(f.id)).state, "inactive");
      else await assert.rejects(f.service.checkin(f.id), /无法确认/);
      await assert.rejects(f.service.checkin("../outside"), /不存在/);
      assert.equal(calls.length, 1);
    } finally {
      f.close();
    }
  }
});
test("expired login returns to Cockpit without token refresh or legacy fallback", async () => {
  const calls = [],
    f = fixture(async (url) => {
      calls.push(url);
      return response({}, { status: 401 });
    });
  try {
    await assert.rejects(f.service.checkin(f.id), /刷新登录/);
    assert.equal(calls.length, 1);
  } finally {
    f.close();
  }
});
test("a timed-out mutation is not retried and cannot be reported as successful", async () => {
  let writes = 0;
  const f = fixture(async (url) => {
    if (url.endsWith(STATUS)) return response({ todayCheckedIn: false });
    writes++;
    throw Error("fixture-access-only");
  });
  try {
    await assert.rejects(
      f.service.checkin(f.id),
      (error) =>
        /未确认/.test(error.message) &&
        !error.message.includes("fixture-access"),
    );
    assert.equal(writes, 1);
  } finally {
    f.close();
  }
});
test("legacy fallback only follows endpoint-not-found; a parallel check-in is confirmed by status", async () => {
  const calls = [];
  let statusCalls = 0;
  const f = fixture(async (url) => {
    calls.push(url);
    if (url.endsWith(STATUS)) return response({}, { status: 404 });
    if (url.endsWith(LEGACY))
      return response({ todayCheckedIn: ++statusCalls > 1 });
    return response({}, { code: 1001, message: "already done" });
  });
  try {
    const result = await f.service.checkin(f.id);
    assert.equal(result.already, true);
    assert.equal(calls.filter((url) => url.endsWith(CHECKIN)).length, 1);
  } finally {
    f.close();
  }
});
test("tampered encrypted data and unsupported envelope kinds fail closed", () => {
  const f = fixture(() => assert.fail("no network"));
  try {
    assert.equal(decodeAccount(f.envelope, f.key).id, f.id);
    assert.throws(() => decodeAccount({ ...f.envelope, kind: "codex" }, f.key));
    const bytes = Buffer.from(f.envelope.ciphertext, "base64");
    bytes[0] ^= 1;
    assert.throws(() =>
      decodeAccount(
        { ...f.envelope, ciphertext: bytes.toString("base64") },
        f.key,
      ),
    );
    assert.throws(() => parseStatus({}), /无法确认/);
  } finally {
    f.close();
  }
});
test("panel IPC only accepts its own isolated renderer", async () => {
  const vm = require("node:vm"),
    handlers = {};
  let options;
  const contents = { setWindowOpenHandler() {}, on() {}, send() {} };
  class Window {
    constructor(value) {
      options = value;
      this.webContents = contents;
    }
    isDestroyed() {
      return false;
    }
    setMenu() {}
    once() {}
    on() {}
    loadFile() {}
    show() {}
    focus() {}
  }
  const context = {
    module: { exports: {} },
    __dirname,
    AbortController,
    require: (name) =>
      name === "electron"
        ? {
            app: {},
            BrowserWindow: Window,
            ipcMain: { handle: (name, handler) => (handlers[name] = handler) },
            screen: {
              getCursorScreenPoint: () => ({ x: 0, y: 0 }),
              getDisplayNearestPoint: () => ({
                workArea: { width: 1200, height: 800 },
              }),
            },
            net: {},
          }
        : name === "./service.cjs"
          ? {
              createService: () => ({ list: () => [] }),
              cleanMessage: (v) => v,
            }
          : require(name),
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.resolve(__dirname, "../src/desktop-integrations/checkin/main.cjs"),
      "utf8",
    ),
    context,
  );
  const api = context.module.exports();
  assert.equal(
    (
      await handlers["workbuddy-checkin-action"](
        { sender: {} },
        { action: "checkin", scope: "all" },
      )
    ).ok,
    false,
  );
  api.show();
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(
    (
      await handlers["workbuddy-checkin-action"](
        { sender: {} },
        { action: "list" },
      )
    ).ok,
    false,
  );
});
