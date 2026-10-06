"use strict";

// Optional process-local OpenSSH config override. The normal application
// leaves this unset and continues to use the user's standard SSH config.
// The tracked Codespaces harness sets it so Windows OpenSSH receives an
// explicit `-F` path; changing USERPROFILE/HOME is not sufficient on Windows.

const path = require("path");

const REMOTE_SSH_CONFIG_ENV = "CLAWD_REMOTE_SSH_CONFIG_FILE";

function getRemoteSshConfigFile(env = process.env) {
  const value = env && env[REMOTE_SSH_CONFIG_ENV];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string"
    || /[\0\r\n]/.test(value)
    || value.startsWith("-")
    || !path.isAbsolute(value)) {
    throw new Error(`${REMOTE_SSH_CONFIG_ENV} must be an absolute path without control characters`);
  }
  return value;
}

function appendRemoteSshConfigArgs(args, env = process.env) {
  const configFile = getRemoteSshConfigFile(env);
  if (configFile) args.push("-F", configFile);
  return args;
}

module.exports = {
  REMOTE_SSH_CONFIG_ENV,
  getRemoteSshConfigFile,
  appendRemoteSshConfigArgs,
};
