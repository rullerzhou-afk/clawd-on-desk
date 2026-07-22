"use strict";

// IPC surface for the read-only credential reader. `read-all` returns masked
// rows only; `reveal`/`copy` are the explicit raw-token paths. Editing/write-
// back was removed — this tab only reads and displays platform tokens.

const defaultReader = require("./credential-reader");

function registerCredentialIpc({ ipcMain, clipboard, reader = defaultReader }) {
  ipcMain.handle("credentials:read-all", () => reader.readAllCredentials());

  ipcMain.handle("credentials:reveal", (_event, agentId) => {
    if (typeof agentId !== "string") return { agentId: null, token: null, found: false };
    return reader.revealAgentToken(agentId);
  });

  ipcMain.handle("credentials:copy", (_event, agentId) => {
    if (typeof agentId !== "string") return { ok: false };
    const { token } = reader.revealAgentToken(agentId);
    if (!token) return { ok: false };
    clipboard.writeText(token);
    return { ok: true };
  });
}

module.exports = { registerCredentialIpc };
