"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  REMOTE_SSH_CONFIG_ENV,
  getRemoteSshConfigFile,
  appendRemoteSshConfigArgs,
} = require("../src/remote-ssh-local-config");
const { buildSshArgs, buildScpArgs } = require("../src/remote-ssh-runtime");
const { buildSshConfigArgs } = require("../src/remote-ssh-transport");

test("remote SSH config override is absent by default and validates explicit paths", () => {
  assert.equal(getRemoteSshConfigFile({}), null);
  assert.throws(
    () => getRemoteSshConfigFile({ [REMOTE_SSH_CONFIG_ENV]: "relative/config" }),
    /absolute path/,
  );
  assert.throws(
    () => getRemoteSshConfigFile({ [REMOTE_SSH_CONFIG_ENV]: "-oProxyCommand=evil" }),
    /absolute path/,
  );
  const absolute = path.resolve("tmp", "isolated-ssh-config");
  assert.equal(getRemoteSshConfigFile({ [REMOTE_SSH_CONFIG_ENV]: absolute }), absolute);
  assert.deepEqual(appendRemoteSshConfigArgs(["-G"], {
    [REMOTE_SSH_CONFIG_ENV]: absolute,
  }), ["-G", "-F", absolute]);
});

test("one process-local override reaches ssh, scp, and effective transport inspection", () => {
  const previous = process.env[REMOTE_SSH_CONFIG_ENV];
  const absolute = path.resolve("tmp", "codespaces-ssh-config");
  try {
    process.env[REMOTE_SSH_CONFIG_ENV] = absolute;
    assert.deepEqual(buildSshArgs({ host: "space" }).slice(-3), ["-F", absolute, "space"]);
    assert.deepEqual(buildScpArgs({}).slice(-2), ["-F", absolute]);
    assert.deepEqual(buildSshConfigArgs({ host: "space" }), ["-G", "-F", absolute, "space"]);
  } finally {
    if (previous === undefined) delete process.env[REMOTE_SSH_CONFIG_ENV];
    else process.env[REMOTE_SSH_CONFIG_ENV] = previous;
  }
});
