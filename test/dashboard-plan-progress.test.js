"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");

test("Dashboard progress is rendered in a dedicated, wrappable row instead of clipped meta", () => {
  const appendMeta = renderer.split("function appendMeta(main, session, now) {")[1]
    .split("function appendPath(main, session) {")[0];
  assert.doesNotMatch(appendMeta, /planProgress|codexPlanProgress/);
  const appendPlan = renderer.split("function appendPlanProgress(main, session) {")[1]
    .split("function appendContextUsage(main, session) {")[0];
  assert.match(appendPlan, /session\.planProgress/);
  assert.match(appendPlan, /"plan-progress-row"/);
  assert.match(renderer, /appendMeta\(main, session, now\);\s*appendPlanProgress\(main, session\);/);
  const css = [...html.matchAll(/\.plan-progress-row\s*\{[^}]+\}/g)].at(-1);
  assert.ok(css);
  assert.match(css[0], /white-space:\s*normal/);
  assert.match(css[0], /overflow-wrap:\s*anywhere/);
});
