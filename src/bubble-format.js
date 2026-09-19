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

  function maybeTruncate(value, max) {
    return Number.isFinite(max) ? truncate(value, max) : String(value == null ? "" : value);
  }

  // Stable reminder tags are machine-facing diagnostics. Keep them on the
  // entry/data attribute for tests and support logs, but never make a user
  // decode `force-push`, `scan-error`, and friends in a localized approval
  // card. Unknown future tags deliberately fall back to a generic localized
  // label instead of leaking the identifier into UI or remote notifications.
  const REMINDER_REASON_LABELS = Object.freeze({
    en: Object.freeze({
      "force-push": "force push",
      "remote-delete": "remote branch deletion",
      "branch-delete": "local branch deletion",
      "history-rewrite": "history rewrite",
      "file-delete": "file deletion",
      "git-clean": "Git worktree cleanup",
      publish: "package publication",
      "repo-delete": "repository or release deletion",
      "go-public": "public visibility change",
      "infra-destroy": "infrastructure deletion",
      "db-destroy": "database or schema deletion",
      "scan-error": "command could not be safely analyzed",
      "not-inspected": "request was not inspected",
      unknown: "destructive action",
    }),
    zh: Object.freeze({
      "force-push": "强制推送",
      "remote-delete": "删除远程分支",
      "branch-delete": "删除本地分支",
      "history-rewrite": "重写历史",
      "file-delete": "删除文件",
      "git-clean": "清理 Git 工作区",
      publish: "发布软件包",
      "repo-delete": "删除仓库或发布版本",
      "go-public": "改为公开可见",
      "infra-destroy": "删除基础设施资源",
      "db-destroy": "删除数据库或架构",
      "scan-error": "无法安全分析命令",
      "not-inspected": "请求未经检查",
      unknown: "破坏性操作",
    }),
    "zh-TW": Object.freeze({
      "force-push": "強制推送",
      "remote-delete": "刪除遠端分支",
      "branch-delete": "刪除本機分支",
      "history-rewrite": "重寫歷史",
      "file-delete": "刪除檔案",
      "git-clean": "清理 Git 工作目錄",
      publish: "發佈套件",
      "repo-delete": "刪除儲存庫或發佈版本",
      "go-public": "改為公開可見",
      "infra-destroy": "刪除基礎設施資源",
      "db-destroy": "刪除資料庫或結構描述",
      "scan-error": "無法安全分析命令",
      "not-inspected": "請求未經檢查",
      unknown: "破壞性操作",
    }),
    ko: Object.freeze({
      "force-push": "강제 푸시",
      "remote-delete": "원격 브랜치 삭제",
      "branch-delete": "로컬 브랜치 삭제",
      "history-rewrite": "기록 다시 쓰기",
      "file-delete": "파일 삭제",
      "git-clean": "Git 작업 트리 정리",
      publish: "패키지 게시",
      "repo-delete": "저장소 또는 릴리스 삭제",
      "go-public": "공개 상태로 변경",
      "infra-destroy": "인프라 리소스 삭제",
      "db-destroy": "데이터베이스 또는 스키마 삭제",
      "scan-error": "명령을 안전하게 분석할 수 없음",
      "not-inspected": "요청이 검사되지 않음",
      unknown: "파괴적 작업",
    }),
    ja: Object.freeze({
      "force-push": "強制プッシュ",
      "remote-delete": "リモートブランチの削除",
      "branch-delete": "ローカルブランチの削除",
      "history-rewrite": "履歴の書き換え",
      "file-delete": "ファイルの削除",
      "git-clean": "Git 作業ツリーのクリーンアップ",
      publish: "パッケージの公開",
      "repo-delete": "リポジトリまたはリリースの削除",
      "go-public": "公開設定への変更",
      "infra-destroy": "インフラリソースの削除",
      "db-destroy": "データベースまたはスキーマの削除",
      "scan-error": "コマンドを安全に解析できませんでした",
      "not-inspected": "リクエストは検査されていません",
      unknown: "破壊的な操作",
    }),
    "pt-BR": Object.freeze({
      "force-push": "push forçado",
      "remote-delete": "exclusão de branch remota",
      "branch-delete": "exclusão de branch local",
      "history-rewrite": "reescrita do histórico",
      "file-delete": "exclusão de arquivos",
      "git-clean": "limpeza da árvore de trabalho do Git",
      publish: "publicação de pacote",
      "repo-delete": "exclusão de repositório ou versão",
      "go-public": "mudança para visibilidade pública",
      "infra-destroy": "exclusão de infraestrutura",
      "db-destroy": "exclusão de banco de dados ou esquema",
      "scan-error": "não foi possível analisar o comando com segurança",
      "not-inspected": "a solicitação não foi inspecionada",
      unknown: "ação destrutiva",
    }),
    es: Object.freeze({
      "force-push": "push forzado",
      "remote-delete": "eliminación de rama remota",
      "branch-delete": "eliminación de rama local",
      "history-rewrite": "reescritura del historial",
      "file-delete": "eliminación de archivos",
      "git-clean": "limpieza del árbol de trabajo de Git",
      publish: "publicación de paquete",
      "repo-delete": "eliminación de repositorio o versión",
      "go-public": "cambio a visibilidad pública",
      "infra-destroy": "eliminación de infraestructura",
      "db-destroy": "eliminación de base de datos o esquema",
      "scan-error": "no se pudo analizar el comando de forma segura",
      "not-inspected": "la solicitud no fue inspeccionada",
      unknown: "acción destructiva",
    }),
  });

  function formatReminderReason(tag, lang) {
    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const dict = typeof lang === "string" && hasOwn(REMINDER_REASON_LABELS, lang)
      ? REMINDER_REASON_LABELS[lang]
      : REMINDER_REASON_LABELS.en;
    return typeof tag === "string" && hasOwn(dict, tag) ? dict[tag] : dict.unknown;
  }

  function formatAntigravityDetail(name, input, options) {
    const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!toolName) return "";
    const max = options && options.mode === "detail" ? Infinity : 160;

    if (toolName === "run_command" || toolName === "bash" || toolName === "shell") {
      return maybeTruncate(firstStringValue(input, ["CommandLine", "command", "Command", "cmd"]), max);
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
      return maybeTruncate(description && filePath ? `${filePath}: ${description}` : (filePath || description), max);
    }
    if (toolName === "view_file" || toolName === "read") {
      return maybeTruncate(firstStringValue(input, ["AbsolutePath", "file_path", "path", "filePath", "FilePath"]), max);
    }
    if (toolName === "list_dir") {
      return maybeTruncate(firstStringValue(input, ["DirectoryPath", "path", "directory"]), max);
    }
    if (toolName === "find_by_name") {
      const searchPath = firstStringValue(input, ["SearchDirectory", "DirectoryPath", "path"]);
      const pattern = firstStringValue(input, ["Pattern", "pattern"]);
      return maybeTruncate(pattern && searchPath ? `${searchPath}: ${pattern}` : (searchPath || pattern), max);
    }
    if (toolName === "grep_search") {
      const searchPath = firstStringValue(input, ["SearchPath", "SearchDirectory", "DirectoryPath", "path"]);
      const query = firstStringValue(input, ["Query", "query"]);
      return maybeTruncate(query && searchPath ? `${searchPath}: ${query}` : (searchPath || query), max);
    }
    if (toolName === "ask_permission") {
      const target = firstStringValue(input, ["Target", "target", "Permission", "permission"]);
      const reason = firstStringValue(input, ["Reason", "reason", "Description", "description"]);
      return maybeTruncate(reason && target ? `${target}: ${reason}` : (target || reason), max);
    }
    if (toolName === "read_url_content") {
      return maybeTruncate(firstStringValue(input, ["Url", "url"]), max);
    }
    if (toolName === "search_web") {
      return maybeTruncate(firstStringValue(input, ["query", "Query"]), max);
    }
    return "";
  }

  function formatDetail(name, input, options) {
    if (!input || typeof input !== "object") return "";
    const detailMode = !!(options && options.mode === "detail");
    const normalizedName = typeof name === "string" ? name.trim().toLowerCase() : "";

    if (detailMode) {
      if (normalizedName === "exitplanmode" && typeof input.plan === "string") return input.plan.trim();
      if (
        (normalizedName === "bash" || normalizedName === "shell" || normalizedName === "run_command")
      ) {
        const command = firstStringValue(input, ["command", "CommandLine", "Command", "cmd"]);
        if (command) return command;
      }
      if (normalizedName === "edit" || normalizedName === "write" || normalizedName === "read") {
        const filePath = firstStringValue(input, ["file_path", "filepath", "path", "AbsolutePath", "TargetFile"]);
        if (filePath) return filePath;
      }
      if (normalizedName === "glob" || normalizedName === "grep") {
        const pattern = firstStringValue(input, ["pattern", "Pattern", "query", "Query"]);
        if (pattern) return pattern;
      }
      if (options && options.isAntigravity) {
        const antigravityDetail = formatAntigravityDetail(name, input, { mode: "detail" });
        if (antigravityDetail) return antigravityDetail;
      }
      if (options && typeof options.formatUnknownDetail === "function") {
        return options.formatUnknownDetail(input);
      }
      try {
        return JSON.stringify(input, null, 2);
      } catch {
        return "";
      }
    }

    if (normalizedName === "exitplanmode" && typeof input.plan === "string") return truncate(input.plan.trim(), 120);
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
  // Every tool name here carries a shell command line. `execute_bash`,
  // `powershell` and `run_shell_command` were missing: they are Claude-compatible
  // tool names that permission automation is willing to allow on its own, so a
  // command sent under one of them was never scanned at all.
  //
  // #1021 review (6): adding `powershell` here means a PowerShell-shaped
  // request is now SCANNED -- it does not mean PowerShell/cmd destructive
  // syntax is RECOGNIZED. IRREVERSIBLE_PATTERNS above is Unix-shaped only
  // (`git`, `rm`, `npm`, `gh`, `terraform`, `kubectl`, …); it has no rule for
  // `Remove-Item -Recurse -Force`, `cmd /c rmdir /s /q`, `del /f`, or any
  // other PowerShell/cmd-native destructive form, so those are silent misses
  // under every tool name here, `powershell` included. Do not read this set
  // as Windows destructive-command coverage -- known-miss fixtures pin the
  // gap in test/permission-destructive-reminder.test.js.
  const SHELL_TOOLS = new Set([
    "bash",
    "exec",
    "execute_bash",
    "powershell",
    "run_command",
    "run_shell_command",
    "run_terminal_cmd",
    "shell",
  ]);
  // Inspection budget, named so a caller can state the same bound instead of
  // repeating the number: at most SCAN_MAX characters of the command string and
  // at most SEGMENT_MAX shell segments are ever examined.
  const SCAN_MAX = 4096;
  const SEGMENT_MAX = 50;
  // The enforcement path bounds raw input before it reaches this shared
  // matcher. Preserve that provenance without adding another enumerable input
  // field, so a quote cut by the budget remains a documented miss rather than
  // being mistaken for malformed syntax inside the inspected request.
  const SCAN_TRUNCATED = Symbol.for("clawd.permission-reminder.scan-truncated");
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
    // True only when the character just appended was an UNQUOTED, UNESCAPED
    // redirection introducer (`<` or `>`). `cur` ending in one is a different
    // question: in `echo \\>& rm -rf x` that '>'
    // is an argument to echo, so the '&' after it really does separate commands.
    let lastWasRedirect = false;
    // Whether the NEXT character starts a shell word. `#` opens a comment only
    // there, and "there" cannot be read off the raw previous character: in
    // `echo foo\\ # & rm -rf x` the space is escaped, so `foo #` is one word and
    // bash really does run the rm; while in `echo safe;# & rm -rf x` there is no
    // space at all and `#` really is a comment. Both are decided by the state
    // machine, not by cmd[i-1].
    let atWordStart = true;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote) {
        if (quote === '"' && ch === "\\") { cur += ch + (cmd[i + 1] || ""); i++; continue; }
        if (ch === quote) quote = null;
        cur += ch;
        continue;
      }
      // A backslash-newline is a LINE CONTINUATION: the shell DELETES it before the
      // command is parsed. Keeping it in `cur` left `echo safe;\\<newline>rm -rf x`
      // with a segment that begins `\\<newline>rm`, which the anchored `^rm`
      // pattern cannot match — the delete the shell actually runs was invisible.
      // Removing it also makes it transparent to word-start and redirection
      // state, which is what the shell does.
      if (ch === "\\" && cmd[i + 1] === "\n") { i++; continue; }
      if (ch === "\\") {                    // escaped char outside quotes = literal
        cur += ch + (cmd[i + 1] || ""); i++;  // (`echo docs\; npm publish` must not split)
        lastWasRedirect = false;
        // An escaped character is part of a word, so what follows it is NOT a word
        // start: `echo \ #; rm -rf ./d` passes ` #` to echo and then runs the rm.
        // (The line-continuation branch above returns before this and stays
        // transparent, which is the one case where the shell removes the pair.)
        atWordStart = false;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; lastWasRedirect = false; atWordStart = false; continue; }
      // An unquoted '#' at the start of a word comments out the rest of the line,
      // so nothing after it is a command position. Without this, splitting on a
      // lone '&' invented one: `echo safe # & rm -rf x` runs only echo, and the
      // matcher reported a file-delete the shell never reaches.
      // KNOWN MISS, and a deliberate one: a heredoc body is DATA, so separators
      // inside it are not command positions and this splitter reports them as if
      // they were. `;` already did that before a lone `&` was added here, so the
      // class is pre-existing and `&` widens it. The direction is a false HOLD —
      // a human glance, not an unreviewed deletion.
      //
      // An attempt to skip heredoc bodies was written and REVERTED: it turned a
      // cheap failure into three expensive ones — a `;` on the opener's own line
      // was swallowed, `<<E'OF'` parsed the delimiter as `E`, and `$((1<<2))`
      // read an arithmetic left-shift as a heredoc opener. Each hid a command the
      // shell runs. Doing this correctly needs real parsing, not a scan, and that
      // is a bigger change than this one should carry.
      if (ch === "#" && atWordStart) {
        const nl = cmd.indexOf("\n", i);
        if (nl === -1) break;
        i = nl - 1;                            // let the loop land on the newline
        lastWasRedirect = false;
        continue;
      }
      // A LONE `&` backgrounds one command and starts the next, exactly like `;`.
      // It was not a separator here, so `npm publish --dry-run & rm -rf ./data`
      // stayed ONE segment: only the publish matched, and a caller's exception
      // for it then covered a delete that was never examined. `&>` and `>&` are
      // redirections rather than separators and stay joined to their command.
      // The same applies to `<&` and `>|`: splitting either pair can hide a
      // later rm operand behind a disposable-path exception.
      const ampSeparates = ch === "&" && cmd[i + 1] !== ">" && !lastWasRedirect;
      const pipeSeparates = ch === "|" && !lastWasRedirect;
      if (ch === "\n" || ch === ";" || pipeSeparates || ampSeparates) {
        if (ch === "&" && cmd[i + 1] === "&") i++;  // consume '&&' second amp
        if (cmd[i + 1] === "|" && ch === "|") i++;  // consume '||' second bar
        segs.push(cur); cur = "";
        atWordStart = true;
        if (segs.length >= SEGMENT_MAX) {
          return { segments: segs, truncated: true };
        }
        continue;
      }
      cur += ch;
      lastWasRedirect = ch === ">" || ch === "<";
      // Same IFS point: a carriage return does not start a new word, so it does
      // not put a following `#` at a word start. `echo safe\r#; rm -rf ./d`
      // runs the delete, and reading CR as whitespace hid it behind a comment.
      atWordStart = ch === " " || ch === "\t" || ch === "\n";
    }
    segs.push(cur);
    return { segments: segs, truncated: false };
  }

  // Command-substitution bodies are COMMAND POSITIONS that the quote-aware split
  // above structurally cannot see: in `echo "$(rm -rf ./d)"` the double quote
  // swallows the whole string, so the only segment is `echo …` and the delete the
  // shell actually runs is invisible. Measured (cross-family round 14, 2026-09-18):
  // both the `$( … )` and the backtick spelling ALLOWED while the plain form HELD —
  // the same composition class the review named, in a different spelling.
  //
  // This is a SECOND, ADDITIVE pass, but a truncated body can still HIDE a later
  // match when an earlier match is excused. Keep its lexical state explicit:
  // parentheses and apostrophes inside quotes are data, while substitutions inside
  // double quotes still execute. `$((` is arithmetic, not a command position.
  // A syntactically incomplete body is reported after any earlier complete
  // segments are collected. The enforcement caller converts it to a human hold;
  // the display-only caller may retain only an already-proven earlier hint.
  class ScanIncompleteError extends Error {
    constructor(message) {
      super(message);
      this.name = "ScanIncompleteError";
    }
  }

  function backtickEnd(cmd, start) {
    for (let i = start + 1; i < cmd.length; i++) {
      if (cmd[i] === "\\") {
        if (i + 1 >= cmd.length) break;
        i++;
        continue;
      }
      if (cmd[i] === "`") return i;
    }
    throw new ScanIncompleteError("unterminated command substitution");
  }

  function dollarSubstitutionEnd(cmd, start) {
    let depth = 1;
    let quote = null;
    let atWordStart = true;
    let lastWasRedirect = false;
    for (let i = start + 2; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === "\\" && i + 1 < cmd.length && '$`"\\\n'.includes(cmd[i + 1])) {
          i++;
          continue;
        }
        if (ch === '"') {
          quote = null;
          continue;
        }
        if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
          i = dollarSubstitutionEnd(cmd, i);
          continue;
        }
        if (ch === "`") {
          i = backtickEnd(cmd, i);
        }
        continue;
      }
      if (ch === "\\" && cmd[i + 1] === "\n") {
        i++;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 >= cmd.length) break;
        i++;
        atWordStart = false;
        lastWasRedirect = false;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        atWordStart = false;
        lastWasRedirect = false;
        continue;
      }
      if (ch === "#" && atWordStart) {
        const nl = cmd.indexOf("\n", i);
        if (nl === -1) break;
        i = nl - 1;
        atWordStart = true;
        lastWasRedirect = false;
        continue;
      }
      if (ch === "`") {
        i = backtickEnd(cmd, i);
        atWordStart = false;
        lastWasRedirect = false;
        continue;
      }
      if (ch === "(") {
        depth++;
        atWordStart = true;
        lastWasRedirect = false;
        continue;
      }
      if (ch === ")") {
        depth--;
        if (depth === 0) return i;
        atWordStart = true;
        lastWasRedirect = false;
        continue;
      }
      const ampSeparates = ch === "&" && cmd[i + 1] !== ">" && !lastWasRedirect;
      const pipeSeparates = ch === "|" && !lastWasRedirect;
      if (ch === "\n" || ch === ";" || pipeSeparates || ampSeparates) {
        if (ch === "&" && cmd[i + 1] === "&") i++;
        if (ch === "|" && cmd[i + 1] === "|") i++;
        atWordStart = true;
        lastWasRedirect = false;
        continue;
      }
      lastWasRedirect = ch === ">" || ch === "<";
      atWordStart = ch === " " || ch === "\t" || ch === "\n";
    }
    throw new ScanIncompleteError("unterminated command substitution");
  }

  function substitutionBodies(cmd) {
    const out = [];
    let quote = null;
    let quoteStart = -1;
    let incomplete = false;
    let atWordStart = true;
    let lastWasRedirect = false;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote === "'") {
        if (ch === "'") {
          quote = null;
          quoteStart = -1;
        }
        continue;
      }
      if (quote === '"') {
        if (ch === "\\" && i + 1 < cmd.length && '$`"\\\n'.includes(cmd[i + 1])) {
          i++;
          continue;
        }
        if (ch === '"') {
          quote = null;
          quoteStart = -1;
          continue;
        }
        if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
          let j;
          try {
            j = dollarSubstitutionEnd(cmd, i);
          } catch (error) {
            if (!(error instanceof ScanIncompleteError)) throw error;
            incomplete = true;
            break;
          }
          const body = cmd.slice(i + 2, j);
          if (body.trim()) out.push({ body, start: i });
          i = j;
          continue;
        }
        if (ch === "`") {
          let end;
          try {
            end = backtickEnd(cmd, i);
          } catch (error) {
            if (!(error instanceof ScanIncompleteError)) throw error;
            incomplete = true;
            break;
          }
          const body = cmd.slice(i + 1, end);
          if (body.trim()) out.push({ body, start: i });
          i = end;
        }
        continue;
      } else {
        if (ch === "\\" && cmd[i + 1] === "\n") {
          i++;
          continue;
        }
        if (ch === "\\") {
          if (i + 1 >= cmd.length) break;
          i++;
          atWordStart = false;
          lastWasRedirect = false;
          continue;
        }
        if (ch === "'") {
          quote = ch;
          quoteStart = i;
          atWordStart = false;
          lastWasRedirect = false;
          continue;
        }
        if (ch === '"') {
          quote = ch;
          quoteStart = i;
          atWordStart = false;
          lastWasRedirect = false;
          continue;
        }
      }
      // Use the same shell word-start rule as the direct segment pass. The
      // contents of a trailing comment are not command text, so apostrophes
      // and substitution markers inside it must not turn a valid command into
      // a scan error or an invented destructive match.
      if (ch === "#" && atWordStart) {
        const nl = cmd.indexOf("\n", i);
        if (nl === -1) break;
        i = nl - 1;
        atWordStart = true;
        lastWasRedirect = false;
        continue;
      }
      const ampSeparates = ch === "&" && cmd[i + 1] !== ">" && !lastWasRedirect;
      const pipeSeparates = ch === "|" && !lastWasRedirect;
      if (ch === "\n" || ch === ";" || pipeSeparates || ampSeparates) {
        if (ch === "&" && cmd[i + 1] === "&") i++;
        if (ch === "|" && cmd[i + 1] === "|") i++;
        atWordStart = true;
        lastWasRedirect = false;
        continue;
      }
      if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
        let j;
        try {
          j = dollarSubstitutionEnd(cmd, i);
        } catch (error) {
          if (!(error instanceof ScanIncompleteError)) throw error;
          incomplete = true;
          break;
        }
        const body = cmd.slice(i + 2, j);
        if (body.trim()) out.push({ body, start: i });
        i = j;
        atWordStart = false;
        lastWasRedirect = false;
        continue;
      }
      if (ch === "`") {
        let end;
        try {
          end = backtickEnd(cmd, i);
        } catch (error) {
          if (!(error instanceof ScanIncompleteError)) throw error;
          incomplete = true;
          break;
        }
        const body = cmd.slice(i + 1, end);
        if (body.trim()) out.push({ body, start: i });
        i = end;
        atWordStart = false;
        lastWasRedirect = false;
        continue;
      }
      lastWasRedirect = ch === ">" || ch === "<";
      atWordStart = ch === " " || ch === "\t" || ch === "\n";
    }
    if (quote) incomplete = true;
    // A completed substitution inside a quote that never closes is part of the
    // malformed construct itself, not an independently proven command. Keep
    // bodies that completed before a later malformed quote/substitution, which
    // lets the display retain an earlier useful hint without inventing one from
    // the uncertain suffix.
    const completed = quote
      ? out.filter((entry) => entry.start < quoteStart)
      : out;
    return { bodies: completed.map((entry) => entry.body), incomplete };
  }

  function segmentCommands(cmd, depth) {
    const out = [];
    let incomplete = false;
    let truncated = false;
    const d = depth || 0;
    const direct = splitOutsideQuotes(cmd);
    truncated = direct.truncated;
    for (let seg of direct.segments) {
      seg = seg.trim();
      // A subshell or group opens with `(` and the command starts inside it, so
      // `echo safe; (rm -rf ./d)` had a segment beginning `(` that the anchored
      // patterns could not match while the shell ran the delete. `((` is
      // arithmetic rather than a command position and is left alone.
      //
      // `{` is the OTHER grouping keyword and was missing: the `{ … ; }` spelling
      // ALLOWED while the `( … )` spelling HELD (measured, cross-family round 14).
      // The shell requires a BLANK after `{` for it to be the group keyword, so that
      // is the discriminator — `{a,b}` is brace expansion (a word, not a command
      // position) and `${VAR}` is an expansion; neither is stripped.
      let g0 = 0;
      while (g0++ < 5 && ((seg.startsWith("(") && !seg.startsWith("((")) || /^\{\s/.test(seg))) {
        seg = seg.slice(1).trim();
      }
      let guard = 0;
      while (WRAPPER.test(seg) && guard++ < 5) seg = seg.replace(WRAPPER, "");
      if (seg) out.push(seg);
    }
    // Depth cap: a substitution inside a substitution is real but unbounded recursion
    // on attacker-shaped input is not worth it. 3 levels, and the segment cap applies.
    if (d < 3 && !truncated) {
      const substitutions = substitutionBodies(cmd);
      incomplete = substitutions.incomplete;
      for (let bodyIndex = 0; bodyIndex < substitutions.bodies.length; bodyIndex++) {
        if (out.length >= SEGMENT_MAX) {
          truncated = true;
          break;
        }
        const body = substitutions.bodies[bodyIndex];
        const nested = segmentCommands(body, d + 1);
        incomplete = incomplete || nested.incomplete;
        truncated = truncated || nested.truncated;
        for (let segmentIndex = 0; segmentIndex < nested.segments.length; segmentIndex++) {
          if (out.length >= SEGMENT_MAX) {
            truncated = true;
            break;
          }
          out.push(nested.segments[segmentIndex]);
        }
        if (out.length >= SEGMENT_MAX && bodyIndex < substitutions.bodies.length - 1) truncated = true;
      }
    }
    return { segments: out, incomplete, truncated };
  }

  // One pattern list, two error policies. detectIrreversibleStrict lets a
  // surprise throw so a caller can decide what a failed scan means; the display
  // wrapper below never propagates it and retains only matches collected before
  // an incomplete suffix. Splitting the *policy* rather than the matcher is what
  // keeps a second caller from drifting into a second pattern list.
  // The matched `segment` is returned so a caller can apply its own carve-outs
  // (a documented `--dry-run` exception, say) without re-splitting the command.
  // Every destructive decision in the request, not just the first one.
  //
  // The badge only ever needed one: it draws a single icon, so it stops at the
  // first match. A gate cannot stop there. `npm publish --dry-run && rm -rf /`
  // has two decisions, and a caller that carves out the first one has to be able
  // to see the second, or the carve-out silently covers the whole request. The
  // same is true inside one segment: `git push --force-with-lease --delete`
  // carries a lease-guarded force-push AND a remote-delete, and only the first
  // was ever tested.
  //
  // `stopAfter` keeps the badge path exactly as cheap as it was -- it asks for
  // one and gets one. The scan stays bounded by construction: at most
  // SEGMENT_MAX segments times the fixed pattern list, so there is no new budget
  // to state and nothing here grows with the accepted input.
  function detectIrreversibleMatches(name, input, stopAfter) {
    const limit = typeof stopAfter === "number" && stopAfter > 0 ? stopAfter : Infinity;
    const found = [];
    const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
    const obj = input && typeof input === "object" ? input : {};
    // Shell-ish tools: scan the command string, anchored per segment.
    if (SHELL_TOOLS.has(toolName)) {
      let cmd = firstStringValue(obj, ["command", "CommandLine", "Command", "cmd", "script"]);
      if (!cmd) return found;
      // Cap the scanned prefix: the command string is attacker-influenced (a
      // prompt-injected agent controls it). Hard cap = O(4KB) by construction.
      let truncated = obj[SCAN_TRUNCATED] === true;
      if (cmd.length > SCAN_MAX) {
        cmd = cmd.slice(0, SCAN_MAX);
        truncated = true;
      }
      const scan = segmentCommands(cmd);
      truncated = truncated || scan.truncated;
      for (const seg of scan.segments) {
        for (const p of IRREVERSIBLE_PATTERNS) {
          if (p.re.test(seg)) {
            found.push({ tag: p.tag, segment: seg });
            if (found.length >= limit && (!scan.incomplete || truncated)) return found;
          }
        }
        if (DB_CLIENTS.test(seg) && DB_DESTROY.test(seg)) {
          found.push({ tag: "db-destroy", segment: seg });
          if (found.length >= limit && (!scan.incomplete || truncated)) return found;
        }
      }
      if (scan.incomplete && !truncated) {
        const error = new ScanIncompleteError("incomplete shell syntax");
        error.partialMatches = found.slice(0, limit);
        throw error;
      }
      return found;
    }
    // Explicit destructive file tools only (generic "delete" substrings would
    // over-match MCP tools like delete_draft — stay conservative).
    if (toolName === "delete_file" || toolName === "deletefile" || toolName === "remove_file") {
      found.push({ tag: "file-delete", segment: null });
    }
    return found;
  }

  // First match only, for the display hint. Delegates rather than keeping its
  // own copy of the walk: two traversals over one pattern list is how the badge
  // and the gate would start disagreeing about what they examined.
  function detectIrreversibleStrict(name, input) {
    const found = detectIrreversibleMatches(name, input, 1);
    return found.length ? found[0] : null;
  }

  function detectIrreversible(name, input) {
    try {
      return detectIrreversibleStrict(name, input);
    } catch (error) {
      if (
        error instanceof ScanIncompleteError
        && Array.isArray(error.partialMatches)
        && error.partialMatches.length
      ) return error.partialMatches[0];
      // Display-only helper on the permission path — a hint must never be able to
      // break the bubble (which blocks tool execution). Any surprise → no hint.
      return null;
    }
  }

  function shouldScanIrreversibleCommand(name) {
    const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
    return SHELL_TOOLS.has(toolName);
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

  const api = { formatDetail, formatAntigravityDetail, formatReminderReason, truncate, firstStringValue, parseMcpToolName, detectIrreversible, detectIrreversibleStrict, detectIrreversibleMatches, shouldScanIrreversibleCommand, SCAN_MAX, SEGMENT_MAX, SCAN_TRUNCATED };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root && typeof root === "object") {
    root.ClawdBubbleFormat = api;
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
