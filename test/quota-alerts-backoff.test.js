"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createQuotaAlerts } = require("../src/quota-alerts");
const START = 1800000001000;
function fixture(notify) {
  let time = START;
  const events = [];
  const alerts = createQuotaAlerts({ historyPath: null, now: () => time,
    notify: event => { events.push(event); return notify(event); } });
  return { alerts, events, advance: ms => { time += ms; },
    observe(remaining = 9, { suppressed = false, resetAt = START + 86400000, sourceKey = "" } = {}) {
      return alerts.observe([{ sourceKey, codexQuota: { group: { codexFiveHour: {
        usedPercent: 100 - remaining, windowMinutes: 300, lastSeenAt: time, resetAt,
      } }, updatedAt: time, lastSeenAt: time } }], { enabled: true, thresholds: [20, 10], recoveryEnabled: true, suppressed });
    } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("persistent failure backs off to a bound without consuming eligibility", () => {
  let success = false;
  const h = fixture(() => success);
  try {
    h.advance(1); h.observe(); assert.equal(h.events.length, 1);
    for (const delay of [30000, 60000, 120000, 240000, 480000, 900000, 900000]) {
      const before = h.events.length;
      h.advance(delay - 1); h.observe(); assert.equal(h.events.length, before);
      h.advance(1); h.observe(); assert.equal(h.events.length, before + 1);
    }
    success = true;
    h.advance(900000); h.observe();
    const delivered = h.events.length;
    h.advance(900000); h.observe(); assert.equal(h.events.length, delivered, "successful delivery finally consumes the threshold");
  } finally { h.alerts.dispose(); }
});

test("failure cooldown is independent by source and urgent threshold", () => {
  const h = fixture(() => false);
  try {
    h.advance(1); h.observe(19);
    h.advance(1); h.observe(9);
    h.observe(9, { sourceKey: "remote:fixture" });
    assert.deepEqual(h.events.map(event => [event.sourceKey, event.threshold]), [["", 20], ["", 10], ["remote:fixture", 10]]);
    h.advance(1); h.observe(9); assert.equal(h.events.length, 3);
  } finally { h.alerts.dispose(); }
});

test("DND does not create or extend failure cooldown and a new window starts fresh", () => {
  const h = fixture(() => false);
  try {
    h.advance(1); h.observe(9, { suppressed: true }); assert.equal(h.events.length, 0);
    h.observe(); assert.equal(h.events.length, 1);
    h.advance(30000); h.observe(9, { suppressed: true }); assert.equal(h.events.length, 1);
    h.observe(); assert.equal(h.events.length, 2, "DND must not push the due attempt further away");
    h.advance(1); h.observe(9, { resetAt: START + 86400001 }); assert.equal(h.events.length, 3);
  } finally { h.alerts.dispose(); }
});

test("async rejection and synchronous throw follow the same cooldown", async () => {
  const sends = [];
  const h = fixture(() => new Promise((resolve, reject) => sends.push({ resolve, reject })));
  try {
    h.advance(1); h.observe(); sends[0].reject(new Error("fixture failure")); await settle();
    h.advance(29999); h.observe(); assert.equal(sends.length, 1);
    h.advance(1); h.observe(); assert.equal(sends.length, 2);
    sends[1].resolve(true); await settle(); h.observe(); assert.equal(sends.length, 2);
  } finally { h.alerts.dispose(); }
  const thrown = fixture(() => { throw new Error("fixture unavailable"); });
  try {
    thrown.advance(1); thrown.observe(); thrown.advance(1); thrown.observe();
    assert.equal(thrown.events.length, 1);
    thrown.advance(29999); thrown.observe(); assert.equal(thrown.events.length, 2);
  } finally { thrown.alerts.dispose(); }
});

test("a negative async acknowledgement in the same window starts the cooldown", async () => {
  const sends = [];
  const h = fixture(() => new Promise(resolve => sends.push(resolve)));
  try {
    h.advance(1); h.observe(); sends[0](false); await settle();
    h.advance(29999); h.observe(); assert.equal(sends.length, 1);
    h.advance(1); h.observe(); assert.equal(sends.length, 2);
  } finally { h.alerts.dispose(); }
});

test("a late old-window failure cannot put its replacement into cooldown", async () => {
  const sends = [];
  const h = fixture(() => new Promise(resolve => sends.push(resolve)));
  try {
    h.advance(1); h.observe();
    h.advance(1); h.observe(9, { resetAt: START + 86400001 });
    sends[0](false); await settle();
    h.observe(9, { resetAt: START + 86400001 }); assert.equal(sends.length, 2);
    sends[1](true); await settle();
    h.observe(9, { resetAt: START + 86400001 }); assert.equal(sends.length, 2);
  } finally { h.alerts.dispose(); }
});
