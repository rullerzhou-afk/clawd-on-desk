"use strict";

(function (root) {
  function truncate(s, max) {
    // Callers pass tool-input fields that are *usually* strings but can be any
    // JSON type when an agent (or a third-party integration) mis-shapes them.
    // Coerce so a numeric/object field can never crash the bubble renderer.
    if (typeof s !== "string") s = String(s == null ? "" : s);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  function firstStringValue(input, names) {
    for (const name of names) {
      const value = input[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function formatAntigravityDetail(name, input) {
    const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!toolName) return "";

    if (toolName === "run_command" || toolName === "bash" || toolName === "shell") {
      return truncate(firstStringValue(input, ["CommandLine", "command", "Command", "cmd"]), 160);
    }
    if (
      toolName === "write_to_file" ||
      toolName === "replace_file_content" ||
      toolName === "multi_replace_file_content" ||
      toolName === "write" ||
      toolName === "edit" ||
      toolName === "multiedit"
    ) {
      const filePath = firstStringValue(input, ["TargetFile", "AbsolutePath", "file_path", "path", "filePath", "FilePath"]);
      const description = firstStringValue(input, ["Description", "Instruction"]);
      return truncate(description && filePath ? `${filePath}: ${description}` : (filePath || description), 160);
    }
    if (toolName === "view_file" || toolName === "read") {
      return truncate(firstStringValue(input, ["AbsolutePath", "file_path", "path", "filePath", "FilePath"]), 160);
    }
    if (toolName === "list_dir") {
      return truncate(firstStringValue(input, ["DirectoryPath", "path", "directory"]), 160);
    }
    if (toolName === "find_by_name") {
      const searchPath = firstStringValue(input, ["SearchDirectory", "DirectoryPath", "path"]);
      const pattern = firstStringValue(input, ["Pattern", "pattern"]);
      return truncate(pattern && searchPath ? `${searchPath}: ${pattern}` : (searchPath || pattern), 160);
    }
    if (toolName === "grep_search") {
      const searchPath = firstStringValue(input, ["SearchPath", "SearchDirectory", "DirectoryPath", "path"]);
      const query = firstStringValue(input, ["Query", "query"]);
      return truncate(query && searchPath ? `${searchPath}: ${query}` : (searchPath || query), 160);
    }
    if (toolName === "ask_permission") {
      const target = firstStringValue(input, ["Target", "target", "Permission", "permission"]);
      const reason = firstStringValue(input, ["Reason", "reason", "Description", "description"]);
      return truncate(reason && target ? `${target}: ${reason}` : (target || reason), 160);
    }
    if (toolName === "read_url_content") {
      return truncate(firstStringValue(input, ["Url", "url"]), 160);
    }
    if (toolName === "search_web") {
      return truncate(firstStringValue(input, ["query", "Query"]), 160);
    }
    return "";
  }

  function formatDetail(name, input, options) {
    if (!input || typeof input !== "object") return "";
    if (typeof input.description === "string" && input.description.trim()) return truncate(input.description.trim(), 120);
    if (name === "Bash" && typeof input.command === "string") return truncate(input.command, 120);
    if ((name === "Edit" || name === "Write" || name === "Read") && typeof input.file_path === "string")
      return truncate(input.file_path, 120);
    if ((name === "Glob" || name === "Grep") && typeof input.pattern === "string")
      return truncate(input.pattern, 120);
    if (options && options.isAntigravity) {
      const antigravityDetail = formatAntigravityDetail(name, input);
      if (antigravityDetail) return antigravityDetail;
    }
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.trim()) return truncate(v.trim(), 100);
    }
    return truncate(JSON.stringify(input), 100);
  }

  // Issue #445: MCP tool names arrive as opaque, scary-looking identifiers
  // (e.g. "MCP__CODEX_APPS__VERCEL__LIST_PROJECTS"). Parse them into a friendly
  // "server · tool" label for display ONLY. Naming differs across agents —
  // Codex uses upper-case 4-segment names, Claude Code uses lower-case 3-segment
  // ("mcp__github__list_issues") — so we are case-insensitive and key off the
  // last two segments. Returns null for anything that is not MCP-shaped, so the
  // caller falls back to the raw name. This must never throw and must never
  // decide safety/approval behavior.
  // Irreversible-action hint (display-only). Conservative by construction:
  // the command string is split into shell segments (&&, ||, ;, |, newline) and each
  // pattern is anchored at the segment's command position — so quoted arguments
  // (`git commit -m "git push --force"`) and echoed text (`echo npm publish`) can
  // never flag, because they are not the command being run. Precision over recall:
  // a false badge is noise on a minimalist pet, a missed one just means no hint.
  // Like the MCP relabel (#445), this never touches Allow/Deny semantics or the
  // no-decision fallback — it only routes the human's attention to destructive
  // decisions (force-push, publish, bulk delete, history rewrite).
  const IRREVERSIBLE_PATTERNS = [
    { tag: "force-push", re: /^git\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b)/ },
    { tag: "remote-delete", re: /^git\s+push\b[^\n]*\s--delete\b/ },
    { tag: "branch-delete", re: /^git\s+branch\b[^\n]*\s-D\b/ },
    { tag: "history-rewrite", re: /^git\s+(reset\s+--hard|filter-branch|filter-repo)\b/ },
    { tag: "file-delete", re: /^rm\s+-[a-zA-Z]*[rf]/ },
    { tag: "git-clean", re: /^git\s+clean\b[^\n]*\s-[a-zA-Z]*f/ },
    { tag: "publish", re: /^(npm|pnpm|yarn)\s+publish\b|^twine\s+upload\b|^gem\s+push\b|^cargo\s+publish\b/ },
    { tag: "repo-delete", re: /^gh\s+(repo|release)\s+delete\b/ },
    { tag: "go-public", re: /^gh\s+repo\s+(create|edit)\b[^\n]*--(public\b|visibility[= ]public)/ },
    { tag: "infra-destroy", re: /^terraform\s+destroy\b|^kubectl\s+delete\b/ },
  ];
  // SQL destroys are quoted almost by definition (psql -c 'DROP TABLE …'), so they
  // get their own rule: the segment's command must be a database client AND the
  // segment must contain the destructive SQL. `echo 'DROP TABLE'` stays quiet.
  const DB_CLIENTS = /^(psql|mysql|mysqlsh|sqlite3|mongosh|mongo)\b/;
  const DB_DESTROY = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i;
  const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "exec", "run_terminal_cmd"]);
  // Wrappers that prefix a command without changing what it runs.
  const WRAPPER = /^(sudo(\s+-[A-Za-z]+)*|env|nohup|time|command)\s+|^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

  function splitOutsideQuotes(cmd) {
    // Quote-aware split: separators (&&, ||, ;, |, newline) only count OUTSIDE
    // quotes — `git commit -m "docs && git push --force"` must stay ONE segment,
    // or the quoted text becomes a fake command position (false positive). Single
    // linear pass over the (already 4KB-capped) string; an unbalanced quote keeps
    // the rest as quoted = no split = the quiet direction (precision over recall).
    const segs = [];
    let cur = "", quote = null;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote) {
        if (quote === '"' && ch === "\\") { cur += ch + (cmd[i + 1] || ""); i++; continue; }
        if (ch === quote) quote = null;
        cur += ch;
        continue;
      }
      if (ch === "\\") {                    // escaped char outside quotes = literal
        cur += ch + (cmd[i + 1] || ""); i++;  // (`echo docs\; npm publish` must not split)
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && cmd[i + 1] === "&")) {
        if (ch === "&") i++;                    // consume '&&'
        if (cmd[i + 1] === "|" && ch === "|") i++;  // consume '||' second bar
        segs.push(cur); cur = "";
        if (segs.length >= 50) return segs;     // segment cap
        continue;
      }
      cur += ch;
    }
    segs.push(cur);
    return segs;
  }

  function segmentCommands(cmd) {
    const out = [];
    for (let seg of splitOutsideQuotes(cmd)) {
      seg = seg.trim();
      let guard = 0;
      while (WRAPPER.test(seg) && guard++ < 5) seg = seg.replace(WRAPPER, "");
      if (seg) out.push(seg);
    }
    return out;
  }

  function detectIrreversible(name, input) {
    try {
      const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
      const obj = input && typeof input === "object" ? input : {};
      // Shell-ish tools: scan the command string, anchored per segment.
      if (SHELL_TOOLS.has(toolName)) {
        let cmd = firstStringValue(obj, ["command", "CommandLine", "Command", "cmd", "script"]);
        if (!cmd) return null;
        // Cap the scanned prefix: the command string is attacker-influenced (a
        // prompt-injected agent controls it). Hard cap = O(4KB) by construction.
        if (cmd.length > 4096) cmd = cmd.slice(0, 4096);
        for (const seg of segmentCommands(cmd)) {
          for (const p of IRREVERSIBLE_PATTERNS) {
            if (p.re.test(seg)) return { tag: p.tag };
          }
          if (DB_CLIENTS.test(seg) && DB_DESTROY.test(seg)) return { tag: "db-destroy" };
        }
        return null;
      }
      // Explicit destructive file tools only (generic "delete" substrings would
      // over-match MCP tools like delete_draft — stay conservative).
      if (toolName === "delete_file" || toolName === "deletefile" || toolName === "remove_file") {
        return { tag: "file-delete" };
      }
      return null;
    } catch (_e) {
      // Display-only helper on the permission path — a hint must never be able to
      // break the bubble (which blocks tool execution). Any surprise → no hint.
      return null;
    }
  }

  function parseMcpToolName(toolName) {
    if (typeof toolName !== "string" || !toolName) return null;
    const segs = toolName.split("__");
    if (segs.length < 2 || segs[0].toLowerCase() !== "mcp") return null;
    const rest = segs.slice(1);
    // Any empty segment (leading / middle / trailing "__") means a malformed
    // name: fall back to the raw display rather than a misleading partial label
    // (e.g. "MCP__CODEX_APPS__VERCEL__" must NOT render as "codex_apps · vercel").
    if (rest.some((seg) => seg === "")) return null;
    const tool = rest[rest.length - 1].toLowerCase();
    const server = rest.length >= 2 ? rest[rest.length - 2].toLowerCase() : null;
    const display = server ? `${server} · ${tool}` : tool;
    return { server, tool, display };
  }

  const api = { formatDetail, formatAntigravityDetail, truncate, firstStringValue, parseMcpToolName, detectIrreversible };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root && typeof root === "object") {
    root.ClawdBubbleFormat = api;
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
