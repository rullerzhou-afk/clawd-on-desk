"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");

const {
  NiriIpcClient,
  decodeReply,
} = require("../src/niri-ipc-client");

class FakeSocket extends EventEmitter {
  constructor(onWrite = () => {}) {
    super();
    this.onWrite = onWrite;
    this.writes = [];
    this.destroyed = false;
  }

  write(value, callback) {
    this.writes.push(String(value));
    this.onWrite(String(value), this);
    if (callback) callback();
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function createConnectedClient(onWrite, options = {}) {
  const socket = new FakeSocket(onWrite);
  const client = new NiriIpcClient({
    socketPath: "/run/user/1000/niri.sock",
    timeoutMs: options.timeoutMs || 100,
    lineLimit: options.lineLimit || 1024,
    createConnection: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  return { client, socket };
}

describe("niri IPC client", () => {
  it("decodes Ok and typed Err envelopes", () => {
    assert.deepStrictEqual(decodeReply('{"Ok":{"Windows":[]}}'), { Windows: [] });
    assert.throws(
      () => decodeReply('{"Err":"not allowed"}'),
      (err) => err.code === "niri-error" && err.poisoned === false,
    );
    assert.throws(
      () => decodeReply("{"),
      (err) => err.code === "invalid-json" && err.poisoned === true,
    );
  });

  it("serializes requests and handles fragmented plus coalesced replies", async () => {
    let writeCount = 0;
    const { client, socket } = createConnectedClient((_value, ownedSocket) => {
      writeCount += 1;
      if (writeCount === 1) {
        queueMicrotask(() => ownedSocket.emit("data", Buffer.from('{"Ok":{"Version":"26.')));
        queueMicrotask(() => ownedSocket.emit("data", Buffer.from('04"}}\n')));
      } else {
        queueMicrotask(() => ownedSocket.emit("data", Buffer.from('{"Ok":{"Windows":[]}}\n')));
      }
    });

    const [version, windows] = await Promise.all([client.version(), client.windows()]);
    assert.equal(version, "26.04");
    assert.deepStrictEqual(windows, []);
    assert.deepStrictEqual(socket.writes.map((line) => JSON.parse(line)), ["Version", "Windows"]);
    client.close();
  });

  it("keeps the aligned socket reusable after an in-band Err", async () => {
    let count = 0;
    const { client } = createConnectedClient((_value, socket) => {
      count += 1;
      const reply = count === 1
        ? '{"Err":"unsupported"}\n'
        : '{"Ok":{"Version":"26.04.1"}}\n';
      queueMicrotask(() => socket.emit("data", Buffer.from(reply)));
    });

    await assert.rejects(client.windows(), (err) => err.code === "niri-error" && !err.poisoned);
    assert.equal(await client.version(), "26.04.1");
    client.close();
  });

  it("poisons the stream after a timeout", async () => {
    const { client, socket } = createConnectedClient(() => {}, { timeoutMs: 5 });
    await assert.rejects(client.version(), (err) => err.code === "timeout" && err.poisoned);
    await assert.rejects(client.windows(), (err) => err.code === "poisoned" && err.poisoned);
    assert.equal(socket.destroyed, true);
  });

  it("emits the exact ScreenshotWindow schema", async () => {
    const { client, socket } = createConnectedClient((_value, ownedSocket) => {
      queueMicrotask(() => ownedSocket.emit("data", Buffer.from('{"Ok":"Handled"}\n')));
    });
    await client.screenshotWindow({ id: 42, path: "/tmp/capture.png" });
    assert.deepStrictEqual(JSON.parse(socket.writes[0]), {
      Action: {
        ScreenshotWindow: {
          id: 42,
          write_to_disk: true,
          show_pointer: false,
          path: "/tmp/capture.png",
        },
      },
    });
    client.close();
  });
});
