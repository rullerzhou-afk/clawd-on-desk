"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
// Wire/storage compatibility: jlcodes99/cockpit-tools v1.3.62.
// Read-only access to existing Cockpit credentials; no export, refresh or account writes.
const ORIGIN = "https://www.codebuddy.cn";
const STATUS = "/v2/billing/meter/checkin-activity-status",
  LEGACY = "/v2/billing/meter/checkin-status",
  CHECKIN = "/v2/billing/meter/daily-checkin";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function cleanMessage(value) {
  return String(value || "请求未完成")
    .replace(
      /Bearer\s+\S+|\beyJ[A-Za-z0-9_.-]+|[A-Za-z0-9_+\/-]{45,}={0,2}/g,
      "[已隐藏]",
    )
    .replace(/[\x00-\x1f]/g, " ")
    .slice(0, 180);
}
function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw Error("账号文件格式异常");
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}
function validId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
}
function decodeAccount(envelope, key) {
  if (
    envelope?.algorithm === undefined &&
    typeof envelope?.access_token === "string"
  )
    return envelope;
  if (
    envelope?.version !== 1 ||
    envelope.kind !== "workbuddy" ||
    envelope.algorithm !== "AES-256-GCM" ||
    envelope.key_id !== "local-secure-account-storage-v1"
  )
    throw Error("Cockpit 账号格式已变化，请先在 Cockpit 中检查登录");
  const nonce = Buffer.from(envelope.nonce || "", "base64"),
    ciphertext = Buffer.from(envelope.ciphertext || "", "base64");
  if (key.length !== 32 || nonce.length !== 12 || ciphertext.length < 16)
    throw Error("Cockpit 账号加密格式无效");
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(ciphertext.subarray(-16));
    plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, -16)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw Error("无法读取 Cockpit 登录，请先在 Cockpit 中重新登录");
  } finally {
    plaintext?.fill(0);
  }
}
function maskLabel(email, index) {
  if (typeof email !== "string" || !email.trim()) return "账号 " + (index + 1);
  const value = email.trim(),
    at = value.indexOf("@");
  return at > 0
    ? value.slice(0, Math.min(3, at)) + "***" + value.slice(at)
    : value.slice(0, 3) + "***";
}
function boolean(value) {
  if (value === true || value === 1 || value === "1" || value === "true")
    return true;
  if (value === false || value === 0 || value === "0" || value === "false")
    return false;
  return null;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function parseStatus(data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("签到状态缺少数据，请稍后重试");
  const checked = boolean(data.today_checked_in ?? data.todayCheckedIn),
    active = boolean(data.active ?? data.Active) ?? true;
  if (checked === null && active)
    throw Error("暂时无法确认今日签到状态，请在 Cockpit 中检查");
  return {
    checked: checked === true,
    active,
    streak: number(data.streak_days ?? data.streakDays),
    credit: number(
      data.today_credit ??
        data.todayCredit ??
        data.daily_credit ??
        data.dailyCredit,
    ),
  };
}
function createService({
  dataRoot = path.join(os.homedir(), ".antigravity_cockpit"),
  fetch: fetcher = globalThis.fetch,
  timeoutMs = 20000,
  isEnabled = () => true,
  signal,
} = {}) {
  function list() {
    if (!isEnabled() || signal?.aborted) throw Error("WorkBuddy 签到已关闭");
    let index;
    try {
      index = readJson(path.join(dataRoot, "workbuddy_accounts.json"));
    } catch {
      throw Error(
        "未找到 Cockpit 的 WorkBuddy 账号，请先在 Cockpit 中添加账号",
      );
    }
    if (!Array.isArray(index.accounts) || index.accounts.length > 200)
      throw Error("Cockpit 账号索引格式异常");
    let current = null;
    try {
      current = readJson(path.join(dataRoot, "provider_current_accounts.json"))
        .current_accounts?.workbuddy;
    } catch {}
    const seen = new Set();
    return index.accounts
      .filter((a) => validId(a?.id) && !seen.has(a.id) && seen.add(a.id))
      .map((a, i) => ({
        id: a.id,
        label: maskLabel(a.email, i),
        current: a.id === current,
      }));
  }
  function account(id) {
    if (!validId(id) || !list().some((a) => a.id === id))
      throw Error("这个 WorkBuddy 账号已不存在，请刷新列表");
    const root = fs.realpathSync(path.join(dataRoot, "workbuddy_accounts")),
      file = fs.realpathSync(path.join(root, id + ".json"));
    if (path.dirname(file) !== root) throw Error("账号文件位置异常");
    const envelope = readJson(file);
    let key;
    try {
      key = envelope.algorithm
        ? Buffer.from(
            fs
              .readFileSync(
                path.join(dataRoot, "secure-account-storage.key"),
                "utf8",
              )
              .trim(),
            "base64",
          )
        : Buffer.alloc(0);
      const value = decodeAccount(envelope, key);
      if (
        value.id !== id ||
        typeof value.access_token !== "string" ||
        !value.access_token.trim() ||
        /[\r\n]/.test(value.access_token)
      )
        throw Error("账号登录信息不完整，请在 Cockpit 中刷新登录");
      return {
        accessToken: value.access_token,
        uid: value.uid,
        enterpriseId: value.enterprise_id,
        domain: value.domain,
      };
    } finally {
      key?.fill(0);
    }
  }
  async function request(id, endpoint) {
    if (!isEnabled() || signal?.aborted) throw Error("WorkBuddy 签到已关闭");
    if (![STATUS, LEGACY, CHECKIN].includes(endpoint))
      throw Error("不支持的签到请求");
    const credentials = account(id),
      headers = {
        Authorization: "Bearer " + credentials.accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": UA,
      };
    for (const [field, value] of [
      ["X-User-Id", credentials.uid],
      ["X-Enterprise-Id", credentials.enterpriseId],
      ["X-Tenant-Id", credentials.enterpriseId],
      ["X-Domain", credentials.domain],
    ])
      if (typeof value === "string" && value) {
        if (/[\r\n]/.test(value)) throw Error("账号认证字段无效");
        headers[field] = value;
      }
    let response, body;
    try {
      response = await fetcher(ORIGIN + endpoint, {
        method: "POST",
        headers,
        body: "{}",
        redirect: "error",
        credentials: "omit",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      const reader = response.body?.getReader();
      if (reader) {
        let bytes = 0;
        const parts = [];
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1024 * 1024) {
              await reader.cancel();
              throw Error("oversize");
            }
            parts.push(Buffer.from(value));
          }
          body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } finally {
          reader.releaseLock();
        }
      } else body = await response.json();
    } catch {
      throw Error(
        endpoint === CHECKIN
          ? "签到结果暂未确认，请刷新状态后再试"
          : "签到服务暂时无法连接，请稍后重试",
      );
    } finally {
      credentials.accessToken = null;
      delete headers.Authorization;
    }
    if (response.status === 401 || response.status === 403) {
      const error = Error(
        "登录已失效或服务拒绝请求，请在 Cockpit 中刷新登录后重试",
      );
      error.auth = true;
      throw error;
    }
    if (!response.ok) {
      const error = Error(
        "签到服务响应异常（" + response.status + "），请稍后重试",
      );
      error.http = response.status;
      throw error;
    }
    if (body?.code !== 0) {
      const error = Error(
        cleanMessage(body?.message ?? body?.msg ?? "签到服务未接受请求"),
      );
      error.apiCode = body?.code;
      throw error;
    }
    if (!body.data || typeof body.data !== "object")
      throw Error("签到服务返回的数据不完整");
    return body.data;
  }
  async function status(id) {
    let data;
    try {
      data = await request(id, STATUS);
    } catch (error) {
      if (error.http !== 404 && error.http !== 405) throw error;
      data = await request(id, LEGACY);
    }
    return parseStatus(data);
  }
  async function checkin(id) {
    const before = await status(id);
    if (before.checked)
      return {
        ...before,
        state: "checked",
        already: true,
        message: "今日已签到，已跳过",
      };
    if (!before.active)
      return { ...before, state: "inactive", message: "签到活动暂未开放" };
    let result;
    try {
      result = await request(id, CHECKIN);
    } catch (error) {
      // Never retry a mutation. A competing Cockpit check-in may have won.
      if (error.apiCode !== undefined) {
        try {
          const now = await status(id);
          if (now.checked)
            return {
              ...now,
              state: "checked",
              already: true,
              message: "今日已签到",
            };
        } catch {}
      }
      throw error;
    }
    if (result.success === false)
      throw Error(cleanMessage(result.message || "签到未成功，请刷新状态"));
    return {
      state: "checked",
      checked: true,
      active: true,
      already: false,
      streak:
        number(result.streak_days ?? result.streakDays) ??
        (before.streak === null ? null : before.streak + 1),
      credit: number(
        result.credit ?? result.today_credit ?? result.todayCredit,
      ),
      message: "签到成功",
    };
  }
  return { list, status, checkin };
}
module.exports = {
  createService,
  decodeAccount,
  parseStatus,
  cleanMessage,
  ORIGIN,
  STATUS,
  LEGACY,
  CHECKIN,
};
