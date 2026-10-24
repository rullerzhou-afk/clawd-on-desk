"use strict";
const $ = (id) => document.getElementById(id);
let busy = false,
  latest = { accounts: [] },
  localPending = false,
  zh = false;
const text = (en, cn) => (zh ? cn : en);
function render(state) {
  latest = state;
  busy = state.busy === true;
  zh = String(state.lang || "en").startsWith("zh");
  document.querySelector("h1").textContent = text(
    "WorkBuddy check-in",
    "WorkBuddy 签到",
  );
  document.querySelector("header p").textContent = text(
    "Uses existing Cockpit accounts",
    "直接使用 Cockpit 中已有的账号",
  );
  document.querySelector(".note").textContent = text(
    "Runs only when you click. If login expires, refresh it in Cockpit.",
    "仅在你点击时签到。若登录失效，请在 Cockpit 中刷新登录后再试。",
  );
  $("current").textContent = text("Check in current account", "当前账号签到");
  $("refresh").textContent = text("Refresh status", "查询今日状态");
  $("progress").textContent =
    state.progress ||
    text(
      "Already checked-in accounts are skipped.",
      "已签到的账号会自动跳过。",
    );
  $("all").textContent = text(
    "Check in all " + state.accounts.length + " accounts",
    "全部 " + state.accounts.length + " 个账号签到",
  );
  for (const id of ["current", "all", "refresh"])
    $(id).disabled = busy || localPending || !state.accounts.length;
  const rows = document.createDocumentFragment();
  for (const account of state.accounts) {
    const row = document.createElement("div");
    row.className = "account state-" + (account.state || "unknown");
    const info = document.createElement("div"),
      label = document.createElement("div");
    label.className = "label";
    label.textContent = account.label;
    if (account.current) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = text("current", "当前");
      label.append(badge);
    }
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = account.message || text("Not checked yet", "尚未查询");
    if (Number.isFinite(account.streak))
      detail.textContent += text(
        " · streak " + account.streak + " days",
        " · 连续 " + account.streak + " 天",
      );
    if (Number.isFinite(account.credit))
      detail.textContent += text(
        " · credits " + account.credit,
        " · 积分 " + account.credit,
      );
    info.append(label, detail);
    const button = document.createElement("button");
    button.textContent = account.checked
      ? text("Checked in", "已签到")
      : text("Check in", "签到");
    button.disabled = busy || localPending || account.checked === true;
    button.addEventListener("click", () => command("checkin", account.id));
    row.append(info, button);
    rows.append(row);
  }
  $("accounts").replaceChildren(rows);
}
async function command(action, scope) {
  if (localPending || busy) return;
  localPending = true;
  render(latest);
  $("error").hidden = true;
  try {
    const result = await window.workbuddyCheckin.command(action, scope);
    if (!result.ok && result.error) {
      $("error").textContent = result.error;
      $("error").hidden = false;
    }
  } catch {
    $("error").textContent = "签到连接中断，请重新打开面板后查询状态。";
    $("error").hidden = false;
  } finally {
    localPending = false;
    render(latest);
  }
}
$("current").onclick = () => command("checkin", "current");
$("all").onclick = () => command("checkin", "all");
$("refresh").onclick = () => command("status", "all");
$("close").onclick = () => window.workbuddyCheckin.command("close");
window.workbuddyCheckin.onState(render);
window.workbuddyCheckin
  .command("list")
  .then((result) => {
    if (result.ok) render(result);
    else {
      $("error").textContent = result.error;
      $("error").hidden = false;
    }
  })
  .catch(() => {
    $("error").textContent = "账号列表读取失败";
    $("error").hidden = false;
  });
