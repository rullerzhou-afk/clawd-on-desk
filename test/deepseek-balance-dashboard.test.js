"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

class Element {
  constructor() { this.children = []; this.style = {}; this.className = ""; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
}

test("DeepSeek Dashboard reuses one quota bar with amount, remaining width, baseline and stale header", () => {
  let time = 1000000;
  const summary = new Element();
  const strings = { dashboardQuotaSectionDeepseek: "DeepSeek", dashboardDeepseekBalanceBaseline: "After top-up {amount}",
    dashboardQuotaAsOf: "as of {time}", dashboardQuotaResetMinutes: "{m}m" };
  const context = vm.createContext({
    Date: class extends Date { static now() { return time; } },
    document: { createElement: () => new Element(), createDocumentFragment: () => new Element() },
    createText: (_tag, cls, text) => Object.assign(new Element(), { className: cls, textContent: text }),
    t: (key) => strings[key] || key,
    quotaSummaryEl: summary, kimiQuotaStatus: null,
    kimiQuotaRefreshButtonEl: null, kimiQuotaRefreshFeedbackEl: null, i18nPayload: { lang: "en" },
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "quota-balance.js"), "utf8"), context);
  vm.runInContext(source.slice(source.indexOf("const QUOTA_WARN_AT"), source.indexOf("function badgeLabel")), context);
  const quota = [{ deepseekQuota: { lastSeenAt: time, group: { deepseekBalance: {
    amount: 45.2, baseline: 100, currency: "CNY", usedPercent: 55,
  } } } }];
  context.snapshot = { accountQuota: quota };
  vm.runInContext("renderQuotaSummary(snapshot)", context);
  const walk = (node) => [node, ...node.children.flatMap(walk)];
  let nodes = walk(summary);
  assert.ok(nodes.some((node) => node.textContent === "DeepSeek"));
  assert.ok(nodes.some((node) => node.textContent === "¥45.20"));
  assert.ok(nodes.some((node) => node.textContent === "After top-up ¥100"));
  const bars = nodes.filter((node) => node.className.includes("quota-bar-fill"));
  assert.equal(bars.length, 1); assert.equal(bars[0].style.width, "45%");
  assert.match(bars[0].className, /pv-deepseekQuota rg-outer sev-ok/);
  assert.ok(!nodes.some((node) => node.className === "quota-group-header"));
  time += 12 * 60000;
  vm.runInContext("renderQuotaSummary(snapshot)", context);
  assert.ok(!walk(summary).some((node) => node.className === "quota-group-header"));
  time += 60000;
  vm.runInContext("renderQuotaSummary(snapshot)", context);
  nodes = walk(summary);
  assert.ok(nodes.some((node) => node.className === "quota-group-header" && node.textContent === "as of 13m"));
  for (const field of ["amount", "baseline", "currency"]) {
    const bucket = { ...quota[0].deepseekQuota.group.deepseekBalance };
    delete bucket[field];
    context.snapshot = { accountQuota: [{
      deepseekQuota: { group: { deepseekBalance: bucket } },
      claudeQuota: { group: { claudeWeekly: { usedPercent: 12 } } },
    }] };
    assert.doesNotThrow(() => vm.runInContext("renderQuotaSummary(snapshot)", context));
    const remaining = walk(summary);
    assert.ok(!remaining.some((node) => node.textContent === "DeepSeek"));
    assert.strictEqual(remaining.filter((node) => node.className.includes("quota-bar-fill")).length, 1);
  }
});


test("DeepSeek labels and connection states exist in all seven languages", () => {
  const { createTranslator } = require("../src/i18n");
  require("../src/settings-i18n");
  for (const lang of ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]) {
    const translate = createTranslator(() => lang);
    for (const key of ["quotaRingBalance", "dashboardQuotaSectionDeepseek", "dashboardDeepseekBalanceBaseline"]) {
      assert.notEqual(translate(key), key);
    }
    const strings = globalThis.ClawdSettingsI18n.STRINGS[lang];
    for (const suffix of ["Title", "Desc", "Security", "Connect", "Disconnect", "Forget", "Reconnect",
      "StatusFresh", "StatusAgentDisabled", "StatusConfiguredDisabled", "StatusRejected", "StatusStorageUnavailable"]) {
      assert.ok(strings[`deepseekBalance${suffix}`], `${lang}: ${suffix}`);
    }
  }
});
