"use strict";

const fs = require("fs");
const path = require("path");

const PRIVATE_ACL_ERROR = "RECAP_PRIVATE_ACL_FAILED";
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const LOCAL_SERVICE_SID = "S-1-5-19";
const NETWORK_SERVICE_SID = "S-1-5-20";
const MAX_MANAGED_NODES = 128;
const RECAP_ATOMIC_TEMP_PATTERN = /^\.(?:meta\.json|daily-\d{4}-\d{2}\.json|coverage-(?:\d{4}-\d{2}|open)\.json)\.\d+\.[a-f0-9]{12}\.tmp$/;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const OPEN_EXISTING = 3;
const MAXIMUM_ALLOWED = 0x02000000;
const FILE_SHARE_READ_WRITE = 0x3;
const TOKEN_QUERY = 0x8;
const TOKEN_USER_CLASS = 1;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const PRIVATE_DACL_SECURITY_INFORMATION = PROTECTED_DACL_SECURITY_INFORMATION
  + DACL_SECURITY_INFORMATION;
const SDDL_REVISION_1 = 1;
const DRIVE_REMOTE = 4;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_LOCK_VIOLATION = 33;
const SHARING_RETRY_DELAYS_MS = Object.freeze([10, 10, 10]);

const windowsAclApiCache = new WeakMap();
let cachedKoffiLoadError = null;

function isManagedRootEntry(name) {
  return name === "events"
    || name === "quarantine"
    || name === "meta.json"
    || /^daily-\d{4}-\d{2}\.json$/.test(name)
    || /^coverage-(?:\d{4}-\d{2}|open)\.json$/.test(name)
    || RECAP_ATOMIC_TEMP_PATTERN.test(name);
}

function privateAclError(stage, cause = null) {
  const error = new Error("recap private Windows ACL could not be applied");
  error.code = PRIVATE_ACL_ERROR;
  error.stage = stage;
  if (cause) error.cause = cause;
  return error;
}

function isTransientRecapPrivateAclError(error) {
  return Boolean(
    error
    && error.code === PRIVATE_ACL_ERROR
    && error.stage === "open"
    && error.cause
    && [ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION].includes(error.cause.win32Code)
  );
}

function normalizeFinalWindowsPath(value) {
  let normalized = String(value || "");
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\/.test(normalized)) normalized = normalized.slice(4);
  return path.win32.resolve(normalized).replace(/[\\/]+$/, "").toLowerCase();
}

function isInvalidHandle(koffi, handle) {
  if (!handle) return true;
  const address = koffi.address(handle);
  return address === 0xffffffffn || address === 0xffffffffffffffffn;
}

function normalizeSddlPrincipal(principal, accountAliases = {}) {
  const aliases = {
    BA: ADMINISTRATORS_SID,
    LS: LOCAL_SERVICE_SID,
    NS: NETWORK_SERVICE_SID,
    SY: SYSTEM_SID,
  };
  if (aliases[principal]) return aliases[principal];
  if ((principal === "LA" || principal === "LG") && accountAliases[principal]) {
    return accountAliases[principal];
  }
  return principal;
}

function hasExactPrivateDacl(sddl, userSid, isDirectory, accountAliases = {}) {
  const descriptor = String(sddl || "");
  const daclStart = descriptor.indexOf("D:");
  if (daclStart < 0) return false;
  const saclStart = descriptor.indexOf("S:", daclStart + 2);
  const dacl = descriptor.slice(daclStart, saclStart < 0 ? descriptor.length : saclStart);
  const firstAce = dacl.indexOf("(");
  if (firstAce < 0 || !dacl.slice(2, firstAce).includes("P")) return false;
  const aces = [...dacl.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]);
  const expectedFlags = isDirectory ? "OICI" : "";
  const normalizedExpected = new Set(
    [userSid, "SY", "BA"].map((principal) => normalizeSddlPrincipal(principal, accountAliases))
  );
  if (aces.length !== normalizedExpected.size) return false;
  for (const ace of aces) {
    const fields = ace.split(";");
    if (fields.length !== 6
      || fields[0] !== "A"
      || fields[1] !== expectedFlags
      || fields[2] !== "FA"
      || fields[3] !== ""
      || fields[4] !== ""
      || !normalizedExpected.delete(normalizeSddlPrincipal(fields[5], accountAliases))) return false;
  }
  return normalizedExpected.size === 0;
}

function hasAllowedPrivateOwner(sddl, userSid, accountAliases = {}) {
  const match = /^O:(.*?)(?=G:|D:|S:|$)/.exec(String(sddl || ""));
  if (!match) return false;
  const owner = normalizeSddlPrincipal(match[1], accountAliases);
  return new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID]).has(owner);
}

function privateDaclDescriptorText(userSid, isDirectory) {
  const inherit = isDirectory ? "OICI" : "";
  const aces = [...new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID])]
    .map((sid) => `(A;${inherit};FA;;;${sid})`)
    .join("");
  return `D:P${aces}`;
}

function createVerifiedPrivateDaclApplier(options) {
  const setPrivateDacl = options && options.setPrivateDacl;
  const readSecuritySddl = options && options.readSecuritySddl;
  const accountAliases = options && options.accountAliases ? options.accountAliases : {};
  const accountAliasesForUser = options && options.accountAliasesForUser;
  if (typeof setPrivateDacl !== "function" || typeof readSecuritySddl !== "function") {
    throw new TypeError("private DACL applier requires set and read operations");
  }
  return function applyPrivateDacl(handle, userSid, isDirectory) {
    setPrivateDacl(handle, privateDaclDescriptorText(userSid, isDirectory));
    const actual = readSecuritySddl(handle);
    const resolvedAliases = typeof accountAliasesForUser === "function"
      ? { ...accountAliases, ...accountAliasesForUser(userSid) }
      : accountAliases;
    if (!hasAllowedPrivateOwner(actual, userSid, resolvedAliases)
      || !hasExactPrivateDacl(actual, userSid, isDirectory, resolvedAliases)) {
      throw privateAclError("verify");
    }
  };
}

function createWindowsAclApi(koffiOverride) {
  let koffi = koffiOverride;
  if (arguments.length === 0) {
    if (cachedKoffiLoadError) throw cachedKoffiLoadError;
    try {
      koffi = require("koffi");
    } catch (cause) {
      cachedKoffiLoadError = privateAclError("native-api", cause);
      throw cachedKoffiLoadError;
    }
  }
  if ((typeof koffi !== "object" && typeof koffi !== "function") || koffi === null) {
    throw privateAclError("native-api", new TypeError("invalid Koffi API"));
  }
  const cached = windowsAclApiCache.get(koffi);
  if (cached) {
    if (cached.error) throw cached.error;
    return cached.api;
  }
  try {
  const HANDLE = koffi.pointer("RECAP_HANDLE", koffi.opaque());
  const FILE_ATTRIBUTE_TAG_INFO = koffi.struct("RECAP_FILE_ATTRIBUTE_TAG_INFO", {
    FileAttributes: "uint32_t",
    ReparseTag: "uint32_t",
  });
  const BY_HANDLE_FILE_INFORMATION = koffi.struct("RECAP_BY_HANDLE_FILE_INFORMATION", {
    dwFileAttributes: "uint32_t",
    ftCreationTimeLow: "uint32_t",
    ftCreationTimeHigh: "uint32_t",
    ftLastAccessTimeLow: "uint32_t",
    ftLastAccessTimeHigh: "uint32_t",
    ftLastWriteTimeLow: "uint32_t",
    ftLastWriteTimeHigh: "uint32_t",
    dwVolumeSerialNumber: "uint32_t",
    nFileSizeHigh: "uint32_t",
    nFileSizeLow: "uint32_t",
    nNumberOfLinks: "uint32_t",
    nFileIndexHigh: "uint32_t",
    nFileIndexLow: "uint32_t",
  });
  const SID_AND_ATTRIBUTES = koffi.struct("RECAP_SID_AND_ATTRIBUTES", {
    Sid: "void *",
    Attributes: "uint32_t",
  });
  const TOKEN_USER = koffi.struct("RECAP_TOKEN_USER", { User: SID_AND_ATTRIBUTES });
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");

  const CloseHandle = kernel32.func("int __stdcall CloseHandle(RECAP_HANDLE handle)");
  const Sleep = kernel32.func("void __stdcall Sleep(uint32_t milliseconds)");
  const GetLastError = kernel32.func("uint32_t __stdcall GetLastError(void)");
  const CreateFileW = kernel32.func(
    "RECAP_HANDLE __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, RECAP_HANDLE template_file)"
  );
  const GetCurrentProcess = kernel32.func("RECAP_HANDLE __stdcall GetCurrentProcess(void)");
  const GetDriveTypeW = kernel32.func("uint32_t __stdcall GetDriveTypeW(const char16_t *root_path)");
  const GetFileInformationByHandleEx = kernel32.func(
    "int __stdcall GetFileInformationByHandleEx(RECAP_HANDLE handle, int info_class, _Out_ void *info, uint32_t size)"
  );
  const GetFileInformationByHandle = kernel32.func(
    "int __stdcall GetFileInformationByHandle(RECAP_HANDLE handle, _Out_ void *info)"
  );
  const GetFinalPathNameByHandleW = kernel32.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(RECAP_HANDLE handle, _Out_ char16_t *path, uint32_t length, uint32_t flags)"
  );
  const LocalFree = kernel32.func("void * __stdcall LocalFree(void *memory)");
  const ConvertSidToStringSidW = advapi32.func(
    "int __stdcall ConvertSidToStringSidW(const void *sid, _Out_ void **string_sid)"
  );
  const ConvertStringSecurityDescriptorToSecurityDescriptorW = advapi32.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, _Out_ uint32_t *size)"
  );
  const GetSecurityDescriptorDacl = advapi32.func(
    "int __stdcall GetSecurityDescriptorDacl(const void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)"
  );
  const GetSecurityInfo = advapi32.func(
    "uint32_t __stdcall GetSecurityInfo(RECAP_HANDLE handle, int object_type, uint32_t info, void **owner, void **group, void **dacl, void **sacl, _Out_ void **descriptor)"
  );
  const GetTokenInformation = advapi32.func(
    "int __stdcall GetTokenInformation(RECAP_HANDLE token, int info_class, _Out_ void *info, uint32_t size, _Out_ uint32_t *needed)"
  );
  const OpenProcessToken = advapi32.func(
    "int __stdcall OpenProcessToken(RECAP_HANDLE process, uint32_t access, _Out_ RECAP_HANDLE *token)"
  );
  const SetSecurityInfo = advapi32.func(
    "uint32_t __stdcall SetSecurityInfo(RECAP_HANDLE handle, int object_type, uint32_t info, void *owner, void *group, void *dacl, void *sacl)"
  );
  const ConvertSecurityDescriptorToStringSecurityDescriptorW = advapi32.func(
    "int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(const void *descriptor, uint32_t revision, uint32_t info, _Out_ void **text, _Out_ uint32_t *length)"
  );

  function close(handle) {
    if (handle && !isInvalidHandle(koffi, handle)) CloseHandle(handle);
  }

  function currentUserSid() {
    const tokenOut = [null];
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, tokenOut) || !tokenOut[0]) {
      throw privateAclError("current-user");
    }
    const token = tokenOut[0];
    try {
      const needed = [0];
      GetTokenInformation(token, TOKEN_USER_CLASS, null, 0, needed);
      if (!Number.isSafeInteger(needed[0]) || needed[0] <= 0 || needed[0] > 64 * 1024) {
        throw privateAclError("current-user");
      }
      const buffer = Buffer.alloc(needed[0]);
      if (!GetTokenInformation(token, TOKEN_USER_CLASS, buffer, buffer.length, needed)) {
        throw privateAclError("current-user");
      }
      const tokenUser = koffi.decode(buffer, TOKEN_USER);
      if (!tokenUser || !tokenUser.User || !tokenUser.User.Sid) throw privateAclError("current-user");
      const sidOut = [null];
      if (!ConvertSidToStringSidW(tokenUser.User.Sid, sidOut) || !sidOut[0]) {
        throw privateAclError("current-user");
      }
      try {
        const sid = koffi.decode(sidOut[0], "char16_t", -1);
        if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw privateAclError("current-user");
        return sid;
      } finally {
        LocalFree(sidOut[0]);
      }
    } finally {
      close(token);
    }
  }

  function accountAliasesForUser(userSid) {
    const descriptorOut = [null];
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
      `O:${userSid}`,
      SDDL_REVISION_1,
      descriptorOut,
      null
    ) || !descriptorOut[0]) throw privateAclError("native-api");
    try {
      const textOut = [null];
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
        descriptorOut[0],
        SDDL_REVISION_1,
        OWNER_SECURITY_INFORMATION,
        textOut,
        null
      ) || !textOut[0]) throw privateAclError("native-api");
      try {
        const text = koffi.decode(textOut[0], "char16_t", -1);
        const match = /^O:(.*?)(?=G:|D:|S:|$)/.exec(text);
        if (!match) throw privateAclError("native-api");
        const principal = match[1];
        if (principal === userSid) return {};
        if (!/^[A-Z]{2}$/.test(principal)) throw privateAclError("native-api");
        return { [principal]: userSid };
      } finally {
        LocalFree(textOut[0]);
      }
    } finally {
      LocalFree(descriptorOut[0]);
    }
  }

  function isRemotePath(nodePath) {
    const resolved = path.win32.resolve(nodePath);
    if (/^\\\\/.test(resolved)) return true;
    return GetDriveTypeW(path.win32.parse(resolved).root) === DRIVE_REMOTE;
  }

  function openNode(nodePath) {
    // Microsoft documents that SetSecurityInfo will not propagate ACEs from
    // a handle opened with MAXIMUM_ALLOWED. This keeps each mutation bound to
    // the one node whose reparse state, final path, identity, and link count we
    // validate below instead of implicitly rewriting descendants.
    for (let attempt = 0; ; attempt += 1) {
      const handle = CreateFileW(
        nodePath,
        MAXIMUM_ALLOWED,
        FILE_SHARE_READ_WRITE,
        null,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        null
      );
      const lastError = GetLastError();
      if (!isInvalidHandle(koffi, handle)) return handle;
      const retryable = lastError === ERROR_SHARING_VIOLATION || lastError === ERROR_LOCK_VIOLATION;
      if (!retryable || attempt >= SHARING_RETRY_DELAYS_MS.length) {
        const cause = new Error(`CreateFileW failed with Win32 error ${lastError}`);
        cause.win32Code = lastError;
        throw privateAclError("open", cause);
      }
      Sleep(SHARING_RETRY_DELAYS_MS[attempt]);
    }
  }

  function attributes(handle) {
    const infoBuffer = Buffer.alloc(koffi.sizeof(FILE_ATTRIBUTE_TAG_INFO));
    // FILE_INFO_BY_HANDLE_CLASS.FileAttributeTagInfo = 9.
    if (!GetFileInformationByHandleEx(handle, 9, infoBuffer, infoBuffer.length)) {
      throw privateAclError("identity");
    }
    const info = koffi.decode(infoBuffer, FILE_ATTRIBUTE_TAG_INFO);
    return info.FileAttributes;
  }

  function finalPath(handle) {
    const required = GetFinalPathNameByHandleW(handle, null, 0, 0);
    if (!required || required > 32768) throw privateAclError("identity");
    const buffer = Buffer.alloc((required + 1) * 2);
    const written = GetFinalPathNameByHandleW(handle, buffer, required + 1, 0);
    if (!written || written > required) throw privateAclError("identity");
    return koffi.decode(buffer, "char16_t", written);
  }

  function byHandleInfo(handle) {
    const infoBuffer = Buffer.alloc(koffi.sizeof(BY_HANDLE_FILE_INFORMATION));
    if (!GetFileInformationByHandle(handle, infoBuffer)) throw privateAclError("identity");
    return koffi.decode(infoBuffer, BY_HANDLE_FILE_INFORMATION);
  }

  function identity(handle) {
    const info = byHandleInfo(handle);
    const inode = (BigInt(info.nFileIndexHigh) << 32n) | BigInt(info.nFileIndexLow);
    return `${BigInt(info.dwVolumeSerialNumber)}:${inode}`;
  }

  function linkCount(handle) {
    return byHandleInfo(handle).nNumberOfLinks;
  }

  function setPrivateDacl(handle, descriptorText) {
    const descriptorOut = [null];
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
      descriptorText,
      SDDL_REVISION_1,
      descriptorOut,
      null
    ) || !descriptorOut[0]) throw privateAclError("descriptor");
    try {
      const present = [0];
      const daclOut = [null];
      const defaulted = [0];
      if (!GetSecurityDescriptorDacl(descriptorOut[0], present, daclOut, defaulted)
        || !present[0]
        || !daclOut[0]) throw privateAclError("descriptor");
      const status = SetSecurityInfo(
        handle,
        SE_FILE_OBJECT,
        PRIVATE_DACL_SECURITY_INFORMATION,
        null,
        null,
        daclOut[0],
        null
      );
      if (status !== 0) throw privateAclError("apply");
    } finally {
      LocalFree(descriptorOut[0]);
    }
  }

  function readSecuritySddl(handle) {
    const actualDescriptorOut = [null];
    const getStatus = GetSecurityInfo(
      handle,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      null,
      null,
      null,
      null,
      actualDescriptorOut
    );
    if (getStatus !== 0 || !actualDescriptorOut[0]) throw privateAclError("verify");
    try {
      const textOut = [null];
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
        actualDescriptorOut[0],
        SDDL_REVISION_1,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        textOut,
        null
      ) || !textOut[0]) throw privateAclError("verify");
      try {
        return koffi.decode(textOut[0], "char16_t", -1);
      } finally {
        LocalFree(textOut[0]);
      }
    } finally {
      LocalFree(actualDescriptorOut[0]);
    }
  }

  const applyPrivateDacl = createVerifiedPrivateDaclApplier({
    accountAliasesForUser,
    readSecuritySddl,
    setPrivateDacl,
  });

  const api = Object.freeze({
    applyPrivateDacl,
    attributes,
    close,
    currentUserSid,
    finalPath,
    identity,
    isRemotePath,
    linkCount,
    openNode,
  });
  windowsAclApiCache.set(koffi, { api });
  return api;
  } catch (cause) {
    const error = cause && cause.code === PRIVATE_ACL_ERROR
      ? cause
      : privateAclError("native-api", cause);
    windowsAclApiCache.set(koffi, { error });
    throw error;
  }
}

function assertRecapPrivatePathSupported(directoryPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return false;
  const api = options.api || createWindowsAclApi();
  if (api.isRemotePath(directoryPath)) throw privateAclError("remote-root");
  return true;
}

function hardenRecapPrivateDirectory(directoryPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return false;

  const fsImpl = options.fsImpl || fs;
  const api = options.api || createWindowsAclApi();
  assertRecapPrivatePathSupported(options.expectedCanonicalRoot || directoryPath, { api, platform });
  const userSid = api.currentUserSid();
  const expectedRoot = normalizeFinalWindowsPath(
    options.expectedCanonicalRoot || fsImpl.realpathSync.native(directoryPath)
  );
  const pending = [{ lexicalPath: directoryPath, expectedPath: expectedRoot, isRoot: true, depth: 0 }];
  let visited = 0;

  while (pending.length > 0) {
    if (++visited > MAX_MANAGED_NODES) throw privateAclError("tree-limit");
    const entry = pending.pop();
    let handle = null;
    let isDirectory = false;
    try {
      handle = api.openNode(entry.lexicalPath);
      const attributes = api.attributes(handle);
      if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw privateAclError("reparse");
      isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
      if (entry.isRoot && !isDirectory) throw privateAclError("identity");
      if (normalizeFinalWindowsPath(api.finalPath(handle)) !== entry.expectedPath) {
        throw privateAclError("identity");
      }
      if (entry.isRoot
        && options.expectedIdentity
        && api.identity(handle) !== options.expectedIdentity) throw privateAclError("identity");
      if (!isDirectory && api.linkCount(handle) !== 1) throw privateAclError("hardlink");
      api.applyPrivateDacl(handle, userSid, isDirectory);
    } finally {
      if (handle) api.close(handle);
    }

    if (!isDirectory) continue;
    let children;
    try {
      children = fsImpl.readdirSync(entry.lexicalPath, { withFileTypes: true });
    } catch (error) {
      throw privateAclError("enumerate", error);
    }
    for (const child of children) {
      if (entry.depth === 0 && !isManagedRootEntry(child.name)) continue;
      pending.push({
        lexicalPath: path.win32.join(entry.lexicalPath, child.name),
        expectedPath: normalizeFinalWindowsPath(path.win32.join(entry.expectedPath, child.name)),
        isRoot: false,
        depth: entry.depth + 1,
      });
    }
  }
  return true;
}

module.exports = {
  ADMINISTRATORS_SID,
  MAX_MANAGED_NODES,
  PRIVATE_DACL_SECURITY_INFORMATION,
  PRIVATE_ACL_ERROR,
  RECAP_ATOMIC_TEMP_PATTERN,
  SYSTEM_SID,
  assertRecapPrivatePathSupported,
  createWindowsAclApi,
  createVerifiedPrivateDaclApplier,
  hasAllowedPrivateOwner,
  hasExactPrivateDacl,
  hardenRecapPrivateDirectory,
  isTransientRecapPrivateAclError,
  normalizeFinalWindowsPath,
};
