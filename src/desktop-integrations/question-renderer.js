"use strict";
const $ = (id) => document.getElementById(id);
let payload;
$("questions").onsubmit = (event) => event.preventDefault();
window.clawdQuestion.get().then((input) => {
  if (!input) return;
  payload = input;
  const zh = input.lang?.startsWith("zh");
  $("heading").textContent = zh ? "请你选择" : "Your answer";
  $("source").textContent =
    (zh ? "MCP 来源（客户端声明）：" : "MCP source (client declared): ") +
    input.source;
  $("submit").textContent = zh ? "提交" : "Submit";
  $("cancel").textContent = zh ? "取消" : "Cancel";
  input.questions.forEach((q, i) => {
    const field = document.createElement("fieldset"),
      legend = document.createElement("legend");
    legend.textContent = q.question;
    field.append(legend);
    q.options.forEach((o, index) => {
      const label = document.createElement("label"),
        control = document.createElement("input");
      control.type = q.multiSelect ? "checkbox" : "radio";
      control.name = "q" + i;
      control.value = String(index);
      label.append(
        control,
        document.createTextNode(
          o.label + (o.description ? " — " + o.description : ""),
        ),
      );
      field.append(label);
    });
    const other = document.createElement("textarea");
    other.id = "other" + i;
    other.maxLength = 8000;
    other.placeholder = zh ? "其他 / 自定义答案" : "Other / your own answer";
    other.addEventListener("input", () => {
      if (!q.multiSelect && other.value)
        for (const control of field.querySelectorAll("input"))
          control.checked = false;
    });
    for (const control of field.querySelectorAll("input"))
      control.addEventListener("change", () => {
        if (!q.multiSelect) other.value = "";
      });
    field.append(other);
    $("questions").append(field);
  });
});
$("submit").onclick = async () => {
  if (!payload) return;
  const answers = payload.questions.map((q, i) => ({
    selected: [
      ...document.querySelectorAll('input[name="q' + i + '"]:checked'),
    ].map((c) => Number(c.value)),
    other: $("other" + i).value,
  }));
  const result = await window.clawdQuestion.answer(answers);
  if (!result?.ok)
    $("error").textContent = payload.lang?.startsWith("zh")
      ? "请回答每一个问题"
      : "Please answer every question";
};
$("cancel").onclick = () => window.clawdQuestion.cancel();
