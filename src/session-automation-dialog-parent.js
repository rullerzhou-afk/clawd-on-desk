"use strict";

function usableWindow(candidate) {
  if (!candidate || typeof candidate.isDestroyed !== "function") return false;
  try {
    return candidate.isDestroyed() !== true;
  } catch {
    return false;
  }
}

function selectSessionAutomationDialogParent({ entry, petWindow } = {}) {
  const bubble = entry && entry.bubble;
  if (usableWindow(bubble)) return bubble;

  // Dashboard requests carry the BrowserWindow resolved from the invoking
  // webContents. Parenting the native warning to the always-on-top pet leaves
  // the dialog visible but inactive on Windows.
  const warningParent = entry && entry.warningParent;
  if (usableWindow(warningParent)) return warningParent;

  return usableWindow(petWindow) ? petWindow : null;
}

module.exports = {
  selectSessionAutomationDialogParent,
};
