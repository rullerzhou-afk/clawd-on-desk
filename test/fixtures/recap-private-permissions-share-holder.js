"use strict";

const koffi = require("koffi");

const HANDLE = koffi.pointer("RECAP_SHARE_HOLDER_HANDLE", koffi.opaque());
const kernel32 = koffi.load("kernel32.dll");
const CreateFileW = kernel32.func(
  "RECAP_SHARE_HOLDER_HANDLE __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, RECAP_SHARE_HOLDER_HANDLE template_file)"
);
const CloseHandle = kernel32.func("int __stdcall CloseHandle(RECAP_SHARE_HOLDER_HANDLE handle)");

const target = process.argv[2];
const holdMs = Number(process.argv[3]);
const handle = CreateFileW(target, 0x80000000, 0x1, null, 3, 0x02000000, null);
const address = handle ? koffi.address(handle) : 0n;
if (!handle || address === 0xffffffffn || address === 0xffffffffffffffffn) process.exit(2);
process.stdout.write("READY\n");
setTimeout(() => {
  CloseHandle(handle);
  process.exit(0);
}, Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : 25);
