"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path"),
  { EventEmitter } = require("events");
const createLibrary = require("../src/desktop-integrations/qqmusic/library-main.cjs"),
  {
    createPlayer,
  } = require("../src/desktop-integrations/qqmusic/library-player.cjs");
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, "runtime-test-"));
  fs.writeFileSync(
    path.join(root, "qqmusic-queue.json"),
    JSON.stringify({
      id: "123",
      revision: "stable-list",
      name: "测试歌单",
      items: [
        { id: "1", title: "甲", artist: "歌手", type: 0, seconds: 200 },
        { id: "2", title: "乙", artist: "歌手", type: 0, seconds: 180 },
      ],
    }),
  );
  const api = createLibrary({
    helperRoot: root,
    storageRoot: root,
    executable: path.join(root, "QQMusic.exe"),
    readState: () => {
      throw Error("foreground control must not wait for a state read");
    },
    requestJson: () => {
      throw Error("not used");
    },
    runCommand: async () => JSON.stringify({ windows: [] }),
    ...options,
  });
  return {
    api,
    close: () => {
      assert.ok(
        path
          .resolve(root)
          .startsWith(path.resolve(__dirname) + path.sep + "runtime-test-"),
      );
      fs.rmSync(root, { recursive: true });
    },
  };
}
test("seeking dispatches immediately without waiting for native polling or fresh SMTC metadata", async () => {
  const calls = [];
  const f = fixture({
    runCommand: async (file, args) => {
      calls.push(args);
      if (args[0] === "snapshot") return new Promise(() => {});
      return "";
    },
  });
  try {
    const result = await f.api.seek(80, {
      title: "甲",
      artist: "歌手",
      duration: 200,
      position: 10,
      playback: "Playing",
    });
    assert.deepEqual(calls, [["/silent", "/seekto", "80"]]);
    assert.equal(result.position, 80);
    assert.equal(result.seekDispatched, true);
    const stale = await f.api.enrichState({
      title: "甲",
      position: 10,
      duration: 200,
      playback: "Playing",
    });
    assert.ok(stale.position >= 80 && stale.position < 82);
  } finally {
    f.close();
  }
});
test("queue selection dispatches only the target track and retains the list revision and order", async () => {
  const selected = [];
  const f = fixture({
    playerFactory: () => ({
      play: () => {
        throw Error("must not resend the playlist");
      },
      select: async (item) => selected.push(item.id),
    }),
  });
  try {
    const result = await f.api.request("queue-play", {
      revision: "stable-list",
      index: 1,
    });
    assert.deepEqual(selected, ["2"]);
    assert.equal(result.playbackPending, true);
    assert.equal(result.queue.revision, "stable-list");
    assert.deepEqual(
      result.queue.items.map((v) => v.id),
      ["1", "2"],
    );
  } finally {
    f.close();
  }
});
test("single-track selection uses the native silent entry point, no playlist file or shell", async () => {
  const argsSeen = [];
  const player = createPlayer({
    executable: path.resolve("QQMusic.exe"),
    storageRoot: "unused",
    spawnProcess: (exe, args, options) => {
      argsSeen.push(args);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      const p = new EventEmitter();
      process.nextTick(() => p.emit("exit", 0));
      return p;
    },
  });
  await player.select({ id: "102362166", type: 0 });
  assert.deepEqual(argsSeen, [
    [
      "/silent",
      "/playbysongid",
      "cmd_count==1&&id_0==102362166&&songtype_0==0",
    ],
  ]);
  await assert.rejects(player.select({ id: "1&&quit", type: 0 }));
  assert.equal(argsSeen.length, 1);
});
