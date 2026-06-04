const vscode = require("vscode");
const http = require("http");

// Port range for Clawd terminal-focus extension instances.
// Each editor window gets its own extension host → each needs a unique port.
// main.js broadcasts to all ports; only the one with the matching PID responds 200.
const PORT_BASE = 23456;
const PORT_RANGE = 5; // support up to 5 concurrent editor windows

let server = null;
let boundPort = null;

async function focusTerminalByPids(pids) {
  for (const terminal of vscode.window.terminals) {
    const termPid = await terminal.processId;
    if (termPid && pids.includes(termPid)) {
      terminal.show(false);
      return true;
    }
  }
  return false;
}

function tryListen(port, maxPort) {
  if (port > maxPort) {
    console.log("Clawd terminal-focus: all ports in use, HTTP server disabled");
    return;
  }

  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/focus-tab") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const pids = Array.isArray(data.pids) ? data.pids.filter(Number.isFinite) : [];
          if (pids.length) {
            focusTerminalByPids(pids).then((found) => {
              res.writeHead(found ? 200 : 404);
              res.end(found ? "ok" : "not found");
            });
          } else {
            res.writeHead(400);
            res.end("no pids");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      server = null;
      tryListen(port + 1, maxPort);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    boundPort = port;
    console.log(`Clawd terminal-focus: listening on 127.0.0.1:${port}`);
  });
}

function activate(context) {
  tryListen(PORT_BASE, PORT_BASE + PORT_RANGE - 1);

  // URI handler kept as fallback for manual testing:
  // vscode://clawd.clawd-terminal-focus?pids=1234,5678
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        const params = new URLSearchParams(uri.query);
        const raw = params.get("pids") || params.get("pid") || "";
        const pids = raw.split(",").map(Number).filter(Boolean);
        if (pids.length) focusTerminalByPids(pids);
      },
    })
  );
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { activate, deactivate };
