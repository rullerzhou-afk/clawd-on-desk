"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");
const { initMobilePreviewServer } = require("../src/network/mobile-preview-server");
const { atomicWrite } = require("../src/network/mobile-device-store");

for (const enabling of [false, true]) {
  for (const failure of ["token", "devices", "prefs", "none"]) {
    test(`${enabling ? "reset-and-enable" : "reset access"} via controller: ${failure}`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mobile-settings-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const tokenPath = path.join(dir, "mobile-token.json");
      atomicWrite(tokenPath, { token: "a".repeat(32) });
      let fail = false, saves = 0, commits = 0;
      const server = initMobilePreviewServer({ tokenPath, log() {},
        writeTokenState(file, value) { if (fail && failure === "token") return false; return atomicWrite(file, value); },
        writeDeviceState(file, value) { if (fail && failure === "devices") return false; return atomicWrite(file, value); },
      });
      t.after(() => server.cleanup());
      const snapshot = { ...prefs.getDefaults(), mobilePreviewEnabled: true, mobilePermissionPreviewEnabled: !enabling };
      const ctrl = createSettingsController({ prefsPath: path.join(dir, "prefs.json"),
        loadResult: { snapshot, locked: false },
        prefs: { save() { saves++; if (failure === "prefs") throw new Error("prefs full"); } },
        injectedDeps: { resetMobileAccess: server.resetMobileAccess, refreshMobilePairCode: server.refreshPairCode },
      });
      ctrl.subscribe(() => { commits++; });
      const before = ctrl.getSnapshot(); fail = true;
      const result = await ctrl.applyCommand(enabling ? "setMobilePermissionPreviewEnabled" : "mobilePreview.resetAccess",
        enabling ? { enabled: true, confirmed: true, resetAccess: true } : {});
      const resetFailed = failure === "token" || failure === "devices";
      assert.equal(result.status, resetFailed || (enabling && failure === "prefs") ? "error" : "ok");
      assert.equal("token" in result, false); assert.equal("commit" in result, false);
      if (resetFailed) {
        assert.equal(result.partialReset, failure === "devices"); assert.equal(saves, 0); assert.equal(commits, 0);
        assert.deepEqual(ctrl.getSnapshot(), before);
      } else if (enabling && failure === "prefs") {
        assert.equal(result.tokenReset, true); assert.equal(result.rePairRequired, true);
        assert.equal(saves, 1); assert.equal(commits, 0); assert.equal(ctrl.get("mobilePermissionPreviewEnabled"), false);
      } else {
        assert.equal(ctrl.get("mobilePermissionPreviewEnabled"), true);
        assert.equal(saves, enabling ? 1 : 0); assert.equal(commits, enabling ? 1 : 0);
      }
      assert.equal(JSON.parse(fs.readFileSync(tokenPath)).token === "a".repeat(32), failure === "token");
      const refresh = await ctrl.applyCommand("mobilePreview.refreshPairCode", {});
      assert.equal(refresh.status, failure === "devices" ? "error" : "ok"); assert.equal("token" in refresh, false);
      assert.equal((await ctrl.applyCommand("mobilePreview.regenerateToken", {})).status, "error");
    });
  }
}
