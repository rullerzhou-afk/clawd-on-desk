"use strict";

// Destructive-action reminder (opt-in, off by default).
//
// This module answers one question: for a request that permission automation
// would otherwise allow by itself, should Clawd stop and put the card in front
// of a human? It never decides Allow or Deny, and it never turns an existing
// ask/deny into an allow -- the only thing it can do is downgrade an automatic
// allow to the normal human decision.
//
// Three deliberate differences from the display-only hint in bubble-format.js,
// which shares this module's pattern list rather than duplicating it:
//
//   1. It reads the request BEFORE display-preview truncation. `entry.toolInput`
//      has been through truncateDeep(), so every string longer than PREVIEW_MAX
//      is already cut; a command whose destructive part sits past that point
//      would be invisible to a matcher reading the entry. The scan input is
//      built from the raw accepted input instead, bounded to SCAN_MAX characters
//      of a single command field.
//   2. A scan that cannot complete ends at the human. The hint swallows a
//      surprise and shows no badge, which is right for decoration; for a
//      reminder the quiet direction would be an automatic allow, so any throw
//      becomes a hold with the `scan-error` reason.
//   3. It carves out deliberate policy exceptions -- a dry run, a lease-guarded
//      force-push, deleting a disposable build directory. These are *matches we
//      choose not to hold*, which is a different thing from text that never
//      matched at all (`grep force`, a commit message). The return value keeps
//      the two apart so the reason can be reviewed rather than guessed at.
const {
  detectIrreversibleStrict,
  SCAN_MAX,
} = require("./bubble-format");

// Reason shown when the scan itself failed. Distinct from every pattern tag so
// a user who sees it can tell "Clawd could not read this" from "Clawd
// recognized a force-push".
const SCAN_ERROR_TAG = "scan-error";

// Reason used when no view was derived for an accepted request at all. It should
// be unreachable -- every entry-creation path derives one -- and it exists so
// that a path added later fails toward the human instead of quietly becoming a
// path the reminder does not cover.
const NOT_INSPECTED_TAG = "not-inspected";

// Supported command shapes: the reminder reads a command out of one of these
// fields, in this order -- the same order and the same field names the display
// hint uses, so the badge and the hold can never disagree about which text was
// examined. Two shapes are supported: a command **string**, and an **array of
// strings** (argv), which is joined with single spaces. Joining is a definition,
// not a guess: it is the same text a shell would have received. Anything else
// (a number, an object, a nested array) is not a command line and yields no
// scan input.
const COMMAND_KEYS = ["command", "CommandLine", "Command", "cmd", "script"];

// Cap the argv join so a long array cannot be walked past the budget.
const ARGV_MAX = 256;

// A dry run performs nothing, whatever it is a dry run of, so this exception is
// not scoped to one pattern. `--dry-run=client` (kubectl) is included.
const DRY_RUN = /(^|\s)--dry-?run(=\S*)?(\s|$)/;

// Asking a destructive command to describe itself performs nothing either.
// Deliberately long-form only: `-h` is the HOST flag for psql and mysql, so
// excusing it would wave through `psql -h db -c 'DROP TABLE users'`.
const HELP_ONLY = /(^|\s)--help(\s|$)/;

// `--force-with-lease` refuses to overwrite remote commits the pusher has not
// observed, which is exactly the accidental loss this reminder exists to catch.
// A segment that also carries a bare --force/-f is NOT excused.
const FORCE_WITH_LEASE = /\s--force-with-lease(=\S*)?(\s|$)/;
const PLAIN_FORCE = /\s--force(?!-with-lease)\b|\s-f\b/;

// Directories whose contents are reproducible by a build or an install. Deleting
// one is routine enough that holding it teaches people to click through.
const DISPOSABLE_BASENAMES = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "temp",
  "tmp",
  "venv",
]);

// A relative path made of plain path characters, nothing else. Absolute paths,
// `..`, globs, variables and command substitution all fail this on purpose: the
// exception has to be obviously safe to read, and anything it cannot read
// plainly stays held.
const PLAIN_RELATIVE_PATH = /^\.?\/?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/;

// `rm -rf dist/*` is the same operation as `rm -rf dist` for this purpose, and it
// is the more common way to write it. Only a trailing `/*` is peeled -- `*/` or a
// glob anywhere else still fails PLAIN_RELATIVE_PATH and stays held.
const TRAILING_CONTENTS_GLOB = /\/\*$/;

function boundCommandString(value) {
  return value.length > SCAN_MAX ? value.slice(0, SCAN_MAX) : value;
}

/**
 * Build the bounded scan input from the raw (pre-truncation) tool input.
 *
 * Returns an object carrying at most one command field, capped at SCAN_MAX
 * characters -- so the reminder's memory and time cost are fixed no matter how
 * large the accepted request was. Tools that carry no command field get `{}`,
 * which is still meaningful: the matcher recognizes explicit delete tools by
 * name alone.
 */
function commandTextFrom(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.slice(0, ARGV_MAX);
    if (!parts.every((part) => typeof part === "string")) return null;
    return parts.join(" ");
  }
  return null;
}

function buildReminderScanInput(rawInput) {
  if (!rawInput || typeof rawInput !== "object") return {};
  for (const key of COMMAND_KEYS) {
    const text = commandTextFrom(rawInput[key]);
    if (typeof text !== "string" || !text.trim()) continue;
    return { [key]: boundCommandString(text) };
  }
  return {};
}

// Split a matched segment into operands: drop the command word and any flags,
// and unwrap a simply-quoted argument. Deliberately not a shell parser -- a
// segment this cannot read plainly yields no operands, and no operands means no
// exception.
function operandsOf(segment) {
  const parts = segment.trim().split(/\s+/).slice(1);
  const operands = [];
  for (const part of parts) {
    if (!part || part.startsWith("-")) continue;
    const unquoted = /^(['"])(.*)\1$/.test(part) ? part.slice(1, -1) : part;
    if (!unquoted) continue;
    operands.push(unquoted);
  }
  return operands;
}

function isDisposablePath(rawOperand) {
  const operand = rawOperand.replace(TRAILING_CONTENTS_GLOB, "");
  if (!operand) return false;
  if (operand.startsWith("/") || operand.startsWith("~")) return false;
  if (!PLAIN_RELATIVE_PATH.test(operand)) return false;
  const trimmed = operand.replace(/\/+$/, "");
  const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!basename || basename === "." || basename === "..") return false;
  if (trimmed.split("/").some((part) => part === "..")) return false;
  return DISPOSABLE_BASENAMES.has(basename);
}

// Every operand must be disposable. `rm -rf dist src` is held, because one
// unrecoverable target is enough.
function deletesOnlyDisposablePaths(segment) {
  const operands = operandsOf(segment);
  if (operands.length === 0) return false;
  return operands.every(isDisposablePath);
}

/**
 * Named policy exception for a real pattern match, or null when the match
 * should be held.
 */
function documentedException(match) {
  const segment = match && typeof match.segment === "string" ? match.segment : "";
  if (!segment) return null;
  if (DRY_RUN.test(segment)) return "dry-run";
  if (HELP_ONLY.test(segment)) return "help";
  if (
    match.tag === "force-push"
    && FORCE_WITH_LEASE.test(segment)
    && !PLAIN_FORCE.test(segment)
  ) return "force-with-lease";
  if (match.tag === "file-delete" && deletesOnlyDisposablePaths(segment)) {
    return "disposable-path";
  }
  return null;
}

/**
 * Evaluate the reminder for one accepted request.
 *
 * @returns {null} the request matched no pattern -- the common case, and the
 *          only one described to the user as "unmatched". Never described as
 *          having passed a review: nothing reviewed it.
 * @returns {{hold: true, tag: string}} hold this request for a human.
 * @returns {{hold: false, tag: string, exception: string}} a real match that a
 *          documented exception excuses. Kept distinct from `null` so the choice
 *          is reviewable in tests and in the log rather than indistinguishable
 *          from never having matched.
 */
function evaluatePermissionReminder(toolName, rawInput) {
  try {
    const match = detectIrreversibleStrict(toolName, buildReminderScanInput(rawInput));
    if (!match || typeof match.tag !== "string" || !match.tag) return null;
    const exception = documentedException(match);
    if (exception) return { hold: false, tag: match.tag, exception };
    return { hold: true, tag: match.tag };
  } catch (_e) {
    return { hold: true, tag: SCAN_ERROR_TAG };
  }
}

/** True only for a stamped evaluation that asks for a human. */
function reminderHolds(evaluation) {
  return !!(evaluation && evaluation.hold === true && typeof evaluation.tag === "string" && evaluation.tag);
}

/**
 * Route-facing sibling of preparePermissionDetail(): both derive a bounded view
 * of the accepted raw input at the trust boundary, and both are spread into the
 * pending entry. Kept as two calls rather than one so a display-text builder
 * never carries a gate concern -- and so the two calls appearing in equal
 * numbers is a checkable property of the route (see the reminder route test).
 *
 * @returns {{permissionReminder: object|null}} entry fields.
 */
function preparePermissionReminder(toolName, rawInput) {
  return { permissionReminder: evaluatePermissionReminder(toolName, rawInput) };
}

module.exports = {
  SCAN_ERROR_TAG,
  NOT_INSPECTED_TAG,
  preparePermissionReminder,
  SCAN_MAX,
  COMMAND_KEYS,
  ARGV_MAX,
  DISPOSABLE_BASENAMES,
  buildReminderScanInput,
  documentedException,
  evaluatePermissionReminder,
  reminderHolds,
};
