"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("vm"),
  fs = require("fs"),
  path = require("path");
function harness() {
  const elements = new Map(),
    calls = [];
  function node() {
    return {
      value: "",
      dataset: {},
      options: [{}],
      classList: { add() {}, remove() {}, toggle() {} },
      handlers: {},
      addEventListener(name, fn) {
        this.handlers[name] = fn;
      },
      append() {},
      setAttribute() {},
      replaceChildren() {},
      querySelectorAll() {
        return [];
      },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: node,
      createDocumentFragment: node,
    },
    window: {
      qqMusic: {
        command(action, value) {
          let resolve;
          const promise = new Promise((r) => (resolve = r));
          calls.push({ action, value, resolve });
          return promise;
        },
        onResult() {},
        onView() {},
        close() {},
      },
    },
    setTimeout() {},
    setInterval() {},
    console,
  });
  vm.runInContext(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../src/desktop-integrations/qqmusic/qqmusic-renderer.js",
      ),
      "utf8",
    ),
    context,
  );
  return { get, calls, run: (code) => vm.runInContext(code, context) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("dragging progress is immediate even while a status request is blocked; rapid drags keep the latest target", async () => {
  const h = harness();
  await tick();
  assert.ok(h.calls.some((v) => v.action === "status"));
  h.run(
    "display({ok:true,state:{connected:true,title:'测试',artist:'歌手',playback:'Playing',duration:200,position:10,canSeek:true,timelineSource:'native'}})",
  );
  const slider = h.get("progress");
  slider.value = "80";
  slider.handlers.change();
  assert.equal(h.get("current-time").textContent, "1:20");
  assert.equal(h.calls.filter((v) => v.action === "seek").length, 1);
  slider.value = "100";
  slider.handlers.change();
  slider.value = "120";
  slider.handlers.change();
  h.calls
    .find((v) => v.action === "seek")
    .resolve({
      ok: true,
      state: { title: "测试", position: 80, duration: 200, canSeek: true },
    });
  await tick();
  assert.deepEqual(
    h.calls.filter((v) => v.action === "seek").map((v) => v.value),
    [80, 120],
  );
  assert.equal(h.get("current-time").textContent, "2:00");
  h.run(
    "display({ok:true,state:{title:'测试',position:10,duration:200,canSeek:true,playback:'Playing'}})",
  );
  assert.equal(h.get("current-time").textContent, "2:00");
  h.calls
    .filter((v) => v.action === "seek")[1]
    .resolve({
      ok: true,
      state: { title: "测试", position: 120, duration: 200, canSeek: true },
    });
  await tick();
});
test("clicking a queue track bypasses a slow library refresh and a pending media status request", async () => {
  const h = harness();
  await tick();
  assert.ok(h.calls.some((v) => v.action === "queue-status"));
  h.run(
    "queueData={revision:'list',items:[{id:'1',title:'甲'},{id:'2',title:'乙'}]};libraryCommand('queue-play',{revision:'list',index:1})",
  );
  const play = h.calls.find((v) => v.action === "queue-play");
  assert.ok(play);
  assert.equal(play.value.index, 1);
  play.resolve({
    ok: true,
    library: {
      queue: {
        revision: "list",
        items: [
          { id: "1", title: "甲" },
          { id: "2", title: "乙" },
        ],
      },
    },
  });
  await tick();
});
