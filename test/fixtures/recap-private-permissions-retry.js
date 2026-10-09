"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const koffi = require("koffi");
const { createWindowsAclApi, hardenRecapPrivateDirectory } = require("../../src/recap-private-permissions");

// A fresh subprocess isolates Koffi's named types. Keep a real Windows handle
// open until the production retry actually calls Sleep, rather than racing a
// second process's 25ms JavaScript timer against the bounded retry budget.
const HANDLE = koffi.pointer("RECAP_RETRY_HOLDER_HANDLE", koffi.opaque());
const kernel32 = koffi.load("kernel32.dll");
const hold = kernel32.func(
  "RECAP_RETRY_HOLDER_HANDLE __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, RECAP_RETRY_HOLDER_HANDLE template_file)"
);
const close = kernel32.func("int __stdcall CloseHandle(RECAP_RETRY_HOLDER_HANDLE handle)");
const target = process.argv[2];
let holder = hold(target, 0x80000000, 0x1, null, 3, 0x02000000, null);
const address = holder ? koffi.address(holder) : 0n;
assert(holder && address !== 0xffffffffn && address !== 0xffffffffffffffffn);

let retrySleeps = 0;
let firstOpenError = null;
let openAttempts = 0;
try {
  assert.throws(() => fs.renameSync(target, `${target}-moved`), (error) =>
    error && ["EBUSY", "EPERM"].includes(error.code));
  const api = createWindowsAclApi({
    ...koffi,
    load(name) {
      const library = koffi.load(name);
      return {
        func(...args) {
          const native = library.func(...args);
          const signature = String(args[0]);
          if (/\bSleep\(/.test(signature)) return (delay) => {
            retrySleeps += 1;
            if (holder) {
              assert.equal(close(holder), 1);
              holder = null;
            }
            return native(delay);
          };
          if (/\bGetLastError\(/.test(signature)) return () => {
            const code = native();
            if (openAttempts === 1 && firstOpenError === null) firstOpenError = code;
            return code;
          };
          if (/\bCreateFileW\(/.test(signature)) return (...values) => {
            if (values[0] === target) openAttempts += 1;
            return native(...values);
          };
          return native;
        },
      };
    },
  });
  const hardened = hardenRecapPrivateDirectory(target, {
    api,
    expectedCanonicalRoot: fs.realpathSync.native(target),
  });
  process.stdout.write(JSON.stringify({ hardened, retrySleeps, firstOpenError, openAttempts }));
} finally {
  if (holder) close(holder);
}
