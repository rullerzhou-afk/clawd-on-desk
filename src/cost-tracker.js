"use strict";

// ── Today's Claude Code spend (cost tracker) ──
//
// Reads Claude Code transcripts under ~/.claude/projects/<encoded-cwd>/*.jsonl,
// sums today's token usage from assistant `message.usage` blocks, and prices it
// into an estimated USD figure. Pure data + filesystem (no Electron) so it stays
// unit-testable; the menu shows the result as a live "Today ~$X.XX" readout.
//
// Estimate only: pricing is a static table (rates drift, and Fable has no public
// per-token rate yet — it inherits the Opus tier). Treat the number as a guide,
// not a billing source of truth. Claude Code only (Codex/others log differently).

const fs = require("fs");
const os = require("os");
const path = require("path");

// USD per 1,000,000 tokens, by model family. Update if Anthropic rates change.
const PRICING = {
  opus:   { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  sonnet: { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6,  cacheRead: 0.3 },
  haiku:  { input: 1,  output: 5,  cacheWrite5m: 1.25,  cacheWrite1h: 2,  cacheRead: 0.1 },
  // Fable 5 has no published per-token price yet → use the flagship (Opus) tier.
  fable:  { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
};
PRICING.default = PRICING.opus;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// Map a model id (e.g. "claude-opus-4-7", "claude-fable-5") to a pricing family.
function modelFamily(model) {
  if (typeof model !== "string") return "default";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "default";
}

// Cost (USD) of a single usage block under the given family's pricing.
function costOfUsage(usage, price) {
  if (!usage || typeof usage !== "object") return 0;
  const cw = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  let write5;
  let write1;
  if (cw) {
    write5 = num(cw.ephemeral_5m_input_tokens);
    write1 = num(cw.ephemeral_1h_input_tokens);
  } else {
    // No tier breakdown → treat all cache-creation as the cheaper 5m tier.
    write5 = num(usage.cache_creation_input_tokens);
    write1 = 0;
  }
  return (
    num(usage.input_tokens) * price.input +
    num(usage.output_tokens) * price.output +
    write5 * price.cacheWrite5m +
    write1 * price.cacheWrite1h +
    num(usage.cache_read_input_tokens) * price.cacheRead
  ) / 1_000_000;
}

function startOfLocalDay(now) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Default transcript root. Override in tests via opts.projectsDir.
function defaultProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

// Compute today's spend by scanning transcripts. Returns a summary object;
// never throws — unreadable files/dirs are skipped. `now` defaults to new Date()
// (injectable for tests). `projectsDir` overridable for tests.
function computeTodayCost(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const projectsDir = opts.projectsDir || defaultProjectsDir();
  const dayStart = startOfLocalDay(now);

  const out = {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messages: 0,
    byModel: {},
    asOf: now.getTime(),
  };

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name));
  } catch {
    return out;
  }

  const seenMessageIds = new Set();

  for (const dir of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      // Cheap skip: a transcript untouched since before today holds no today
      // entries. (Small clock-skew buffer of 1h.)
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < dayStart - 3_600_000) continue;
      } catch {
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line || line.indexOf('"usage"') === -1) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = entry && entry.message;
        const usage = msg && msg.usage;
        if (!usage || typeof usage !== "object") continue;
        // Today-only, by entry timestamp.
        const ts = Date.parse(entry.timestamp);
        if (!Number.isFinite(ts) || ts < dayStart || ts > now.getTime() + 60_000) continue;
        // Dedup: the same assistant message can appear multiple times.
        const id = msg.id;
        if (typeof id === "string" && id) {
          if (seenMessageIds.has(id)) continue;
          seenMessageIds.add(id);
        }
        const family = modelFamily(msg.model);
        const price = PRICING[family] || PRICING.default;
        const cost = costOfUsage(usage, price);
        out.usd += cost;
        out.inputTokens += num(usage.input_tokens);
        out.outputTokens += num(usage.output_tokens);
        out.cacheReadTokens += num(usage.cache_read_input_tokens);
        out.cacheWriteTokens += num(usage.cache_creation_input_tokens);
        out.messages += 1;
        const bm = out.byModel[family] || (out.byModel[family] = { usd: 0, messages: 0 });
        bm.usd += cost;
        bm.messages += 1;
      }
    }
  }

  return out;
}

// "~$1.23" / "~$0.00". Compact, with the ~ to signal it's an estimate.
function formatUsd(usd) {
  const n = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
  return "~$" + n.toFixed(2);
}

module.exports = {
  PRICING,
  modelFamily,
  costOfUsage,
  computeTodayCost,
  formatUsd,
  startOfLocalDay,
  defaultProjectsDir,
};
