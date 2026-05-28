"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  envFileTokenStore,
  parseTokenFromEnvFileText,
  buildEnvFileText,
  isValidToken,
} = require("../src/telegram-token-store");

const VALID = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123456789";

function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-tg-store-${label}-`));
  return {
    dir,
    file: path.join(dir, "telegram-approval.env"),
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

test("isValidToken matches Telegram bot token shape", () => {
  assert.equal(isValidToken(VALID), true);
  assert.equal(isValidToken("not-a-token"), false);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken(null), false);
});

test("parseTokenFromEnvFileText accepts the standard CLAWD_TG_BOT_TOKEN line", () => {
  assert.equal(parseTokenFromEnvFileText(`CLAWD_TG_BOT_TOKEN=${VALID}\n`), VALID);
  assert.equal(parseTokenFromEnvFileText(`  CLAWD_TG_BOT_TOKEN = ${VALID}  \n`), VALID);
});

test("parseTokenFromEnvFileText rejects malformed contents", () => {
  assert.equal(parseTokenFromEnvFileText(""), null);
  assert.equal(parseTokenFromEnvFileText("OTHER_VAR=foo"), null);
  assert.equal(parseTokenFromEnvFileText("CLAWD_TG_BOT_TOKEN=garbage"), null);
});

test("buildEnvFileText produces the line the sidecar expects", () => {
  assert.equal(buildEnvFileText(VALID), `CLAWD_TG_BOT_TOKEN=${VALID}\n`);
});

test("envFileTokenStore requires filePath + fs.readFileSync", () => {
  assert.throws(() => envFileTokenStore({ filePath: "" }), /filePath is required/);
  assert.throws(
    () => envFileTokenStore({ filePath: "x", fs: {} }),
    /fs must implement readFileSync/,
  );
});

test("envFileTokenStore.getToken reads the file and parses", async (t) => {
  const tmp = tmpDir("get");
  t.after(tmp.cleanup);
  fs.writeFileSync(tmp.file, `CLAWD_TG_BOT_TOKEN=${VALID}\n`);
  const store = envFileTokenStore({ filePath: tmp.file });
  assert.equal(await store.getToken(), VALID);
  assert.equal(await store.hasToken(), true);
});

test("envFileTokenStore.getToken returns null when file missing", async (t) => {
  const tmp = tmpDir("missing");
  t.after(tmp.cleanup);
  const store = envFileTokenStore({ filePath: tmp.file });
  assert.equal(await store.getToken(), null);
  assert.equal(await store.hasToken(), false);
});

test("envFileTokenStore.writeToken refuses invalid tokens", async (t) => {
  const tmp = tmpDir("invalid");
  t.after(tmp.cleanup);
  const store = envFileTokenStore({ filePath: tmp.file });
  await assert.rejects(() => store.writeToken("nope"), /invalid bot token/);
  assert.equal(fs.existsSync(tmp.file), false, "no file should be created on invalid input");
});

test("envFileTokenStore.writeToken atomically persists token (temp+rename)", async (t) => {
  const tmp = tmpDir("write");
  t.after(tmp.cleanup);
  const store = envFileTokenStore({ filePath: tmp.file });
  await store.writeToken(VALID);
  const text = fs.readFileSync(tmp.file, "utf8");
  assert.equal(text, buildEnvFileText(VALID));
  // round-trip via store
  assert.equal(await store.getToken(), VALID);
  // No leftover .tmp files in the directory.
  const leftovers = fs.readdirSync(tmp.dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "atomic write must clean temp files");
});

test("envFileTokenStore.writeToken overwrites existing token safely", async (t) => {
  const tmp = tmpDir("overwrite");
  t.after(tmp.cleanup);
  const store = envFileTokenStore({ filePath: tmp.file });
  const OLD = "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA-_9876543210";
  await store.writeToken(OLD);
  assert.equal(await store.getToken(), OLD);
  await store.writeToken(VALID);
  assert.equal(await store.getToken(), VALID);
});

test("envFileTokenStore.deleteToken removes the file silently if missing", async (t) => {
  const tmp = tmpDir("delete");
  t.after(tmp.cleanup);
  const store = envFileTokenStore({ filePath: tmp.file });
  // First delete with no file present.
  await store.deleteToken();
  // Then create + delete.
  fs.writeFileSync(tmp.file, `CLAWD_TG_BOT_TOKEN=${VALID}\n`);
  await store.deleteToken();
  assert.equal(fs.existsSync(tmp.file), false);
});

test("Source invariant: src/telegram-token-store.js never references process.env.CLAWD_TG_BOT_TOKEN", () => {
  // Mirrors the existing invariant test for telegram-approval-settings.js.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "telegram-token-store.js"),
    "utf8",
  );
  assert.equal(
    source.includes("process.env.CLAWD_TG_BOT_TOKEN"),
    false,
    "token store must not read CLAWD_TG_BOT_TOKEN from process.env",
  );
  assert.equal(
    /process\.env\s*\.\s*CLAWD_TG_BOT_TOKEN/.test(source),
    false,
  );
});
