"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { WatchSidecarClient } = require("../src/watch-sidecar-client");

describe("WatchSidecarClient", () => {
  it("should expose transport with connected=false initially", () => {
    const client = new WatchSidecarClient({ command: "echo" });
    assert.strictEqual(client.transport.connected, false);
    assert.strictEqual(client.transport.secure, false);
    assert.strictEqual(client.started, false);
  });

  it("should wrap state payloads as snapshot messages in transport.send", () => {
    const written = [];
    const client = new WatchSidecarClient({ command: "cat" });
    client._writeStdin = (obj) => written.push(obj);
    client.transport.send({ s: "working", svg: "clawd-working-typing.svg", n: 1 });
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].type, "snapshot");
    assert.strictEqual(written[0].payload.s, "working");
  });

  it("should pass approval_request messages through without wrapping", () => {
    const written = [];
    const client = new WatchSidecarClient({ command: "cat" });
    client._writeStdin = (obj) => written.push(obj);
    client.transport.send({ type: "approval_request", requestId: "r1", tool: "Bash" });
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].type, "approval_request");
    assert.strictEqual(written[0].requestId, "r1");
    assert.strictEqual(written[0].payload, undefined);
  });

  it("should route status messages to onStatus and update transport.connected", () => {
    const statuses = [];
    const transportChanges = [];
    const client = new WatchSidecarClient({
      command: "echo",
      onStatus: (s) => statuses.push(s),
      onTransportStateChanged: (s) => transportChanges.push(s),
    });
    client._handleLine('{"type":"status","connected":true,"deviceName":"TestWatch"}');
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].deviceName, "TestWatch");
    assert.strictEqual(client.transport.connected, true);
    assert.strictEqual(client.transport.secure, true);
    assert.strictEqual(transportChanges.length, 1);
    assert.strictEqual(transportChanges[0].connected, true);
  });

  it("should route devices messages to onDevices", () => {
    const devices = [];
    const client = new WatchSidecarClient({
      command: "echo",
      onDevices: (items) => devices.push(items),
    });
    client._handleLine('{"type":"devices","items":[{"address":"AA:BB","name":"Watch","rssi":-50}]}');
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0][0].name, "Watch");
  });

  it("should route approval_response messages to onApprovalResponse", () => {
    const responses = [];
    const client = new WatchSidecarClient({
      command: "echo",
      onApprovalResponse: (r) => responses.push(r),
    });
    client._handleLine('{"type":"approval_response","requestId":"r1","decision":"allow"}');
    assert.strictEqual(responses.length, 1);
    assert.strictEqual(responses[0].requestId, "r1");
    assert.strictEqual(responses[0].decision, "allow");
  });

  it("should route error messages to onError", () => {
    const errors = [];
    const client = new WatchSidecarClient({
      command: "echo",
      onError: (e) => errors.push(e),
    });
    client._handleLine('{"type":"error","code":"DISCONNECTED","message":"BLE link lost"}');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, "DISCONNECTED");
  });

  it("should send connect command via stdin", () => {
    const written = [];
    const client = new WatchSidecarClient({ command: "echo" });
    client._writeStdin = (obj) => written.push(obj);
    client.connect("AA:BB:CC:DD:EE:FF");
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].type, "connect");
    assert.strictEqual(written[0].address, "AA:BB:CC:DD:EE:FF");
  });

  it("should send connect command for object target", () => {
    const written = [];
    const client = new WatchSidecarClient({ command: "echo" });
    client._writeStdin = (obj) => written.push(obj);
    client.connect({ address: "AA:BB" });
    assert.strictEqual(written[0].address, "AA:BB");
  });

  it("should send scan command via stdin", () => {
    const written = [];
    const client = new WatchSidecarClient({ command: "echo" });
    client._writeStdin = (obj) => written.push(obj);
    client.scan();
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].type, "scan");
  });

  it("should not fire onTransportStateChanged for duplicate status", () => {
    const changes = [];
    const client = new WatchSidecarClient({
      command: "echo",
      onTransportStateChanged: (s) => changes.push(s),
    });
    client._handleLine('{"type":"status","connected":true}');
    client._handleLine('{"type":"status","connected":true}');
    assert.strictEqual(changes.length, 1);
  });

  it("should ignore malformed JSON lines", () => {
    const client = new WatchSidecarClient({ command: "echo" });
    client._handleLine("not json");
    client._handleLine("");
    client._handleLine("   ");
    assert.strictEqual(client.transport.connected, false);
  });

  it("should set _stopping flag on stop to suppress stale exit events", () => {
    const client = new WatchSidecarClient({ command: "echo" });
    assert.strictEqual(client._stopping, false);
    // Simulate having a running process
    client.proc = { stdin: { write: () => {}, destroyed: false }, kill: () => {} };
    client.started = true;
    client.stop();
    assert.strictEqual(client._stopping, true, "stop should set _stopping before kill");
    assert.strictEqual(client.started, false);
  });
});
