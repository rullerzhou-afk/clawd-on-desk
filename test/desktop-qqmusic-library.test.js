"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  LibraryCatalog,
  identifier,
} = require("../src/desktop-integrations/qqmusic/library-catalog.cjs");
const {
  protocolFor,
  createPlayer,
} = require("../src/desktop-integrations/qqmusic/library-player.cjs");
const {
  parseSnapshot,
  parseTimeline,
  parseNativeQueue,
} = require("../src/desktop-integrations/qqmusic/library-main.cjs");
const envelope = (data) => ({ code: 0, req_0: { code: 0, data } });
const lists = [
  { tid: 123, dirName: "我喜欢", dirId: 201, songNum: 450 },
  { tid: 456, dirName: "纯", dirId: 202, songNum: 1 },
];
const raw = (id) => ({
  id,
  mid: "mid" + id,
  title: "歌" + id,
  singer: [{ name: "歌手" }],
  album: { name: "专辑" },
  interval: 121,
});
test("reads every page of a large playlist and preserves order", async () => {
  const requested = [];
  const api = new LibraryCatalog({
    account: "1152920000000000001",
    request: async (body) => {
      const { method, param } = body.req_0;
      if (method === "GetPlaylistByUin")
        return envelope({ total: 2, bFinish: true, v_playlist: lists });
      requested.push(param.song_begin);
      return envelope({
        total_song_num: 450,
        dirinfo: { title: "我喜欢" },
        songlist: Array.from(
          { length: Math.min(200, 450 - param.song_begin) },
          (_, i) => raw(param.song_begin + i + 1),
        ),
      });
    },
  });
  const value = await api.playlist("123");
  assert.equal(value.items.length, 450);
  assert.equal(value.items[449].id, "450");
  assert.deepEqual(requested, [0, 200, 400]);
});
test("rejects incomplete or repeated upstream pages instead of showing a partial playlist", async () => {
  for (const rows of [[], Array.from({ length: 200 }, (_, i) => raw(i + 1))]) {
    const api = new LibraryCatalog({
      account: "12345",
      request: async (body) =>
        body.req_0.method === "GetPlaylistByUin"
          ? envelope({ total: 2, bFinish: true, v_playlist: lists })
          : envelope({ total_song_num: 450, songlist: rows }),
    });
    await assert.rejects(api.playlist("123"), /完整|重复/);
  }
});
test("filtered special songs consume native positions and do not shift later pages", async () => {
  const requested = [];
  const api = new LibraryCatalog({
    account: "12345",
    request: async (body) => {
      const { method, param } = body.req_0;
      if (method === "GetPlaylistByUin")
        return envelope({ total: 2, bFinish: true, v_playlist: lists });
      requested.push(param.song_begin);
      return param.song_begin === 0
        ? envelope({
            total_song_num: 298,
            songlist: Array.from({ length: 199 }, (_, i) => raw(i + 1)),
            filtered_song: [{ songid: 9999, songtype: 13 }],
            hasmore: 1,
          })
        : envelope({
            total_song_num: 299,
            songlist: Array.from({ length: 99 }, (_, i) => raw(i + 201)),
            filtered_song: [],
            hasmore: 0,
          });
    },
  });
  const value = await api.playlist("123");
  assert.deepEqual(requested, [0, 200]);
  assert.equal(value.total, 299);
  assert.equal(value.items.length, 298);
  assert.equal(value.excluded, 1);
  assert.equal(value.items[199].id, "201");
});
test("only personal catalog playlists are accepted", async () => {
  const api = new LibraryCatalog({
    account: "12345",
    request: async () =>
      envelope({ total: 2, bFinish: true, v_playlist: lists }),
  });
  await assert.rejects(api.playlist("999"), /我的歌单/);
  for (const value of ["https://example.com", "1&&exit", "-1", "1.2"])
    assert.throws(() => identifier(value));
});
test("native playback protocol contains only verified numeric tracks, including long queues", () => {
  const items = Array.from({ length: 2881 }, (_, i) => ({
    id: String(100000000 + i),
    type: 0,
  }));
  const text = protocolFor(items, 1);
  assert.ok(text.startsWith("version==1173&&"));
  assert.ok(text.includes("cmd_0==playsong&&id_0==100000001|100000002"));
  assert.ok(text.includes("|100000000&&songtype_0=="));
  assert.ok(text.length > 32767);
  assert.throws(() => protocolFor([{ id: "1&&exit", type: 0 }]));
  assert.throws(() => protocolFor([{ id: "123", type: "0&&exit" }]));
  assert.ok(protocolFor([{ id: "123", type: 13 }]).includes("songtype_0==13"));
});
test("native playback errors do not claim success and a later user retry is allowed", async () => {
  const fs = require("fs"),
    os = require("os"),
    path = require("path"),
    { EventEmitter } = require("events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-library-test-"));
  let fail = true,
    calls = 0;
  const player = createPlayer({
    executable: "QQMusic.exe",
    storageRoot: root,
    spawnProcess: (exe, args, options) => {
      calls++;
      assert.equal(exe, path.resolve("QQMusic.exe"));
      assert.equal(args[0], "/silent");
      assert.equal(args[1], "/tencentprotocolfile");
      assert.equal(options.shell, false);
      assert.equal(options.cwd, path.dirname(exe));
      const bytes = fs.readFileSync(args[2]);
      assert.equal(bytes[0], 118);
      assert.equal(bytes[1], 0);
      assert.ok(bytes.toString("utf16le").startsWith("version==1173&&"));
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", fail ? 1 : 0));
      return child;
    },
  });
  try {
    await assert.rejects(player.play([{ id: "1", type: 0 }]), /未接受/);
    fail = false;
    const result = await player.play(
      [
        { id: "1", type: 0 },
        { id: "2", type: 0 },
      ],
      1,
    );
    assert.equal(result.dispatched, true);
    assert.deepEqual(
      result.ordered.map((v) => v.id),
      ["2", "1"],
    );
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test("mode and account come from the QQ Music player controls, not lyric windows", () => {
  const data = {
    windows: [
      { rows: [{ name: "单曲循环", type: "ControlType.Button" }] },
      {
        rows: [
          { name: "播放队列", type: "ControlType.Button" },
          { name: "随机播放", type: "ControlType.Button" },
          { name: "1152920000000000001", type: "ControlType.Text" },
        ],
      },
    ],
  };
  assert.deepEqual(parseSnapshot(data), {
    account: "1152920000000000001",
    mode: "shuffle",
  });
  assert.deepEqual(parseSnapshot({ windows: [] }), {
    account: null,
    mode: null,
  });
});
test("native time parsing ignores song-list durations and trims player clock labels", () => {
  const data = {
    windows: [
      {
        rows: [
          { name: "播放队列", type: "ControlType.Button" },
          { name: "时长：04:14", type: "ControlType.Text" },
          { name: "00:45 ", type: "ControlType.Text" },
          { name: "02:43 ", type: "ControlType.Text" },
        ],
      },
    ],
  };
  assert.deepEqual(parseTimeline(data), {
    position: 45,
    duration: 163,
    minimized: false,
  });
  assert.equal(parseTimeline({ windows: [] }), null);
});
test("native queue reports partial coverage and orders rows by their actual layout", () => {
  const value = parseNativeQueue({
    windows: [
      {
        title: "播放队列",
        countText: "共3首歌曲",
        items: [
          { title: "B", artist: "乙", orderY: 120 },
          { title: "A", artist: "甲", orderY: 50 },
        ],
      },
    ],
  });
  assert.equal(value.total, 3);
  assert.equal(value.complete, false);
  assert.deepEqual(
    value.items.map((v) => v.title),
    ["A", "B"],
  );
  assert.equal(parseNativeQueue({ windows: [] }), null);
});
