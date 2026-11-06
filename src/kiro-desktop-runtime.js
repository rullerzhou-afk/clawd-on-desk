"use strict";
const { resolveSessionIdentity } = require("./session-key");
const { createKiroDesktopInteractions } = require("./kiro-desktop-interactions");
const { createKiroDesktopReminder } = require("./kiro-desktop-reminder");
const { RECORD_TYPES } = require("../agents/kiro-desktop-log-monitor");
const { isLocalApprovalReminderSession } = require("./approval-reminder-session");

function createKiroDesktopRuntime(options) {
  const interactions = createKiroDesktopInteractions({ now: options.now });
  const reminder = createKiroDesktopReminder({
    interactions,
    getContext: options.getKiroDesktopReminderContext || (() => ({})),
    getPermissionRuntime: options.getPermissionRuntime,
  });
  let monitor = null;
  let generation = 0;
  interactions.onChange(sessionId => {
    reminder.sync(sessionId);
    options.getStateRuntime()?.refreshPendingAttention?.();
  });

  function onRecord(record) {
    const { sessionId } = resolveSessionIdentity(record.sessionId, "local");
    if (record.type === RECORD_TYPES.PENDING) interactions.add(sessionId, { ...record, sessionId });
    else if (record.type === RECORD_TYPES.RESOLVED) interactions.resolve(sessionId, record);
    else if (record.type === RECORD_TYPES.TURN_END) {
      interactions.clearExecution(sessionId, record.executionId);
    } else if ([RECORD_TYPES.REBASELINE, RECORD_TYPES.UNTRACKED].includes(record.type)) {
      interactions.clearSession(sessionId);
    }
  }

  return {
    start() {
      if (monitor) return;
      const epoch = ++generation;
      const Monitor = options.loadKiroDesktopMonitor?.() || require("../agents/kiro-desktop-log-monitor").KiroDesktopLogMonitor;
      monitor = new Monitor({
        ...(options.kiroDesktopMonitorOptions || {}),
        onRecord(record) { if (epoch === generation && monitor) onRecord(record); },
      });
      monitor.start();
    },
    stop() {
      generation++;
      const previous = monitor;
      monitor = null;
      previous?.stop();
      interactions.clearAll();
      reminder.clearCards("monitor-stopped");
    },
    onHook(sessionId, event, session) {
      if (isLocalApprovalReminderSession(session) && ["UserPromptSubmit", "Stop"].includes(event)) {
        interactions.clearSession(sessionId);
      }
    },
    resyncReminderCards() {
      for (const sessionId of interactions.getPendingSessionIds()) reminder.sync(sessionId);
    },
    clearSession: sessionId => interactions.clearSession(sessionId),
    getPendingSessionIds: () => interactions.getPendingSessionIds(),
    clearCards: reason => reminder.clearCards(reason),
  };
}
module.exports = { createKiroDesktopRuntime };
