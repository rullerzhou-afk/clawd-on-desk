"use strict";

(function initSettingsTabRecap(root) {
  let coreState = null;
  let runtime = null;
  let helpers = null;
  let ops = null;
  let renderSerial = 0;
  let mountedHost = null;
  let mountedBody = null;
  let mountedLoading = null;
  let loadingTimer = null;
  let mountedInteraction = null;

  function clearLoadingIndicator() {
    if (loadingTimer !== null) clearTimeout(loadingTimer);
    loadingTimer = null;
  }

  function clearInteraction() {
    if (mountedInteraction) mountedInteraction.clearPeek();
    mountedInteraction = null;
  }

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
    gridIndex: null,
  };

  function t(key) {
    return helpers.t(key);
  }

  function locale() {
    const lang = coreState && coreState.snapshot && coreState.snapshot.lang;
    return ({ zh: "zh-CN", "zh-TW": "zh-TW", ko: "ko-KR", ja: "ja-JP", "pt-BR": "pt-BR", es: "es" })[lang] || "en";
  }

  // A local-year render asks for a few hundred formatted labels and numbers.
  // Intl formatter construction is one to two orders of magnitude more
  // expensive than format(), so keep one formatter per locale/options pair.
  // The key set is bounded by the literals used in this file times the number
  // of locales a long-lived window can switch through, and the cap keeps a
  // pathological caller from growing it without bound.
  const FORMATTER_CACHE_LIMIT = 64;
  const FORMATTED_DATE_CACHE_LIMIT = 1024;
  const dateFormatCache = new Map();
  const numberFormatCache = new Map();
  const formattedDateCache = new Map();
  const optionKeyCache = new WeakMap();

  const DATE_OPTIONS_TODAY_TITLE = Object.freeze({ year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const DATE_OPTIONS_WEEK_ENDPOINT = Object.freeze({ month: "short", day: "numeric" });
  const DATE_OPTIONS_MONTH_TITLE = Object.freeze({ year: "numeric", month: "long" });
  const DATE_OPTIONS_YEAR_TITLE = Object.freeze({ year: "numeric" });
  const DATE_OPTIONS_CELL_WHEN = Object.freeze({ month: "short", day: "numeric", weekday: "short" });
  const DATE_OPTIONS_WEEKDAY_NARROW = Object.freeze({ weekday: "narrow" });
  const DATE_OPTIONS_MONTH_SHORT = Object.freeze({ month: "short" });
  const DATE_OPTIONS_SINCE = Object.freeze({ year: "numeric", month: "short", day: "numeric" });
  const NUMBER_OPTIONS_TWO_DIGIT = Object.freeze({ minimumIntegerDigits: 2, useGrouping: false });

  function optionCacheKey(options) {
    if (!options || typeof options !== "object") return "";
    let key = optionKeyCache.get(options);
    if (key === undefined) {
      key = JSON.stringify(options);
      optionKeyCache.set(options, key);
    }
    return key;
  }

  function createDateFormat(lang, options) {
    return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...options });
  }

  function createNumberFormat(lang, options) {
    return new Intl.NumberFormat(lang, options);
  }

  function cachedFormatter(cache, options, create) {
    const lang = locale();
    const key = `${lang}\0${optionCacheKey(options)}`;
    let formatter = cache.get(key);
    if (!formatter) {
      if (cache.size >= FORMATTER_CACHE_LIMIT) cache.clear();
      formatter = create(lang, options);
      cache.set(key, formatter);
    }
    return formatter;
  }

  function formatNumber(value, options) {
    return cachedFormatter(numberFormatCache, options, createNumberFormat).format(value);
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
    const raw = String(localDate || "");
    const lang = locale();
    const cacheKey = `${lang}\0${raw}\0${optionCacheKey(options)}`;
    const cached = formattedDateCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const date = parseLocalDate(raw);
    const formatted = date
      ? cachedFormatter(dateFormatCache, options, createDateFormat).format(date)
      : raw;
    if (formattedDateCache.size >= FORMATTED_DATE_CACHE_LIMIT) formattedDateCache.clear();
    formattedDateCache.set(cacheKey, formatted);
    return formatted;
  }

  function formatHour(hour) {
    return `${formatNumber(hour, NUMBER_OPTIONS_TWO_DIGIT)}:00`;
  }

  function requestData() {
    if (view.status !== "idle") return;
    view.status = "loading";
    const requestSeq = ++view.requestSeq;
    const period = view.period;
    Promise.resolve().then(() => {
      if (!window.settingsAPI || typeof window.settingsAPI.queryRecap !== "function") {
        throw new Error("recap API unavailable");
      }
      return window.settingsAPI.queryRecap(period);
    }).then((result) => {
      if (requestSeq !== view.requestSeq) return;
      if (!result || result.status !== "ready") {
        view.status = result && result.status === "unavailable" ? "unavailable" : "error";
        view.data = result || null;
      } else {
        view.status = "ready";
        view.data = result;
      }
      refreshBody();
      refreshIfNeeded();
    }).catch(() => {
      if (requestSeq !== view.requestSeq) return;
      view.status = "error";
      view.data = null;
      refreshBody();
      refreshIfNeeded();
    });
  }

  function refreshIfNeeded() {
    if (!view.refreshQueued || view.refreshInFlight) return;
    if (coreState.activeTab !== "recap") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    // A rebuild that starts mid-scroll lands inside the frame the user is
    // waiting on, and the cards are rebuilt whole. Hold the refresh until the
    // pane has been quiet for a moment instead of dropping frames.
    if (scrollActivity.scrolling) {
      scrollActivity.pendingRefresh = true;
      return;
    }
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
          if (mountedInteraction && mountedInteraction.patchDataInPlace(result)) {
            syncRecordingDescription();
          } else {
            refreshBody();
          }
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

  // Scroll activity of the Settings pane. The Recap page is the tallest page in
  // Settings, and both of its live behaviours are hostile to a frame that is
  // already busy scrolling: a card rebuild changes the whole subtree, and a cell
  // hover popover is built and measured against the layout. Chromium re-resolves
  // the hover target as content streams under a resting pointer, so during a
  // scroll those mouseenter handlers can fire dozens of times per second.
  // Both are therefore deferred to the quiet window after the scroll stops.
  const SCROLL_QUIET_MS = 260;
  const scrollActivity = {
    scroller: null,
    bound: false,
    scrolling: false,
    timer: null,
    pendingRefresh: false,
    pendingPeek: null,
  };

  function onContentScroll() {
    if (scrollActivity.timer !== null) clearTimeout(scrollActivity.timer);
    if (!scrollActivity.scrolling) {
      scrollActivity.scrolling = true;
      if (mountedInteraction) mountedInteraction.clearPeek();
    }
    scrollActivity.timer = setTimeout(() => {
      scrollActivity.timer = null;
      scrollActivity.scrolling = false;
      if (scrollActivity.pendingRefresh) {
        scrollActivity.pendingRefresh = false;
        view.refreshQueued = true;
        refreshIfNeeded();
      }
      if (scrollActivity.pendingPeek && mountedInteraction) {
        const { cell, element, rowByKey } = scrollActivity.pendingPeek;
        scrollActivity.pendingPeek = null;
        mountedInteraction.showPeek(cell, element, rowByKey);
      }
    }, SCROLL_QUIET_MS);
  }

  function unbindScrollActivity() {
    if (scrollActivity.timer !== null) clearTimeout(scrollActivity.timer);
    scrollActivity.timer = null;
    scrollActivity.scrolling = false;
    scrollActivity.pendingRefresh = false;
    scrollActivity.pendingPeek = null;
    if (scrollActivity.bound && scrollActivity.scroller
      && typeof scrollActivity.scroller.removeEventListener === "function") {
      scrollActivity.scroller.removeEventListener("scroll", onContentScroll);
    }
    scrollActivity.scroller = null;
    scrollActivity.bound = false;
  }

  function bindScrollActivity() {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    const scroller = document.getElementById("content");
    if (!scroller || typeof scroller.addEventListener !== "function") return;
    if (scrollActivity.bound && scrollActivity.scroller === scroller) return;
    unbindScrollActivity();
    scrollActivity.scroller = scroller;
    scrollActivity.bound = true;
    scroller.addEventListener("scroll", onContentScroll, { passive: true });
  }

  function resetInteraction() {
    view.hoverRowKey = null;
    view.lockedRowKey = null;
    view.gridIndex = null;
  }

  function reload({ retainContent = false } = {}) {
    view.requestSeq += 1;
    view.status = "idle";
    view.data = null;
    view.refreshQueued = false;
    resetInteraction();
    if (coreState.activeTab === "recap") {
      requestData();
      refreshBody({ retainContent });
    }
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
            turnsCompleted: 0,
            toolCalls: 0,
            activityEvents: 0,
          };
          rows.set(key, row);
        }
        const metrics = source.metrics || {};
        row.turnsCompleted = combineMetric(row.turnsCompleted, metrics.turnsCompleted);
        row.toolCalls = combineMetric(row.toolCalls, metrics.toolCalls);
        row.activityEvents += Number.isSafeInteger(metrics.activityEvents) ? metrics.activityEvents : 0;
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

  const EMPTY_DAY_METRICS = Object.freeze({
    coverage: null,
    coveredTotal: 0,
    capacities: null,
    hasShape: false,
    targets: null,
    expectedTotal: 0,
  });

  // Everything a cell needs from its local day, derived once per day instead of
  // once per cell. A year grid renders 372 cells, and the old per-cell path
  // allocated a 24-slot coverage array plus a 24-slot capacity array (and a
  // closure) for every one of them. Hour-cell geometries (today/week) keep the
  // per-hour arrays; day-cell geometries (month/year) only need the totals.
  function dayMetrics(data, localDate, day, hourly) {
    if (!hourly && (!day || !day.coverage || !Array.isArray(day.coverage.coverageMinutes))) {
      return EMPTY_DAY_METRICS;
    }
    const hasShape = !!(day && (
      Array.isArray(day.hourCapacities)
      || (day.coverage && Array.isArray(day.coverage.hourCapacities))
    ));
    const minutes = day && day.coverage && Array.isArray(day.coverage.coverageMinutes)
      ? day.coverage.coverageMinutes
      : [];
    const coverage = hourly ? new Array(24) : null;
    const capacities = hourly ? new Array(24) : null;
    const targets = hourly ? new Array(24) : null;
    let coveredTotal = 0;
    const startedDate = data.recordingStartedDate || data.startDate || data.anchorDate;
    const startedHour = localDate === startedDate && Number.isInteger(data.recordingStartedLocalHour)
      ? data.recordingStartedLocalHour
      : 0;
    const endHour = localDate === data.anchorDate && Number.isInteger(data.currentLocalHour)
      ? data.currentLocalHour
      : 23;
    const startedMinute = data.recordingStartedLocalMinute;
    const startedElapsed = data.recordingStartedHourElapsedMinutes;
    const currentMinute = data.currentLocalMinute;
    const currentElapsed = data.currentHourElapsedMinutes;
    let expectedTotal = 0;
    for (let hour = 0; hour < 24; hour += 1) {
      const coveredValue = Number(minutes[hour]);
      const coveredMinutes = Number.isFinite(coveredValue) && coveredValue > 0 ? coveredValue : 0;
      if (coverage) coverage[hour] = coveredMinutes;
      coveredTotal += coveredMinutes;
      const known = Math.max(
        Number(day && Array.isArray(day.hourCapacities) ? day.hourCapacities[hour] : 0) || 0,
        Number(day && day.coverage && Array.isArray(day.coverage.hourCapacities)
          ? day.coverage.hourCapacities[hour]
          : 0) || 0
      );
      const capacity = hasShape ? known : 60;
      if (capacities) capacities[hour] = capacity;
      let target = 0;
      if (hour >= startedHour && hour <= endHour) {
        let eligibleStart = 0;
        let eligibleEnd = capacity;
        if (localDate === startedDate && hour === startedHour && Number.isInteger(startedMinute)) {
          eligibleStart = Number.isInteger(startedElapsed) ? startedElapsed : startedMinute;
        }
        if (localDate === data.anchorDate && hour === endHour && Number.isInteger(currentMinute)) {
          eligibleEnd = Number.isInteger(currentElapsed) ? currentElapsed : currentMinute;
        }
        target = Math.max(0, Math.min(capacity, eligibleEnd) - Math.min(capacity, eligibleStart));
      }
      if (targets) targets[hour] = target;
      expectedTotal += target;
    }
    return { coverage, coveredTotal, capacities, hasShape, targets, expectedTotal };
  }

  function hourKind(metrics, hour) {
    const capacity = metrics.capacities[hour];
    if (capacity > 60) return "fold";
    if (metrics.hasShape && capacity === 0) return "gap";
    if (capacity > 0 && capacity < 60) return "gap";
    return "normal";
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

  function classifyCell(data, localDate, hour, metricsFor, counts, kind, invalid = false) {
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    if (invalid) return { state: "blank", total, counts, kind: "normal" };
    // A DST gap is not a zero, a future slot, or a pre-recording slot: this
    // local hour did not exist at all.
    // A zero-capacity gap did not exist. Partial-hour transitions (for
    // example Lord Howe's 30-minute jump) still have real time in which
    // activity and coverage can occur, so they must continue through the
    // normal classification path.
    if (kind === "gap" && hour !== null && metricsFor().capacities[hour] === 0) {
      return { state: "gap", total: 0, counts: [], kind };
    }
    const anchorDate = data.anchorDate;
    const afterToday = compareLocalDates(localDate, anchorDate) > 0;
    const futureHour = hour !== null
      && localDate === anchorDate
      && hour > (Number.isInteger(data.currentLocalHour) ? data.currentLocalHour : 23);
    // Historical local hours remain frozen after a timezone change. Existing
    // activity and coverage are evidence, even if today's clock is now behind.
    if (total > 0) return { state: "activity", total, counts, kind };
    // The per-day metrics are only needed for the coverage path, so an active
    // day never pays to derive them.
    const metrics = metricsFor();
    const coveredMinutes = hour === null ? metrics.coveredTotal : metrics.coverage[hour];
    const expectedMinutes = hour === null ? metrics.expectedTotal : metrics.targets[hour];
    if (coveredMinutes > 0) {
      return {
        state: expectedMinutes > 0 && coveredMinutes >= expectedMinutes ? "covered" : "partial",
        total: 0,
        counts: [],
        kind,
      };
    }
    if (afterToday || futureHour) return { state: "future", total: 0, counts: [], kind: "normal" };
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

  function createCell(data, localDate, hour, day, metricsFor, optionsValue = {}) {
    const getMetrics = () => metricsFor(localDate, day);
    const counts = hour === null ? countsForDay(day) : countsForHour(day, hour);
    const kind = hour === null ? "normal" : hourKind(getMetrics(), hour);
    return {
      key: hour === null ? localDate : `${localDate}T${String(hour).padStart(2, "0")}`,
      localDate,
      hour,
      dayNumber: optionsValue.dayNumber || null,
      ...classifyCell(data, localDate, hour, getMetrics, counts, kind, optionsValue.invalid === true),
    };
  }

  function buildTimelineModel(data, period) {
    const dayMap = new Map((data.days || []).map((day) => [day.localDate, day]));
    const hourly = period === "today" || period === "week";
    const metricsByDate = new Map();
    function metricsFor(localDate, day) {
      let metrics = metricsByDate.get(localDate);
      if (!metrics) {
        metrics = dayMetrics(data, localDate, day, hourly);
        metricsByDate.set(localDate, metrics);
      }
      return metrics;
    }
    const cells = [];
    let columns = 24;
    let rows = 1;
    let startDate = data.startDate;
    if (period === "today") {
      const day = dayMap.get(data.anchorDate);
      for (let hour = 0; hour < 24; hour += 1) {
        cells.push(createCell(data, data.anchorDate, hour, day, metricsFor));
      }
    } else if (period === "week") {
      startDate = data.startDate;
      rows = 7;
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const localDate = addLocalDays(startDate, dayIndex);
        const day = dayMap.get(localDate);
        for (let hour = 0; hour < 24; hour += 1) {
          cells.push(createCell(data, localDate, hour, day, metricsFor));
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
        const blank = createCell(data, startDate, null, null, metricsFor, { invalid: true });
        blank.key = `month-leading-${index}`;
        cells.push(blank);
      }
      for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
        const localDate = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
        cells.push(createCell(data, localDate, null, dayMap.get(localDate), metricsFor, { dayNumber }));
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
          cells.push(createCell(data, localDate, null,
            dayNumber > dayCount ? null : dayMap.get(localDate), metricsFor, {
              dayNumber,
              invalid: dayNumber > dayCount,
            }));
        }
      }
    }
    return { period, cells, columns, rows, startDate };
  }

  function buildPeriodChoice() {
    const control = helpers.buildSegmentedRadio({
      id: "recap-period",
      ariaLabel: t("recapPeriodLabel"),
      className: "recap-period-tabs",
      value: view.period,
      options: PERIODS.map((period) => ({ value: period, label: t(`recapPeriod_${period}`) })),
      onChange(period) {
        clearInteraction();
        view.period = period;
        reload({ retainContent: true });
      },
    });
    for (const button of control.element.querySelectorAll("button")) button.classList.add("recap-period-button");
    return control.element;
  }

  function metricText(value) {
    if (value === null) return t("recapMetricUnavailable");
    return formatNumber(value);
  }

  function applyAgentRowMetrics(row, item, metricCountNodes) {
    const metricEntries = [
      ["recapMetricTurns", row.turnsCompleted],
      ["recapMetricTools", row.toolCalls],
      ["recapMetricSignals", row.activityEvents],
    ];
    const metricDescription = metricEntries.map(([labelKey, value]) => {
      const accessibleValue = value === null
        ? t("recapMetricUnavailableReason")
        : metricText(value);
      return `${t(labelKey)}: ${accessibleValue}`;
    }).join(". ");
    item.setAttribute("aria-label", `${replace(t("recapAgentHighlightAria"), {
      agent: rowDisplayName(row),
    })}. ${metricDescription}`);
    for (let index = 0; index < metricEntries.length; index += 1) {
      const [labelKey, value] = metricEntries[index];
      const count = metricCountNodes[index];
      count.textContent = metricText(value);
      if (value === null) {
        count.title = t("recapMetricUnavailableReason");
        count.setAttribute("aria-label", `${t(labelKey)}: ${t("recapMetricUnavailableReason")}`);
      } else {
        delete count.title;
        count.removeAttribute("aria-label");
      }
    }
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
      const metricCountNodes = [];
      for (const labelKey of ["recapMetricTurns", "recapMetricTools", "recapMetricSignals"]) {
        const pair = document.createElement("div");
        const label = document.createElement("dt");
        label.textContent = t(labelKey);
        const count = document.createElement("dd");
        pair.appendChild(label);
        pair.appendChild(count);
        metrics.appendChild(pair);
        metricCountNodes.push(count);
      }
      applyAgentRowMetrics(row, item, metricCountNodes);
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
      interaction.rowMetricNodes.set(row.key, metricCountNodes);
      list.appendChild(item);
    }
    return list;
  }

  function periodTitle(data) {
    if (view.period === "today") {
      return formatDate(data.anchorDate, DATE_OPTIONS_TODAY_TITLE);
    }
    if (view.period === "week") {
      const end = addLocalDays(data.startDate, 6);
      return `${formatDate(data.startDate, DATE_OPTIONS_WEEK_ENDPOINT)} — ${formatDate(end, DATE_OPTIONS_WEEK_ENDPOINT)}`;
    }
    if (view.period === "month") {
      return formatDate(`${data.anchorDate.slice(0, 7)}-01`, DATE_OPTIONS_MONTH_TITLE);
    }
    return formatDate(`${data.anchorDate.slice(0, 4)}-01-01`, DATE_OPTIONS_YEAR_TITLE);
  }

  function cellWhen(cell) {
    const date = formatDate(cell.localDate, DATE_OPTIONS_CELL_WHEN);
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

  function cellStatusLabel(cell) {
    const keys = {
      covered: "recapStatusCovered", partial: "recapStatusPartial",
      uncovered: "recapStatusUncovered", future: "recapStatusFuture",
      "not-started": "recapStatusNotStarted", gap: "recapStatusGap",
    };
    return cell.state === "activity"
      ? replace(t("recapTooltipTotal"), { count: formatNumber(cell.total) })
      : t(keys[cell.state]);
  }

  function sameCellCounts(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index].rowKey !== right[index].rowKey || left[index].count !== right[index].count) {
        return false;
      }
    }
    return true;
  }

  function sameCellState(left, right) {
    return left.key === right.key
      && left.state === right.state
      && left.total === right.total
      && left.kind === right.kind
      && left.dayNumber === right.dayNumber
      && sameCellCounts(left.counts, right.counts);
  }

  function cellClassName(cell, anchorDate, extraClasses = []) {
    const classes = ["recap-cell", `recap-cell-${cell.state}`];
    if (view.period === "today") classes.push("recap-bar-slot");
    if (cell.state !== "blank") {
      if (cell.state === "activity") classes.push(`recap-depth-${depthOf(cell.total)}`);
      if (cell.kind === "fold") classes.push("recap-cell-fold");
      if (cell.dayNumber && view.period === "month" && cell.localDate === anchorDate) {
        classes.push("recap-cell-current");
      }
    }
    for (const extra of extraClasses) classes.push(extra);
    return classes.join(" ");
  }

  function buildTimeline(data, interaction) {
    const model = buildTimelineModel(data, view.period);
    const rowByKey = interaction.rowByKey;
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
    const renderedCells = [];
    let renderedCellCount = 0;
    const todayBarMaximum = view.period === "today"
      ? Math.max(1, ...model.cells.map((cell) => cell.total))
      : 1;
    interaction.todayBarMaximum = todayBarMaximum;

    function appendCell(cell, parent, rowIndex, columnIndex) {
      const element = document.createElement("div");
      element.id = `recap-cell-${serial}-${renderedCellCount}`;
      renderedCellCount += 1;
      element.dataset.cellKey = cell.key;
      if (cell.state === "blank") {
        element.className = cellClassName(cell, data.anchorDate);
        element.setAttribute("role", "presentation");
        element.setAttribute("aria-hidden", "true");
        renderedCells.push({ cell, element, listIndex: -1 });
        parent.appendChild(element);
        return;
      }
      element.setAttribute("role", "gridcell");
      element.setAttribute("aria-rowindex", String(rowIndex));
      element.setAttribute("aria-colindex", String(columnIndex));
      element.setAttribute("aria-label", cellAriaLabel(cell, rowByKey));
      if (view.period === "today") {
        element.dataset.barMaximum = String(todayBarMaximum);
        setTodayBarLevel(element, cell.total);
        const fill = document.createElement("span");
        fill.className = "recap-bar-fill";
        fill.setAttribute("aria-hidden", "true");
        element.appendChild(fill);
      }
      if (cell.dayNumber && view.period === "month") {
        if (cell.localDate === data.anchorDate) {
          element.setAttribute("aria-current", "date");
        }
        const dayNumber = document.createElement("span");
        dayNumber.className = "recap-day-number";
        dayNumber.textContent = formatNumber(cell.dayNumber);
        dayNumber.setAttribute("aria-hidden", "true");
        element.appendChild(dayNumber);
      }
      element.className = cellClassName(cell, data.anchorDate);
      const cellIndex = cellElements.length;
      // Share one bound mouseenter/mouseleave function across all 365 cells
      // instead of allocating 365 closures per year render.
      element.addEventListener("mouseenter", interaction.handleCellMouseEnter);
      element.addEventListener("mouseleave", interaction.clearPeek);
      // The grid owns one delegated mousedown handler; record the index so the
      // handler is O(1) instead of scanning every rendered cell.
      interaction.cellIndexByElement.set(element, cellIndex);
      interaction.cellElements.set(cell.key, { cell, element });
      cellElements.push({ cell, element, rowIndex, columnIndex });
      renderedCells.push({ cell, element, listIndex: cellIndex });
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
        label.textContent = hour % 3 === 0 ? formatNumber(hour, NUMBER_OPTIONS_TWO_DIGIT) : "";
        labels.appendChild(label);
      }
      grid.appendChild(labels);
    } else if (view.period === "week") {
      const hours = document.createElement("div");
      hours.className = "recap-week-hours";
      hours.setAttribute("aria-hidden", "true");
      for (let hour = 0; hour < 24; hour += 1) {
        const label = document.createElement("span");
        label.textContent = hour % 6 === 0 ? formatNumber(hour, NUMBER_OPTIONS_TWO_DIGIT) : "";
        hours.appendChild(label);
      }
      grid.appendChild(hours);
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const row = document.createElement("div");
        row.className = "recap-week-row";
        row.setAttribute("role", "row");
        const localDate = addLocalDays(model.startDate, dayIndex);
        const label = document.createElement("span");
        label.className = "recap-row-label";
        label.textContent = formatDate(localDate, DATE_OPTIONS_WEEKDAY_NARROW);
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
        label.textContent = formatDate(addLocalDays("2026-08-24", index), DATE_OPTIONS_WEEKDAY_NARROW);
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
        label.textContent = formatDate(`${data.anchorDate.slice(0, 4)}-${String(monthIndex + 1).padStart(2, "0")}-01`, DATE_OPTIONS_MONTH_SHORT);
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
    interaction.renderedCells = renderedCells;
    if (view.gridIndex === null) {
      const current = cellElements.findIndex(({ cell }) => cell.localDate === data.anchorDate
        && (cell.hour === null || cell.hour === data.currentLocalHour));
      const recent = cellElements.findLastIndex(({ cell }) => cell.state === "activity");
      view.gridIndex = current >= 0 ? current : Math.max(0, recent);
    }
    view.gridIndex = Math.max(0, Math.min(view.gridIndex, cellElements.length - 1));
    interaction.selectGridCell(view.gridIndex, false);
    grid.addEventListener("focus", () => {
      const keyboard = typeof grid.matches !== "function" || grid.matches(":focus-visible");
      grid.classList.toggle("recap-keyboard-mode", keyboard);
      interaction.selectGridCell(view.gridIndex, keyboard);
    });
    grid.addEventListener("mousedown", (event) => {
      grid.classList.remove("recap-keyboard-mode");
      // One delegated listener replaces one mousedown closure per cell. Walk up
      // from the event target (a cell or one of its spans) to the owning cell
      // and select it through the precomputed index.
      let node = event.target;
      while (node && node !== grid) {
        const index = interaction.cellIndexByElement.get(node);
        if (index !== undefined) {
          interaction.selectGridCell(index, false);
          return;
        }
        node = node.parentNode;
      }
    });
    grid.addEventListener("blur", () => {
      grid.classList.remove("recap-keyboard-mode");
      interaction.clearPeek();
    });
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
      grid.classList.add("recap-keyboard-mode");
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
      date: formatDate(data.recordingStartedDate || data.anchorDate, DATE_OPTIONS_SINCE),
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
      card,
      data,
      period: view.period,
      localeKey: locale(),
      summaryRows: summary.rows,
      titleNode: title,
      sinceNode: since,
      ledeNode: lede,
      hintNode: hint,
      rowElements: new Map(),
      rowMetricNodes: new Map(),
      cellElements: new Map(),
      cellIndexByElement: new Map(),
      cellList: [],
      renderedCells: [],
      todayBarMaximum: 1,
      rowByKey: new Map(summary.rows.map((row) => [row.key, row])),
      highlightedKey: undefined,
      highlightedCells: [],
      hitCount: 0,
      grid: null,
      live: null,
      visual: null,
      peekTimer: null,
      popover: null,
      peekElement: null,
      peekCell: null,
      peekSegments: null,
      handleCellMouseEnter: (event) => {
        const target = event && (event.currentTarget || event.target);
        const index = interaction.cellIndexByElement.get(target);
        const entry = index !== undefined ? interaction.cellList[index] : null;
        if (entry) interaction.showPeek(entry.cell, entry.element, interaction.rowByKey);
      },
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
        if (activeKey !== this.highlightedKey) {
          // Restore the cells the previous highlight touched instead of
          // clearing and re-applying classes on every rendered cell. On the
          // year grid that turns a 372-cell class/style rewrite per hover into
          // work proportional to the actual hit count.
          for (const { cell, element } of this.highlightedCells) {
            element.classList.remove("recap-cell-hit", "recap-depth-1", "recap-depth-2", "recap-depth-3");
            element.style.removeProperty("--recap-cell-color");
            if (cell.state === "activity") element.classList.add(`recap-depth-${depthOf(cell.total)}`);
            if (view.period === "today") setTodayBarLevel(element, cell.total);
          }
          this.highlightedCells = [];
          this.highlightedKey = activeKey;
          let hitCount = 0;
          if (activeKey) {
            const row = this.rowByKey.get(activeKey);
            const rowColor = row ? agentColorToken(row.agentId) : null;
            for (const { cell, element } of this.cellElements.values()) {
              const match = cell.counts.find((entry) => entry.rowKey === activeKey);
              if (!match) continue;
              hitCount += 1;
              element.classList.add("recap-cell-hit", `recap-depth-${depthOf(match.count)}`);
              element.style.setProperty("--recap-cell-color", rowColor || agentColorToken(match.agentId));
              if (view.period === "today") setTodayBarLevel(element, match.count);
              this.highlightedCells.push({ cell, element });
            }
          }
          this.hitCount = hitCount;
        }
        for (const [key, element] of this.rowElements) {
          element.classList.toggle("active", key === activeKey);
          element.setAttribute("aria-pressed", view.lockedRowKey === key ? "true" : "false");
        }
        if (activeKey && this.live) {
          const row = this.rowByKey.get(activeKey);
          const unitKey = view.period === "today" || view.period === "week"
            ? "recapCellUnitHour"
            : "recapCellUnitDay";
          this.live.textContent = replace(t("recapLookingAt"), {
            agent: row ? rowDisplayName(row) : "",
            count: formatNumber(this.hitCount),
            unit: t(unitKey),
          });
        } else if (this.live) this.live.textContent = "";
      },
      clearPeek: () => {
        if (interaction.peekTimer) clearTimeout(interaction.peekTimer);
        interaction.peekTimer = null;
        if (interaction.peekSegments) {
          interaction.peekSegments.remove();
          interaction.peekSegments = null;
        }
        if (interaction.peekElement) {
          interaction.peekElement.classList.remove("recap-cell-peek");
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
        scrollActivity.pendingPeek = null;
        if (interaction.popover) interaction.popover.remove();
        interaction.popover = null;
      },
      showPeek(cell, element, rowByKey) {
        // Cells stream under a resting pointer while the pane scrolls; building
        // and measuring a popover for every one of them is pure jank.
        if (scrollActivity.scrolling) {
          scrollActivity.pendingPeek = { cell, element, rowByKey };
          return;
        }
        const immediatePopover = this.peekElement === element && Boolean(this.popover);
        this.clearPeek();
        const entries = cell.counts.slice().sort((left, right) => right.count - left.count);
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
          this.peekSegments = segments;
        }
        const mountPopover = () => {
          this.peekTimer = null;
          if (this.peekElement !== element || !element.parentNode) return;
          const popover = document.createElement("div");
          popover.className = "recap-cell-popover";
          popover.setAttribute("aria-hidden", "true");
          const popTitle = document.createElement("strong");
          popTitle.textContent = cellWhen(cell);
          popover.appendChild(popTitle);
          const status = document.createElement("p");
          status.className = "recap-cell-popover-note";
          status.textContent = cellStatusLabel(cell);
          popover.appendChild(status);
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
        };
        if (immediatePopover) mountPopover();
        else this.peekTimer = setTimeout(mountPopover, 90);
      },
      selectGridCell(index, announce) {
        if (!this.cellList.length) return;
        const previous = this.cellList[view.gridIndex];
        view.gridIndex = Math.max(0, Math.min(index, this.cellList.length - 1));
        const current = this.cellList[view.gridIndex].element;
        if (previous && previous.element !== current) previous.element.classList.remove("recap-cell-keyboard");
        if (!current.classList.contains("recap-cell-keyboard")) current.classList.add("recap-cell-keyboard");
        if (this.grid) this.grid.setAttribute("aria-activedescendant", current.id);
        if (announce && this.live) this.live.textContent = current.getAttribute("aria-label") || "";
        if (announce) this.showPeek(this.cellList[view.gridIndex].cell, current, this.rowByKey);
      },
      patchDataInPlace(nextData) {
        if (!mountedBody || mountedBody.inert || !this.card || this.card.parentNode !== mountedBody) return false;
        if (!this.data || !nextData || this.period !== view.period) return false;
        if (this.localeKey !== locale()) return false;
        if (this.data.anchorDate !== nextData.anchorDate || this.data.startDate !== nextData.startDate) return false;
        const nextSummary = summarize(nextData);
        if (nextSummary.rows.length === 0 || nextSummary.rows.length !== this.summaryRows.length) return false;
        for (let index = 0; index < nextSummary.rows.length; index += 1) {
          if (nextSummary.rows[index].key !== this.summaryRows[index].key) return false;
        }
        const nextModel = buildTimelineModel(nextData, view.period);
        if (nextModel.cells.length !== this.renderedCells.length) return false;
        this.data = nextData;
        this.summaryRows = nextSummary.rows;
        this.rowByKey = new Map(nextSummary.rows.map((row) => [row.key, row]));
        this.sinceNode.textContent = replace(t("recapRecordingSince"), {
          date: formatDate(nextData.recordingStartedDate || nextData.anchorDate, DATE_OPTIONS_SINCE),
        });
        for (const row of nextSummary.rows) {
          const item = this.rowElements.get(row.key);
          const metricCountNodes = this.rowMetricNodes.get(row.key);
          if (item && metricCountNodes) applyAgentRowMetrics(row, item, metricCountNodes);
        }
        const nextTodayBarMaximum = view.period === "today"
          ? Math.max(1, ...nextModel.cells.map((cell) => cell.total))
          : 1;
        const barMaxChanged = view.period === "today" && nextTodayBarMaximum !== this.todayBarMaximum;
        let anyCellChanged = false;
        let peekCellChanged = false;
        for (let index = 0; index < nextModel.cells.length; index += 1) {
          const nextCell = nextModel.cells[index];
          const slot = this.renderedCells[index];
          const prevCell = slot.cell;
          const cellChanged = !sameCellState(prevCell, nextCell);
          if (!cellChanged && !barMaxChanged) continue;
          anyCellChanged = true;
          slot.cell = nextCell;
          if (slot.listIndex >= 0) this.cellList[slot.listIndex].cell = nextCell;
          const mapEntry = this.cellElements.get(nextCell.key);
          if (mapEntry) mapEntry.cell = nextCell;
          const element = slot.element;
          if (element === this.peekElement && cellChanged) peekCellChanged = true;
          if (cellChanged) {
            const preserved = [];
            if (element.classList.contains("recap-cell-keyboard")) preserved.push("recap-cell-keyboard");
            if (element.classList.contains("recap-cell-peek")) preserved.push("recap-cell-peek");
            element.className = cellClassName(nextCell, nextData.anchorDate, preserved);
            if (nextCell.state !== "blank") {
              element.setAttribute("aria-label", cellAriaLabel(nextCell, this.rowByKey));
            }
          }
          if (view.period === "today" && nextCell.state !== "blank") {
            element.dataset.barMaximum = String(nextTodayBarMaximum);
            setTodayBarLevel(element, nextCell.total);
          }
        }
        this.todayBarMaximum = nextTodayBarMaximum;
        if (anyCellChanged) {
          this.highlightedKey = undefined;
          this.applyHighlight();
          if (this.peekElement && this.peekElement.dataset && this.peekElement.dataset.cellKey) {
            const peekEntry = this.cellElements.get(this.peekElement.dataset.cellKey);
            if (peekEntry) {
              if (peekCellChanged) {
                this.showPeek(peekEntry.cell, this.peekElement, this.rowByKey);
                if (!this.highlightedKey && this.live && this.peekElement.classList.contains("recap-cell-keyboard")) {
                  this.live.textContent = this.peekElement.getAttribute("aria-label") || "";
                }
              } else {
                this.peekCell = peekEntry.cell;
              }
            }
          }
          if (scrollActivity.pendingPeek && scrollActivity.pendingPeek.element && scrollActivity.pendingPeek.element.dataset) {
            const pendingEntry = this.cellElements.get(scrollActivity.pendingPeek.element.dataset.cellKey);
            if (pendingEntry) {
              scrollActivity.pendingPeek = {
                cell: pendingEntry.cell,
                element: scrollActivity.pendingPeek.element,
                rowByKey: this.rowByKey,
              };
            }
          }
        }
        return true;
      },
    };

    card.appendChild(buildAgentRows(summary, interaction));
    card.appendChild(buildTimeline(data, interaction));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!view.lockedRowKey && !interaction.peekElement) return;
      event.preventDefault();
      view.lockedRowKey = null;
      interaction.clearPeek();
      interaction.applyHighlight();
    });
    mountedInteraction = interaction;
    interaction.applyHighlight();
    return card;
  }

  function buildRecordingControls() {
    const rows = [];
    const enabled = !!(coreState.snapshot && coreState.snapshot.recapEnabled !== false);
    const paused = enabled && view.status === "ready"
      && view.data && view.data.recordingEnabled === false;
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
    desc.textContent = t(paused ? "recapRecordingPaused" : "recapRecordingDesc");
    if (paused) desc.setAttribute("role", "status");
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
    clearLoadingIndicator();
    clearInteraction();
    bindScrollActivity();
    if (mountedHost) mountedHost.dispose();
    mountedHost = helpers.createSubpageHost({ disposeBody: clearInteraction });
    const header = document.createElement("div");
    header.className = "recap-page-header";
    const title = document.createElement("h1");
    title.textContent = t("recapTitle");
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("recapSubtitle");
    header.appendChild(title);
    header.appendChild(subtitle);
    header.appendChild(buildPeriodChoice());
    parent.appendChild(header);

    const dataRegion = document.createElement("div");
    dataRegion.className = "recap-data-region";
    mountedBody = document.createElement("div");
    mountedBody.className = "recap-data-body";
    mountedLoading = document.createElement("div");
    mountedLoading.className = "recap-loading-status";
    mountedLoading.setAttribute("role", "status");
    mountedLoading.hidden = true;
    dataRegion.appendChild(mountedBody);
    dataRegion.appendChild(mountedLoading);
    parent.appendChild(dataRegion);

    if (view.status === "idle") requestData();
    else refreshIfNeeded();
    refreshBody();
    parent.appendChild(buildRecordingControls());
  }

  function syncRecordingDescription() {
    // Recording state may change in the returned data without replacing controls.
    const description = document.getElementById("recap-recording-description");
    if (description) {
      const paused = coreState.snapshot?.recapEnabled !== false && view.status === "ready"
        && view.data?.recordingEnabled === false;
      description.textContent = t(paused ? "recapRecordingPaused" : "recapRecordingDesc");
      if (paused) description.setAttribute("role", "status");
      else description.removeAttribute("role");
    }
  }

  function refreshBody({ retainContent = false } = {}) {
    if (coreState.activeTab !== "recap" || !mountedHost || !mountedBody) return;
    const pending = view.status === "loading" || view.status === "idle";
    const retain = retainContent && pending && !!mountedBody.querySelector(".recap-card");
    clearLoadingIndicator();
    mountedBody.setAttribute("aria-busy", String(pending));
    mountedBody.inert = retain;
    mountedLoading.hidden = true;
    mountedLoading.textContent = retain ? `${t(`recapPeriod_${view.period}`)} · ${t("recapLoading")}` : "";
    if (retain) {
      // Fast local queries should not flash a loading badge. Slow queries keep
      // the previous chart's geometry, but its controls cannot act on old data.
      loadingTimer = setTimeout(() => {
        loadingTimer = null;
        if (mountedLoading) mountedLoading.hidden = false;
      }, 150);
    }
    if (!retain) mountedHost.render(mountedBody, renderDataBody);
    syncRecordingDescription();
  }

  function renderDataBody(parent) {
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
      retry.addEventListener("click", () => reload());
      error.appendChild(retry);
      parent.appendChild(error);
    }
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
      onExit() {
        clearLoadingIndicator();
        clearInteraction();
        unbindScrollActivity();
        // Bumping requestSeq drops an in-flight background refresh; queue it
        // again so returning to Recap fetches the data it would have shown.
        if (view.refreshInFlight) view.refreshQueued = true;
        view.requestSeq += 1;
        if (view.status === "loading") view.status = "idle";
        if (mountedHost) mountedHost.dispose();
        mountedHost = null;
        mountedBody = null;
        mountedLoading = null;
      },
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
