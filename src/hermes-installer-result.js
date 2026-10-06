"use strict";

// ── Hermes installer result (shared wire contract) ──
//
// hooks/hermes-install.js prints exactly one sentinel line on stdout. Every
// deploy path that runs it parses that line through this module so the schema
// stays single-sourced: src/wsl-deploy.js (wsl.exe stdin pipe) and
// src/remote-ssh-deploy.js (fenced SSH command). WSL and Remote SSH share
// only this parser and the plugin asset list — never their orchestration.
//
// schemaVersion stays 1; the installer may add fields additively, and this
// parser passes the whole object through untouched so new fields reach the
// caller without a change here.

const HERMES_RESULT_SENTINEL = "CLAWD_HERMES_RESULT_V1=";
const HERMES_RESULT_SCHEMA_VERSION = 1;

// The two managed plugin assets. Both deploy paths ship exactly these files
// into their staging directory and remove exactly these files afterwards —
// no recursive deletion anywhere.
const HERMES_PLUGIN_ASSET_FILES = Object.freeze(["plugin.yaml", "__init__.py"]);

function parseHermesInstallerResult(stdout, expectedOperation) {
  const text = typeof stdout === "string" ? stdout : "";
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith(HERMES_RESULT_SENTINEL));
  if (lines.length !== 1) return { ok: false, error: "Hermes installer did not return exactly one result sentinel" };
  let result;
  try {
    result = JSON.parse(lines[0].slice(HERMES_RESULT_SENTINEL.length));
  } catch (err) {
    return { ok: false, error: `Hermes installer returned invalid JSON: ${err.message}` };
  }
  if (!result || result.schemaVersion !== HERMES_RESULT_SCHEMA_VERSION) {
    return { ok: false, error: "Unsupported Hermes installer result schema" };
  }
  if (!["ok", "warning", "error"].includes(result.status)) return { ok: false, error: "Invalid Hermes installer result status" };
  if (expectedOperation && result.operation !== expectedOperation) return { ok: false, error: "Hermes installer returned the wrong operation" };
  return { ok: true, result };
}

module.exports = {
  HERMES_RESULT_SENTINEL,
  HERMES_RESULT_SCHEMA_VERSION,
  HERMES_PLUGIN_ASSET_FILES,
  parseHermesInstallerResult,
};
