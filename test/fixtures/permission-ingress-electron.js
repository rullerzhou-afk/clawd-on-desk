"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { registerPermissionIpc } = require("../../src/permission");
const { createPermissionIngressHarness, postPermission, dummyPermission, waitUntil } = require("../helpers/permission-ingress-harness");

// Run with Electron, never with the application main: no real profile, hooks,
// integrations, agent tools, or remote approvals are loaded by this fixture.
const evidenceDir = process.env.CLAWD_INGRESS_EVIDENCE_DIR;
const expectBlocked = process.env.CLAWD_INGRESS_EXPECT_BLOCKED !== "0";
app.on("window-all-closed", () => {});
const deadline = setTimeout(() => app.exit(1), 25000);

app.whenReady().then(async () => {
  const harness = await createPermissionIngressHarness({ render: true });
  const registration = registerPermissionIpc({ ipcMain, permission: harness.permission });
  const pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Issue 976 isolated cross-origin sender</title>");
  });
  pageServer.listen(0, "127.0.0.1");
  await once(pageServer, "listening");
  const browser = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  } });
  try {
    const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
    await browser.loadURL(pageOrigin);
    const browserResult = browser.webContents.executeJavaScript(`
      fetch(${JSON.stringify(`http://127.0.0.1:${harness.port}/permission`)}, {
        method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" },
        body: ${JSON.stringify(JSON.stringify(dummyPermission("browser-forged")))},
        signal: AbortSignal.timeout(4000)
      }).then(r => ({type:r.type,status:r.status})).catch(e => ({error:e.name}))
    `);
    if (!expectBlocked) {
      await waitUntil(() => harness.shown.length === 1, "browser did not create approval UI");
      const entry = harness.shown[0];
      await waitUntil(() => entry.bubbleReady, "approval renderer did not load");
      await waitUntil(() => entry.bubble.isVisible(), "approval bubble not visible");
      const text = await entry.bubble.webContents.executeJavaScript("document.body.innerText");
      assert.match(text, /issue-976-browser-forged/);
      if (evidenceDir) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, "baseline-forged-bubble.png"), (await entry.bubble.webContents.capturePage()).toPNG());
      }
      harness.permission.resolvePermissionEntry(entry, "no-decision", "Fixture cleanup");
    }
    const browserOutcome = await browserResult;
    // A browser/network policy can block localhost before HTTP dispatch. That
    // is not evidence that the server guard works: require actual delivery.
    assert.equal(harness.requests.length, 1, "browser request must reach the real HTTP server");
    const browserRequest = harness.requests[0];
    assert.equal(browserRequest.method, "POST");
    assert.equal(browserRequest.path, "/permission");
    assert.equal(browserRequest.origin, pageOrigin);
    assert.equal(browserRequest.contentType, "text/plain");
    if (expectBlocked) assert.equal(browserRequest.status, 403);
    assert.equal(harness.shown.length, expectBlocked ? 0 : 1);
    const browserBubbleCount = harness.shown.length;

    // Same session, independent sockets and inputs. Resolving B must not
    // resolve A. These dummy clients deliberately execute no agent or tool.
    const a = postPermission(harness.port, dummyPermission("legitimate-A"));
    await waitUntil(() => harness.permission.pendingPermissions.length === 1, "A not pending");
    const entryA = harness.permission.pendingPermissions[0];
    const b = postPermission(harness.port, dummyPermission("unrelated-B"));
    await waitUntil(() => harness.permission.pendingPermissions.length === 2, "B not pending");
    const entryB = harness.permission.pendingPermissions[1];
    await waitUntil(() => entryA.bubbleReady && entryB.bubbleReady, "A/B UI did not render");
    harness.permission.resolvePermissionEntry(entryB, "allow");
    assert.equal(JSON.parse((await b.response).body).hookSpecificOutput.decision.behavior, "allow");
    assert.equal(a.settled, false);
    assert.equal(harness.permission.pendingPermissions[0], entryA);
    assert.equal(entryA.bubble.isDestroyed(), false);
    harness.permission.resolvePermissionEntry(entryA, "deny", "Dummy request only");
    assert.equal(JSON.parse((await a.response).body).hookSpecificOutput.decision.behavior, "deny");
    const result = { platform: process.platform, arch: process.arch, electron: process.versions.electron,
      chromium: process.versions.chrome, expectBlocked, pageOrigin, browserOutcome,
      browserBubbleCount, browserRequest, separateResponses: true, realAgentExecuted: false,
      securityFlagsDisabled: app.commandLine.hasSwitch("no-sandbox") };
    if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, expectBlocked ? "fixed-electron.json" : "baseline-electron.json"), JSON.stringify(result, null, 2));
    console.log("PERMISSION_INGRESS_ELECTRON_OK " + JSON.stringify(result));
  } finally {
    browser.destroy();
    registration.dispose();
    await harness.close();
    await new Promise((resolve) => pageServer.close(resolve));
    clearTimeout(deadline);
  }
  app.exit(0);
}).catch((error) => { console.error(error.stack); app.exit(1); });
