"use strict";
const api = window.sessionResults;
const list = document.getElementById("cards");
let lastPayload = null;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function render(payload) {
  if (!payload) return;
  // Geometry-only broadcasts must not replace buttons under the pointer.
  const signature = JSON.stringify(payload);
  if (signature === lastPayload) return;
  lastPayload = signature;
  const { cards, dictionary: t, lang } = payload;
  document.documentElement.lang = lang;
  document.title = t.title;
  document.getElementById("title").textContent = t.title;
  document.getElementById("count").textContent = String(cards.length);
  const scrollTop = list.scrollTop;
  const focused = document.activeElement;
  const focusId = focused && focused.dataset.cardId;
  const focusAction = focused && focused.dataset.action;
  list.replaceChildren();
  for (const card of cards) {
    const item = element("article", "card " + card.kind);
    const heading = element("div", "card-heading");
    const icon = element("span", "status-icon", card.kind === "failed" ? "!" : "✓");
    icon.setAttribute("aria-hidden", "true");
    heading.append(icon, element("h2", "", t[card.kind]));
    const close = element("button", "close", "×");
    close.setAttribute("aria-label", t.close);
    close.title = t.close;
    close.dataset.cardId = card.id;
    close.dataset.action = "dismiss";
    close.onclick = () => { void api.dismiss(card.id, card.generation); };
    heading.append(close);
    const meta = element("div", "meta");
    const date = new Date(card.at);
    const time = element("time", "", date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }));
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString(lang);
    meta.append(element("span", "", card.agentName), time);
    const title = element("p", "session-title", card.title);
    title.title = card.title;
    item.append(heading, meta, title, element("p", "body", t[card.kind + "Body"]));
    const open = element("button", "open", card.opening ? t.opening : t.open);
    open.disabled = !card.canOpen || card.opening;
    open.dataset.cardId = card.id;
    open.dataset.action = "open";
    open.onclick = () => { void api.open(card.id, card.generation); };
    item.append(open);
    const notice = !card.canOpen ? t.unavailable
      : card.notice === "unconfirmed" ? t.unconfirmed
        : card.notice === "failed" || card.notice === "unavailable" ? t.openFailed : "";
    if (notice) item.append(element("p", "notice", notice));
    list.append(item);
  }
  list.scrollTop = scrollTop;
  if (focusId) {
    const target = [...list.querySelectorAll("button")].find(button =>
      button.dataset.cardId === focusId && button.dataset.action === focusAction);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
  requestAnimationFrame(measure);
}
function measure() {
  const rows = [...list.children].slice(0, 3);
  const height = 8 + document.querySelector("header").offsetHeight
    + rows.reduce((total, row) => total + row.offsetHeight, 0) + 2;
  if (height > 0) api.measure(Math.ceil(height));
}
api.onChange(render);
void api.ready().then(render);
new ResizeObserver(measure).observe(list);
