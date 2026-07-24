"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  LOCAL_SESSION_PROFILE_ID,
  makeSessionKey,
  resolveSessionIdentity,
} = require("../src/session-key");

test("local session action ids use the same opaque profile envelope", () => {
  const key = makeSessionKey({
    profileId: LOCAL_SESSION_PROFILE_ID,
    rawSessionId: "thread-1",
  });
  assert.match(key, /^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(key.includes("thread-1"), false);
});

test("same raw session id in two remote profiles produces opaque collision-free keys", () => {
  const a = makeSessionKey({ profileId: "profile_a", rawSessionId: "same::raw" });
  const b = makeSessionKey({ profileId: "profile_b", rawSessionId: "same::raw" });
  assert.notEqual(a, b);
  assert.match(a, /^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(a.includes("same::raw"), false);
  assert.equal(a.includes("profile_a"), false);
});

test("session identity preserves raw id strictly for display", () => {
  assert.deepEqual(resolveSessionIdentity("abc", "profile_a"), {
    profileId: "profile_a",
    rawSessionId: "abc",
    sessionId: makeSessionKey({ profileId: "profile_a", rawSessionId: "abc" }),
  });
});

test("a local raw id cannot collide with a remote canonical key", () => {
  const remote = makeSessionKey({ profileId: "profile_a", rawSessionId: "thread-1" });
  const local = makeSessionKey({
    profileId: LOCAL_SESSION_PROFILE_ID,
    rawSessionId: remote,
  });
  assert.notEqual(local, remote);
});
