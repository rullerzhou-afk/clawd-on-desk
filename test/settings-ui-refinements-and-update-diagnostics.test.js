const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const settingsCss = fs.readFileSync(path.join(__dirname, "..", "src", "settings.css"), "utf8");
const settingsTabAgents = fs.readFileSync(path.join(__dirname, "..", "src", "settings-tab-agents.js"), "utf8");
const settingsTabPermissions = fs.readFileSync(path.join(__dirname, "..", "src", "settings-tab-permissions.js"), "utf8");
const settingsI18n = fs.readFileSync(path.join(__dirname, "..", "src", "settings-i18n.js"), "utf8");
const { i18n } = require("../src/i18n");
const initUpdater = require("../src/updater");

describe("Settings UI refinements and update diagnostics (5-point refinement plan)", () => {
  it("Point 1: centers 'Auto' and 'Intercept' in Codex permission mode slider", () => {
    assert.match(
      settingsCss,
      /\.codex-permission-mode-segmented button \{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;[\s\S]*text-align:\s*center;/
    );
    assert.match(
      settingsCss,
      /\.codex-permission-mode-segmented \.settings-segmented-radio-label \{[\s\S]*text-align:\s*center;[\s\S]*\}/
    );
  });

  it("Point 2: uses vertical column layout for CodeBuddy custom permission URL row to prevent text squeezing", () => {
    assert.match(
      settingsCss,
      /\.agent-text-input-row \{[\s\S]*flex-direction:\s*column;[\s\S]*align-items:\s*stretch;[\s\S]*gap:\s*10px;/
    );
    assert.match(
      settingsCss,
      /\.agent-text-input-row \.row-text \{[\s\S]*width:\s*100%;[\s\S]*flex:\s*1 1 auto;[\s\S]*\}/
    );
    assert.match(
      settingsCss,
      /\.agent-text-input-control \{[\s\S]*width:\s*100%;[\s\S]*flex:\s*1 1 auto;[\s\S]*min-width:\s*0;[\s\S]*\}/
    );
  });

  it("Point 3: uses in-app showSettingsConfirmModal for agent integration uninstall with full i18n support", () => {
    assert.match(settingsTabAgents, /showSettingsConfirmModal\(\{/);
    assert.match(settingsTabAgents, /title:\s*t\("agentIntegrationUninstallConfirmTitle"\)/);
    assert.match(settingsTabAgents, /detail:\s*t\("agentIntegrationUninstallConfirm"\)/);
    assert.match(settingsTabAgents, /label:\s*t\("agentIntegrationUninstallCancel"\)/);

    const locales = ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"];
    for (const locale of locales) {
      assert.match(settingsI18n, new RegExp(`agentIntegrationUninstallConfirmTitle: "[^"]+"`));
      assert.match(settingsI18n, new RegExp(`agentIntegrationUninstallCancel: "[^"]+"`));
    }
  });

  it("Point 4: styles 'Codex 设置' button in Permissions tab using helpers.buildButton", () => {
    assert.doesNotMatch(
      settingsTabPermissions,
      /button\.className = "btn"/,
      "must not use unstyled raw button.className = 'btn'"
    );
    assert.match(
      settingsTabPermissions,
      /helpers\.buildButton\(\{[\s\S]*size:\s*"compact"[\s\S]*label:\s*t\("codexApprovalSettingsLink"\)[\s\S]*className:\s*"codex-approval-settings-btn"/
    );
  });

  it("Point 5: updater error report extracts rich diagnostics and states that repair suggestions are for reference only", async () => {
    // 1. Check i18n suggestion label in all 7 languages
    const locales = ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"];
    for (const locale of locales) {
      assert.ok(i18n[locale].updateErrorSuggestionLabel, `missing updateErrorSuggestionLabel for locale: ${locale}`);
      assert.match(
        i18n[locale].updateErrorSuggestionLabel,
        /reference|仅供参考|僅供參考|참고용|参考のみ|refer[eê]ncia/i,
        `updateErrorSuggestionLabel in ${locale} must clarify it is for reference only`
      );
    }

    // 2. Check settings-i18n next step copy specifies suggestion
    assert.match(settingsI18n, /aboutUpdateErrorNextStep:\s*"修复建议（仅供参考）："/);
    assert.match(settingsI18n, /aboutUpdateErrorNextStep:\s*"Suggested fix \(for reference only\):"/);

    // 3. Check error extraction with rich technical error properties
    const bubbles = [];
    const ctx = {
      doNotDisturb: false,
      miniMode: false,
      rebuildAllMenus() {},
      updateLog() {},
      t: (k, fb) => i18n.zh[k] || fb || k,
      lang: "zh",
      showUpdateBubble: (payload) => bubbles.push(payload),
      hideUpdateBubble() {},
      setUpdateVisualState() {},
      applyState() {},
      resolveDisplayState: () => "idle",
    };

    const updater = initUpdater(ctx, {
      app: { isPackaged: true, getVersion: () => "1.4.0", relaunch() {}, exit() {} },
      shell: { openExternal() {} },
      httpsGetImpl: (url, opts, cb) => {
        const err = new Error("getaddrinfo ENOTFOUND api.github.com");
        err.code = "ENOTFOUND";
        err.syscall = "getaddrinfo";
        err.hostname = "api.github.com";
        const callback = typeof opts === "function" ? opts : cb;
        const req = {
          on: (event, handler) => {
            if (event === "error") setImmediate(() => handler(err));
            return req;
          },
          setTimeout: () => req,
          destroy: () => {},
        };
        return req;
      },
    });

    await updater.checkForUpdates(true);

    assert.strictEqual(bubbles.length, 2);
    const errorBubble = bubbles[1];
    assert.strictEqual(errorBubble.mode, "error");

    // Detail must include the suggestion label explaining it's for reference
    assert.match(errorBubble.detail, /修复建议（仅供参考）：/);
    assert.match(errorBubble.detail, /Code:\s*DNS_FAILED/);
    assert.match(errorBubble.detail, /Syscall:\s*getaddrinfo/);
    assert.match(errorBubble.detail, /Host:\s*api\.github\.com/);
    assert.match(errorBubble.detail, /Error Code:\s*ENOTFOUND/);

    // copyText must also contain the labeled suggestion and technical fields
    assert.match(errorBubble.copyText, /\[修复建议（仅供参考）：\]/);
    assert.match(errorBubble.copyText, /Syscall:\s*getaddrinfo/);
    assert.match(errorBubble.copyText, /Host:\s*api\.github\.com/);
  });
});
