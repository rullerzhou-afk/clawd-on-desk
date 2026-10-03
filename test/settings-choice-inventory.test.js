"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "src");

test("Settings choice semantics are owned by the shared primitives", () => {
  const files = fs.readdirSync(src).filter((name) => /^settings.*\.(js|html)$/.test(name));
  const offenders = [];
  for (const name of files) {
    if (name === "settings-ui-core.js") continue;
    let source = fs.readFileSync(path.join(src, name), "utf8");
    // Theme Card is an intentional radio-like surface, not a segmented enum.
    if (name === "settings-tab-theme.js") {
      assert.equal(source.match(/card\.setAttribute\("role", "radio"\);/g)?.length, 1);
      source = source.replace('card.setAttribute("role", "radio");', "");
    }
    const handwrittenRole = /setAttribute\(\s*["']role["']\s*,\s*["'](?:tablist|tab|tabpanel|radiogroup|radio)["']/;
    const templateRole = /role\s*=\s*["'](?:tablist|tab|tabpanel|radiogroup|radio)["']/;
    const handwrittenSegment = /className\s*=\s*["'`][^"'`\n]*\bsegmented\b|classList\.add\(\s*["']segmented["']/;
    if (handwrittenRole.test(source) || templateRole.test(source) || handwrittenSegment.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "new Settings tabs/segmented controls must use shared primitives");
});

test("the migrated choice inventory distinguishes navigation from values", () => {
  const inventory = [
    ["settings-renderer.js", "buildTabs", ["settings-navigation"]],
    ["settings-tab-agents.js", "buildTabs", ["settings-agents"]],
    ["settings-tab-anim-overrides.js", "buildTabs", ["settings-animations"]],
    ["settings-tab-telegram-approval.js", "buildTabs", ["settings-remote-approval"]],
    ["settings-tab-agents.js", "buildSegmentedRadio", ["codex-permission-mode"]],
    ["settings-tab-telegram-approval.js", "buildSegmentedRadio", ["feishu-platform", "feishu-id-type", "approval-completion-output"]],
    ["settings-tab-recap.js", "buildSegmentedRadio", ["recap-period"]],
  ];
  for (const [name, helper, ids] of inventory) {
    const source = fs.readFileSync(path.join(src, name), "utf8");
    for (const id of ids) {
      assert.match(source, new RegExp(`${helper}\\(\\{\\s*id: "${id}"`), `${name}: ${id}`);
    }
  }
  // Intentional exceptions: Theme/asset cards and Recap row highlighting are
  // not segmented enum controls. Select/asset listboxes retain aria-selected;
  // Recap rows retain aria-pressed. Do not globally forbid those attributes.
  const recap = fs.readFileSync(path.join(src, "settings-tab-recap.js"), "utf8");
  assert.match(recap, /item\.setAttribute\("aria-pressed"/);
});
