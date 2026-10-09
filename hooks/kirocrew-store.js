"use strict";

// Native lock and owner-only atomic writer for KiroCrew's hooks.json store.
// The lock files are the same rendezvous used by KiroCrew itself:
// hooks.json.lock (flock / msvcrt byte 0) and gateway.lock.

const fs = require("fs");
const path = require("path");

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const WINDOWS_LOCKED_ERRORS = new Set([33, 36]); // ERROR_LOCK_VIOLATION / ERROR_SHARING_BUFFER_EXCEEDED
const nativeApiCache = new Map();

function nativeApis(platform) {
  if (nativeApiCache.has(platform)) return nativeApiCache.get(platform);
  const koffi = require("koffi");
  if (platform !== "win32") {
    const lib = platform === "darwin"
      ? koffi.load("/usr/lib/libSystem.B.dylib")
      : koffi.load("libc.so.6");
    const api = { koffi, flock: lib.func("int flock(int fd, int operation)"), errno: koffi.errno };
    nativeApiCache.set(platform, api);
    return api;
  }

  const HANDLE = koffi.pointer("KCREW_HANDLE", koffi.opaque());
  const OVERLAPPED = koffi.struct("KCREW_OVERLAPPED", {
    Internal: "uintptr_t",
    InternalHigh: "uintptr_t",
    Offset: "uint32_t",
    OffsetHigh: "uint32_t",
    hEvent: "void *",
  });
  const kernel32 = koffi.load("kernel32.dll");
  const api = {
    koffi,
    HANDLE,
    OVERLAPPED,
    CreateFileW: kernel32.func("KCREW_HANDLE __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, KCREW_HANDLE template_file)"),
    LockFileEx: kernel32.func("int __stdcall LockFileEx(KCREW_HANDLE file, uint32_t flags, uint32_t reserved, uint32_t low, uint32_t high, KCREW_OVERLAPPED *overlapped)"),
    UnlockFileEx: kernel32.func("int __stdcall UnlockFileEx(KCREW_HANDLE file, uint32_t reserved, uint32_t low, uint32_t high, KCREW_OVERLAPPED *overlapped)"),
    CloseHandle: kernel32.func("int __stdcall CloseHandle(KCREW_HANDLE handle)"),
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError(void)"),
  };
  nativeApiCache.set(platform, api);
  return api;
}

function invalidHandle(koffi, handle) {
  if (!handle) return true;
  const address = koffi.address(handle);
  return address === 0xffffffffn || address === 0xffffffffffffffffn;
}

function createLockFile(filePath, platform) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (platform !== "win32") {
    const fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
    return { fd };
  }
  const api = nativeApis(platform);
  // GENERIC_READ | GENERIC_WRITE; allow peer readers/writers but deny delete
  // sharing. KiroCrew may unlink a stale gateway.lock before recreating it;
  // denying delete keeps that reclamation from replacing the inode while we
  // hold the cross-process startup fence. OPEN_ALWAYS never truncates it.
  const handle = api.CreateFileW(filePath, 0xc0000000, 0x3, null, 4, 0x80, null);
  if (invalidHandle(api.koffi, handle)) {
    const code = api.GetLastError();
    const error = new Error(`Could not open KiroCrew lock file (Win32 ${code})`);
    error.win32Code = code;
    throw error;
  }
  const overlapped = Buffer.alloc(api.koffi.sizeof(api.OVERLAPPED));
  return { api, handle, overlapped };
}

function acquireKiroCrewLock(filePath, options = {}) {
  const platform = options.platform || process.platform;
  const api = nativeApis(platform);
  const opened = createLockFile(filePath, platform);
  if (platform !== "win32") {
    const result = api.flock(opened.fd, LOCK_EX | LOCK_NB);
    if (result !== 0) {
      const code = api.errno();
      fs.closeSync(opened.fd);
      if (code === 11 || code === 35) return null; // EAGAIN / EWOULDBLOCK
      const error = new Error(`Could not lock ${path.basename(filePath)} (errno ${code})`);
      error.code = `ERRNO_${code}`;
      throw error;
    }
    return () => {
      try { api.flock(opened.fd, LOCK_UN); } finally { fs.closeSync(opened.fd); }
    };
  }

  const acquired = opened.api.LockFileEx(opened.handle, 0x3, 0, 1, 0, opened.overlapped);
  if (!acquired) {
    const code = opened.api.GetLastError();
    opened.api.CloseHandle(opened.handle);
    if (WINDOWS_LOCKED_ERRORS.has(code)) return null;
    const error = new Error(`Could not lock ${path.basename(filePath)} (Win32 ${code})`);
    error.win32Code = code;
    throw error;
  }
  return () => {
    try { opened.api.UnlockFileEx(opened.handle, 0, 1, 0, opened.overlapped); }
    finally { opened.api.CloseHandle(opened.handle); }
  };
}

function acquireKiroCrewDirectoryLock(directoryPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return () => {};
  const api = nativeApis(platform);
  const fd = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  const result = api.flock(fd, LOCK_EX | LOCK_NB);
  if (result !== 0) {
    const code = api.errno();
    fs.closeSync(fd);
    if (code === 11 || code === 35) return null; // EAGAIN / EWOULDBLOCK
    const error = new Error(`Could not lock KiroCrew home directory (errno ${code})`);
    error.code = `ERRNO_${code}`;
    throw error;
  }
  return () => {
    try { api.flock(fd, LOCK_UN); } finally { fs.closeSync(fd); }
  };
}

function hardenOwnerOnlyFile(filePath, platform) {
  if (platform !== "win32") return false;
  const { createWindowsAclApi } = require("../src/recap-private-permissions");
  const api = createWindowsAclApi();
  let handle = null;
  try {
    handle = api.openNode(filePath);
    const attributes = api.attributes(handle);
    if ((attributes & 0x10) !== 0 || (attributes & 0x400) !== 0 || api.linkCount(handle) !== 1) {
      throw new Error("KiroCrew hook store temp file is not a regular single-link file");
    }
    api.applyPrivateDacl(handle, api.currentUserSid(), false);
    return true;
  } finally {
    if (handle) api.close(handle);
  }
}

function writeKiroCrewStoreAtomic(filePath, data, options = {}) {
  const platform = options.platform || process.platform;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${require("crypto").randomBytes(4).toString("hex")}.tmp`);
  let fd = null;
  try {
    // Load the native API before opening the temp file so a missing runtime
    // library cannot leave an unlinked descriptor behind.
    if (platform !== "win32") nativeApis(platform);
    fd = fs.openSync(tempPath, "wx", 0o600);
    if (platform === "win32") {
      // Windows ignores POSIX mode bits. Apply and verify the restrictive DACL
      // before writing the first byte; inability to do so is a hard failure.
      hardenOwnerOnlyFile(tempPath, platform);
    } else {
      fs.fchmodSync(fd, 0o600);
    }
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

module.exports = {
  acquireKiroCrewDirectoryLock,
  acquireKiroCrewLock,
  hardenOwnerOnlyFile,
  writeKiroCrewStoreAtomic,
};
