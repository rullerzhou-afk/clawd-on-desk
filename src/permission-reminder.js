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
  detectIrreversibleMatches,
  shouldScanIrreversibleCommand,
  SCAN_MAX,
  SCAN_TRUNCATED,
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
// not a guess: it is the same text a shell would have received. A malformed
// element inside an inspected argv is a scan error; a present unsupported
// top-level shape is also a scan error and cannot fall through to a lower-
// priority command field.
const COMMAND_KEYS = ["command", "CommandLine", "Command", "cmd", "script"];

// Historical stress-test width retained as an exported compatibility constant.
// It is no longer an element cap: SCAN_MAX characters are the inspection budget,
// and joinArgvBounded() stops walking as soon as that budget is full.
const ARGV_MAX = 256;

// Reading an option out of a command line means reading ARGV, not text. The
// shell removes quoting before the program ever sees its arguments, so the same
// four characters are an option in one spelling and data in another:
//
//   rm -rf src '--' --dry-run          -- ends rm's options; --dry-run is a FILE
//   psql -c "DROP TABLE t; --dry-run"  the flag is inside a SQL string
//   npm publish "--dry-run"            quoted, and still the option npm acts on
//   kubectl delete p --dry-run="client"   quoted VALUE, still client-side
//
// A regex over the raw segment gets all four wrong, in both directions: it
// excuses the first two (fail-open on a real delete and a real DROP) and holds
// the last two (an over-block on ordinary shell, which is how a reminder trains
// people to click through). So the exceptions read tokens.
//
// This is deliberately NOT a shell. It expands nothing -- no variables, no
// globs, no substitution -- because an exception may only be granted on text
// that is already plainly what it looks like. An unterminated quote keeps the
// rest as one token, which is the quiet direction: it can only make a flag
// stop being recognized, never make one appear.
function shellTokens(segment) {
  const tokens = [];
  let cur = "";
  let started = false;
  // Two questions, and the second is what tells a FLAG from DATA:
  //   bare     — nothing quoted or escaped contributed anywhere in this token
  //   bareHead — the token's FIRST character was written bare
  // `psql -c '--dry-run' -c 'DROP TABLE t'` runs the DROP: `-c` takes the quoted
  // word as SQL, so it is not a flag at all — its head is quoted. Meanwhile
  // `kubectl delete pod api --dry-run="client"` IS the flag: the name is bare and
  // only the value is quoted. Only the head separates those two.
  let bare = true;
  let bareHead = null;
  let quote = null;

  function pushCurrent() {
    if (!started) return;
    tokens.push({ value: cur, bare, bareHead: bareHead !== false });
    cur = "";
    started = false;
    bare = true;
    bareHead = null;
  }

  function resetCurrent() {
    cur = "";
    started = false;
    bare = true;
    bareHead = null;
  }

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      // Inside double quotes a backslash escapes only $ ` " \\ and a newline.
      // Before anything else it is a literal backslash, so `"\\--"` is the two
      // characters \\-- and NOT the end-of-options marker: consuming it here
      // manufactured a `--` the shell never passes.
      if (quote === '"' && ch === "\\" && i + 1 < segment.length && '$`"\\\n'.includes(segment[i + 1])) {
        if (bareHead === null) bareHead = false;
        cur += segment[++i]; started = true; bare = false; continue;
      }
      if (ch === quote) { quote = null; bare = false; continue; }
      if (bareHead === null) bareHead = false;
      cur += ch; started = true; bare = false; continue;
    }
    if (ch === "\\" && i + 1 < segment.length) { if (bareHead === null) bareHead = false; cur += segment[++i]; started = true; bare = false; continue; }
    if (ch === '"' || ch === "'") { if (bareHead === null) bareHead = false; quote = ch; started = true; bare = false; continue; }
    // Bash's default IFS is space, tab and newline. A carriage return is NOT a
    // word separator -- it stays inside the word -- so /\s/ split words the
    // shell would have kept together.
    if (ch === " " || ch === "\t" || ch === "\n") { pushCurrent(); continue; }
    // Redirection syntax is not an argv word. Split it even when it is attached
    // (`dist>out`, `2>/dev/null`, `&>>log`) so exception code can remove the
    // operator and its target without mistaking either for a flag or rm operand.
    // Quoted/escaped angle brackets reach neither branch and stay ordinary data.
    if (ch === ">" || ch === "<") {
      let prefix = "";
      if (started && bare && /^\d+$/.test(cur)) {
        prefix = cur;
        resetCurrent();
      } else if (started && bare && cur.endsWith("&")) {
        const word = cur.slice(0, -1);
        if (word) {
          cur = word;
          started = true;
          pushCurrent();
        } else {
          resetCurrent();
        }
        prefix = "&";
      } else {
        pushCurrent();
      }

      let op = ch;
      if (ch === ">" && segment[i + 1] === ">") { op = ">>"; i++; }
      else if (ch === ">" && segment[i + 1] === "|") { op = ">|"; i++; }
      else if (ch === ">" && segment[i + 1] === "&") { op = ">&"; i++; }
      else if (ch === "<" && segment[i + 1] === "<") {
        op = segment[i + 2] === "<" ? "<<<" : "<<";
        i += op.length - 1;
      } else if (ch === "<" && segment[i + 1] === "&") { op = "<&"; i++; }
      else if (ch === "<" && segment[i + 1] === ">") { op = "<>"; i++; }
      tokens.push({ value: prefix + op, bare: true, bareHead: true, redirection: true });
      continue;
    }
    if (bareHead === null) bareHead = true;
    cur += ch; started = true;
  }
  pushCurrent();
  return tokens;
}

// The options THIS command will act on: everything before a bare `--`, which
// ends option parsing. After it, a word that looks like a flag is an operand or
// an argument list bound for another program -- `npm publish -- --dry-run`
// publishes for real.
// A redirection operator is followed by a FILE NAME, not by an option:
// `rm -rf ./d > "--dry-run"` writes to a file called --dry-run and deletes for
// real. Reading tokens is what made this reachable -- the old regex could not
// see the quoted spelling at all -- so the operand is dropped here.
const REDIRECTION_OP = /^\d*(?:>>?|>\||<<<|<<?|>&|<&|&>>?|<>)$/;

// Two different things are being read here, and they read quoting OPPOSITELY.
// A redirection operator is SYNTAX: quoting or escaping it removes it, so
// `npm publish ">" --dry-run` passes a literal `>` as an argument and the
// --dry-run after it is still the option npm acts on. `--` is an ARGUMENT the
// program itself interprets, so `rm -rf src '--' --dry-run` still ends options.
// Hence: the terminator is matched on the VALUE, the operator only when BARE.
function commandTokens(segment) {
  const tokens = shellTokens(segment);
  // Redirection operands come off FIRST: in `npm publish > -- --dry-run` the
  // `--` is the redirection's FILE NAME, and searching for the terminator before
  // removing it truncated the command at a filename and lost the real flag.
  const afterRedirection = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].redirection || (tokens[i].bare && REDIRECTION_OP.test(tokens[i].value))) {
      if (
        i + 1 >= tokens.length
        || tokens[i + 1].redirection
        || (tokens[i + 1].bare && REDIRECTION_OP.test(tokens[i + 1].value))
      ) return null;
      i++;
      continue;
    }
    afterRedirection.push(tokens[i]);
  }
  return afterRedirection;
}

function optionTokens(segment) {
  const afterRedirection = commandTokens(segment);
  if (!afterRedirection) return null;
  const end = afterRedirection.findIndex((t) => t.value === "--");
  const scoped = end === -1 ? afterRedirection : afterRedirection.slice(0, end);
  // 🟥 The head test is applied in ONE direction only, and the direction is the
  // whole point. A quoted head means the word may be DATA handed to a preceding
  // option, so it must not GRANT an exception — that is fail-closed. But it can
  // still be a real flag (`git push --force-with-lease "--force"` really does
  // force), so a word that CANCELS an exception has to be read whether or not
  // its head is bare. Filtering both lists the same way excused a real
  // force-push, which is the failure this asymmetry exists to prevent.
  return {
    tokens: scoped,
    afterTerminator: end === -1 ? [] : afterRedirection.slice(end + 1),
    granting: scoped.filter((t) => t.bareHead).map((t) => t.value),
    all: scoped.map((t) => t.value),
  };
}

const OPTION_SPECS = Object.freeze({
  npmPublish: Object.freeze({
    longBoolean: new Set(["--dry-run", "--help", "--json", "--provenance", "--ignore-scripts", "--foreground-scripts", "--workspaces", "--include-workspace-root"]),
    longValue: new Set(["--otp", "--tag", "--workspace", "--registry", "--access", "--userconfig", "--loglevel", "--cache", "--provenance-file"]),
    shortBoolean: new Set([]),
    shortValue: new Set(["w"]),
  }),
  cargoPublish: Object.freeze({
    longBoolean: new Set(["--dry-run", "--help", "--allow-dirty", "--no-verify", "--locked", "--offline", "--frozen"]),
    longValue: new Set(["--token", "--registry", "--index", "--target", "--manifest-path", "--package", "--jobs", "--features", "--config"]),
    shortBoolean: new Set(["q", "v"]),
    shortValue: new Set(["p", "j", "F"]),
  }),
  kubectlDelete: Object.freeze({
    longBoolean: new Set(["--dry-run", "--help", "--all", "--force", "--ignore-not-found", "--now", "--wait"]),
    longValue: new Set(["--filename", "--namespace", "--selector", "--field-selector", "--output", "--grace-period", "--timeout", "--cascade", "--context", "--cluster", "--user", "--request-timeout", "--raw"]),
    shortBoolean: new Set([]),
    shortValue: new Set(["f", "n", "l", "o"]),
  }),
  gitPush: Object.freeze({
    longBoolean: new Set(["--dry-run", "--help", "--force", "--force-with-lease", "--force-if-includes", "--delete", "--atomic", "--follow-tags", "--mirror", "--all", "--tags", "--prune", "--porcelain", "--quiet", "--verbose", "--set-upstream", "--no-verify", "--signed", "--ipv4", "--ipv6", "--progress"]),
    longValue: new Set(["--repo", "--exec", "--receive-pack", "--push-option", "--recurse-submodules"]),
    shortBoolean: new Set(["f", "u", "n", "q", "v", "4", "6"]),
    shortValue: new Set(["o"]),
  }),
  terraformDestroy: Object.freeze({
    longBoolean: new Set(["--help"]),
    longValue: new Set([]),
    shortBoolean: new Set([]),
    shortValue: new Set([]),
  }),
});

// Parse only enough of one reviewed command's option grammar to PROVE an
// exception. Unknown option spellings fail closed for the exception. A quoted
// option name can still consume a following value (the program receives the
// same argv), but it never grants a safety exception itself.
function reviewedInvocation(segment, commands, subcommand, spec) {
  const options = optionTokens(segment);
  if (!options) return null;
  const tokens = options.tokens;
  if (tokens.length < 2 || !commands.has(tokens[0].value) || tokens[1].value !== subcommand) return null;

  const flags = [];
  let ambiguous = false;
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    const value = token.value;
    if (!value || value === "-") continue;
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      const name = eq === -1 ? value : value.slice(0, eq);
      if (spec.longValue.has(name)) {
        if (eq === -1) {
          if (i + 1 >= tokens.length) ambiguous = true;
          else i++;
        }
        continue;
      }
      if (spec.longBoolean.has(name)) {
        flags.push({ value, bareHead: token.bareHead });
        continue;
      }
      ambiguous = true;
      continue;
    }
    if (value.startsWith("-") && value.length > 1) {
      const cluster = value.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const name = cluster[j];
        if (spec.shortValue.has(name)) {
          if (j === cluster.length - 1) {
            if (i + 1 >= tokens.length) ambiguous = true;
            else i++;
          }
          break;
        }
        if (!spec.shortBoolean.has(name)) ambiguous = true;
        flags.push({ value: `-${name}`, bareHead: token.bareHead });
      }
    }
  }
  return { ambiguous, flags, optionValues: options.all };
}

// Once a command-specific parser has proved that a token is this invocation's
// dry-run flag, its VALUE decides whether the invocation performs nothing.
// Only some values mean "perform nothing": kubectl's `--dry-run=none` spells
// say "actually do it", and `--dry-run=false` / `--dry-run=0` read the same way.
// Accepting any value after `=` turned the most explicit way to say "execute
// this" into the exception that waved it through.
//
// So values are allow-listed and EVERY dry-run token has to clear it: an
// unrecognized value is not assumed harmless, and `--dry-run=client
// --dry-run=none` is not excused by the first one.
const DRY_RUN_TOKEN = /^--dry-?run(=(.*))?$/;
// `true` is npm's spelling of the same flag -- dry-run is a boolean config, and
// `npm publish --dry-run=true` performs nothing. `client`/`server` are kubectl's.
// Deliberately NOT here: `1`, `yes`, `on`. They may well be accepted by some
// parser, but an exception is only granted on a value we can name, and an
// unnamed value failing closed costs a human glance rather than a deletion.
const DRY_RUN_NONEXECUTING = new Set(["true", "client", "server"]);

function dryRunPerformsNothing(tokens, allowBare) {
  let seen = false;
  for (const token of tokens) {
    const match = DRY_RUN_TOKEN.exec(token);
    if (!match) continue;
    seen = true;
    if (match[1] === undefined) {
      if (allowBare === false) return false;
      continue;
    }
    if (!DRY_RUN_NONEXECUTING.has(String(match[2]).toLowerCase())) return false;
  }
  return seen;
}

// Asking a reviewed destructive invocation to describe itself performs nothing
// either. Deliberately long-form only: `-h` is the HOST flag for psql and mysql,
// so a future command-specific parser must not generalize it to every command.
function helpOnly(tokens) {
  return tokens.includes("--help");
}

// `--force-with-lease` refuses to overwrite remote commits the pusher has not
// observed, which is exactly the accidental loss this reminder exists to catch.
// A segment that also carries a bare --force/-f is NOT excused.
// Same reading, same reason: a quoted `"--force"` is still the flag git acts on,
// and a matcher that needs whitespace in front of it excuses a real force-push.
function hasForceWithLease(tokens) {
  return tokens.some((t) => /^--force-with-lease(=.*)?$/.test(t));
}
function hasPlainForce(tokens) {
  return tokens.some((t) => (
    t === "--force"
    || t === "-f"
    || /^-[A-Za-z0-9]*f[A-Za-z0-9]*$/.test(t)
  ));
}

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

// Join argv into the same text `parts.join(" ")` would produce, but without
// ever materializing or traversing more of it than the character scan will use.
//
// #1021 review (4): `parts.join(" ")` followed by boundCommandString() was
// bounded on the WRONG side -- ARGV_MAX (above) caps element COUNT, not
// total bytes, so a 256-element array of megabyte-sized strings joined a
// multi-hundred-MB string before the SCAN_MAX cut ever ran, and a large
// enough one throws `RangeError: Invalid string length` out of Array.join
// itself (measured: 256 x 1MB elements = a real ~256MB allocation and
// ~30ms; 256 x 4MB elements throws). evaluatePermissionReminder's own
// try/catch still catches that throw and degrades to SCAN_ERROR_TAG (holds
// for a human, the documented fail-closed direction), so this was never a
// bypass -- but the module doc comment's claim that "the reminder's memory
// and time cost are fixed no matter how large the accepted request was" was
// false for the argv shape, and the unbounded work ran on every such
// request whether or not the scan ultimately threw.
//
// This builds the result incrementally and stops as soon as it has SCAN_MAX
// characters, so no single element and no element count can make work exceed
// that budget. It returns byte-for-byte the same string
// `parts.join(" ").slice(0, max)` would for every input (verified by test:
// the two are compared directly for a battery of small inputs), so this is
// a performance fix, not a behavior change.
function joinArgvBoundedResult(parts, max) {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      if (out.length >= max) return { text: out.slice(0, max), truncated: true };
      out += " ";
      if (out.length >= max) {
        const exactEmptyTail = i === parts.length - 1
          && typeof parts[i] === "string"
          && parts[i].length === 0;
        return { text: out.slice(0, max), truncated: !exactEmptyTail };
      }
    }
    const room = max - out.length;
    const part = parts[i];
    if (typeof part !== "string") {
      throw new TypeError("command argv contains a non-string element");
    }
    if (part.length > room) {
      return { text: out + part.slice(0, room), truncated: true };
    }
    out += part;
    if (out.length >= max && i < parts.length - 1) {
      return { text: out.slice(0, max), truncated: true };
    }
  }
  return { text: out.length > max ? out.slice(0, max) : out, truncated: out.length > max };
}

function joinArgvBounded(parts, max) {
  return joinArgvBoundedResult(parts, max).text;
}

/**
 * Build the bounded scan input from the raw (pre-truncation) tool input.
 *
 * Returns an object carrying at most one command field, capped at SCAN_MAX
 * characters -- so the reminder's memory and time cost are fixed no matter how
 * large the accepted request was. A non-enumerable marker records whether the
 * chosen field was cut by that budget. Tools that carry no command field get
 * `{}`, which is still meaningful: the matcher recognizes explicit delete tools
 * by name alone. A present unreadable field throws so enforcement fails closed.
 */
function commandTextFrom(value) {
  if (typeof value === "string") {
    return { text: boundCommandString(value), truncated: value.length > SCAN_MAX };
  }
  if (Array.isArray(value)) {
    // Arrays are the supported argv shape, so every element reached inside the
    // character budget must be a string -- including the first one.
    return joinArgvBoundedResult(value, SCAN_MAX);
  }
  return null;
}

function buildReminderScanInput(rawInput) {
  if (!rawInput || typeof rawInput !== "object") return {};
  for (const key of COMMAND_KEYS) {
    const value = rawInput[key];
    if (value === undefined) continue;
    const result = commandTextFrom(value);
    // A present but unsupported higher-priority field is not permission to scan
    // a different field and pretend it described the accepted invocation.
    if (!result) throw new TypeError(`unsupported command field: ${key}`);
    if (!result.text.trim()) continue;
    const scanInput = { [key]: result.text };
    if (result.truncated) {
      Object.defineProperty(scanInput, SCAN_TRUNCATED, { value: true });
    }
    return scanInput;
  }
  return {};
}

const RM_SHORT_OPTIONS = new Set(["d", "f", "i", "I", "r", "R", "v"]);
const RM_LONG_OPTIONS = new Set([
  "--dir",
  "--force",
  "--help",
  "--interactive",
  "--no-preserve-root",
  "--one-file-system",
  "--preserve-root",
  "--recursive",
  "--verbose",
  "--version",
]);

// Read rm operands from the same quote/redirection-aware token stream used by
// the option exceptions. Unknown rm options fail closed because they may consume
// an argument; after `--`, flag-looking words are targets and must be checked.
function rmOperands(segment) {
  const tokens = commandTokens(segment);
  if (!tokens || !tokens.length || tokens[0].value !== "rm") return null;
  const operands = [];
  let optionsActive = true;
  for (let i = 1; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (optionsActive && value === "--") {
      optionsActive = false;
      continue;
    }
    if (optionsActive && value.startsWith("--")) {
      const eq = value.indexOf("=");
      const name = eq === -1 ? value : value.slice(0, eq);
      if (!RM_LONG_OPTIONS.has(name)) return null;
      continue;
    }
    if (optionsActive && /^-[^-]/.test(value)) {
      const names = value.slice(1);
      if (![...names].every((name) => RM_SHORT_OPTIONS.has(name))) return null;
      continue;
    }
    if (value) operands.push(value);
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
  const operands = rmOperands(segment);
  if (!operands || operands.length === 0) return false;
  return operands.every(isDisposablePath);
}

function grantingFlags(invocation) {
  if (!invocation || invocation.ambiguous) return [];
  return invocation.flags.filter((flag) => flag.bareHead).map((flag) => flag.value);
}

function dryRunInvocation(match, segment) {
  if (match.tag === "publish") {
    const npmFamily = reviewedInvocation(
      segment,
      new Set(["npm", "pnpm", "yarn"]),
      "publish",
      OPTION_SPECS.npmPublish
    );
    if (npmFamily) return npmFamily;
    return reviewedInvocation(segment, new Set(["cargo"]), "publish", OPTION_SPECS.cargoPublish);
  }
  if (match.tag === "infra-destroy") {
    return reviewedInvocation(segment, new Set(["kubectl"]), "delete", OPTION_SPECS.kubectlDelete);
  }
  if (match.tag === "force-push") {
    return reviewedInvocation(segment, new Set(["git"]), "push", OPTION_SPECS.gitPush);
  }
  return null;
}

function helpInvocation(match, segment) {
  if (match.tag === "publish") {
    const npmFamily = reviewedInvocation(
      segment,
      new Set(["npm", "pnpm", "yarn"]),
      "publish",
      OPTION_SPECS.npmPublish
    );
    if (npmFamily) return npmFamily;
    return reviewedInvocation(segment, new Set(["cargo"]), "publish", OPTION_SPECS.cargoPublish);
  }
  if (match.tag === "infra-destroy") {
    const kubectl = reviewedInvocation(
      segment,
      new Set(["kubectl"]),
      "delete",
      OPTION_SPECS.kubectlDelete
    );
    if (kubectl) return kubectl;
    return reviewedInvocation(
      segment,
      new Set(["terraform"]),
      "destroy",
      OPTION_SPECS.terraformDestroy
    );
  }
  if (match.tag === "force-push") {
    return reviewedInvocation(segment, new Set(["git"]), "push", OPTION_SPECS.gitPush);
  }
  return null;
}

/**
 * Named policy exception for a real pattern match, or null when the match
 * should be held.
 */
function documentedException(match) {
  const segment = match && typeof match.segment === "string" ? match.segment : "";
  if (!segment) return null;
  const dryRun = dryRunInvocation(match, segment);
  // npm/cargo/git document a bare boolean dry-run. kubectl's flag has an
  // explicit none/client/server value space, so only the known non-executing
  // client/server spellings earn an exception.
  if (dryRunPerformsNothing(grantingFlags(dryRun), match.tag !== "infra-destroy")) return "dry-run";
  const help = helpInvocation(match, segment);
  if (helpOnly(grantingFlags(help))) return "help";
  if (match.tag === "force-push") {
    const gitPush = reviewedInvocation(segment, new Set(["git"]), "push", OPTION_SPECS.gitPush);
    const granting = grantingFlags(gitPush);
    const optionValues = gitPush ? gitPush.flags.map((flag) => flag.value) : [];
    if (
      gitPush
      && !gitPush.ambiguous
      && hasForceWithLease(granting)
      && !hasPlainForce(optionValues)
    ) return "force-with-lease";
  }
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
 * @returns {{hold: false, tag: string, exception: string}} every real match in
 *          the request is excused by a documented exception -- reported with the
 *          first one. Kept distinct from `null` so the choice is reviewable in
 *          tests and in the log rather than indistinguishable from never having
 *          matched. One excused decision never speaks for a later unexcused one:
 *          a single unexcused match anywhere in the request holds all of it.
 */
function evaluatePermissionReminder(toolName, rawInput) {
  try {
    const scanInput = shouldScanIrreversibleCommand(toolName)
      ? buildReminderScanInput(rawInput)
      : {};
    const matches = detectIrreversibleMatches(toolName, scanInput);
    if (!matches.length) return null;
    let firstExcused = null;
    for (const match of matches) {
      // A match this function cannot read is not a match it may skip: skipping
      // is the fail-open direction, and the whole point of the loop is that one
      // excused decision must not speak for the rest of the request.
      if (!match || typeof match.tag !== "string" || !match.tag) {
        return { hold: true, tag: SCAN_ERROR_TAG };
      }
      const exception = documentedException(match);
      if (!exception) return { hold: true, tag: match.tag };
      if (!firstExcused) firstExcused = { hold: false, tag: match.tag, exception };
    }
    return firstExcused;
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
 * #1021 review (5): this module has no ctx and so cannot read the
 * destructiveActionReminder SETTING at all -- it runs this scan and stamps a
 * verdict on EVERY accepted request, whether or not the setting is on. "When
 * it is off, nothing reads it" (the feature's original commit message)
 * describes the observable decision/UI, not this function: the setting only
 * gates whether permission.js's permissionReminderHolds() honors a matched
 * stamp, at the entry's first automation evaluation (see that function's own
 * comment for the accept-time snapshot this implies). A caller that wants
 * "the setting off means the scan itself never runs" needs a different gate
 * than this one -- this one is eager by construction, unconditionally.
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
  joinArgvBounded,
};
