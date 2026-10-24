"use strict";
const $ = (id) => document.getElementById(id);
let current,
  zh = false,
  rows = [];
const text = (en, cn) => (zh ? cn : en);
function row(label, control, choose) {
  const wrap = document.createElement("div");
  wrap.className = "row";
  const name = document.createElement("label");
  name.textContent = label;
  name.htmlFor = control.id;
  wrap.append(name, control);
  if (choose) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text("Choose…", "选择…");
    button.onclick = async () => {
      const result = await window.desktopSettings.invoke(
        "choose",
        null,
        choose,
      );
      if (result.path) control.value = result.path;
    };
    wrap.append(button);
  }
  $("form").append(wrap);
}
function flag(key, label, disabled = false) {
  const input = document.createElement("input");
  input.id = key;
  input.type = "checkbox";
  input.checked = current[key];
  input.disabled = disabled;
  row(label, input);
}
function field(key, label, directory = false) {
  const input = document.createElement("input");
  input.id = key;
  input.type = "text";
  input.value = current[key];
  input.placeholder = directory
    ? text("Default Cockpit data directory", "默认 Cockpit 账号目录")
    : text("Choose the installed application", "选择已安装的应用");
  row(label, input, directory ? "directory" : "file");
}
function appRow(
  item = {
    id: "app-" + crypto.randomUUID().slice(0, 8),
    name: "",
    executable: "",
  },
) {
  const wrap = document.createElement("div");
  wrap.className = "app-row";
  const name = document.createElement("input"),
    executable = document.createElement("input"),
    choose = document.createElement("button"),
    remove = document.createElement("button");
  name.value = item.name;
  name.placeholder = text("Application name", "应用名称");
  executable.value = item.executable;
  executable.className = "path";
  executable.placeholder = text("Application path", "应用路径");
  choose.type = remove.type = "button";
  choose.textContent = text("Choose", "选择");
  remove.textContent = "×";
  choose.onclick = async () => {
    const result = await window.desktopSettings.invoke("choose", null, "file");
    if (result.path) executable.value = result.path;
  };
  remove.onclick = () => {
    rows = rows.filter((entry) => entry.wrap !== wrap);
    wrap.remove();
  };
  wrap.append(name, executable, choose, remove);
  $("apps").append(wrap);
  rows.push({ wrap, id: item.id, name, executable });
}
window.desktopSettings.invoke("get").then((result) => {
  if (result.status !== "ok") return;
  current = result.settings;
  zh = result.lang?.startsWith("zh");
  $("title").textContent = text("Desktop integrations", "桌面接入");
  $("hint").textContent = text(
    "Optional tools. Nothing runs until enabled and requested. Application updates retain these settings.",
    "按需启用。点击菜单才执行应用控制或签到，更新保留这些设置。",
  );
  flag(
    "qqmusicEnabled",
    text("QQ Music controls (Windows x64)", "QQ 音乐控制（Windows x64）"),
    result.platform !== "win32" || result.arch !== "x64",
  );
  field("qqmusicExecutable", text("QQMusic.exe", "QQMusic.exe 路径"));
  flag(
    "cockpitCheckinEnabled",
    text(
      "WorkBuddy check-in using Cockpit accounts",
      "WorkBuddy 签到（使用 Cockpit 现有账号）",
    ),
  );
  field(
    "cockpitDataRoot",
    text("Cockpit account directory", "Cockpit 账号目录"),
    true,
  );
  const note = document.createElement("p");
  note.className = "notice";
  note.textContent = text(
    "Check-in reads existing account credentials in memory and sends them only to CodeBuddy. It does not copy credentials or refresh tokens. Enable only for your own accounts.",
    "签到仅在内存使用已有登录，认证信息只发送到 CodeBuddy 官方服务，不复制或刷新令牌。请仅接入你自己的账号。",
  );
  $("form").append(note);
  flag("questionsEnabled", text("MCP clarification questions", "MCP 普通问答"));
  const questionNote = document.createElement("p");
  questionNote.className = "notice";
  questionNote.textContent = text(
    "Copy the MCP configuration into a compatible AI client. Questions wait for your answer; security approvals stay in the original app.",
    "将 MCP 配置复制到兼容的 AI 客户端后使用。问题等待你的实际回答；安全审批仍由原应用处理。",
  );
  $("form").append(questionNote);
  flag(
    "gatewayEnabled",
    text("Gateway controls (Windows)", "喵云网关开关（Windows）"),
    result.platform !== "win32",
  );
  field(
    "gatewayExecutable",
    text("Gateway wb2api.exe", "网关 wb2api.exe 路径"),
  );
  const port = document.createElement("input");
  port.type = "number";
  port.min = 1;
  port.max = 65535;
  port.id = "gatewayPort";
  port.value = current.gatewayPort;
  row(text("Gateway port", "网关端口"), port);
  const title = document.createElement("h2");
  title.textContent = text("Application shortcuts", "应用快捷打开");
  const apps = document.createElement("div");
  apps.id = "apps";
  $("form").append(title, apps);
  for (const item of current.apps) appRow(item);
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = text("Add application", "添加应用");
  add.onclick = () => {
    if (rows.length < 20) appRow();
  };
  $("form").append(add);
  $("save").textContent = text("Save", "保存");
  $("mcp").textContent = text("Copy MCP configuration", "复制 MCP 配置");
  if (!result.available) $("save").disabled = true;
});
$("save").onclick = async () => {
  if (!current) return;
  $("save").disabled = true;
  try {
    const value = { ...current };
    for (const key of [
      "qqmusicEnabled",
      "cockpitCheckinEnabled",
      "questionsEnabled",
      "gatewayEnabled",
    ])
      value[key] = $(key).checked;
    for (const key of [
      "qqmusicExecutable",
      "cockpitDataRoot",
      "gatewayExecutable",
    ])
      value[key] = $(key).value;
    value.gatewayPort = Number($("gatewayPort").value);
    value.apps = rows
      .filter((row) => row.name.value.trim() || row.executable.value.trim())
      .map((row) => ({
        id: row.id,
        name: row.name.value.trim(),
        executable: row.executable.value.trim(),
      }));
    const result = await window.desktopSettings.invoke("save", value);
    $("status").textContent =
      result.status === "ok"
        ? text("Saved", "已保存")
        : result.message || text("Could not save", "保存失败");
    if (result.status === "ok") current = result.settings;
  } finally {
    $("save").disabled = false;
  }
};
$("mcp").onclick = async () => {
  const result = await window.desktopSettings.invoke("copy-mcp");
  $("status").textContent =
    result.status === "ok"
      ? text("MCP configuration copied", "MCP 配置已复制")
      : text("Could not copy", "复制失败");
};
