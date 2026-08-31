"use strict";

(function initSettingsTabRecap(root) {
  let coreState = null;
  let runtime = null;
  let helpers = null;
  let ops = null;
  let renderSerial = 0;

  const PERIODS = ["today", "week", "month", "year"];
  const KNOWN_AGENT_COLORS = Object.freeze({
    "claude-code": "var(--recap-agent-claude)",
    codex: "var(--recap-agent-codex)",
    opencode: "var(--recap-agent-opencode)",
    "gemini-cli": "var(--recap-agent-gemini)",
    codewhale: "var(--recap-agent-whale)",
  });
  const FALLBACK_COLOR_COUNT = 12;
  const view = {
    period: "today",
    status: "idle",
    data: null,
    requestSeq: 0,
    refreshInFlight: false,
    refreshQueued: false,
    togglePending: false,
    clearPending: false,
    hoverRowKey: null,
    lockedRowKey: null,
    gridIndex: 0,
  };

  function t(key) {
    return helpers.t(key);
  }

  function locale() {
    const lang = coreState && coreState.snapshot && coreState.snapshot.lang;
    return ({ zh: "zh-CN", "zh-TW": "zh-TW", ko: "ko-KR", ja: "ja-JP", "pt-BR": "pt-BR", es: "es" })[lang] || "en";
  }

  function formatNumber(value, options) {
    return new Intl.NumberFormat(locale(), options).format(value);
  }

  function replace(template, values) {
    return Object.entries(values).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
      String(template || "")
    );
  }

  function parseLocalDate(localDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate || ""));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (
      date.getUTCFullYear() !== Number(match[1])
      || date.getUTCMonth() !== Number(match[2]) - 1
      || date.getUTCDate() !== Number(match[3])
    ) return null;
    return date;
  }

  function toLocalDate(date) {
    return [
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("-");
  }

  function addLocalDays(localDate, amount) {
    const date = parseLocalDate(localDate);
    if (!date) return localDate;
    date.setUTCDate(date.getUTCDate() + amount);
    return toLocalDate(date);
  }

  function compareLocalDates(left, right) {
    return String(left).localeCompare(String(right));
  }

  function formatDate(localDate, options) {
    const date = parseLocalDate(localDate);
    return date
      ? new Intl.DateTimeFormat(locale(), { timeZone: "UTC", ...options }).format(date)
      : String(localDate || "");
  }

  function formatHour(hour) {
    return `${formatNumber(hour, { minimumIntegerDigits: 2, useGrouping: false })}:00`;
  }

  function requestData() {
    if (view.status !== "idle") return;
    view.status = "loading";
    const requestSeq = ++view.requestSeq;
    Promise.resolve().then(() => {
      if (!window.settingsAPI || typeof window.settingsAPI.queryRecap !== "function") {
        throw new Error("recap API unavailable");
      }
      return window.settingsAPI.queryRecap(view.period);
    }).then((result) => {
      if (requestSeq !== view.requestSeq) return;
      if (!result || result.status !== "ready") {
        view.status = result && result.status === "unavailable" ? "unavailable" : "error";
        view.data = result || null;
      } else {
        view.status = "ready";
        view.data = result;
      }
      if (coreState.activeTab === "recap") ops.requestRender({ content: true, preserveScroll: true });
      refreshIfNeeded();
    }).catch(() => {
      if (requestSeq !== view.requestSeq) return;
      view.status = "error";
      view.data = null;
      if (coreState.activeTab === "recap") ops.requestRender({ content: true, preserveScroll: true });
    });
  }

  function refreshIfNeeded() {
    if (!view.refreshQueued || view.refreshInFlight) return;
    if (coreState.activeTab !== "recap") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (["unavailable", "error"].includes(view.status)) {
      view.refreshQueued = false;
      view.status = "idle";
      view.data = null;
      requestData();
      return;
    }
    if (view.status !== "ready") return;
    view.refreshQueued = false;
    view.refreshInFlight = true;
    const requestSeq = ++view.requestSeq;
    const period = view.period;
    Promise.resolve().then(() => {
      if (!window.settingsAPI || typeof window.settingsAPI.queryRecap !== "function") {
        throw new Error("recap API unavailable");
      }
      return window.settingsAPI.queryRecap(period);
    }).then((result) => {
      if (requestSeq !== view.requestSeq) return;
      if (result && result.status === "ready") {
        view.status = "ready";
        view.data = result;
        if (coreState.activeTab === "recap") {
          ops.requestRender({ content: true, preserveScroll: true });
        }
      }
    }).catch(() => {
      // A background refresh must not replace already-visible data with an
      // error card. The next accepted activity signal will retry naturally.
    }).finally(() => {
      view.refreshInFlight = false;
      refreshIfNeeded();
    });
  }

  function applyDataChanged() {
    view.refreshQueued = true;
    refreshIfNeeded();
  }

  function resetInteraction() {
    view.hoverRowKey = null;
    view.lockedRowKey = null;
    view.gridIndex = 0;
  }

  function reload() {
    view.requestSeq += 1;
    view.status = "idle";
    view.data = null;
    view.refreshQueued = false;
    resetInteraction();
    if (coreState.activeTab === "recap") ops.requestRender({ content: true, preserveScroll: true });
  }

  function agentName(agentId) {
    const metadata = Array.isArray(runtime.agentMetadata)
      ? runtime.agentMetadata.find((agent) => agent && agent.id === agentId)
      : null;
    return metadata && metadata.name ? metadata.name : agentId;
  }

  function scopeLabel(row) {
    if (row.scope === "local") return "";
    const key = row.scope === "wsl" ? "recapScopeWsl" : "recapScopeRemote";
    return t(key);
  }

  function rowKey(row) {
    return `${row.agentId}\0${row.scope}`;
  }

  function rowDisplayName(row) {
    const scope = scopeLabel(row);
    return scope ? `${agentName(row.agentId)} · ${scope}` : agentName(row.agentId);
  }

  function agentColorToken(agentId) {
    if (KNOWN_AGENT_COLORS[agentId]) return KNOWN_AGENT_COLORS[agentId];
    let hash = 2166136261;
    for (const char of String(agentId || "")) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `var(--recap-agent-fallback-${(hash >>> 0) % FALLBACK_COLOR_COUNT})`;
  }

  function combineMetric(current, next) {
    if (current === null || next === null) return null;
    return current + (Number.isSafeInteger(next) ? next : 0);
  }

  function summarize(data) {
    const rows = new Map();
    const agentIds = new Set();
    for (const day of data.days || []) {
      for (const source of day.rows || []) {
        agentIds.add(source.agentId);
        const key = rowKey(source);
        let row = rows.get(key);
        if (!row) {
          row = {
            key,
            agentId: source.agentId,
            scope: source.scope,
            scopeInstance: source.scopeInstance,
            sessionsStarted: 0,
            turnsCompleted: 0,
            toolCalls: 0,
            activityEvents: 0,
            sessionsStartedPartial: false,
          };
          rows.set(key, row);
        }
        const metrics = source.metrics || {};
        row.sessionsStarted = combineMetric(row.sessionsStarted, metrics.sessionsStarted);
        row.turnsCompleted = combineMetric(row.turnsCompleted, metrics.turnsCompleted);
        row.toolCalls = combineMetric(row.toolCalls, metrics.toolCalls);
        row.activityEvents += Number.isSafeInteger(metrics.activityEvents) ? metrics.activityEvents : 0;
        row.sessionsStartedPartial ||= source.sessionsStartedPartial === true;
      }
    }
    return {
      agentCount: agentIds.size,
      rows: [...rows.values()].sort((left, right) =>
        agentName(left.agentId).localeCompare(agentName(right.agentId), locale())
        || String(left.scopeInstance).localeCompare(String(right.scopeInstance))),
    };
  }

  function depthOf(value) {
    if (value >= 26) return 3;
    if (value >= 9) return 2;
    return value > 0 ? 1 : 0;
  }

  function barRatio(value, maximum) {
    const count = Number(value);
    const max = Number(maximum);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(max) || max <= 0) return 0;
    return Math.min(1, count / max);
  }

  function setTodayBarLevel(element, value) {
    const maximum = Number(element && element.dataset && element.dataset.barMaximum);
    if (!element || !element.style) return;
    element.style.setProperty("--recap-bar-ratio", String(barRatio(value, maximum)));
  }

  function coverageForDay(day) {
    const minutes = day && day.coverage && Array.isArray(day.coverage.coverageMinutes)
      ? day.coverage.coverageMinutes
      : [];
    return Array.from({ length: 24 }, (_, hour) => {
      const value = Number(minutes[hour]);
      return Number.isFinite(value) && value > 0 ? value : 0;
    });
  }

  function hourCapacity(day, hour) {
    const hasShape = !!(day && (
      Array.isArray(day.hourCapacities)
      || (day.coverage && Array.isArray(day.coverage.hourCapacities))
    ));
    const capacities = [
      day && Array.isArray(day.hourCapacities) ? day.hourCapacities[hour] : 0,
      day && day.coverage && Array.isArray(day.coverage.hourCapacities)
        ? day.coverage.hourCapacities[hour]
        : 0,
    ];
    const capacity = Math.max(...capacities.map((value) => Number(value) || 0));
    return { capacity, hasShape };
  }

  function hourKind(day, hour) {
    const { capacity, hasShape } = hourCapacity(day, hour);
    if (capacity > 60) return "fold";
    if (hasShape && capacity === 0) return "gap";
    if (capacity > 0 && capacity < 60) return "gap";
    return "normal";
  }

  function expectedCoverage(data, localDate, hour, day) {
    const hasShape = !!(day && (
      Array.isArray(day.hourCapacities)
      || (day.coverage && Array.isArray(day.coverage.hourCapacities))
    ));
    const capacities = Array.from({ length: 24 }, (_, index) => {
      const known = Math.max(
        Number(day && Array.isArray(day.hourCapacities) ? day.hourCapacities[index] : 0) || 0,
        Number(day && day.coverage && Array.isArray(day.coverage.hourCapacities)
          ? day.coverage.hourCapacities[index]
          : 0) || 0
      );
      return hasShape ? known : 60;
    });
    const startedDate = data.recordingStartedDate || data.startDate || data.anchorDate;
    const startedHour = localDate === startedDate && Number.isInteger(data.recordingStartedLocalHour)
      ? data.recordingStartedLocalHour
      : 0;
    const endHour = localDate === data.anchorDate && Number.isInteger(data.currentLocalHour)
      ? data.currentLocalHour
      : 23;
    function targetForHour(index) {
      if (index < startedHour || index > endHour) return 0;
      const capacity = capacities[index];
      let eligibleStart = 0;
      let eligibleEnd = capacity;
      if (localDate === startedDate && index === startedHour && Number.isInteger(data.recordingStartedLocalMinute)) {
        eligibleStart = Number.isInteger(data.recordingStartedHourElapsedMinutes)
          ? data.recordingStartedHourElapsedMinutes
          : data.recordingStartedLocalMinute;
      }
      if (localDate === data.anchorDate && index === endHour && Number.isInteger(data.currentLocalMinute)) {
        eligibleEnd = Number.isInteger(data.currentHourElapsedMinutes)
          ? data.currentHourElapsedMinutes
          : data.currentLocalMinute;
      }
      return Math.max(0, Math.min(capacity, eligibleEnd) - Math.min(capacity, eligibleStart));
    }
    if (hour !== null) return targetForHour(hour);
    return Array.from({ length: 24 }, (_, index) => targetForHour(index))
      .reduce((sum, value) => sum + value, 0);
  }

  function countsForHour(day, hour) {
    const counts = [];
    for (const row of day && Array.isArray(day.rows) ? day.rows : []) {
      const count = Array.isArray(row.hours) && Number.isSafeInteger(row.hours[hour])
        ? row.hours[hour]
        : 0;
      if (count > 0) counts.push({
        rowKey: rowKey(row),
        agentId: row.agentId,
        scope: row.scope,
        scopeInstance: row.scopeInstance,
        count,
      });
    }
    return counts;
  }

  function countsForDay(day) {
    const counts = [];
    for (const row of day && Array.isArray(day.rows) ? day.rows : []) {
      const count = row.metrics && Number.isSafeInteger(row.metrics.activityEvents)
        ? row.metrics.activityEvents
        : 0;
      if (count > 0) counts.push({
        rowKey: rowKey(row),
        agentId: row.agentId,
        scope: row.scope,
        scopeInstance: row.scopeInstance,
        count,
      });
    }
    return counts;
  }

  function classifyCell(data, localDate, hour, day, counts, kind, invalid = false) {
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    if (invalid) return { state: "blank", total, counts, kind: "normal" };
    // A DST gap is not a zero, a future slot, or a pre-recording slot: this
    // local hour did not exist at all.
    // A zero-capacity gap did not exist. Partial-hour transitions (for
    // example Lord Howe's 30-minute jump) still have real time in which
    // activity and coverage can occur, so they must continue through the
    // normal classification path.
    if (kind === "gap" && hour !== null && hourCapacity(day, hour).capacity === 0) {
      return { state: "gap", total: 0, counts: [], kind };
    }
    const anchorDate = data.anchorDate;
    const afterToday = compareLocalDates(localDate, anchorDate) > 0;
    const futureHour = hour !== null
      && localDate === anchorDate
      && hour > (Number.isInteger(data.currentLocalHour) ? data.currentLocalHour : 23);
    if (afterToday || futureHour) return { state: "future", total: 0, counts: [], kind: "normal" };
    if (total > 0) return { state: "activity", total, counts, kind };
    const coverage = coverageForDay(day);
    const coveredMinutes = hour === null
      ? coverage.reduce((sum, minutes) => sum + minutes, 0)
      : coverage[hour];
    const expectedMinutes = expectedCoverage(data, localDate, hour, day);
    if (coveredMinutes > 0) {
      return {
        state: expectedMinutes > 0 && coveredMinutes >= expectedMinutes ? "covered" : "partial",
        total: 0,
        counts: [],
        kind,
      };
    }
    const startedDate = data.recordingStartedDate || data.startDate || anchorDate;
    const beforeStartedDate = compareLocalDates(localDate, startedDate) < 0;
    const beforeStartedHour = hour !== null
      && localDate === startedDate
      && Number.isInteger(data.recordingStartedLocalHour)
      && hour < data.recordingStartedLocalHour;
    if (beforeStartedDate || beforeStartedHour) {
      return { state: "not-started", total: 0, counts: [], kind: "normal" };
    }
    return { state: "uncovered", total: 0, counts: [], kind };
  }

  function createCell(data, localDate, hour, day, optionsValue = {}) {
    const counts = hour === null ? countsForDay(day) : countsForHour(day, hour);
    const kind = hour === null ? "normal" : hourKind(day, hour);
    return {
      key: hour === null ? localDate : `${localDate}T${String(hour).padStart(2, "0")}`,
      localDate,
      hour,
      dayNumber: optionsValue.dayNumber || null,
      ...classifyCell(data, localDate, hour, day, counts, kind, optionsValue.invalid === true),
    };
  }

  function buildTimelineModel(data, period) {
    const dayMap = new Map((data.days || []).map((day) => [day.localDate, day]));
    const cells = [];
    let columns = 24;
    let rows = 1;
    let startDate = data.startDate;
    if (period === "today") {
      const day = dayMap.get(data.anchorDate);
      for (let hour = 0; hour < 24; hour += 1) {
        cells.push(createCell(data, data.anchorDate, hour, day));
      }
    } else if (period === "week") {
      startDate = data.startDate;
      rows = 7;
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const localDate = addLocalDays(startDate, dayIndex);
        const day = dayMap.get(localDate);
        for (let hour = 0; hour < 24; hour += 1) {
          cells.push(createCell(data, localDate, hour, day));
        }
      }
    } else if (period === "month") {
      const anchor = parseLocalDate(data.anchorDate);
      const year = anchor.getUTCFullYear();
      const month = anchor.getUTCMonth();
      const monthStart = new Date(Date.UTC(year, month, 1));
      startDate = toLocalDate(monthStart);
      const leading = (monthStart.getUTCDay() + 6) % 7;
      const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      columns = 7;
      rows = Math.ceil((leading + dayCount) / 7);
      for (let index = 0; index < leading; index += 1) {
        const blank = createCell(data, startDate, null, null, { invalid: true });
        blank.key = `month-leading-${index}`;
        cells.push(blank);
      }
      for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
        const localDate = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
        cells.push(createCell(data, localDate, null, dayMap.get(localDate), { dayNumber }));
      }
    } else {
      const year = Number(String(data.anchorDate).slice(0, 4));
      startDate = `${String(year).padStart(4, "0")}-01-01`;
      columns = 31;
      rows = 12;
      for (let month = 1; month <= 12; month += 1) {
        const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
        for (let dayNumber = 1; dayNumber <= 31; dayNumber += 1) {
          const localDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
          cells.push(createCell(data, localDate, null, dayMap.get(localDate), {
            dayNumber,
            invalid: dayNumber > dayCount,
          }));
        }
      }
    }
    return { period, cells, columns, rows, startDate };
  }

  function buildPeriodTabs() {
    const group = document.createElement("div");
    group.className = "recap-period-tabs";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", t("recapPeriodLabel"));
    for (const period of PERIODS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recap-period-button";
      button.setAttribute("data-settings-focus-key", `recap-period-${period}`);
      button.textContent = t(`recapPeriod_${period}`);
      button.classList.toggle("active", view.period === period);
      button.setAttribute("aria-pressed", view.period === period ? "true" : "false");
      button.addEventListener("click", () => {
        if (view.period === period) return;
        view.period = period;
        reload();
      });
      group.appendChild(button);
    }
    return group;
  }

  function metricText(value, partial = false) {
    if (value === null) return t("recapMetricUnavailable");
    const formatted = formatNumber(value);
    return partial ? `${formatted} · ${t("recapMetricPartial")}` : formatted;
  }

  function buildAgentRows(summary, interaction) {
    const list = document.createElement("div");
    list.className = "recap-agent-list";
    if (summary.rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "recap-empty";
      empty.textContent = t("recapEmptyBody");
      list.appendChild(empty);
      return list;
    }
    for (const row of summary.rows) {
      const item = document.createElement("div");
      item.className = "recap-agent-row";
      item.dataset.rowKey = row.key;
      item.setAttribute("data-settings-focus-key", `recap-agent-${row.key}`);
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-pressed", view.lockedRowKey === row.key ? "true" : "false");
      const metricEntries = [
        ["recapMetricSessions", row.sessionsStarted, row.sessionsStartedPartial],
        ["recapMetricTurns", row.turnsCompleted, false],
        ["recapMetricTools", row.toolCalls, false],
        ["recapMetricSignals", row.activityEvents, false],
      ];
      const metricDescription = metricEntries.map(([labelKey, value, partial]) => {
        const accessibleValue = value === null
          ? t("recapMetricUnavailableReason")
          : metricText(value, partial);
        return `${t(labelKey)}: ${accessibleValue}`;
      }).join(". ");
      item.setAttribute("aria-label", `${replace(t("recapAgentHighlightAria"), {
        agent: rowDisplayName(row),
      })}. ${metricDescription}`);
      item.style.setProperty("--recap-row-color", agentColorToken(row.agentId));
      const identity = document.createElement("div");
      identity.className = "recap-agent-identity";
      const swatch = document.createElement("span");
      swatch.className = "recap-agent-swatch";
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("strong");
      name.textContent = agentName(row.agentId);
      identity.appendChild(swatch);
      identity.appendChild(name);
      const scope = scopeLabel(row);
      if (scope) {
        const scopeNode = document.createElement("span");
        scopeNode.textContent = scope;
        identity.appendChild(scopeNode);
      }
      item.appendChild(identity);
      const metrics = document.createElement("dl");
      metrics.className = "recap-agent-metrics";
      for (const [labelKey, value, partial] of metricEntries) {
        const pair = document.createElement("div");
        const label = document.createElement("dt");
        label.textContent = t(labelKey);
        const count = document.createElement("dd");
        count.textContent = metricText(value, partial);
        if (value === null) {
          count.title = t("recapMetricUnavailableReason");
          count.setAttribute("aria-label", `${t(labelKey)}: ${t("recapMetricUnavailableReason")}`);
        }
        pair.appendChild(label);
        pair.appendChild(count);
        metrics.appendChild(pair);
      }
      item.appendChild(metrics);
      item.addEventListener("mouseenter", () => interaction.setHover(row.key));
      item.addEventListener("mouseleave", () => interaction.setHover(null));
      item.addEventListener("focus", () => interaction.setHover(row.key));
      item.addEventListener("blur", () => interaction.setHover(null));
      const toggleLock = () => interaction.toggleLock(row.key);
      item.addEventListener("click", toggleLock);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleLock();
        }
      });
      interaction.rowElements.set(row.key, item);
      list.appendChild(item);
    }
    return list;
  }

  function periodTitle(data) {
    if (view.period === "today") {
      return formatDate(data.anchorDate, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    }
    if (view.period === "week") {
      const end = addLocalDays(data.startDate, 6);
      return `${formatDate(data.startDate, { month: "short", day: "numeric" })} — ${formatDate(end, { month: "short", day: "numeric" })}`;
    }
    if (view.period === "month") {
      return formatDate(`${data.anchorDate.slice(0, 7)}-01`, { year: "numeric", month: "long" });
    }
    return formatDate(`${data.anchorDate.slice(0, 4)}-01-01`, { year: "numeric" });
  }

  function cellWhen(cell) {
    const date = formatDate(cell.localDate, { month: "short", day: "numeric", weekday: "short" });
    return cell.hour === null ? date : `${date} ${formatHour(cell.hour)}`;
  }

  function cellAriaLabel(cell, rowByKey) {
    const when = cellWhen(cell);
    let text;
    if (cell.state === "activity") {
      text = replace(t("recapCellActivity"), { when, count: formatNumber(cell.total) });
      const details = cell.counts
        .slice()
        .sort((left, right) => right.count - left.count)
        .map((entry) => {
          const row = rowByKey.get(entry.rowKey) || entry;
          return `${rowDisplayName(row)} ${formatNumber(entry.count)}`;
        });
      if (details.length) text += ` · ${details.join(" · ")}`;
    } else if (cell.state === "covered") {
      text = replace(t("recapDayCovered"), { date: when });
    } else if (cell.state === "partial") {
      text = replace(t("recapDayPartial"), { date: when });
    } else if (cell.state === "uncovered") {
      text = replace(t("recapDayUncovered"), { date: when });
    } else if (cell.state === "future") {
      text = replace(t("recapCellFuture"), { when });
    } else if (cell.state === "not-started") {
      text = replace(t("recapCellNotStarted"), { when });
    } else if (cell.state === "gap") {
      text = replace(t("recapCellGap"), { when });
    } else {
      text = when;
    }
    if (cell.kind === "fold") text += ` · ${t("recapCellFold")}`;
    return text;
  }

  function buildTimeline(data, summary, interaction) {
    const model = buildTimelineModel(data, view.period);
    const rowByKey = new Map(summary.rows.map((row) => [row.key, row]));
    const section = document.createElement("section");
    section.className = "recap-visual";
    interaction.visual = section;
    const heading = document.createElement("div");
    heading.className = "recap-visual-heading";
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = t("recapTimelineLabel");
    const headingDetail = document.createElement("span");
    headingDetail.textContent = t(view.period === "today"
      ? "recapTimelineTodayBars"
      : view.period === "week" ? "recapTimelineHours" : "recapTimelineDays");
    heading.appendChild(headingTitle);
    heading.appendChild(headingDetail);
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = `recap-grid recap-grid-${view.period}`;
    grid.setAttribute("data-settings-focus-key", `recap-grid-${view.period}`);
    grid.tabIndex = 0;
    grid.setAttribute("role", "grid");
    grid.setAttribute("aria-label", t("recapGridInstructions"));
    grid.setAttribute("aria-rowcount", String(model.rows));
    grid.setAttribute("aria-colcount", String(model.columns));
    interaction.grid = grid;
    const serial = ++renderSerial;
    const cellElements = [];
    let renderedCellCount = 0;
    const todayBarMaximum = view.period === "today"
      ? Math.max(1, ...model.cells.map((cell) => cell.total))
      : 1;

    function appendCell(cell, parent, rowIndex, columnIndex) {
      const element = document.createElement("div");
      element.id = `recap-cell-${serial}-${renderedCellCount}`;
      renderedCellCount += 1;
      element.className = `recap-cell recap-cell-${cell.state}`;
      if (view.period === "today") element.classList.add("recap-bar-slot");
      element.dataset.cellKey = cell.key;
      if (cell.state === "blank") {
        element.setAttribute("role", "presentation");
        element.setAttribute("aria-hidden", "true");
        parent.appendChild(element);
        return;
      }
      element.setAttribute("role", "gridcell");
      element.setAttribute("aria-rowindex", String(rowIndex));
      element.setAttribute("aria-colindex", String(columnIndex));
      const label = cellAriaLabel(cell, rowByKey);
      element.setAttribute("aria-label", label);
      element.title = label;
      if (view.period === "today") {
        element.dataset.barMaximum = String(todayBarMaximum);
        setTodayBarLevel(element, cell.total);
        const fill = document.createElement("span");
        fill.className = "recap-bar-fill";
        fill.setAttribute("aria-hidden", "true");
        element.appendChild(fill);
      }
      if (cell.state === "activity") element.classList.add(`recap-depth-${depthOf(cell.total)}`);
      if (cell.kind === "fold") element.classList.add("recap-cell-fold");
      if (cell.dayNumber && view.period === "month") {
        const dayNumber = document.createElement("span");
        dayNumber.className = "recap-day-number";
        dayNumber.textContent = formatNumber(cell.dayNumber);
        dayNumber.setAttribute("aria-hidden", "true");
        element.appendChild(dayNumber);
      }
      if (cell.state === "activity" || cell.kind === "fold") {
        element.addEventListener("mouseenter", () => interaction.showPeek(cell, element, rowByKey));
        element.addEventListener("mouseleave", interaction.clearPeek);
      }
      interaction.cellElements.set(cell.key, { cell, element });
      cellElements.push({ cell, element, rowIndex, columnIndex });
      parent.appendChild(element);
    }

    if (view.period === "today") {
      const band = document.createElement("div");
      band.className = "recap-band recap-today-band";
      band.setAttribute("role", "row");
      model.cells.forEach((cell, index) => appendCell(cell, band, 1, index + 1));
      grid.appendChild(band);
      const labels = document.createElement("div");
      labels.className = "recap-hour-labels";
      labels.setAttribute("aria-hidden", "true");
      for (let hour = 0; hour < 24; hour += 1) {
        const label = document.createElement("span");
        label.textContent = hour % 3 === 0 ? formatNumber(hour, { minimumIntegerDigits: 2, useGrouping: false }) : "";
        labels.appendChild(label);
      }
      grid.appendChild(labels);
    } else if (view.period === "week") {
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const row = document.createElement("div");
        row.className = "recap-week-row";
        row.setAttribute("role", "row");
        const localDate = addLocalDays(model.startDate, dayIndex);
        const label = document.createElement("span");
        label.className = "recap-row-label";
        label.textContent = formatDate(localDate, { weekday: "narrow" });
        label.setAttribute("aria-hidden", "true");
        row.appendChild(label);
        const band = document.createElement("div");
        band.className = "recap-band";
        model.cells.slice(dayIndex * 24, (dayIndex + 1) * 24).forEach((cell, hour) => {
          appendCell(cell, band, dayIndex + 1, hour + 1);
        });
        row.appendChild(band);
        grid.appendChild(row);
      }
    } else if (view.period === "month") {
      const weekdays = document.createElement("div");
      weekdays.className = "recap-month-weekdays";
      weekdays.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 7; index += 1) {
        const label = document.createElement("span");
        label.textContent = formatDate(addLocalDays("2026-08-24", index), { weekday: "narrow" });
        label.setAttribute("aria-hidden", "true");
        weekdays.appendChild(label);
      }
      grid.appendChild(weekdays);
      const month = document.createElement("div");
      month.className = "recap-month-grid";
      month.setAttribute("role", "rowgroup");
      for (let rowIndex = 0; rowIndex < model.rows; rowIndex += 1) {
        const row = document.createElement("div");
        row.className = "recap-month-row";
        row.setAttribute("role", "row");
        model.cells.slice(rowIndex * 7, (rowIndex + 1) * 7).forEach((cell, columnIndex) => {
          appendCell(cell, row, rowIndex + 1, columnIndex + 1);
        });
        month.appendChild(row);
      }
      grid.appendChild(month);
    } else {
      for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
        const row = document.createElement("div");
        row.className = "recap-year-row";
        row.setAttribute("role", "row");
        const label = document.createElement("span");
        label.className = "recap-row-label";
        label.textContent = formatDate(`${data.anchorDate.slice(0, 4)}-${String(monthIndex + 1).padStart(2, "0")}-01`, { month: "narrow" });
        label.setAttribute("aria-hidden", "true");
        row.appendChild(label);
        const band = document.createElement("div");
        band.className = "recap-band";
        model.cells.slice(monthIndex * 31, (monthIndex + 1) * 31).forEach((cell, dayIndex) => {
          appendCell(cell, band, monthIndex + 1, dayIndex + 1);
        });
        row.appendChild(band);
        grid.appendChild(row);
      }
    }

    const live = document.createElement("div");
    live.className = "recap-sr-only";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    interaction.live = live;
    interaction.cellList = cellElements;
    view.gridIndex = Math.max(0, Math.min(view.gridIndex, cellElements.length - 1));
    interaction.selectGridCell(view.gridIndex, false);
    grid.addEventListener("focus", () => interaction.selectGridCell(view.gridIndex, true));
    grid.addEventListener("keydown", (event) => {
      let next = view.gridIndex;
      if (event.key === "ArrowRight") next += 1;
      else if (event.key === "ArrowLeft") next -= 1;
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const current = cellElements[view.gridIndex];
        const direction = event.key === "ArrowDown" ? 1 : -1;
        let targetRow = current ? current.rowIndex + direction : 0;
        let target = -1;
        while (current && targetRow >= 1 && targetRow <= model.rows && target === -1) {
          target = cellElements.findIndex((entry) =>
            entry.rowIndex === targetRow && entry.columnIndex === current.columnIndex);
          targetRow += direction;
        }
        if (target !== -1) next = target;
      }
      else if (event.key === "Home" || event.key === "End") {
        if (event.ctrlKey || event.metaKey) {
          next = event.key === "Home" ? 0 : cellElements.length - 1;
        } else {
          const current = cellElements[view.gridIndex];
          const sameRow = current
            ? cellElements.map((entry, index) => ({ entry, index }))
              .filter(({ entry }) => entry.rowIndex === current.rowIndex)
            : [];
          if (sameRow.length > 0) {
            next = event.key === "Home"
              ? sameRow[0].index
              : sameRow[sameRow.length - 1].index;
          }
        }
      }
      else return;
      event.preventDefault();
      interaction.selectGridCell(Math.max(0, Math.min(next, cellElements.length - 1)), true);
    });
    section.appendChild(grid);
    section.appendChild(live);
    return section;
  }

  function buildDataCard(data) {
    const summary = summarize(data);
    const card = document.createElement("section");
    card.className = "recap-card";
    const heading = document.createElement("div");
    heading.className = "recap-card-heading";
    const titleWrap = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = periodTitle(data);
    const since = document.createElement("p");
    since.textContent = replace(t("recapRecordingSince"), {
      date: formatDate(data.recordingStartedDate || data.anchorDate, { year: "numeric", month: "short", day: "numeric" }),
    });
    titleWrap.appendChild(title);
    titleWrap.appendChild(since);
    const paw = document.createElement("span");
    paw.className = "recap-paw";
    paw.textContent = "🐾";
    paw.setAttribute("aria-hidden", "true");
    heading.appendChild(titleWrap);
    heading.appendChild(paw);
    card.appendChild(heading);

    const lede = document.createElement("p");
    lede.className = "recap-lede";
    lede.textContent = replace(t("recapHeadline"), { count: formatNumber(summary.agentCount) });
    const hint = document.createElement("span");
    hint.textContent = t("recapInteractionHint");
    lede.appendChild(hint);
    card.appendChild(lede);

    const interaction = {
      rowElements: new Map(),
      cellElements: new Map(),
      cellList: [],
      grid: null,
      live: null,
      visual: null,
      peekTimer: null,
      popover: null,
      peekElement: null,
      peekCell: null,
      setHover(key) {
        view.hoverRowKey = key;
        this.applyHighlight();
      },
      toggleLock(key) {
        view.lockedRowKey = view.lockedRowKey === key ? null : key;
        this.applyHighlight();
      },
      applyHighlight() {
        const activeKey = view.hoverRowKey || view.lockedRowKey;
        if (this.grid) this.grid.classList.toggle("recap-grid-dim", !!activeKey);
        let hitCount = 0;
        for (const { cell, element } of this.cellElements.values()) {
          element.classList.remove("recap-cell-hit", "recap-depth-1", "recap-depth-2", "recap-depth-3");
          element.style.removeProperty("--recap-cell-color");
          const match = activeKey && cell.counts.find((entry) => entry.rowKey === activeKey);
          if (match) {
            hitCount += 1;
            const row = summary.rows.find((candidate) => candidate.key === activeKey);
            element.classList.add("recap-cell-hit", `recap-depth-${depthOf(match.count)}`);
            element.style.setProperty("--recap-cell-color", agentColorToken(row ? row.agentId : match.agentId));
          } else if (cell.state === "activity") {
            element.classList.add(`recap-depth-${depthOf(cell.total)}`);
          }
          if (view.period === "today") setTodayBarLevel(element, match ? match.count : cell.total);
        }
        for (const [key, element] of this.rowElements) {
          element.classList.toggle("active", key === activeKey);
          element.setAttribute("aria-pressed", view.lockedRowKey === key ? "true" : "false");
        }
        if (activeKey && this.live) {
          const row = summary.rows.find((candidate) => candidate.key === activeKey);
          const unitKey = view.period === "today" || view.period === "week"
            ? "recapCellUnitHour"
            : "recapCellUnitDay";
          this.live.textContent = replace(t("recapLookingAt"), {
            agent: row ? rowDisplayName(row) : "",
            count: formatNumber(hitCount),
            unit: t(unitKey),
          });
        } else if (this.live) this.live.textContent = "";
      },
      clearPeek: () => {
        if (interaction.peekTimer) clearTimeout(interaction.peekTimer);
        interaction.peekTimer = null;
        if (interaction.peekElement) {
          interaction.peekElement.classList.remove("recap-cell-peek");
          const segments = interaction.peekElement.querySelector(".recap-cell-segments");
          if (segments) segments.remove();
          if (view.period === "today" && interaction.peekCell) {
            const activeKey = view.hoverRowKey || view.lockedRowKey;
            const match = activeKey
              && interaction.peekCell.counts.find((entry) => entry.rowKey === activeKey);
            setTodayBarLevel(
              interaction.peekElement,
              match ? match.count : interaction.peekCell.total
            );
          }
        }
        interaction.peekElement = null;
        interaction.peekCell = null;
        if (interaction.popover) interaction.popover.remove();
        interaction.popover = null;
      },
      showPeek(cell, element, rowByKey) {
        this.clearPeek();
        const entries = cell.counts.slice().sort((left, right) => right.count - left.count);
        if (entries.length === 0 && cell.kind !== "fold") return;
        this.peekElement = element;
        this.peekCell = cell;
        element.classList.add("recap-cell-peek");
        if (view.period === "today") setTodayBarLevel(element, cell.total);
        if (entries.length > 0) {
          const segments = document.createElement("span");
          segments.className = "recap-cell-segments";
          segments.setAttribute("aria-hidden", "true");
          for (const entry of entries) {
            const segment = document.createElement("i");
            segment.style.background = agentColorToken(entry.agentId);
            segment.style.flex = `${entry.count} 1 0%`;
            segments.appendChild(segment);
          }
          const segmentHost = element.querySelector(".recap-bar-fill") || element;
          segmentHost.appendChild(segments);
        }
        this.peekTimer = setTimeout(() => {
          this.peekTimer = null;
          if (this.peekElement !== element || !element.parentNode) return;
          const popover = document.createElement("div");
          popover.className = "recap-cell-popover";
          popover.setAttribute("aria-hidden", "true");
          const popTitle = document.createElement("strong");
          popTitle.textContent = `${cellWhen(cell)} · ${replace(t("recapTooltipTotal"), { count: formatNumber(cell.total) })}`;
          popover.appendChild(popTitle);
          if (cell.kind === "fold") {
            const foldNote = document.createElement("p");
            foldNote.className = "recap-cell-popover-note";
            foldNote.textContent = t("recapCellFold");
            popover.appendChild(foldNote);
          }
          for (const entry of entries) {
            const row = rowByKey.get(entry.rowKey) || entry;
            const detail = document.createElement("div");
            const swatch = document.createElement("i");
            swatch.style.background = agentColorToken(entry.agentId);
            const name = document.createElement("span");
            name.textContent = rowDisplayName(row);
            const value = document.createElement("em");
            value.textContent = replace(t("recapTooltipAgent"), {
              count: formatNumber(entry.count),
              percent: formatNumber(Math.round(entry.count / cell.total * 100)),
            });
            detail.appendChild(swatch);
            detail.appendChild(name);
            detail.appendChild(value);
            popover.appendChild(detail);
          }
          this.visual.appendChild(popover);
          this.popover = popover;
          if (typeof this.visual.getBoundingClientRect === "function" && typeof element.getBoundingClientRect === "function") {
            const wrapperRect = this.visual.getBoundingClientRect();
            const anchor = element.querySelector(".recap-bar-fill") || element;
            const cellRect = anchor.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            let left = cellRect.left - wrapperRect.left + cellRect.width / 2 - popRect.width / 2;
            left = Math.max(0, Math.min(left, Math.max(0, wrapperRect.width - popRect.width)));
            let top = cellRect.top - wrapperRect.top - popRect.height - 7;
            if (top < 0) top = cellRect.bottom - wrapperRect.top + 7;
            popover.style.left = `${left}px`;
            popover.style.top = `${top}px`;
          }
          popover.classList.add("show");
        }, 90);
      },
      selectGridCell(index, announce) {
        if (!this.cellList.length) return;
        view.gridIndex = Math.max(0, Math.min(index, this.cellList.length - 1));
        this.cellList.forEach(({ element }, cellIndex) => {
          element.classList.toggle("recap-cell-keyboard", cellIndex === view.gridIndex);
        });
        const current = this.cellList[view.gridIndex].element;
        if (this.grid) this.grid.setAttribute("aria-activedescendant", current.id);
        if (announce && this.live) this.live.textContent = current.getAttribute("aria-label") || "";
      },
    };

    card.appendChild(buildAgentRows(summary, interaction));
    card.appendChild(buildTimeline(data, summary, interaction));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!view.lockedRowKey && !interaction.peekElement) return;
      event.preventDefault();
      view.lockedRowKey = null;
      interaction.clearPeek();
      interaction.applyHighlight();
    });
    interaction.applyHighlight();
    return card;
  }

  function buildRecordingControls() {
    const rows = [];
    const enabled = !!(coreState.snapshot && coreState.snapshot.recapEnabled !== false);
    const switchRow = document.createElement("div");
    switchRow.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.id = "recap-recording-label";
    label.textContent = t("recapRecordingLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.id = "recap-recording-description";
    desc.textContent = t("recapRecordingDesc");
    text.appendChild(label);
    text.appendChild(desc);
    switchRow.appendChild(text);
    const control = document.createElement("div");
    control.className = "row-control";
    const toggle = () => {
      if (view.togglePending || !window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
      view.togglePending = true;
      ops.requestRender({ content: true, preserveScroll: true });
      Promise.resolve(window.settingsAPI.update("recapEnabled", !enabled)).then((result) => {
        if (!result || result.status !== "ok") throw new Error("save failed");
        reload();
      }).catch(() => ops.showToast(t("recapToggleFailed"), { error: true })).finally(() => {
        view.togglePending = false;
        if (coreState.activeTab === "recap") ops.requestRender({ content: true, preserveScroll: true });
      });
    };
    const switchControl = helpers.buildSwitch({
      checked: enabled,
      pending: view.togglePending,
      ariaLabelledBy: label.id,
      ariaDescribedBy: desc.id,
      onToggle: toggle,
    });
    const sw = switchControl.element;
    sw.setAttribute("data-settings-focus-key", "recap-recording-toggle");
    control.appendChild(sw);
    switchRow.appendChild(control);
    rows.push(switchRow);

    const clearRow = document.createElement("div");
    clearRow.className = "row";
    const clearText = document.createElement("div");
    clearText.className = "row-text";
    const clearLabel = document.createElement("span");
    clearLabel.className = "row-label";
    clearLabel.textContent = t("recapClearLabel");
    const clearDesc = document.createElement("span");
    clearDesc.className = "row-desc";
    clearDesc.textContent = t("recapClearDesc");
    clearText.appendChild(clearLabel);
    clearText.appendChild(clearDesc);
    clearRow.appendChild(clearText);
    const clearControl = document.createElement("div");
    clearControl.className = "row-control";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "soft-btn danger";
    clearButton.setAttribute("data-settings-focus-key", "recap-clear");
    clearButton.setAttribute("data-settings-focus-fallback-key", "recap-recording-toggle");
    clearButton.textContent = view.clearPending ? t("recapClearing") : t("recapClearAction");
    clearButton.disabled = view.clearPending;
    clearButton.addEventListener("click", async () => {
      if (view.clearPending || !window.settingsAPI || typeof window.settingsAPI.clearRecap !== "function") return;
      const action = await helpers.showSettingsConfirmModal({
        title: t("recapClearConfirmTitle"),
        detail: t("recapClearConfirmDetail"),
        actions: [
          { id: "cancel", label: t("recapCancel"), tone: "neutral", defaultFocus: true },
          { id: "confirm", label: t("recapClearConfirmAction"), tone: "danger" },
        ],
      });
      if (action !== "confirm") return;
      view.clearPending = true;
      ops.requestRender({ content: true, preserveScroll: true });
      try {
        const result = await window.settingsAPI.clearRecap();
        if (!result || result.status !== "ok") throw new Error("clear failed");
        ops.showToast(t("recapClearDone"));
        reload();
      } catch {
        ops.showToast(t("recapClearFailed"), { error: true });
      } finally {
        view.clearPending = false;
        if (coreState.activeTab === "recap") ops.requestRender({ content: true, preserveScroll: true });
      }
    });
    clearControl.appendChild(clearButton);
    clearRow.appendChild(clearControl);
    rows.push(clearRow);
    return helpers.buildSection(t("recapPrivacyTitle"), rows);
  }

  function render(parent) {
    const header = document.createElement("div");
    header.className = "recap-page-header";
    const title = document.createElement("h1");
    title.textContent = t("recapTitle");
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("recapSubtitle");
    header.appendChild(title);
    header.appendChild(subtitle);
    header.appendChild(buildPeriodTabs());
    parent.appendChild(header);

    if (view.status === "idle") requestData();
    else refreshIfNeeded();
    if (view.status === "loading" || view.status === "idle") {
      const loading = document.createElement("div");
      loading.className = "recap-state-card";
      loading.setAttribute("role", "status");
      loading.textContent = t("recapLoading");
      parent.appendChild(loading);
    } else if (view.status === "ready") {
      parent.appendChild(buildDataCard(view.data));
    } else {
      const error = document.createElement("div");
      error.className = "recap-state-card recap-error";
      error.setAttribute("role", "alert");
      error.textContent = t(view.status === "unavailable" ? "recapUnavailable" : "recapLoadFailed");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "soft-btn";
      retry.textContent = t("recapRetry");
      retry.setAttribute("data-settings-focus-key", `recap-retry-${view.period}`);
      retry.setAttribute("data-settings-focus-fallback-key", `recap-period-${view.period}`);
      retry.addEventListener("click", reload);
      error.appendChild(retry);
      parent.appendChild(error);
    }
    parent.appendChild(buildRecordingControls());
  }

  function init(core) {
    coreState = core.state;
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") refreshIfNeeded();
      });
    }
    core.tabs.recap = {
      render,
      applyDataChanged,
      patchInPlace(changes) {
        if (!changes || !Object.hasOwn(changes, "recapEnabled")) return false;
        reload();
        return false;
      },
    };
  }

  root.ClawdSettingsTabRecap = {
    init,
    __test: {
      agentColorToken,
      barRatio,
      buildTimelineModel,
      depthOf,
      summarize,
    },
  };
})(globalThis);
