# Plan: #763 Koffi target-native packaging and foreign-native audit

> Status: **Implemented.** Shipped by PR #824 (`fix: package only target-native Koffi
> binaries`, 2026-08-07); issue #763 closed the same day. The packaging rule and the
> foreign-native audit gate are now part of the release process — see
> `docs/project/release-process.md`. Follow-up: the Koffi 3 split-package migration is
> tracked separately in #823. The plan below is kept as the design record; it was
> drafted as "Draft v3 with second-review findings incorporated; no implementation is
> authorized by this document", and that authorization was given separately.
> Date: 2026-08-07 (status refreshed 2026-08-12)
> Issue: https://github.com/rullerzhou-afk/clawd-on-desk/issues/763
> Origin: follow-up deliberately excluded from PR #762
> Scope: Windows x64/ARM64, macOS x64/ARM64, Linux x64 release artifacts

---

## 0. Decision summary

The implementation should not begin by blindly deleting 17 directories from the packaged app.

Koffi 3.x provides an upstream split-package answer, but its ABI layer is still receiving material fixes: 3.1.1 restored a missing Windows ARM64 package, and 3.1.4 fixed unused register/stack bytes for Win64 and i386 `bool` arguments. Clawd's FFI surface includes manual COM vtable dispatch, multiple `objc_msgSend` prototypes, and private SkyLight calls. Migrating that surface while also changing dependency provisioning and release-job topology would combine three independently risky changes.

Both packaging routes can satisfy #763's acceptance condition: each release target contains exactly one target-native Koffi addon. The selected route for #763 is therefore **Route B**:

1. pin the reviewed latest Koffi 2.16.x release, currently `2.16.3`, exactly;
2. run real-library compatibility probes because 2.15.2 to 2.16.3 is not assumed to be behavior-neutral;
3. use electron-builder's supported `afterPack` hook to retain only the target triplet's `koffi.node` and remove every other Koffi native payload before signing;
4. add a post-package assertion that exactly the expected Koffi native payload is present;
5. add a full extracted-app native audit with one narrow, documented exception for electron-builder's NSIS `resources/elevate.exe` helper;
6. require positive packaged/runtime behavior evidence instead of treating a clean launch or lack of warnings as proof.

Koffi 3 migration is deliberately deferred to a separate issue. That issue will own BigInt pointer adaptation, split-package lockfile/provisioning experiments, `process.resourcesPath` loading, multi-prototype `objc_msgSend` verification, and any release-job/updater-metadata topology change. Those topics do not gate #763.

No release, tag, asset/history cleanup, Telegram retirement work, Remote SSH change, or unrelated FFI refactor belongs in this change.

---

## 1. Verified current state

### 1.1 Package evidence

The current repository declares `koffi: "^2.15.2"`; the lockfile resolves exactly 2.15.2. Koffi 2.15.2 installs all supported native targets into one package.

The current source install contains:

| Item | Count / bytes |
|---|---:|
| `koffi.node` files | 18 |
| Total `koffi.node` bytes | 79,636,403 |
| Total files under `node_modules/koffi/build/koffi` | 79,645,670 |

The local v0.14.0 Windows x64 staged app built on 2026-08-05 still reproduces the issue:

| Item | Count / bytes |
|---|---:|
| Packaged Koffi native modules | 18 / 79,636,403 bytes |
| Foreign-to-win32-x64 modules | 17 / 76,446,131 bytes |
| `resources/elevate.exe` | 107,520 bytes, PE ia32 |

These local numbers are diagnosis evidence, not the canonical before/after benchmark. The implementation PR must produce same-commit, clean-run baselines as described in section 8.

### 1.2 Runtime use of Koffi

Koffi is not an incidental dependency. Clawd uses it in production paths:

| Platform | Files / behavior |
|---|---|
| Windows | `src/main.js`: `AllowSetForegroundWindow`, console output code page |
| Windows | `src/win-fullscreen-detect.js`: foreground fullscreen detection |
| Windows | `src/win-foreground-terminal.js`: foreground Windows Terminal capture |
| Windows | `src/win-cloak-recovery.js`: DWM cloak state and COM vtable calls |
| macOS | `src/mac-window.js`: Objective-C/AppKit messaging and private SkyLight calls |
| Linux | No current Clawd production FFI call, but the release contract will keep the matching linux-x64 Koffi package so `require("koffi")` remains valid and the five-target packaging rule stays uniform. Removing Linux Koffi entirely is a separate product/dependency decision. |

The Windows cloak recovery path is the highest-risk compatibility area. It manually decodes COM vtable pointers and calls function pointers. Unit fakes cannot prove that its pointer widths, calling conventions, or behavior under a new Koffi native build are correct.

### 1.3 Existing build topology

The release workflow currently does the following:

| Job | Host install | Outputs from the same dependency tree |
|---|---|---|
| Windows | `windows-latest`, one `npm install` | x64 NSIS + ARM64 NSIS and one combined `latest.yml` |
| macOS | `macos-latest`, one `npm install` | x64 DMG + ARM64 DMG |
| Linux | Ubuntu x64, one `npm install` | x64 AppImage + x64 deb |

The published v0.14.0 `latest.yml` contains both Windows x64 and ARM64 installer entries. Route B preserves the single-job release topology and avoids introducing updater metadata merge/overwrite behavior merely to solve #763. The implementation still switches package/install jobs from `npm install` to clean, lockfile-driven `npm ci` as described in section 9.4.

### 1.4 Upstream and package facts used by this plan

- Koffi changelog: https://koffi.dev/changelog
- Koffi pointer documentation: https://koffi.dev/pointers
- Koffi 2.16.3 registry metadata: https://registry.npmjs.org/koffi/2.16.3
- electron-builder build hooks: https://www.electron.build/docs/features/hooks/
- electron-builder lifecycle: https://www.electron.build/docs/features/build-lifecycle/
- npm clean install: https://docs.npmjs.com/cli/commands/npm-ci/
- Published v0.14.0 updater metadata: [Windows](https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/v0.14.0/latest.yml), [macOS](https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/v0.14.0/latest-mac.yml), [Linux](https://github.com/rullerzhou-afk/clawd-on-desk/releases/download/v0.14.0/latest-linux.yml)
- GitHub Windows ARM64 runner image migration notice: https://github.blog/changelog/2026-06-11-new-runner-images-in-public-preview/

As of this plan, Koffi 2.16.3 is the selected candidate. It was released on 2026-07-20. Koffi 2.16.0 expanded `koffi.address()` to support Buffers and typed arrays, changed x86 SEH stack placement, and substantially reduced package size; 2.16.1 changed Windows callback stack/exception behavior. Do not assume API/ABI behavior solely from the unchanged major version. Do not leave a caret range that can silently change native code during a later lockfile refresh; pin `2.16.3` exactly.

The published 2.16.3 tarball has an unpacked size of 28,750,096 bytes and integrity `sha512-E9y1AsgYGlaxMhcZzHr8y96QF2U5XzA12GGVAfbWqIubTwPNMXQarfBzePNXHe0xtIEtNd6ifAv3GAKYGUeBAQ==`. Its measured `build/koffi` layout contains 18 target directories and 18 `koffi.node` files. Each Windows triplet also contains `koffi.lib` and `koffi.exp`; those link artifacts are not needed at runtime. After pruning, the retained target triplet must contain exactly one file: `koffi.node`.

Koffi 2.16.3 still has an install script (`node src/cnoke/cnoke.js -P . -D src/koffi --prebuild`). Phase 0 must prove that clean installs use the published prebuilds and do not silently fall back to a local source build.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Each of the five release targets contains exactly one target-appropriate Koffi native addon and no foreign Koffi native addon.
2. `require("koffi")` succeeds from the packaged Electron app on every target.
3. Windows and macOS FFI behavior continues to work on the actual target architecture.
4. A deterministic extracted-app audit reports every PE, ELF, and Mach-O payload and fails on an unexpected foreign architecture.
5. The intentional electron-builder `resources/elevate.exe` helper is allowed by one exact-path, Windows-only, PE-ia32 exception with recorded provenance and reason.
6. Installer/download bytes and staged/unpacked bytes are recorded independently from a same-commit baseline.
7. Release CI cannot publish an artifact that skipped the Koffi/native audit.

### 2.2 Non-goals

1. Do not remove Koffi from Linux in this issue.
2. Do not replace Koffi with another FFI library.
3. Do not rewrite the Windows focus, fullscreen, cloak recovery, or macOS SkyLight feature design.
4. Do not add universal Windows NSIS output; x64 and ARM64 remain separate.
5. Do not remove `elevate.exe`. The task is to recognize its deliberate electron-builder provenance, not to disable an installer helper.
6. Do not rewrite Git history or clean unrelated assets.
7. Do not treat unit-test fakes as native ABI evidence.
8. Do not migrate to Koffi 3, add `@koromix/koffi-*` provisioning, or split release jobs by architecture in #763.

---

## 3. Phase 0: Route B validation gate before production changes

Phase 0 is a bounded spike. Its output is a checked-in evidence note or a clear section in the implementation PR. Route B is already selected; Phase 0 validates the selected version and pruning mechanics rather than reopening the Koffi 3 decision.

### 3.1 Koffi 2.16.3 compatibility and install spike

Use an isolated clean worktree or temporary project; do not mutate the user's active `node_modules` and call that reproducible evidence.

Pin `koffi@2.16.3` and run the existing focused FFI tests plus new real-library probes on the applicable operating systems and architectures.

Explicitly check:

- all existing `lib.func(...)` declarations initialize;
- `koffi.struct`, `koffi.sizeof`, output arrays, Buffers, and typed arrays behave unchanged;
- `koffi.decode(buffer, "void *")` and offset decode return the pointers expected by `win-cloak-recovery.js`;
- `koffi.proto` + `koffi.call` works for the manual COM vtable path;
- `koffi.address()` returns the correct lossless BigInt for real pointer wrappers, Buffers/typed arrays where relevant, and the HWND path used by `win-foreground-terminal.js`;
- Windows COM vtable decode/call succeeds against a real `IVirtualDesktopManager` instance far enough to obtain a non-null Boolean result for a real window;
- macOS loads `libobjc` and SkyLight declarations, and multiple declarations of `objc_msgSend` with different prototypes each return plausible values;
- Linux loads libc and a harmless call such as `getpid()` matches `process.pid`.

Phase 0 fails if any real-library probe crashes, returns an implausible pointer, or requires weakening an existing runtime safety check.

### 3.2 Install and package-layout evidence

For Windows, macOS, and Linux CI hosts, start from the committed lockfile with `npm ci` and record:

- the installed Koffi version and integrity;
- the install-script result and whether any native source compilation or network download was attempted;
- the actual `build/koffi` triplet inventory, file counts, and bytes;
- successful `require("koffi")` plus one harmless native call;
- successful execution of this repository's normal postinstall chain, including `scripts/verify-electron-install.js` and the host Electron binary.

Any environment that falls back to local Koffi compilation or an install-time network download is rejected for release packaging until the cause is understood. The packaging hook itself must not download dependencies or run Koffi's build system.

Build at least each unpacked target once and record the actual electron-builder 26.8.1 `afterPack` context platform/arch value. Normalize that value through the authoritative target map; do not hard-code unverified numeric enum values.

### 3.3 Selected production route and pruning contract

- Pin `koffi` to exactly `2.16.3`; do not remain on 2.15.2 or use a floating caret.
- Register an electron-builder `afterPack` hook. Official lifecycle guarantees this runs after app files are packaged and before signing/distributable assembly.
- Resolve the target triplet exclusively from the hook context's platform and architecture.
- Re-measure the installed 2.16.3 layout in Phase 0 before freezing the prune implementation; do not copy a 2.15.2 directory list by assumption.
- Under the resolved staged app only, retain the target triplet directory and remove every sibling target directory.
- Remove **all** `.lib` and `.exp` files, including any inside the retained target triplet.
- After pruning, require the retained target triplet to contain exactly `koffi.node` and no other file.
- Fail closed on an unknown platform/arch, a missing expected directory, zero native modules, multiple native modules, or a path that resolves outside the staged Koffi subtree.
- Never mutate source `node_modules`, shared caches, or another architecture's output directory.
- Apply all audit, CI, size, and real-machine requirements below without weakening them because the major Koffi version remains 2.x.

### 3.4 Deferred Koffi 3 issue

Create a separate follow-up issue before or alongside implementation. Preserve the following research inputs there rather than implementing them in #763:

- exact Koffi 3 version selection after ABI-fix frequency settles;
- BigInt pointer migration and `koffi.address()` compatibility;
- all five `@koromix/koffi-*` lockfile rows and clean cross-target provisioning;
- Koffi 3's documented `process.resourcesPath` search roots and a possible `extraResources`-based target-native model;
- full-Electron smoke when `ELECTRON_RUN_AS_NODE` cannot exercise `process.resourcesPath`;
- Windows ARM64 COM vtable and macOS multi-prototype `objc_msgSend` probes;
- updater metadata ownership/merge behavior before any release job is split by architecture.

---

## 4. Production design

### 4.1 One authoritative target map

Create one pure helper used by packaging, tests, and audits. Suggested responsibility:

```text
(electronPlatformName, electronBuilderArch)
  -> releaseTargetId
  -> expected process.platform/process.arch
  -> Koffi package name or Koffi 2 triplet
  -> expected native binary format and machine
```

Required mappings:

| Release target | Runtime tuple | Koffi triplet | Binary format / machine | Artifact arch aliases |
|---|---|---|---|---|
| windows-x64 | `win32/x64` | `win32_x64` | PE x64 | `x64` |
| windows-arm64 | `win32/arm64` | `win32_arm64` | PE ARM64 | `arm64` |
| darwin-x64 | `darwin/x64` | `darwin_x64` | Mach-O x86_64 | `x64` |
| darwin-arm64 | `darwin/arm64` | `darwin_arm64` | Mach-O arm64 | `arm64` |
| linux-x64 | `linux/x64` | `linux_x64` | ELF x86_64 | AppImage `x86_64`, deb `amd64` |

Do not duplicate this mapping in the build hook, audit CLI, workflow shell, and tests. Do not infer the audit target from artifact filenames; workflows pass the explicit release target ID. Do not use unreviewed numeric electron-builder arch constants in several files; normalize them once and test the actual hook context values emitted by electron-builder 26.8.1.

### 4.2 Staged-app Koffi assertion

The packaging hook or immediate post-pack assertion must:

1. resolve the staged resources directory from `context.appOutDir` and platform conventions;
2. inventory all physical `koffi.node` files in `app.asar.unpacked`;
3. require exactly one target Koffi addon;
4. parse its native header and verify the target machine, not merely trust its directory name;
5. record relative path, byte size, SHA-256, Koffi version, package name/triplet, format, and machine in a JSON manifest;
6. throw on missing, duplicate, malformed, or foreign Koffi payloads.

The assertion must also list the logical ASAR entries for Koffi native files. `afterPack` physical deletion may leave stale `unpacked` header entries pointing at deleted foreign files. Do not accept those entries as harmless by reasoning alone: document the observed ASAR behavior, make the artifact audit count physical payloads correctly, and require packaged `require("koffi")` plus a native call to succeed.

Do **not** attempt to eliminate stale logical entries by rewriting `app.asar` inside `afterPack` or any later hook. electron-builder 26.8.1 computes ASAR integrity during `beforeCopyExtraFiles`, before `afterPack`, and embeds it in the Windows executable resource and macOS `Info.plist` (`ElectronAsarIntegrity`). Rewriting the archive after that point produces a staged app whose integrity record no longer matches. On macOS this can make the packaged app fail at launch while an `ELECTRON_RUN_AS_NODE` smoke still passes. For Route B, stale logical entries are handled exclusively through the documented physical-inventory audit plus packaged `require("koffi")`/native-call smoke; the archive itself remains byte-for-byte unchanged after its integrity is recorded.

### 4.3 Full extracted-app foreign-native audit

Add a platform-neutral Node script, with its parser logic separated for unit tests. Suggested interface:

```text
node scripts/audit-packaged-native.js \
  --app-root <extracted-app-root> \
  --target windows-x64 \
  --output <manifest.json>
```

Audit scope is the complete staged/extracted application directory used to create the installer:

- Windows: `dist/win-unpacked` and `dist/win-arm64-unpacked`;
- macOS: each `.app` bundle under the architecture-specific output directory;
- Linux: `dist/linux-unpacked`.

The script should identify binaries by magic/header, not extension alone:

- PE: validate DOS and PE signatures, then read `Machine`;
- ELF: validate class/endianness and read `e_machine`;
- Mach-O: support thin and fat headers, enumerate slices, and report CPU types;
- unknown or malformed executable-looking files: fail with path and reason rather than silently classifying them as assets.

The first implementation should report every discovered native binary. It should not attempt to interpret arbitrary compressed archives. ASAR native payloads must be covered through ASAR listing plus `app.asar.unpacked` physical files.

The manifest must be stable and sorted by normalized relative path. Include:

- schema version;
- release target;
- app root identity;
- each binary's path, size, SHA-256, format, architecture/slices;
- disposition: `target`, `exception`, or `error`;
- the exact policy entry used for an exception;
- summary counts and bytes by disposition.

### 4.4 Narrow `elevate.exe` policy

electron-builder 26.8.1 copies the NSIS helper from its NSIS resources in `CopyElevateHelper` to `<appOutDir>/resources/elevate.exe`. The helper is intentionally PE ia32 even in x64 and ARM64 app directories.

Represent this in a checked-in policy file rather than a broad code conditional. The exception must require all of:

- normalized relative path is exactly `resources/elevate.exe`;
- target platform is Windows;
- parsed format is PE;
- parsed machine is ia32;
- reason names electron-builder NSIS `CopyElevateHelper`;
- the audit manifest still records size and SHA-256 for review.

Do not allow `**/elevate.exe`, every ia32 PE, every file under `resources`, or arbitrary electron-builder helpers.

Do not pin only the unsigned file hash without accounting for release signing: electron-builder can sign the copied helper. If the implementation adds a hash or Authenticode condition, it must work for both unsigned validation builds and signed releases, and the review must explain how provenance remains verifiable after signing.

The post-build extracted-app audit is required because electron-builder copies `elevate.exe` during NSIS target assembly, later than the normal `afterPack` stage.

### 4.5 Fail-safe filesystem rules

Any pruning implementation must:

1. resolve and normalize the staged target directory;
2. verify it is inside `context.appOutDir`;
3. verify the deletion root is the exact Koffi native subtree;
4. enumerate proposed deletions before applying them;
5. reject symlinks/reparse points or any resolved path that leaves the subtree;
6. never use the workspace root, user home, an unresolved environment variable, or a broad glob as a recursive-delete target;
7. stop the build if the retained target fails post-prune verification.

These guards require unit tests. A correct happy-path build is not evidence that the destructive boundary is safe.

---

## 5. Koffi 2.16.3 runtime compatibility checks

The major version remains 2.x, but 2.16.0 changed `koffi.address()` behavior and Koffi's native build/ABI implementation. The following production paths require explicit source and real-library review.

### 5.1 Windows foreground terminal

`src/win-foreground-terminal.js` calls `koffi.address(hwnd)` and converts the result directly to a decimal string. Keep the lossless BigInt-to-decimal path and prove that 2.16.3 returns the actual foreground Windows Terminal handle rather than silently falling through the module's catch-to-`null` behavior.

Tests must assert:

- a real Koffi pointer wrapper converts to the expected BigInt address;
- Buffer/typed-array address behavior added in 2.16.0 does not alter the HWND path;
- decimal HWND output never passes through `Number`;
- the real Windows probe returns a decimal HWND while a real Windows Terminal is foreground;
- the real ABI smoke does not hard-code the text `koffi 2.15.2`.

### 5.2 Windows cloak recovery

Review and exercise every pointer boundary in `src/win-cloak-recovery.js`:

- `CoCreateInstance` output `ppv[0]`;
- vtable decode;
- function-pointer decode at slots 2 and 3;
- `koffi.proto` calling conventions;
- `koffi.call` arguments and output array;
- HWND decode from Electron's native window handle Buffer.

Keep or strengthen explicit type/prototype declarations. The real probe must report `available=true`, obtain a non-null true/false result from `isOnCurrentVirtualDesktop()` for a real window, and dispose the COM manager cleanly. Initialization without a successful call is insufficient.

### 5.3 macOS Objective-C and SkyLight

`nativeHandleToPointer()` already returns BigInt. Verify on both Intel and Apple Silicon:

- Objective-C selectors/classes initialize;
- the existing multiple `objc_msgSend` declarations preserve their individual signatures and return widths (`long`/`ulong` on LP64);
- SkyLight connection/space IDs remain plausible;
- `applyStationaryCollectionBehavior()` returns true for a real Clawd window and the pet remains stationary during a Space switch;
- de-delegation and restoration perform successful calls rather than merely avoiding warnings;
- the optional de-delegation API still degrades safely when symbols are absent.

### 5.4 Linux

Run a packaged Koffi load smoke against libc (`getpid` or another harmless stable function). This is a package integrity test, not a new Clawd Linux runtime dependency.

---

## 6. Automated tests

### 6.1 Pure/unit tests

Add focused coverage for:

- all five target mappings and unknown platform/arch rejection;
- Koffi package/triplet inventory: exact one, zero, duplicate, wrong package, wrong arch;
- PE x64/ARM64/ia32 parsing and malformed/truncated PE;
- ELF x64/ARM64 parsing, class/endianness validation, malformed ELF;
- thin Mach-O x86_64/arm64 and fat Mach-O slice parsing;
- stable manifest sorting and path normalization across `\` and `/`;
- exact `elevate.exe` exception and near-miss rejection:
  - wrong directory;
  - wrong filename case policy, if case normalization is used;
  - non-Windows target;
  - PE x64/ARM64 instead of ia32;
  - malformed payload;
- prune boundary safety: missing root, path escape, symlink/reparse point, unknown target, retained-file verification failure;
- Koffi 2.16.3 pointer/address-to-decimal conversion and call-time failure detection;
- `package-lock.json` contains exactly `koffi@2.16.3` with the reviewed official integrity;
- `package.json` and workflow contract tests that prove the hook/audit cannot be omitted from release builds.

Use tiny generated header fixtures where possible. Do not commit copied proprietary/system binaries just to test format parsing.

### 6.2 Real-library ABI tests

Keep existing fake-Koffi tests for branch behavior, but add/extend platform-gated real-library tests:

- Windows host: load `kernel32`/`user32`, perform harmless calls, exercise foreground-terminal initialization, and exercise the COM vtable path far enough to prove pointer decoding without mutating desktop state;
- macOS host: load `libobjc`, resolve a known class and selector, and run a harmless message send;
- Linux host: load libc and compare native `getpid()` with `process.pid`.

These tests prove the source install. The packaged smoke below separately proves the final ASAR/unpacked layout.

### 6.3 Packaged module-load smoke

Run a small script under the packaged Electron runtime with `ELECTRON_RUN_AS_NODE=1`, or another equally direct packaged-runtime entry that does not depend on the developer's source `node_modules`.

The smoke must:

1. require Koffi from `resources/app.asar`;
2. prove the loaded `.node` path is inside the packaged app's physical `app.asar.unpacked` tree and matches the target package/triplet; obtain this evidence from the native `dlopen`/module-load layer rather than `require.cache` keys, which may retain the logical `app.asar` path;
3. perform the platform's harmless native call and assert the expected return shape/value (`getpid() === process.pid` on Linux, and equivalent deterministic calls on Windows/macOS);
4. initialize every platform-specific Clawd FFI probe that can run safely in CI, then perform at least one successful real call rather than only checking that construction did not throw;
5. print a small JSON result containing runtime platform/arch, Koffi version, addon path, each probe's actual return value, and whether the call was positively validated;
6. exit non-zero on any fallback to the source checkout/global module path, `null`/sentinel result where success is expected, or caught call-time failure.

Route B keeps Koffi under `app.asar.unpacked`, so `ELECTRON_RUN_AS_NODE=1` is acceptable only after the smoke proves it resolves the same packaged addon path used by normal Electron. If a probe needs a real Electron window or if `ELECTRON_RUN_AS_NODE` is not reliable for a signed target, add a narrowly gated full-Electron self-test entry. The full-Electron path is also required to exercise normal application loading and the ASAR integrity check that `ELECTRON_RUN_AS_NODE` may bypass. It must not modify user preferences, install hooks, open the live HTTP port, or persist data. The future Koffi 3 `process.resourcesPath` packaging model must use full Electron and is out of scope here.

---

## 7. Real-machine behavior smoke

Artifact-load success is necessary but insufficient. Record target-appropriate behavior evidence.

| Target | Required real-machine checks |
|---|---|
| Windows x64 | App launches without Koffi warnings. With a real Windows Terminal foreground, the probe returns a base-10 HWND and the session's `wt_hwnd` is observed updating; HUD/session focus returns to that terminal. A real fullscreen app makes the fullscreen probe return true and Clawd yield. The cloak inspector reports `available=true`; `isOnCurrentVirtualDesktop()` returns true or false, never `null`, for a real window; disposal succeeds. |
| Windows ARM64 | Repeat the same positive assertions on native ARM64 Windows hardware. x64 emulation is not ARM64 evidence. A native CI runner can cover packaged load/call but does not replace interactive focus/fullscreen/cloak evidence. |
| macOS x64 | App launches on Intel. `applyStationaryCollectionBehavior()` returns true for the real pet window; the pet remains stationary across a Space switch; entering/leaving text editing successfully de-delegates and restores the window. Lack of Koffi/SkyLight warnings alone is not a pass. |
| macOS ARM64 | Repeat the same positive assertions on Apple Silicon without Rosetta standing in for native ARM64 evidence. |
| Linux x64 | App launches; packaged Koffi loads from the staged app; libc `getpid()` equals `process.pid`; normal pet window behavior has no regression. |

For Windows Terminal cleanup, follow the repository safety rule: never terminate `WindowsTerminal.exe` or related shared processes. Test terminals exit only from the clearly owned test session with `exit`; otherwise preserve them for manual closure.

Use the existing five-target PR matrix to reduce hardware gaps: evaluate `windows-11-arm` for the Windows ARM64 row and `macos-15-intel` for the macOS x64 row; keep `macos-latest` for Apple Silicon. These labels must be confirmed in Phase 0 and may be unavailable or preview-grade. If a native runner cannot support packaging, retain the cross-build row and document the remaining hardware block. Do not relabel a cross-build or headless native call as an interactive runtime smoke.

GitHub plans to migrate the `windows-11-arm` label to its Visual Studio 2026 image in early September 2026. If implementation or later CI validation spans that migration window, rerun the runner viability and timeout check after the image changes rather than treating changed toolchain behavior as a product regression.

---

## 8. Size and audit evidence

### 8.1 Same-commit baseline

For each target, capture a baseline and candidate from the same source commit and equivalent clean runner/toolchain. The only intentional difference should be the packaging implementation under review.

Record separately:

- distributable bytes: NSIS, DMG, AppImage, deb;
- staged/extracted app bytes;
- `resources` bytes;
- `app.asar` bytes;
- `app.asar.unpacked` bytes;
- Koffi main-package bytes;
- Koffi native file count/bytes;
- foreign-native count/bytes;
- exception count/bytes.

Do not infer installer savings by subtracting raw native bytes. Compression, signing, DMG/AppImage formats, and blockmaps make raw and distributable deltas different.

### 8.2 Expected result shape

The PR description should contain a table like:

| Target | Artifact before | Artifact after | Staged before | Staged after | Koffi native before | Koffi native after | Audit |
|---|---:|---:|---:|---:|---:|---:|---|
| windows-x64 | TBD | TBD | TBD | TBD | TBD | 1 / TBD | pass + elevate exception |
| windows-arm64 | TBD | TBD | TBD | TBD | TBD | 1 / TBD | pass + elevate exception |
| darwin-x64 | TBD | TBD | TBD | TBD | TBD | 1 / TBD | pass |
| darwin-arm64 | TBD | TBD | TBD | TBD | TBD | 1 / TBD | pass |
| linux-x64 | TBD | TBD | TBD | TBD | TBD | 1 / TBD | pass |

Do not copy the Windows local diagnosis into the other rows. Build and measure each target.

### 8.3 Audit acceptance

Each manifest must end with:

- exactly one target Koffi `.node`;
- zero foreign Koffi `.node` files;
- zero unexpected foreign native binaries;
- Windows only: exactly one approved `resources/elevate.exe` exception;
- zero undeclared exceptions;
- no missing or malformed native payload.

Any additional legitimate helper discovered in fresh macOS/Linux builds must be investigated and documented individually. Do not broaden the policy to make the audit green.

---

## 9. CI and release integration

### 9.1 Pull-request validation workflow

Extend the existing five-target `.github/workflows/telegram-retirement-package-audit.yml` package matrix instead of adding a second five-target build. The same per-target build output must feed both the retired-sidecar assertion and the new Koffi/native audit. The workflow may be renamed to a general package-audit name only if all tests, path filters, artifact names, and references are updated atomically.

Add relevant trigger paths:

- `package.json`, `package-lock.json`;
- Koffi/packaging/audit scripts and policy;
- `.github/workflows/build.yml` and the audit workflow;
- Koffi-using runtime files;
- native audit/package config tests.

It should also support `workflow_dispatch`. It must not create a tag or release.

Evaluate native runner substitutions inside the existing rows, not as duplicate packaging jobs:

- Windows ARM64: `windows-11-arm` public-preview runner, with fallback to the existing Windows cross-build if electron-builder or required tooling is unsupported;
- macOS x64: `macos-15-intel`;
- macOS ARM64: `macos-latest`/Apple Silicon;
- Windows x64 and Linux x64: their existing native runners.

Always upload, including on failure:

- per-target Koffi manifest;
- per-target full native manifest;
- packaged load-smoke JSON;
- size report;
- relevant build logs.

### 9.2 Release workflow

The normal tag build must run the same assertions beside the existing retired-sidecar assertion after each platform build and before artifact upload/release. Reuse the same per-target manifest-upload pattern. The `release` job must depend on audited build jobs. A missing manifest is a failure, not a warning.

Route B must retain the current single Windows release job that creates both x64 and ARM64 installers and one combined `latest.yml`; retain `${arch}` in Windows artifact names and `buildUniversalInstaller: false`. Do not split release jobs in #763.

Add updater metadata validation before release publication:

- `latest.yml` lists both Windows x64 and ARM64 installers;
- `latest-mac.yml` and Linux metadata list every artifact expected by the current updater contract;
- every metadata `url` resolves to an artifact selected for upload;
- metadata `size` and `sha512` match the actual artifact;
- no architecture entry is lost or overwritten.

The current updater contract is anchored to the released v0.14.0 shape: `latest.yml` lists both Windows executables and its top-level `path` points at the x64 installer; `latest-mac.yml` lists both DMGs (no invented zip entry) and points at the x64 DMG; `latest-linux.yml` lists both the `x86_64` AppImage and `amd64` deb, points at the AppImage, and preserves the generated AppImage `blockMapSize`. Validate generated files against this shape and update the contract deliberately if the repository's configured release outputs change.

### 9.3 Test command integration

Add focused scripts only where they reduce ambiguity, for example:

- `npm run audit:native-package -- ...` for an already-built app;
- a focused package test list for `artifact_validation_only`;
- no npm script that silently performs a full release or publishes artifacts.

### 9.4 Install hygiene gates

- Switch every install step in `.github/workflows/build.yml` and the existing five-target PR package-audit workflow, including its unit and package jobs, from `npm install` to `npm ci`. Do not restore `node_modules` across lockfile changes.
- Add a checked-in unit/contract test that reads `package-lock.json` and asserts exactly `koffi@2.16.3`, the reviewed official integrity, and an install-script-bearing package row.
- Keep the repository's existing registry topology out of scope; do not normalize hundreds of unrelated lockfile `resolved` URLs in #763. Whether the Koffi tarball resolves through npmjs or the existing mirror, its integrity must equal the official registry value and clean `npm ci` must succeed on all three CI operating systems.
- If a future Koffi 3 issue adopts split optional packages, that issue must add a stronger lockfile test for all target `@koromix/koffi-*` `version`/`resolved`/`integrity`/`os`/`cpu` rows.

---

## 10. Implementation sequence

1. Run the bounded Koffi 2.16.3 compatibility, install-script, layout, and `afterPack` context probes from Phase 0.
2. Pin `koffi` to exactly 2.16.3, update the lockfile, and add the package/lock hygiene contract test.
3. Implement the authoritative target map and binary parsers with unit tests.
4. Implement the guarded `afterPack` pruning hook; delete all foreign triplets and every `.lib`/`.exp`, then verify the retained triplet contains exactly `koffi.node`.
5. Implement the staged-app Koffi assertion and JSON manifest, including logical ASAR and physical unpacked inventory.
6. Implement the full extracted-app audit and exact `elevate.exe` policy.
7. Build and audit local Windows x64, then Windows ARM64; run packaged positive load/call smoke where the host can execute the target.
8. Extend the existing five-target PR workflow and release workflow, switch packaging installs to `npm ci`, and retain all manifests/smoke JSON.
9. Validate updater metadata coverage, sizes, and hashes against the built artifacts.
10. Run all five target builds; use native Windows ARM64 and Intel macOS PR runners where Phase 0 proves them viable.
11. Perform real-machine Windows x64/ARM64 and macOS x64/ARM64 positive behavior smoke; perform Linux x64 launch/load smoke.
12. Record same-commit before/after bytes and behavior evidence in the PR.
13. Create the separate Koffi 3 migration issue with the deferred research inputs from section 3.4.
14. Update `docs/project/release-process.md` with the native audit requirement and add a short AGENTS.md invariant only after the implementation shape is final.
15. Run focused tests, full `npm test`, `git diff --check`, and inspect the final diff for unrelated changes.

Expected effort after review:

- Phase 0: 1–3 focused hours;
- code, parsers, and tests: 4–8 hours;
- five-target CI and evidence: several hours of runner time;
- real target smoke: dependent on device availability.

Realistically this is one to two engineering days, not counting unavailable ARM64/Intel hardware waits.

---

## 11. Rollback and failure policy

### 11.1 Before merge

Do not merge when:

- any target retains anything other than one correctly parsed target-architecture Koffi addon;
- any packaged `require("koffi")` smoke uses the source checkout;
- Koffi's install script falls back to an unexplained local source build or network download;
- any Windows/macOS real FFI smoke lacks the required successful return value or is degraded;
- the full native audit needs an unexplained exception;
- signed and unsigned Windows builds disagree in a way the `elevate.exe` policy cannot explain;
- local combined-arch build commands produce incomplete artifacts;
- updater metadata omits an expected artifact or its size/hash does not match.

### 11.2 Selected-route rollback

If 2.16.3 fails Phase 0 or positive runtime smoke, stop before production pruning and record the failure. Re-evaluate a reviewed Koffi 2.x version or close #763 as blocked; do not silently switch to Koffi 3 inside the same implementation PR.

If a post-merge regression is found before release, disable/remove the `afterPack` pruning hook and restore the last known exact Koffi version. The build must then intentionally fail the new one-target audit until the rollback decision also explicitly reverts that release gate. Keep independently valid audit parser work only if it remains truthful against the restored package. Never make the audit green with a broad exception for the old multi-target payload.

### 11.3 Deferred migration isolation

Do not ship a hybrid that carries Koffi 2's multi-target package and Koffi 3's split target packages. The future Koffi 3 issue must start from the post-#763 audited packaging contract and make its own migration/rollback decision.

---

## 12. Definition of done

- [ ] Phase 0 proves Koffi 2.16.3 compatibility, lockfile-backed prebuilt installation without source-build/network fallback, actual layout, and `afterPack` target context.
- [ ] Koffi is pinned exactly to 2.16.3; the lockfile integrity matches the reviewed official package.
- [ ] Release and five-target PR package jobs use `npm ci`.
- [ ] All five staged apps contain exactly one target-appropriate Koffi `.node`.
- [ ] Every retained Koffi triplet contains exactly `koffi.node`; no `.lib` or `.exp` remains.
- [ ] Packaged Electron loads and successfully calls Koffi on all five targets with actual return values recorded.
- [ ] Windows x64 and ARM64 real focus/fullscreen/cloak smoke passes the positive assertions in section 7.
- [ ] macOS x64 and ARM64 real ObjC/SkyLight behavior smoke passes the positive assertions in section 7.
- [ ] Linux x64 launch and packaged libc call smoke passes.
- [ ] Full native manifests contain zero unexpected foreign payloads.
- [ ] Windows manifests contain exactly the narrow `resources/elevate.exe` exception.
- [ ] Same-commit artifact and staged bytes are recorded for every target.
- [ ] The existing five-target PR package workflow and release workflow both enforce the same audit without a duplicate matrix.
- [ ] Updater metadata covers every expected architecture and matches artifact size/SHA-512.
- [ ] Native `windows-11-arm` and `macos-15-intel` PR rows are used if Phase 0 proves them viable; otherwise the residual hardware gap is explicit.
- [ ] The deferred Koffi 3 migration issue records the section 3.4 research inputs.
- [ ] Focused tests, full `npm test`, and `git diff --check` pass.
- [ ] Release process documentation and final packaging invariant are updated.
- [ ] No unrelated cleanup or runtime behavior change is mixed into the PR.

---

## 13. Questions the external review must answer

1. Is Route B now bounded tightly enough for #763, or does any remaining text accidentally reintroduce Koffi 3 migration/provisioning work?
2. Does Phase 0 adequately detect 2.16.3 install-script fallback to local compilation or network download on Windows, macOS, and Linux?
3. Do the proposed real-library probes cover every 2.15.2 to 2.16.3 behavior risk used by Clawd, especially `koffi.address`, COM vtable decode/call, Buffer-to-pointer decode, and multiple `objc_msgSend` declarations?
4. Is `afterPack` the correct lifecycle point on Windows/macOS/Linux, including macOS signing, physical `app.asar.unpacked` deletion, and possible stale logical ASAR entries?
5. Does requiring the retained triplet to contain exactly `koffi.node` correctly remove every runtime-unneeded `.lib`/`.exp` without deleting anything Koffi needs later?
6. Is the full native audit scope well-defined? What legitimate fat Mach-O or foreign helper cases could produce false positives?
7. Is the `elevate.exe` exception sufficiently narrow and provenance-aware for both unsigned CI and signed release builds, given that NSIS copies it after `afterPack`?
8. Are the packaged smoke JSON and section 7 positive assertions sufficient to catch Clawd's fail-open/catch-to-null behavior?
9. Can the existing five-target PR workflow safely substitute `windows-11-arm` and `macos-15-intel` without changing release metadata topology or duplicating expensive builds?
10. Is the updater metadata gate complete for combined Windows x64/ARM64 `latest.yml`, macOS, and Linux artifacts?
11. Is the scoped lockfile policy sufficient: exact version + official integrity + cross-OS `npm ci`, without normalizing hundreds of unrelated registry URLs?
12. Are any planned deletes insufficiently constrained or capable of touching source `node_modules`, another architecture's output, a symlink/reparse target, or user data?
13. Is any requirement excessive for #763, or is any release-critical acceptance condition still missing?
