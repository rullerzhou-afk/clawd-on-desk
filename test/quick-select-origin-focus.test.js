"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const createOriginFocus = require("../src/quick-select-origin-focus");

function harness() {
  let foreground = 10;
  let pid = 20;
  let visible = true;
  let minimized = false;
  const restored = [];
  const win = { isDestroyed: () => false };
  const focus = createOriginFocus({ platform: "win32", bindings: {
    foreground: () => foreground, pid: () => pid, visible: () => visible, minimized: () => minimized,
    hwndOf: () => 30, same: (a, b) => a === b,
    setForeground: (hwnd) => { restored.push(hwnd); foreground = hwnd; return true; },
  } });
  return { focus, win, restored, setForeground: (value) => { foreground = value; }, setPid: (value) => { pid = value; }, setVisible: (value) => { visible = value; }, setMinimized: (value) => { minimized = value; } };
}

test("restores only the captured HWND with the same owning PID while the palette is foreground", () => {
  const h = harness();
  const source = h.focus.capture(null);
  assert.deepEqual(source, { hwnd: 10, pid: 20 });
  h.setForeground(30);
  assert.equal(h.focus.restore(source, h.win), true);
  assert.deepEqual(h.restored, [10]);
});

test("repeated shortcut in the palette preserves its original source", () => {
  const h = harness();
  const source = h.focus.capture(null);
  h.setForeground(30);
  assert.equal(h.focus.capture(h.win, source), source);
});

test("another foreground window, replaced HWND owner, minimized or hidden source prevents restoration", () => {
  for (const change of [h => h.setForeground(99), h => h.setPid(99), h => h.setVisible(false), h => h.setMinimized(true)]) {
    const h = harness();
    const source = h.focus.capture(null);
    h.setForeground(30);
    change(h);
    assert.equal(h.focus.restore(source, h.win), false);
    assert.deepEqual(h.restored, []);
  }
});

test("missing origins, destroyed windows, unavailable native bindings and non-Windows hosts are harmless", () => {
  const h = harness();
  h.setForeground(30);
  assert.equal(h.focus.restore(null, h.win), false);
  assert.equal(h.focus.restore({ hwnd: 10, pid: 20 }, { isDestroyed: () => true }), false);
  const broken = createOriginFocus({ platform: "win32", bindings: { foreground() { throw Error("unavailable"); } } });
  assert.equal(broken.capture(null), null);
  assert.equal(broken.restore({ hwnd: 10, pid: 20 }, h.win), false);
  const mac = createOriginFocus({ platform: "darwin" });
  assert.equal(mac.capture(h.win), null);
  assert.equal(mac.restore({ hwnd: 10, pid: 20 }, h.win), false);
});
