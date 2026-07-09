"use strict";

const { CodexWavePetAdapter } = require("./codex-event-adapter");
const { WavePetEngine } = require("./engine");
const { mapWavePetToClawd } = require("./clawd-mapper");

class WavePetRuntime {
  constructor(options = {}) {
    this.sessions = new Map();
    this.now = typeof options.now === "function" ? options.now : Date.now;
  }

  _sessionKey(sessionId) {
    return String(sessionId || "default");
  }

  _entry(sessionId) {
    const id = this._sessionKey(sessionId);
    let entry = this.sessions.get(id);
    if (!entry) {
      entry = {
        adapter: new CodexWavePetAdapter({ sessionId: id }),
        engine: new WavePetEngine(),
        lastMappedKey: "",
        lastOutput: null,
      };
      this.sessions.set(id, entry);
    }
    return entry;
  }

  processCodexRecord(sessionId, record, options = {}) {
    const entry = this._entry(sessionId);
    const events = entry.adapter.eventsFromRecord(record);
    if (!events.length) return null;

    let latest = null;
    for (const event of events) latest = entry.engine.update(event);
    if (!latest) return null;

    const completed = events.some(
      (event) => event.event === "assistant_end" && event.finish_reason === "stop"
    );
    const hardFailure = events.some(
      (event) => event.event === "error_feedback" && event.severity === "fatal"
    );
    const mapped = mapWavePetToClawd(latest, { completed, hardFailure });
    const mappedKey = JSON.stringify({
      state: mapped.state,
      displayHint: mapped.displayHint || null,
      waveState: latest.state,
    });

    if (mappedKey === entry.lastMappedKey && !(latest.smoothing && latest.smoothing.changed)) {
      entry.lastOutput = latest;
      return null;
    }

    entry.lastMappedKey = mappedKey;
    entry.lastOutput = latest;
    return {
      sessionId: this._sessionKey(sessionId),
      state: mapped.state,
      event: `wavepet:${latest.state}`,
      displayHint: mapped.displayHint,
      extra: {
        agentId: "codex",
        wavepet: latest,
      },
    };
  }

  getSessionSnapshot(sessionId) {
    const entry = this.sessions.get(this._sessionKey(sessionId));
    return entry ? entry.lastOutput : null;
  }

  clearSession(sessionId) {
    return this.sessions.delete(this._sessionKey(sessionId));
  }
}

module.exports = {
  WavePetRuntime,
};
