"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  INITIAL_DISCOVER_TIMEOUT_MS,
  STARTUP_DISCOVER_TIMEOUT_MS,
  waitForClawdPort,
  main,
} = require("../hooks/auto-start");

test("auto-start exits without launching when Clawd is already listening", async () => {
  const calls = [];

  await new Promise((resolve) => {
    main({
      discoverClawdPort(options, callback) {
        calls.push(["discover", options.timeoutMs]);
        callback(23333);
      },
      launchApp() {
        calls.push(["launch"]);
      },
      exit(code) {
        calls.push(["exit", code]);
        resolve();
      },
    });
  });

  assert.deepStrictEqual(calls, [
    ["discover", INITIAL_DISCOVER_TIMEOUT_MS],
    ["exit", 0],
  ]);
});

test("auto-start waits for the cold-launched app before exiting", async () => {
  const calls = [];
  const ports = [null, null, 23333];

  await new Promise((resolve) => {
    main({
      discoverClawdPort(options, callback) {
        calls.push(["discover", options.timeoutMs]);
        callback(ports.shift() || null);
      },
      launchApp() {
        calls.push(["launch"]);
      },
      setTimeout(callback) {
        calls.push(["timer"]);
        callback();
        return 1;
      },
      exit(code) {
        calls.push(["exit", code]);
        resolve();
      },
    });
  });

  assert.deepStrictEqual(calls, [
    ["discover", INITIAL_DISCOVER_TIMEOUT_MS],
    ["launch"],
    ["discover", STARTUP_DISCOVER_TIMEOUT_MS],
    ["timer"],
    ["discover", STARTUP_DISCOVER_TIMEOUT_MS],
    ["exit", 0],
  ]);
});

test("waitForClawdPort gives up after the startup deadline", async () => {
  const calls = [];
  let now = 0;

  await new Promise((resolve) => {
    waitForClawdPort({
      timeoutMs: 250,
      intervalMs: 100,
      discoverTimeoutMs: 10,
      now: () => now,
      discoverClawdPort(options, callback) {
        calls.push(["discover", options.timeoutMs, now]);
        callback(null);
      },
      setTimeout(callback, delayMs) {
        calls.push(["timer", delayMs]);
        now += delayMs;
        callback();
        return 1;
      },
    }, (port) => {
      calls.push(["done", port, now]);
      resolve();
    });
  });

  assert.deepStrictEqual(calls, [
    ["discover", 10, 0],
    ["timer", 100],
    ["discover", 10, 100],
    ["timer", 100],
    ["discover", 10, 200],
    ["timer", 100],
    ["discover", 10, 300],
    ["done", null, 300],
  ]);
});
