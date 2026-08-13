"use strict";

const KOFFI_VERSION = "2.16.3";

const KOFFI_TRIPLETS = Object.freeze([
  "darwin_arm64",
  "darwin_x64",
  "freebsd_arm64",
  "freebsd_ia32",
  "freebsd_x64",
  "linux_arm64",
  "linux_armhf",
  "linux_ia32",
  "linux_loong64",
  "linux_riscv64d",
  "linux_x64",
  "musl_arm64",
  "musl_x64",
  "openbsd_ia32",
  "openbsd_x64",
  "win32_arm64",
  "win32_ia32",
  "win32_x64",
]);

const KOFFI_TRIPLET_SET = new Set(KOFFI_TRIPLETS);

module.exports = { KOFFI_VERSION, KOFFI_TRIPLETS, KOFFI_TRIPLET_SET };
