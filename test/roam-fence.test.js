"use strict";

// test/roam-fence.test.js — validation and failure semantics of the roam
// fence loader (src/roam-fence.js). The contract under test (PR #810 review,
// rounds 1 and 2):
//   • get() is null (UNKNOWN) until the loader confirms a first status —
//     a valid parse, a valid enabled:false, or ENOENT proving absence;
//   • an isolated ENOENT under an active fence is treated as a replace-style
//     save in flight: last known good is kept, a second consecutive ENOENT
//     confirms removal;
//   • malformed / partially saved / schema-invalid content keeps the last
//     known good state (or stays UNKNOWN before the first valid read);
//   • a stat guard rejects FIFOs and oversized files before reading;
//   • invalid content warns once per distinct cause, not once per refresh;
//   • strict validation: real booleans and finite in-range numbers only,
//     no Number() coercion; BOM tolerated.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createRoamFenceLoader = require("../src/roam-fence");

const VALID = JSON.stringify({
  enabled: true,
  left: 0.25,
  top: 0.1,
  right: 0.75,
  bottom: 0.9,
});

function loaderWith(contents, extraDeps = {}) {
  // contents: string → file body; Error instance → readFile rejects with it
  let current = contents;
  const warnings = [];
  const loader = createRoamFenceLoader({
    readFile: async () => {
      if (current instanceof Error) throw current;
      return current;
    },
    warn: (m) => warnings.push(m),
    filePath: "/nonexistent/roam-area.json",
    ...extraDeps,
  });
  return {
    loader,
    warnings,
    set: (next) => {
      current = next;
    },
  };
}

function enoent() {
  const err = new Error("ENOENT: no such file");
  err.code = "ENOENT";
  return err;
}

describe("roam-fence loader", () => {
  it("is UNKNOWN (null) before any refresh", () => {
    const { loader } = loaderWith(VALID);
    assert.equal(loader.get(), null);
  });

  it("parses a valid file into an active fence", async () => {
    const { loader } = loaderWith(VALID);
    await loader.refresh();
    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.25,
      top: 0.1,
      right: 0.75,
      bottom: 0.9,
    });
  });

  it("defaults missing edges to the full range", async () => {
    const { loader } = loaderWith(JSON.stringify({ enabled: true, left: 0.3 }));
    await loader.refresh();
    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.3,
      top: 0,
      right: 1,
      bottom: 1,
    });
  });

  it("confirms ENOENT on first load as 'no fence' immediately", async () => {
    const { loader } = loaderWith(enoent());
    await loader.refresh();
    assert.equal(loader.get().active, false, "confirmed missing = disabled");
  });

  it("treats enabled:false as a confirmed disabled fence", async () => {
    const { loader } = loaderWith(
      JSON.stringify({ enabled: false, left: 0.25, right: 0.75 }),
    );
    await loader.refresh();
    assert.equal(loader.get().active, false);
  });

  it("keeps an active fence across an isolated ENOENT, drops it on the second", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    set(enoent());
    await loader.refresh();
    assert.equal(
      loader.get().active,
      true,
      "one ENOENT = replace-save in flight, fence must survive",
    );
    await loader.refresh();
    assert.equal(
      loader.get().active,
      false,
      "second consecutive ENOENT confirms removal",
    );
  });

  it("recovers cleanly through valid → ENOENT → valid", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    set(enoent());
    await loader.refresh();
    set(VALID);
    await loader.refresh();
    assert.equal(loader.get().active, true);
    set(enoent());
    await loader.refresh();
    assert.equal(
      loader.get().active,
      true,
      "the ENOENT streak must reset after a successful read",
    );
  });

  it("stays UNKNOWN when the first read is malformed", async () => {
    const { loader, set, warnings } = loaderWith("garb{age");
    await loader.refresh();
    assert.equal(loader.get(), null, "invalid first read must not fail open");
    assert.equal(warnings.length, 1);
    set(VALID);
    await loader.refresh();
    assert.equal(loader.get().active, true);
  });

  it("stays UNKNOWN when the first read errors transiently", async () => {
    const eacces = new Error("EACCES");
    eacces.code = "EACCES";
    const { loader } = loaderWith(eacces);
    await loader.refresh();
    assert.equal(loader.get(), null);
  });

  it("strips a UTF-8 BOM before parsing", async () => {
    const { loader } = loaderWith("﻿" + VALID);
    await loader.refresh();
    assert.equal(loader.get().active, true);
  });

  it("keeps the last known good state across a malformed (partial) save", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    set('{ "enabled": true, "left": 0.2'); // truncated mid-write
    await loader.refresh();
    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.25,
      top: 0.1,
      right: 0.75,
      bottom: 0.9,
    });
  });

  it("keeps the last known good state across a transient read error", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    const eacces = new Error("EACCES");
    eacces.code = "EACCES";
    set(eacces);
    await loader.refresh();
    assert.equal(loader.get().active, true);
  });

  it("never fails open: invalid content after a valid fence keeps the fence", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    for (const bad of [
      "not json at all",
      "null",
      "[0.1, 0.9]",
      '"a string"',
      JSON.stringify({ left: 0.1, right: 0.9 }), // enabled missing
      JSON.stringify({ enabled: "true", left: 0.1, right: 0.9 }), // string boolean
      JSON.stringify({ enabled: 1, left: 0.1, right: 0.9 }), // numeric boolean
      JSON.stringify({ enabled: true, left: "0.1", right: 0.9 }), // coercible string
      JSON.stringify({ enabled: true, left: 0.9, right: 0.1 }), // reversed
      JSON.stringify({ enabled: true, left: 0.5, right: 0.5 }), // zero-width fraction
      JSON.stringify({ enabled: true, left: -0.2, right: 0.9 }), // out of range
      JSON.stringify({ enabled: true, left: 0.1, right: 1.5 }), // out of range
      JSON.stringify({ enabled: true, top: 0.8, bottom: 0.2 }), // reversed vertical
      JSON.stringify({ enabled: true, left: 1e999, right: 1 }), // Infinity via JSON
    ]) {
      set(bad);
      await loader.refresh();
      assert.equal(
        loader.get().active,
        true,
        `invalid content must not disturb the fence: ${bad}`,
      );
      assert.equal(loader.get().left, 0.25);
    }
  });

  it("warns once per distinct invalid cause, again after recovery", async () => {
    const { loader, set, warnings } = loaderWith(VALID);
    await loader.refresh();
    set("broken{");
    await loader.refresh();
    await loader.refresh();
    await loader.refresh();
    assert.equal(warnings.length, 1, "identical breakage warns exactly once");
    set(VALID);
    await loader.refresh();
    set("broken{");
    await loader.refresh();
    assert.equal(warnings.length, 2, "a fix followed by a new break warns again");
  });

  it("rejects non-regular files via the stat guard without reading them", async () => {
    let reads = 0;
    const warnings = [];
    const loader = createRoamFenceLoader({
      readFile: async () => {
        reads += 1;
        return VALID;
      },
      stat: async () => ({ isFile: () => false, size: 10 }),
      warn: (m) => warnings.push(m),
      filePath: "/nonexistent/roam-area.json",
    });
    await loader.refresh();
    assert.equal(reads, 0, "a FIFO must never be read (it would hang)");
    assert.equal(loader.get(), null, "guard failure is not a confirmed state");
    assert.equal(warnings.length, 1);
  });

  it("rejects oversized files via the stat guard, keeping last known good", async () => {
    let statResult = { isFile: () => true, size: 10 };
    const { loader } = loaderWith(VALID, {
      stat: async () => statResult,
    });
    await loader.refresh();
    assert.equal(loader.get().active, true);
    statResult = { isFile: () => true, size: 10 * 1024 * 1024 };
    await loader.refresh();
    assert.equal(loader.get().active, true, "oversize keeps the fence");
  });

  it("coalesces concurrent refreshes: N requests cost at most one trailing read", async () => {
    // Round-3 semantics: requests that arrive while a read is in flight are
    // satisfied by ONE trailing read (so the newest file content wins), never
    // one read per request.
    let reads = 0;
    const loader = createRoamFenceLoader({
      readFile: async () => {
        reads += 1;
        return VALID;
      },
      filePath: "/nonexistent/roam-area.json",
    });
    await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
    assert.equal(reads, 2, "initial read + one trailing read, not one each");
    assert.equal(loader.get().active, true);
  });

  it("counts at most one ENOENT confirmation per coalesced refresh batch", async () => {
    let missing = false;
    let signalReadStarted;
    let releaseRead;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    const readGate = new Promise((resolve) => { releaseRead = resolve; });
    let missingReads = 0;
    const loader = createRoamFenceLoader({
      readFile: async () => {
        if (!missing) return VALID;
        missingReads += 1;
        if (missingReads === 1) {
          signalReadStarted();
          await readGate;
        }
        throw enoent();
      },
      warn: () => {},
      filePath: "/nonexistent/roam-area.json",
    });
    await loader.refresh();
    missing = true;

    const first = loader.refresh();
    await readStarted;
    const second = loader.refresh();
    const third = loader.refresh();
    releaseRead();
    await Promise.all([first, second, third]);

    assert.equal(missingReads, 2, "the batch still performs its one trailing read");
    assert.equal(loader.get().active, true, "one missing-file window casts only one vote");
    await loader.refresh();
    assert.equal(loader.get().active, false, "a later independent refresh confirms removal");
  });
});

describe("roam-fence production file-handle reader (#810 maintainer follow-up)", () => {
  it("continues short reads until EOF before parsing", async () => {
    const raw = Buffer.from(VALID);
    let readCalls = 0;
    let statCalls = 0;
    let closed = false;
    const loader = createRoamFenceLoader({
      openFile: async () => ({
        stat: async () => {
          statCalls += 1;
          return { isFile: () => true, size: raw.length };
        },
        read: async (buffer, offset, length, position) => {
          readCalls += 1;
          const bytesRead = Math.min(5, length, raw.length - position);
          if (bytesRead <= 0) return { bytesRead: 0, buffer };
          raw.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead, buffer };
        },
        close: async () => {
          closed = true;
        },
      }),
      warn: () => {},
      filePath: "/nonexistent/roam-area.json",
    });

    await loader.refresh();

    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.25,
      top: 0.1,
      right: 0.75,
      bottom: 0.9,
    });
    assert.ok(readCalls > 1, "a short read must not be treated as EOF");
    assert.equal(
      statCalls,
      2,
      "the same handle is checked before and after reading",
    );
    assert.equal(closed, true, "the handle closes after a successful read");
  });

  it("rejects a file that grows beyond 64 KiB after the first stat", async () => {
    const prefix = Buffer.from(JSON.stringify({ enabled: true }));
    const grown = Buffer.concat([
      prefix,
      Buffer.alloc(64 * 1024 + 1 - prefix.length, 0x20),
    ]);
    const warnings = [];
    let readCalls = 0;
    let statCalls = 0;
    let closed = false;
    const loader = createRoamFenceLoader({
      openFile: async () => ({
        stat: async () => {
          statCalls += 1;
          return {
            isFile: () => true,
            size: statCalls === 1 ? prefix.length : grown.length,
          };
        },
        read: async (buffer, offset, length, position) => {
          readCalls += 1;
          const chunkLimit = position === 0 ? prefix.length : 4096;
          const bytesRead = Math.min(
            chunkLimit,
            length,
            grown.length - position,
          );
          if (bytesRead <= 0) return { bytesRead: 0, buffer };
          grown.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead, buffer };
        },
        close: async () => {
          closed = true;
        },
      }),
      warn: (message) => warnings.push(message),
      filePath: "/nonexistent/roam-area.json",
    });

    await loader.refresh();

    assert.equal(
      loader.get(),
      null,
      "an oversized growth must not become active",
    );
    assert.ok(readCalls > 1, "the reader must continue after a short JSON prefix");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /larger than 65536 bytes/);
    assert.equal(closed, true, "the handle closes after a guard failure");
  });

  it("keeps the last good fence when the file grows after EOF within the cap", async () => {
    const stable = Buffer.from(VALID);
    const disabledPrefix = Buffer.from(JSON.stringify({ enabled: false }));
    const warnings = [];
    let opens = 0;
    const loader = createRoamFenceLoader({
      openFile: async () => {
        opens += 1;
        const firstRefresh = opens === 1;
        const raw = firstRefresh ? stable : disabledPrefix;
        let statCalls = 0;
        return {
          stat: async () => {
            statCalls += 1;
            return {
              isFile: () => true,
              size: firstRefresh || statCalls === 1
                ? raw.length
                : raw.length + 7,
            };
          },
          read: async (buffer, offset, length, position) => {
            const bytesRead = Math.min(length, raw.length - position);
            if (bytesRead <= 0) return { bytesRead: 0, buffer };
            raw.copy(buffer, offset, position, position + bytesRead);
            return { bytesRead, buffer };
          },
          close: async () => {},
        };
      },
      warn: (message) => warnings.push(message),
      filePath: "/nonexistent/roam-area.json",
    });

    await loader.refresh();
    await loader.refresh();

    assert.equal(
      loader.get().active,
      true,
      "a stale valid prefix must not disable the last-known-good fence",
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /file changed while being read/);
  });
});

describe("roam-fence loader round-3 (#810)", () => {
  const OLD = JSON.stringify({ enabled: true, left: 0.1, right: 0.9 });
  const NEW = JSON.stringify({ enabled: true, left: 0.4, right: 0.6 });

  it("runs one trailing read when a refresh arrives mid-read (last writer wins)", async () => {
    // Reviewer repro: a slow read captures pre-edit content; while it is
    // pending the file changes and roam requests another refresh. Coalescing
    // that request away would leave the cache stale for the next walk.
    let current = OLD;
    let release;
    let reads = 0;
    const loader = createRoamFenceLoader({
      readFile: () =>
        new Promise((resolve) => {
          reads += 1;
          if (reads === 1) {
            // First (slow) read: resolves later with the OLD content it
            // captured at open time.
            release = () => resolve(OLD);
          } else {
            resolve(current);
          }
        }),
      warn: () => {},
      filePath: "/nonexistent/roam-area.json",
    });
    const p1 = loader.refresh(); // slow read in flight
    current = NEW; // file replaced on disk
    const p2 = loader.refresh(); // request while pending — must not be lost
    release();
    await p1;
    await p2;
    assert.equal(reads, 2, "a trailing read must follow the in-flight one");
    assert.equal(
      loader.get().left,
      0.4,
      "the state after refresh settles must reflect the newest file",
    );
  });

  it("non-ENOENT errors break the consecutive-ENOENT streak", async () => {
    // valid → ENOENT → EACCES → ENOENT: the two ENOENTs are NOT consecutive,
    // so the active fence must survive; only ENOENT → ENOENT disables it.
    let current = OLD;
    const loader = createRoamFenceLoader({
      readFile: async () => {
        if (current instanceof Error) throw current;
        return current;
      },
      warn: () => {},
      filePath: "/nonexistent/roam-area.json",
    });
    const enoentErr = () => {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      return e;
    };
    const eaccesErr = () => {
      const e = new Error("EACCES");
      e.code = "EACCES";
      return e;
    };
    await loader.refresh();
    current = enoentErr();
    await loader.refresh();
    current = eaccesErr();
    await loader.refresh();
    current = enoentErr();
    await loader.refresh();
    assert.equal(
      loader.get().active,
      true,
      "ENOENT, EACCES, ENOENT is not two consecutive misses",
    );
    await loader.refresh();
    assert.equal(
      loader.get().active,
      false,
      "a genuine consecutive ENOENT pair still confirms removal",
    );
  });

  it("warns once (deduplicated) for persistent read errors", async () => {
    const warnings = [];
    const eacces = new Error("EACCES");
    eacces.code = "EACCES";
    let current = OLD;
    const loader = createRoamFenceLoader({
      readFile: async () => {
        if (current instanceof Error) throw current;
        return current;
      },
      warn: (m) => warnings.push(m),
      filePath: "/nonexistent/roam-area.json",
    });
    await loader.refresh();
    current = eacces;
    await loader.refresh();
    await loader.refresh();
    await loader.refresh();
    assert.equal(warnings.length, 1, "persistent read errors warn exactly once");
    assert.ok(/read failed/.test(warnings[0]));
  });
});
