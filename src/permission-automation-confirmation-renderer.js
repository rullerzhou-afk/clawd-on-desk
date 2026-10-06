"use strict";

const bridge = window.permissionAutomationConfirmation;
const root = document.getElementById("dialog");
const title = document.getElementById("title");
const message = document.getElementById("message");
const detail = document.getElementById("detail");
const checkboxRow = document.getElementById("checkbox-row");
const checkbox = document.getElementById("suppress");
const checkboxLabel = document.getElementById("checkbox-label");
const confirmButton = document.getElementById("confirm");
const cancelButton = document.getElementById("cancel");
const closeButton = document.getElementById("close");

function submit(action) {
  bridge.submit({
    action,
    suppressFutureConfirmation: checkbox.checked,
  });
}

bridge.onState((state = {}) => {
  const isError = state.kind === "error";
  document.documentElement.lang = state.lang || "en";
  document.title = state.title || "Clawd";
  root.dataset.kind = isError ? "error" : "confirm";
  title.textContent = state.title || "";
  message.textContent = state.message || "";
  message.hidden = !state.message;
  detail.textContent = state.detail || "";
  checkboxLabel.textContent = state.checkboxLabel || "";
  confirmButton.textContent = isError ? (state.dismissLabel || "OK") : (state.confirmLabel || "OK");
  cancelButton.textContent = state.cancelLabel || "Cancel";
  closeButton.title = isError ? (state.dismissLabel || "Close") : (state.cancelLabel || "Cancel");
  closeButton.setAttribute("aria-label", closeButton.title);
  checkboxRow.hidden = isError || !state.checkboxLabel;
  cancelButton.hidden = isError;
  confirmButton.classList.toggle("danger", !isError);
  if (isError) confirmButton.focus();
  else cancelButton.focus();
  bridge.stateApplied();
});
bridge.ready();

confirmButton.addEventListener("click", () => {
  submit(root.dataset.kind === "error" ? "dismiss" : "confirm");
});
cancelButton.addEventListener("click", () => submit("cancel"));
closeButton.addEventListener("click", () => submit("cancel"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    submit("cancel");
  }
});
