"use strict";

const fs = require("fs");
const { app } = require("electron");
const { hardenRecapPrivateDirectory } = require("../../src/recap-private-permissions");

app.whenReady().then(() => {
  const root = process.env.CLAWD_RECAP_ELECTRON_ACL_ROOT;
  hardenRecapPrivateDirectory(root, {
    expectedCanonicalRoot: fs.realpathSync.native(root),
  });
  process.stdout.write("RECAP_ELECTRON_ACL_OK\n");
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
