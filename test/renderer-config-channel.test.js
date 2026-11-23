"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createRendererConfigChannel } = require("../src/renderer-config-channel");

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    on(channel, handler) {
      handlers.set(channel, handler);
    },
    ask(channel) {
      const event = { returnValue: undefined };
      handlers.get(channel)(event);
      return event.returnValue;
    },
  };
}

describe("renderer config channel", () => {
  it("returns null before a config is set", () => {
    const ipcMain = makeIpcMain();
    const channel = createRendererConfigChannel({ ipcMain });

    assert.strictEqual(channel.getPetConfig(), null);
    assert.strictEqual(channel.getHitConfig(), null);
    assert.strictEqual(ipcMain.ask("renderer-config:get-pet"), null);
    assert.strictEqual(ipcMain.ask("renderer-config:get-hit"), null);
  });

  it("stores and returns the same pet and hit objects", () => {
    const ipcMain = makeIpcMain();
    const channel = createRendererConfigChannel({ ipcMain });
    const pet = { themeId: "clawd", rendering: { objectChannelFiles: [] } };
    const hit = { reactions: { left: "clawd-react-left.svg" } };

    channel.setPetConfig(pet);
    channel.setHitConfig(hit);

    assert.strictEqual(channel.getPetConfig(), pet);
    assert.strictEqual(channel.getHitConfig(), hit);
    assert.strictEqual(ipcMain.ask("renderer-config:get-pet"), pet);
    assert.strictEqual(ipcMain.ask("renderer-config:get-hit"), hit);
  });

  it("keeps pet and hit configs isolated", () => {
    const ipcMain = makeIpcMain();
    const channel = createRendererConfigChannel({ ipcMain });
    const pet = { kind: "pet" };

    channel.setPetConfig(pet);

    assert.strictEqual(channel.getPetConfig(), pet);
    assert.strictEqual(channel.getHitConfig(), null);
    assert.strictEqual(ipcMain.ask("renderer-config:get-hit"), null);
  });

  it("clears a slot when it is set to null", () => {
    const ipcMain = makeIpcMain();
    const channel = createRendererConfigChannel({ ipcMain });
    channel.setPetConfig({ kind: "pet" });

    channel.setPetConfig(null);

    assert.strictEqual(channel.getPetConfig(), null);
    assert.strictEqual(ipcMain.ask("renderer-config:get-pet"), null);
  });
});
