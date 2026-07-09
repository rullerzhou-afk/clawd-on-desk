"use strict";

function mapWavePetToClawd(waveState, options = {}) {
  const input = waveState && typeof waveState === "object" ? waveState : {};
  const state = input.state || "steady_work";

  let clawdState = "working";
  let displayHint = "clawd-working-typing.svg";

  if (state === "reading_understanding") {
    clawdState = "thinking";
    displayHint = "clawd-working-thinking.svg";
  } else if (state === "steady_work") {
    clawdState = "working";
    displayHint = "clawd-working-typing.svg";
  } else if (state === "deep_output") {
    clawdState = "working";
    displayHint = "clawd-working-ultrathink.svg";
  } else if (state === "overheat_debugging") {
    clawdState = options.hardFailure === true ? "error" : "working";
    displayHint = options.hardFailure === true ? null : "clawd-working-debugger.svg";
  } else if (state === "closing") {
    clawdState = options.completed === true ? "attention" : "thinking";
    displayHint = options.completed === true ? null : "clawd-working-thinking.svg";
  }

  return {
    state: clawdState,
    displayHint,
    wavepet: input,
  };
}

module.exports = {
  mapWavePetToClawd,
};
