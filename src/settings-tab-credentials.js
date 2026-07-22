"use strict";

// Settings tab: Platform Tokens & Usage.
//   - Top: usage statistics read from each CLI's session logs (summary tiles +
//     per-platform and per-model breakdowns). No proxy.
//   - Below: read-only token display per platform (masked, with Reveal/Copy).
// Editing/write-back was removed. The renderer never holds a raw token at rest
// (reveal fetches on demand).

(function initSettingsTabCredentials(root) {
  let helpers = null;
  let ops = null;

  function t(key) { return helpers.t(key); }

  const AGENT_NAMES = {
    "claude-code": "Claude Code", "codex": "Codex", "gemini-cli": "Gemini",
    "qwen-code": "Qwen", "openclaw": "OpenClaw", "opencode": "opencode", "hermes": "Hermes",
  };
  const num = (x) => Number(x || 0).toLocaleString();
  const usd = (x) => "$" + Number(x || 0).toFixed(2);

  // ── Usage statistics ──────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Compact token count: 万/亿 for zh/ja, K/M/B otherwise (matches cc-switch).
  function compact(v) {
    v = Number(v || 0);
    if (!isFinite(v) || v <= 0) return "0";
    const lang = (helpers.getLang && helpers.getLang()) || "en";
    const tw = lang === "zh-TW" || lang.indexOf("Hant") !== -1;
    if (lang.indexOf("zh") === 0 || lang.indexOf("ja") === 0) {
      if (v >= 1e8) return (v / 1e8).toFixed(2) + (tw ? " 億" : " 亿");
      if (v >= 1e4) return (v / 1e4).toFixed(1) + (tw ? " 萬" : " 万");
      return v.toLocaleString();
    }
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toLocaleString();
  }

  function miniStat(color, label, value) {
    const s = el("div", "usage-stat");
    const k = el("div", "k");
    const dot = el("span", "dot"); dot.style.background = color;
    k.appendChild(dot); k.appendChild(el("span", null, label));
    s.appendChild(k);
    s.appendChild(el("div", "v", value));
    return s;
  }

  function breakdownTable(sec, titleKey, rows, maxTokens) {
    sec.appendChild(el("div", "usage-sub", t(titleKey)));
    const table = el("div", "usage-table");
    for (const g of rows) {
      const row = el("div", "usage-trow");
      const bar = el("div", "barbg");
      bar.style.width = maxTokens > 0 ? Math.max(2, (g.totalTokens / maxTokens) * 100) + "%" : "0";
      row.appendChild(bar);
      row.appendChild(el("div", "name", g.displayName || g.key));
      const nums = el("div", "nums");
      nums.appendChild(el("span", null, num(g.requests)));
      nums.appendChild(el("span", null, compact(g.totalTokens)));
      nums.appendChild(el("span", "c", usd(g.cost)));
      row.appendChild(nums);
      table.appendChild(row);
    }
    sec.appendChild(table);
  }

  // Range selector: key in s.ranges → i18n label key. "today" is the default.
  const RANGES = [
    ["today", "usageRangeToday"],
    ["last7", "usageRange7"],
    ["last30", "usageRange30"],
    ["all", "usageRangeAll"],
  ];

  // Render the hero card + mini-stat grid + breakdown tables for one range.
  function renderRangeBody(body, r) {
    body.innerHTML = "";
    if (!r || !r.requests) {
      body.appendChild(el("div", "usage-empty", t("usageEmpty")));
      return;
    }

    const hero = el("div", "usage-hero");
    const top = el("div", "usage-hero-top");
    const total = el("div", "usage-hero-total");
    total.appendChild(el("div", "lbl", t("usageRealTokens")));
    const numline = el("div");
    numline.appendChild(el("span", "num", num(r.totalTokens)));
    numline.appendChild(el("span", "approx", "≈ " + compact(r.totalTokens)));
    total.appendChild(numline);
    top.appendChild(total);

    const pill = el("div", "usage-hero-pill");
    const c1 = el("div", "col");
    c1.appendChild(el("div", "k", t("usageRequests")));
    c1.appendChild(el("div", "v", num(r.requests)));
    pill.appendChild(c1);
    pill.appendChild(el("div", "sep"));
    const c2 = el("div", "col");
    c2.appendChild(el("div", "k", t("usageCost")));
    c2.appendChild(el("div", "v cost", "$" + Number(r.cost || 0).toFixed(2)));
    pill.appendChild(c2);
    top.appendChild(pill);
    hero.appendChild(top);

    const grid = el("div", "usage-grid");
    grid.appendChild(miniStat("#3b82f6", t("usageInput"), compact(r.input)));
    grid.appendChild(miniStat("#a855f7", t("usageOutput"), compact(r.output)));
    grid.appendChild(miniStat("#f59e0b", t("usageCacheCreate"), compact(r.cacheCreation)));
    grid.appendChild(miniStat("#10b981", t("usageCacheHit"), compact(r.cacheRead)));
    const rate = el("div", "usage-stat usage-rate");
    const rt = el("div", "rt");
    rt.appendChild(el("span", null, t("usageCacheRate")));
    const pct = Math.max(0, Math.min(100, Number(r.cacheHitRate || 0) * 100));
    rt.appendChild(el("span", "pct", pct.toFixed(1) + "%"));
    rate.appendChild(rt);
    const barwrap = el("div", "bar");
    const fill = el("div", "fill"); fill.style.width = pct + "%";
    barwrap.appendChild(fill);
    rate.appendChild(barwrap);
    grid.appendChild(rate);
    hero.appendChild(grid);
    body.appendChild(hero);

    const agents = Array.isArray(r.byAgent)
      ? r.byAgent.map((g) => ({ ...g, displayName: AGENT_NAMES[g.key] || g.key }))
      : [];
    if (agents.length) {
      breakdownTable(body, "usageByAgent", agents, Math.max(...agents.map((g) => g.totalTokens), 1));
    }
    const models = Array.isArray(r.byModel) ? r.byModel.slice(0, 15) : [];
    if (models.length) {
      breakdownTable(body, "usageByModel", models, Math.max(...models.map((g) => g.totalTokens), 1));
    }
  }

  function renderUsageStats(parent) {
    if (!window.usage || typeof window.usage.stats !== "function") return;
    const sec = el("section", "section");
    const head = el("div", "usage-head");
    head.appendChild(el("h3", null, t("usageTitle")));
    const tabs = el("div", "usage-tabs");
    head.appendChild(tabs);
    sec.appendChild(head);
    const body = el("div", "usage-body");
    sec.appendChild(body);
    parent.appendChild(sec);

    window.usage.stats().then((s) => {
      const ranges = (s && s.ranges) || {};
      const buttons = {};
      function select(key) {
        for (const k of Object.keys(buttons)) buttons[k].classList.toggle("active", k === key);
        renderRangeBody(body, ranges[key]);
      }
      for (const [key, labelKey] of RANGES) {
        const b = el("button", "usage-tab", t(labelKey));
        b.type = "button";
        b.addEventListener("click", () => select(key));
        buttons[key] = b;
        tabs.appendChild(b);
      }
      select("today"); // default to the current day
    }).catch(() => {});
  }

  // ── Read-only token display ───────────────────────────────────────
  function refresh(list) {
    if (!window.credentials || typeof window.credentials.readAll !== "function") return;
    window.credentials.readAll().then((rows) => {
      list.innerHTML = "";
      for (const row of (Array.isArray(rows) ? rows : [])) list.appendChild(buildReadRow(row));
    }).catch(() => {});
  }

  function buildReadRow(row) {
    const el = document.createElement("div");
    el.className = "about-info-row";
    const label = document.createElement("div");
    label.className = "about-info-label";
    label.textContent = row.agentName;
    const meta = document.createElement("div");
    meta.className = "about-info-description";
    meta.style.opacity = "0.7";
    meta.style.fontSize = "12px";
    meta.textContent = [row.baseUrl || "-", row.model || ""].filter(Boolean).join("  ·  ");
    label.appendChild(meta);

    const value = document.createElement("div");
    value.className = "about-info-value";
    value.style.display = "flex";
    value.style.alignItems = "center";
    value.style.gap = "8px";
    const code = document.createElement("code");
    code.className = "credential-token";
    code.textContent = row.hasToken ? row.tokenMasked : (row.error ? t("credentialsErrorLabel") : t("credentialsNotFound"));
    if (!row.hasToken) code.style.opacity = "0.6";
    value.appendChild(code);

    if (row.hasToken) {
      let shown = false;
      const reveal = document.createElement("button");
      reveal.className = "about-check-update-btn";
      reveal.type = "button";
      reveal.textContent = t("credentialsReveal");
      reveal.addEventListener("click", () => {
        if (shown) {
          code.textContent = row.tokenMasked;
          reveal.textContent = t("credentialsReveal");
          shown = false;
          return;
        }
        if (!window.credentials || typeof window.credentials.reveal !== "function") return;
        reveal.disabled = true;
        window.credentials.reveal(row.agentId)
          .then((res) => {
            code.textContent = (res && res.token) ? res.token : row.tokenMasked;
            reveal.textContent = t("credentialsHide");
            shown = true;
          })
          .catch(() => {})
          .finally(() => { reveal.disabled = false; });
      });

      const copy = document.createElement("button");
      copy.className = "about-check-update-btn";
      copy.type = "button";
      copy.textContent = t("credentialsCopy");
      copy.addEventListener("click", () => {
        if (!window.credentials || typeof window.credentials.copy !== "function") return;
        copy.disabled = true;
        window.credentials.copy(row.agentId)
          .then((res) => {
            copy.textContent = t(res && res.ok ? "credentialsCopied" : "credentialsCopyFailed");
          })
          .catch(() => { copy.textContent = t("credentialsCopyFailed"); })
          .finally(() => {
            setTimeout(() => { copy.textContent = t("credentialsCopy"); }, 1500);
            copy.disabled = false;
          });
      });

      value.appendChild(reveal);
      value.appendChild(copy);
    }

    el.appendChild(label);
    el.appendChild(value);
    return el;
  }

  function render(parent) {
    const title = document.createElement("h2");
    title.className = "about-title";
    title.textContent = t("credentialsTitle");
    parent.appendChild(title);
    const hint = document.createElement("p");
    hint.className = "about-tagline";
    hint.textContent = t("credentialsHint");
    parent.appendChild(hint);

    renderUsageStats(parent);

    const section = document.createElement("section");
    section.className = "section";
    parent.appendChild(section);
    if (!window.credentials || typeof window.credentials.readAll !== "function") {
      const empty = document.createElement("div");
      empty.className = "about-info-value";
      empty.textContent = t("credentialsNotFound");
      section.appendChild(empty);
      return;
    }
    refresh(section);
  }

  function init(core) {
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.credentials = { render };
  }

  root.ClawdSettingsTabCredentials = { init };
})(globalThis);
