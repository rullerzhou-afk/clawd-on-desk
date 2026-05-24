"use strict";

(function (root) {
  function truncate(s, max) {
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
    if (name === "Bash" && input.command) return truncate(input.command, 120);
    if ((name === "Edit" || name === "Write" || name === "Read") && input.file_path)
      return truncate(input.file_path, 120);
    if ((name === "Glob" || name === "Grep") && input.pattern)
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

  const api = { formatDetail, formatAntigravityDetail, truncate, firstStringValue };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root && typeof root === "object") {
    root.ClawdBubbleFormat = api;
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
