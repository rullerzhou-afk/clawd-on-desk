"use strict";
// Explicit source IDs retain provenance; this does not grant tool permissions.
const QUESTION_SOURCES=Object.freeze([
  'codex','workbuddy','claude-code','gemini-cli','copilot-cli','cursor-agent',
  'kiro-cli','kimi-cli','codebuddy','qoder','opencode','mimocode','pi','hermes','reasonix','zcode',
]);
module.exports={QUESTION_SOURCES,isQuestionSource:source=>QUESTION_SOURCES.includes(source)};
