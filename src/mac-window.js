// src/mac-window.js - macOS-only NSWindow tweaks that Electron does not expose.

const isMac = process.platform === "darwin";

// Values from AppKit's NSWindowCollectionBehavior enum.
const NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0;
const NSWindowCollectionBehaviorMoveToActiveSpace = 1 << 1;
const NSWindowCollectionBehaviorManaged = 1 << 2;
const NSWindowCollectionBehaviorTransient = 1 << 3;
const NSWindowCollectionBehaviorStationary = 1 << 4;
const NSWindowCollectionBehaviorParticipatesInCycle = 1 << 5;
const NSWindowCollectionBehaviorIgnoresCycle = 1 << 6;
const NSWindowCollectionBehaviorFullScreenPrimary = 1 << 7;
const NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8;
const NSWindowCollectionBehaviorFullScreenNone = 1 << 9;
const NSWindowCollectionBehaviorFullScreenAllowsTiling = 1 << 11;
const NSWindowCollectionBehaviorFullScreenDisallowsTiling = 1 << 12;
const NSWindowCollectionBehaviorPrimary = 1 << 16;
const NSWindowCollectionBehaviorAuxiliary = 1 << 17;
const NSWindowCollectionBehaviorCanJoinAllApplications = 1 << 18;
const NSWindowAnimationBehaviorNone = 2;
const CGAssistiveTechHighWindowLevel = 1500;

let objc = null;
let selWindow = null;
let selCollectionBehavior = null;
let selSetCollectionBehavior = null;
let selSetAnimationBehavior = null;
let selSetCanHide = null;
let selSetHidesOnDeactivate = null;
let selSetMovable = null;
let selSetLevel = null;
let selWindowNumber = null;
let selNumberWithInt = null;
let selArrayWithObject = null;
let warnedApplyFailure = false;
let warnedSkyLightFailure = false;
let skyLight = null;

function initObjc() {
  if (objc) return objc;

  const koffi = require("koffi");
  const libobjc = koffi.load("/usr/lib/libobjc.A.dylib");
  const objc_getClass = libobjc.func("void *objc_getClass(const char *name)");
  const sel_registerName = libobjc.func("void *sel_registerName(const char *name)");

  objc = {
    NSNumber: objc_getClass("NSNumber"),
    NSArray: objc_getClass("NSArray"),
    msgPtr: libobjc.func("objc_msgSend", "void *", ["void *", "void *"]),
    msgULong: libobjc.func("objc_msgSend", "ulong", ["void *", "void *"]),
    msgLong: libobjc.func("objc_msgSend", "long", ["void *", "void *"]),
    msgPtrInt: libobjc.func("objc_msgSend", "void *", ["void *", "void *", "int"]),
    msgPtrPtr: libobjc.func("objc_msgSend", "void *", ["void *", "void *", "void *"]),
    msgVoidULong: libobjc.func("objc_msgSend", "void", ["void *", "void *", "ulong"]),
    msgVoidLong: libobjc.func("objc_msgSend", "void", ["void *", "void *", "long"]),
    msgVoidBool: libobjc.func("objc_msgSend", "void", ["void *", "void *", "bool"]),
  };

  selWindow = sel_registerName("window");
  selCollectionBehavior = sel_registerName("collectionBehavior");
  selSetCollectionBehavior = sel_registerName("setCollectionBehavior:");
  selSetAnimationBehavior = sel_registerName("setAnimationBehavior:");
  selSetCanHide = sel_registerName("setCanHide:");
  selSetHidesOnDeactivate = sel_registerName("setHidesOnDeactivate:");
  selSetMovable = sel_registerName("setMovable:");
  selSetLevel = sel_registerName("setLevel:");
  selWindowNumber = sel_registerName("windowNumber");
  selNumberWithInt = sel_registerName("numberWithInt:");
  selArrayWithObject = sel_registerName("arrayWithObject:");
  return objc;
}

function initSkyLight() {
  if (skyLight) return skyLight;

  // Technique follows Masko Code's SkyLightOperator approach: create a private
  // system-level Space and move overlay windows into it so Space swipes do not
  // animate or temporarily hide them.
  const koffi = require("koffi");
  const lib = koffi.load("/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight");

  const SLSMainConnectionID = lib.func("SLSMainConnectionID", "int", []);
  const SLSSpaceCreate = lib.func("SLSSpaceCreate", "int", ["int", "int", "int"]);
  const SLSSpaceSetAbsoluteLevel = lib.func("SLSSpaceSetAbsoluteLevel", "int", ["int", "int", "int"]);
  const SLSShowSpaces = lib.func("SLSShowSpaces", "int", ["int", "void *"]);
  const SLSSpaceAddWindowsAndRemoveFromSpaces = lib.func("SLSSpaceAddWindowsAndRemoveFromSpaces", "int", [
    "int",
    "int",
    "void *",
    "int",
  ]);
  // #640 Phase 2: pulling a window back OUT of the private space (de-delegation).
  const SLSRemoveWindowsFromSpaces = lib.func("SLSRemoveWindowsFromSpaces", "int", ["int", "void *", "void *"]);
  const SLSGetActiveSpace = lib.func("SLSGetActiveSpace", "uint64", ["int"]);

  const connection = SLSMainConnectionID();
  const space = SLSSpaceCreate(connection, 1, 0);

  skyLight = {
    connection,
    space,
    SLSSpaceAddWindowsAndRemoveFromSpaces,
    SLSRemoveWindowsFromSpaces,
    SLSGetActiveSpace,
  };

  // Same strategy as Masko Code: create an absolute-level system Space that is
  // not part of the user's left/right Space swipe animation.
  SLSSpaceSetAbsoluteLevel(connection, space, 100);
  SLSShowSpaces(connection, makeNSNumberArray(space));

  return skyLight;
}

function nativeHandleToPointer(handle) {
  if (!handle || handle.length < 8) return null;
  const ptr = handle.readBigUInt64LE(0);
  return ptr === 0n ? null : ptr;
}

function makeNSNumberArray(value) {
  const { NSNumber, NSArray, msgPtrInt, msgPtrPtr } = initObjc();
  const number = msgPtrInt(NSNumber, selNumberWithInt, value);
  return msgPtrPtr(NSArray, selArrayWithObject, number);
}

function delegateWindowToStationarySpace(nsWindow) {
  try {
    const { msgLong } = initObjc();
    const { connection, space, SLSSpaceAddWindowsAndRemoveFromSpaces } = initSkyLight();
    const windowNumber = Number(msgLong(nsWindow, selWindowNumber)) || 0;
    if (!windowNumber) return false;

    SLSSpaceAddWindowsAndRemoveFromSpaces(connection, space, makeNSNumberArray(windowNumber), 7);
    return true;
  } catch (err) {
    if (!warnedSkyLightFailure) {
      console.warn("Clawd: failed to move macOS window into stationary SkyLight space:", err.message);
      warnedSkyLightFailure = true;
    }
    return false;
  }
}

function applyStationaryCollectionBehavior(browserWindow) {
  if (!isMac || !browserWindow || browserWindow.isDestroyed()) return false;

  try {
    const { msgPtr, msgULong, msgVoidULong, msgVoidLong, msgVoidBool } = initObjc();
    const nsView = nativeHandleToPointer(browserWindow.getNativeWindowHandle());
    if (!nsView) return false;

    // Electron exposes NSView*. The collection behavior lives on its NSWindow.
    const nsWindow = msgPtr(nsView, selWindow);
    if (!nsWindow) return false;

    const current = Number(msgULong(nsWindow, selCollectionBehavior)) || 0;
    const clearMask =
      NSWindowCollectionBehaviorMoveToActiveSpace |
      NSWindowCollectionBehaviorManaged |
      NSWindowCollectionBehaviorTransient |
      NSWindowCollectionBehaviorParticipatesInCycle |
      NSWindowCollectionBehaviorFullScreenPrimary |
      NSWindowCollectionBehaviorFullScreenNone |
      NSWindowCollectionBehaviorFullScreenAllowsTiling |
      NSWindowCollectionBehaviorPrimary |
      NSWindowCollectionBehaviorAuxiliary |
      NSWindowCollectionBehaviorCanJoinAllApplications;
    const setMask =
      NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorStationary |
      NSWindowCollectionBehaviorFullScreenAuxiliary |
      NSWindowCollectionBehaviorIgnoresCycle |
      NSWindowCollectionBehaviorFullScreenDisallowsTiling;
    const next = (current & ~clearMask) | setMask;

    if (next !== current) {
      msgVoidULong(nsWindow, selSetCollectionBehavior, next);
    }
    msgVoidBool(nsWindow, selSetCanHide, false);
    msgVoidBool(nsWindow, selSetHidesOnDeactivate, false);
    msgVoidBool(nsWindow, selSetMovable, false);
    msgVoidLong(nsWindow, selSetAnimationBehavior, NSWindowAnimationBehaviorNone);
    msgVoidLong(nsWindow, selSetLevel, CGAssistiveTechHighWindowLevel);
    delegateWindowToStationarySpace(nsWindow);
    return true;
  } catch (err) {
    if (!warnedApplyFailure) {
      console.warn("Clawd: failed to apply macOS stationary window behavior:", err.message);
      warnedApplyFailure = true;
    }
    return false;
  }
}

// #640 Phase 2 — reverse of applyStationaryCollectionBehavior's space delegation.
// While a text field is focused the editing bubble drops to the normal window
// level (#626), but the pet stays in the private absolute-level-100 space and
// keeps covering — and eating clicks over — that bubble. This pulls the given
// window OUT of the private space so its normal window level applies again and
// it sits BEHIND the bubble. Restore by re-running applyStationaryCollectionBehavior
// (idempotent: re-adds to the private space and restores the assistive-tech level).
//
// Two non-obvious points, both confirmed by real-machine probing:
//  - Adding the window to the active space is NOT enough; it stays a member of
//    the private space (whose absolute level dominates) until it is explicitly
//    removed via SLSRemoveWindowsFromSpaces.
//  - The SkyLight calls return a non-zero status (6619136) even on success, so
//    the return code is deliberately ignored.
function deDelegateWindowFromStationarySpace(browserWindow, level = 0) {
  if (!isMac || !browserWindow || browserWindow.isDestroyed()) return false;
  try {
    const { msgPtr, msgLong, msgVoidLong } = initObjc();
    const nsView = nativeHandleToPointer(browserWindow.getNativeWindowHandle());
    if (!nsView) return false;
    const nsWindow = msgPtr(nsView, selWindow);
    if (!nsWindow) return false;
    const windowNumber = Number(msgLong(nsWindow, selWindowNumber)) || 0;
    if (!windowNumber) return false;

    const {
      connection,
      space,
      SLSRemoveWindowsFromSpaces,
      SLSSpaceAddWindowsAndRemoveFromSpaces,
      SLSGetActiveSpace,
    } = initSkyLight();

    // 1. Explicitly leave the private absolute-level space.
    SLSRemoveWindowsFromSpaces(connection, makeNSNumberArray(windowNumber), makeNSNumberArray(space));
    // 2. Land in the current user space so the window keeps a valid on-screen home.
    const activeSpace = Number(BigInt(SLSGetActiveSpace(connection))) || 0;
    if (activeSpace) {
      SLSSpaceAddWindowsAndRemoveFromSpaces(connection, activeSpace, makeNSNumberArray(windowNumber), 7);
    }
    // 3. Drop the native level applyStationaryCollectionBehavior raised to
    //    CGAssistiveTechHighWindowLevel (Electron's setAlwaysOnTop can't undo it).
    msgVoidLong(nsWindow, selSetLevel, level);
    return true;
  } catch (err) {
    if (!warnedSkyLightFailure) {
      console.warn("Clawd: failed to de-delegate window from stationary SkyLight space:", err.message);
      warnedSkyLightFailure = true;
    }
    return false;
  }
}

module.exports = {
  applyStationaryCollectionBehavior,
  deDelegateWindowFromStationarySpace,
};
