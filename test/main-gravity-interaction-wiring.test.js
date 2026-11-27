"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

it("gravity: the pet's drag and click IPC reaches the fall", () => {
  const start = source.indexOf("registerPetInteractionIpc({");
  assert.ok(start >= 0, "missing pet interaction IPC registration");
  const options = source.slice(start, source.indexOf("\n  });", start));
  for (const line of [
    "startGravityFall: (onEnd) => _gravity.release(onEnd),",
    "beginGravityDrag: () => _gravity.beginDrag(),",
    "endGravityPress: () => _gravity.endPress(),",
    "isGravityFalling: () => _gravity.isFalling(),",
    "setGravityFallEndHandler: (handler) => _gravity.setFallEndHandler(handler),",
  ]) {
    assert.ok(options.includes(line), `missing ${line}`);
  }
});
