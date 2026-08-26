"use strict";

const card = document.getElementById("queueCard");
const launcher = document.getElementById("queueLauncher");
const launcherCopy = document.getElementById("queueLauncherCopy");
const launcherAction = document.getElementById("queueLauncherAction");
const title = document.getElementById("queueTitle");
const closeButton = document.getElementById("queueClose");
const list = document.getElementById("queueList");

const STRINGS = {
  en: { pending: "{count} more pending", view: "View ›", title: "All {total} · {hidden} collapsed", close: "Collapse", empty: "No pending requests", answer: "Answer", viewPlan: "View plan", viewRequest: "View", locked: "Finish typing to switch" },
  zh: { pending: "还有 {count} 个待处理", view: "查看 ›", title: "全部 {total} 个 · 其中 {hidden} 个已收起", close: "收起", empty: "没有待处理请求", answer: "回答", viewPlan: "查看计划", viewRequest: "查看", locked: "请先完成当前输入" },
  "zh-TW": { pending: "還有 {count} 個待處理", view: "查看 ›", title: "全部 {total} 個 · 其中 {hidden} 個已收合", close: "收合", empty: "沒有待處理請求", answer: "回答", viewPlan: "查看計畫", viewRequest: "查看", locked: "請先完成目前輸入" },
  ko: { pending: "대기 중인 요청 {count}개 더 있음", view: "보기 ›", title: "전체 {total}개 · {hidden}개 접힘", close: "접기", empty: "대기 중인 요청 없음", answer: "답변", viewPlan: "계획 보기", viewRequest: "보기", locked: "입력을 마친 후 전환하세요" },
  ja: { pending: "保留中のリクエストがあと {count} 件", view: "表示 ›", title: "全 {total} 件 · {hidden} 件を収納", close: "閉じる", empty: "保留中のリクエストはありません", answer: "回答", viewPlan: "計画を表示", viewRequest: "表示", locked: "入力を完了してから切り替えてください" },
  "pt-BR": { pending: "Mais {count} pendentes", view: "Ver ›", title: "Todos: {total} · {hidden} recolhidos", close: "Recolher", empty: "Nenhuma solicitação pendente", answer: "Responder", viewPlan: "Ver plano", viewRequest: "Ver", locked: "Termine de digitar para alternar" },
  es: { pending: "{count} pendientes más", view: "Ver ›", title: "Todas: {total} · {hidden} contraídas", close: "Contraer", empty: "No hay solicitudes pendientes", answer: "Responder", viewPlan: "Ver plan", viewRequest: "Ver", locked: "Termina de escribir para cambiar" },
};

let currentPayload = null;

function text(lang, key, values = {}) {
  const strings = STRINGS[lang] || STRINGS.en;
  let value = strings[key] || STRINGS.en[key] || key;
  for (const [name, replacement] of Object.entries(values)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

function rowActionLabel(lang, action) {
  if (action === "answer") return text(lang, "answer");
  if (action === "view-plan") return text(lang, "viewPlan");
  return text(lang, "viewRequest");
}

function renderDrawer(payload) {
  const lang = payload.lang || "en";
  title.textContent = text(lang, "title", {
    total: payload.totalCount,
    hidden: payload.hiddenCount,
  });
  closeButton.textContent = text(lang, "close");
  closeButton.setAttribute("aria-label", text(lang, "close"));
  list.textContent = "";

  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = text(lang, "empty");
    list.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const section = document.createElement("section");
    section.className = "queue-session";
    const heading = document.createElement("h2");
    heading.className = "queue-session-title";
    heading.textContent = [session.agentLabel, session.sessionLabel].filter(Boolean).join(" · ");
    section.appendChild(heading);

    for (const entry of Array.isArray(session.entries) ? session.entries : []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "queue-row";
      row.classList.toggle("visible", entry.visible === true);
      row.disabled = payload.switchingLocked === true;
      if (row.disabled) row.title = text(lang, "locked");

      const tool = document.createElement("span");
      tool.className = "queue-row-tool";
      tool.textContent = entry.toolLabel || "Request";
      const summary = document.createElement("span");
      summary.className = "queue-row-summary";
      summary.textContent = entry.summary || "";
      const action = document.createElement("span");
      action.className = "queue-row-action";
      action.textContent = rowActionLabel(lang, entry.action);
      row.append(tool, summary, action);
      row.addEventListener("click", () => {
        window.permissionQueueAPI.select({
          uiEntryId: entry.uiEntryId,
          intent: entry.action,
        });
      });
      section.appendChild(row);
    }
    list.appendChild(section);
  }
}

function acknowledge(payload) {
  const sendAcknowledgement = () => {
    const acknowledgement = { revision: payload.revision };
    if (payload.drawerOpen) {
      card.classList.add("measuring");
      acknowledgement.height = Math.ceil(card.scrollHeight + 12);
      card.classList.remove("measuring");
    }
    window.permissionQueueAPI.acknowledge(acknowledgement);
  };

  // Chromium suspends requestAnimationFrame for a BrowserWindow that has
  // never been shown. The first compact queue revision is deliberately sent
  // while this window is hidden, and the main process waits for this ACK
  // before showing it. Send that revision synchronously to avoid a visibility
  // deadlock. Once visible, keep the frame boundary so drawer measurement
  // observes the rendered layout.
  if (document.visibilityState === "hidden") {
    sendAcknowledgement();
    return;
  }
  requestAnimationFrame(sendAcknowledgement);
}

function render(payload) {
  if (!payload || !Number.isInteger(payload.revision)) return;
  currentPayload = payload;
  const lang = payload.lang || "en";
  card.classList.toggle("drawer", payload.drawerOpen === true);
  launcherCopy.textContent = text(lang, "pending", { count: payload.hiddenCount });
  launcherAction.textContent = payload.switchingLocked
    ? text(lang, "locked")
    : text(lang, "view");
  launcher.disabled = payload.switchingLocked === true;
  renderDrawer(payload);
  acknowledge(payload);
}

launcher.addEventListener("click", () => window.permissionQueueAPI.open());
closeButton.addEventListener("click", () => window.permissionQueueAPI.close());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && currentPayload && currentPayload.drawerOpen) {
    event.preventDefault();
    window.permissionQueueAPI.close();
  }
});

window.permissionQueueAPI.onShow(render);
