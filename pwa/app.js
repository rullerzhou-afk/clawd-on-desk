(function() {
  "use strict";

  // === i18n ===
  // Strings live in pwa/i18n.js (window.ClawdMobileI18N). The active language is
  // injected by the desktop app's LAN server as window.__CLAWD_LANG__ so the PWA
  // follows whatever language you picked on the desktop; it falls back to the
  // document/browser language, then English.
  var I18N = (typeof window !== "undefined" && window.ClawdMobileI18N) || { en: {} };
  var LANG = (function() {
    var want = (typeof window !== "undefined" && window.__CLAWD_LANG__) || "";
    if (I18N[want]) return want;
    var docLang = (document.documentElement && document.documentElement.lang) || "";
    if (I18N[docLang]) return docLang;
    var nav = (navigator.language || "en");
    if (I18N[nav]) return nav;
    var base = String(nav).split("-")[0];
    for (var k in I18N) { if (I18N.hasOwnProperty(k) && k.split("-")[0] === base) return k; }
    return "en";
  })();
  function t(key, vars) {
    var dict = I18N[LANG] || I18N.en || {};
    var s = (dict[key] != null) ? dict[key] : ((I18N.en && I18N.en[key] != null) ? I18N.en[key] : key);
    if (vars) { for (var vk in vars) { if (vars.hasOwnProperty(vk)) s = s.replace("{" + vk + "}", vars[vk]); } }
    return s;
  }
  function applyStaticI18n() {
    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute("data-i18n");
      if (k) els[i].textContent = t(k);
    }
    if (document.documentElement) document.documentElement.lang = LANG;
  }

  // === Constants ===

  var STATE_CONFIG = {
    error:        { icon: "error",        color: "#ef4444", priority: 0, label: t("stError") },
    attention:    { icon: "attention",    color: "#b45309", priority: 1, label: t("stAttention") },
    working:      { icon: "working",      color: "#22c55e", priority: 2, label: t("stWorking") },
    juggling:     { icon: "juggling",     color: "#22c55e", priority: 2, label: t("stJuggling") },
    thinking:     { icon: "thinking",     color: "#3b82f6", priority: 3, label: t("stThinking") },
    notification: { icon: "notification", color: "#d97757", priority: 4, label: t("stNotification") },
    sweeping:     { icon: "sweeping",     color: "#71717a", priority: 5, label: t("stSweeping") },
    carrying:     { icon: "carrying",     color: "#71717a", priority: 5, label: t("stCarrying") },
    idle:         { icon: "idle",         color: "#71717a", priority: 6, label: t("stIdle") },
    sleeping:     { icon: "sleeping",     color: "#a1a1aa", priority: 7, label: t("stSleeping") },
  };

  var CONNECTION_STATES = {
    connected:    { dot: "connected", text: t("connConnected"), color: "#22c55e" },
    connecting:   { dot: "connecting", text: t("connConnecting"), color: "#b45309" },
    reconnecting: { dot: "reconnecting", text: t("connReconnecting"), color: "#ef4444" },
    disconnected: { dot: "", text: "", color: "#52525b" },
    auth_failed:  { dot: "", text: t("connAuthFailed"), color: "#ef4444" },
  };

  var EVENT_LABELS_I18N = {
    UserPromptSubmit: t("evUserPromptSubmit"), PreToolUse: t("evPreToolUse"), PostToolUse: t("evPostToolUse"),
    PostToolUseFailure: t("evPostToolUseFailure"), Stop: t("evStop"), SessionStart: t("evSessionStart"),
    SessionEnd: t("evSessionEnd"), PermissionRequest: t("evPermissionRequest"), Notification: t("evNotification"),
    SubagentStart: t("evSubagentStart"), SubagentStop: t("evSubagentStop"),
  };

  // Mascot animation per state — served from the active theme's asset set so the
  // phone shows the same Clawd pet, reacting to the most active session.
  var PET_SVG = {
    error: "clawd-error.svg",
    attention: "clawd-notification.svg",
    notification: "clawd-notification.svg",
    working: "clawd-working-typing.svg",
    juggling: "clawd-working-juggling.svg",
    thinking: "clawd-working-thinking.svg",
    sweeping: "clawd-working-sweeping.svg",
    carrying: "clawd-working-carrying.svg",
    idle: "clawd-idle-follow.svg",
    sleeping: "clawd-sleeping.svg",
  };


  var MAX_HISTORY = 5;
  var MAX_LOG_LINES = 200;
  var _logBuffer = [];

  // === Utilities ===

  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function icon(name) {
    return (typeof ICONS !== "undefined" && ICONS[name]) || "";
  }

  function shortPath(p) {
    if (!p) return "";
    var parts = p.split(/[/\\]/);
    return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : p;
  }

  function formatAgo(ts) {
    if (!ts) return "";
    var sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return t("timeJustNow");
    if (sec < 60) return t("timeSecAgo", { n: sec });
    if (sec < 3600) return t("timeMinAgo", { n: Math.floor(sec / 60) });
    return t("timeHrAgo", { n: Math.floor(sec / 3600) });
  }

  function eventLabel(eventName) {
    return EVENT_LABELS_I18N[eventName] || (typeof EVENT_LABELS !== "undefined" && EVENT_LABELS[eventName]) || eventName || "";
  }

  var EVENT_ICONS = {
    UserPromptSubmit: "💬", PreToolUse: "⚙️", PostToolUse: "✅",
    PostToolUseFailure: "❌", Stop: "🏁", StopFailure: "❌",
    SessionStart: "▶️", SessionEnd: "⏹️",
    PermissionRequest: "🔒", Notification: "🔔",
    SubagentStart: "🔀", SubagentStop: "🔀",
    AfterAgent: "✅", ApiError: "❌",
    Elicitation: "❓", WorktreeCreate: "🌿",
  };

  function eventIcon(eventName) {
    return EVENT_ICONS[eventName] || "●";
  }

  function log(msg) {
    var now = new Date();
    var ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(function(n) { return String(n).padStart(2, "0"); }).join(":");
    var line = "[" + ts + "] " + msg;
    _logBuffer.push(line);
    if (_logBuffer.length > MAX_LOG_LINES) _logBuffer.shift();
    var el = document.getElementById("settings-log-content");
    if (el) {
      var div = document.createElement("div");
      div.textContent = line;
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
    }
  }

  function showToast(message, type, persist) {
    type = type || "info";
    var container = document.getElementById("toast-container");
    var toast = document.createElement("div");
    toast.className = "toast " + type + (persist ? " toast-persist" : "");
    toast.textContent = message;
    if (persist) {
      var close = document.createElement("span");
      close.className = "toast-close";
      close.textContent = "✕";
      close.onclick = function() { toast.remove(); };
      toast.appendChild(close);
    }
    container.appendChild(toast);
    if (!persist) {
      setTimeout(function() {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(function() { toast.remove(); }, 300);
      }, 3000);
    }
  }

  // === NotificationManager ===

  class NotificationManager {
    constructor() { this.permission = "default"; this.lastStates = new Map(); }

    requestPermission() {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") { this.permission = "granted"; return; }
      if (Notification.permission !== "denied") {
        var self = this;
        Notification.requestPermission().then(function(p) { self.permission = p; });
      }
    }

    onStateChange(sessionId, data) {
      var prev = this.lastStates.get(sessionId);
      this.lastStates.set(sessionId, data.state);
      var s = data.state;
      var config = STATE_CONFIG[s];
      if (!config) return;
      var label = data.title || data.agentId || "Agent";
      var title = null, body = null, tag = s;
      if (s === "error" || s === "attention" || s === "notification") {
        title = config.label; body = label + " — " + config.label;
      } else if ((prev === "working" || prev === "thinking" || prev === "juggling") && s === "idle") {
        title = t("notifyTaskDone"); body = t("notifyTaskDoneBody", { label: label }); tag = "idle";
      }
      if (!title) return;
      // Haptic buzz (Android; iOS ignores navigator.vibrate, but the system
      // notification itself buzzes the phone).
      try { if (navigator.vibrate) navigator.vibrate(s === "error" ? [60, 40, 60] : [40]); } catch (e) {}
      // System notification only when the app isn't already in the foreground.
      if (this.permission === "granted" && document.visibilityState !== "visible") {
        this._notify(title, body, tag);
      }
    }

    _notify(title, body, tag) {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(function(reg) {
            reg.showNotification(title, { body: body, tag: "clawd-" + (tag || "default"), icon: "/mobile/icons/icon-256.png" });
          });
        } else {
          new Notification(title, { body: body, tag: "clawd-" + (tag || "default") });
        }
      } catch {}
    }
  }

  // === ConnectionManager ===

  class ConnectionManager {
    constructor() {
      this.ws = null; this.config = null;
      this.reconnectDelay = 1000; this.maxReconnectDelay = 30000;
      this.reconnectTimer = null; this.state = "disconnected";
      this.retryCount = 0;
      this.onStateChange = null; this.onMessage = null; this.onDisconnected = null;
      this._hiddenAt = 0;
      this._bindVisibility();
    }

    connect(config) {
      this.config = config;
      this.retryCount = 0;
      this.reconnectDelay = 1000;
      clearTimeout(this.reconnectTimer);
      this._saveToHistory(config);
      this._doConnect();
    }

    _doConnect() {
      if (!this.config) return;
      // Tear down old socket — clear callbacks first to prevent stale events
      var old = this.ws;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try { old.close(); } catch {}
      }
      var url = "ws://" + this.config.host + ":" + this.config.port + "/ws?token=" + this.config.token;
      this._setState("connecting");
      log("Connecting to " + this.config.host + ":" + this.config.port + "...");
      var socket;
      try { socket = new WebSocket(url); } catch (err) { log("WS create failed: " + err.message); this._scheduleReconnect(); return; }
      this.ws = socket;
      var self = this;
      var connected = false;
      socket.onopen = function() {
        if (socket !== self.ws) return; // stale socket — ignore
        connected = true; self.retryCount = 0; self.reconnectDelay = 1000;
        self._setState("connected"); log("Connected"); showToast(t("toastConnected"), "success");
        // Dismiss any persistent toasts (e.g. retry hint)
        var persisted = document.querySelectorAll(".toast-persist");
        for (var i = 0; i < persisted.length; i++) { persisted[i].remove(); }
        // Keep the query params in the URL: iOS "Add to Home Screen" may bookmark
        // the current URL rather than the manifest start_url, and stripping them
        // broke that. The token rotates and _autoConnect prefers the freshest
        // token from history, so a stale ?token= left here is harmless.
      };
      socket.onmessage = function(event) {
        if (socket !== self.ws) return;
        try { var msg = JSON.parse(event.data); if (self.onMessage) self.onMessage(msg); } catch {}
      };
      socket.onclose = function(event) {
        if (socket !== self.ws) return; // stale socket — ignore
        if (event.code === 1008) { self._setState("auth_failed"); log("Auth failed"); showToast(t("toastTokenExpired"), "error"); return; }
        if (connected) log("Disconnected (code: " + event.code + ")");
        if (self.onDisconnected) self.onDisconnected();
        self._scheduleReconnect();
      };
      socket.onerror = function() {};
    }

    send(data) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(typeof data === "string" ? data : JSON.stringify(data)); }

    _scheduleReconnect() {
      if (!this.config) return;
      this.retryCount++;
      this._setState("reconnecting");
      // After several retries, give actionable feedback (don't stop — just inform)
      if (this.retryCount === 5) {
        showToast(t("toastStillReconnecting"), "info", true);
      }
      var self = this;
      this.reconnectTimer = setTimeout(function() { self.reconnectDelay = Math.min(self.reconnectDelay * 2, self.maxReconnectDelay); self._doConnect(); }, this.reconnectDelay);
    }

    _setState(state) { this.state = state; if (this.onStateChange) this.onStateChange(state); }

    _saveToHistory(config) {
      var history = []; try { history = JSON.parse(localStorage.getItem("clawd-history") || "[]"); } catch {}
      var entry = { host: config.host, port: config.port, token: config.token, timestamp: Date.now() };
      var filtered = history.filter(function(h) { return h.host !== config.host || h.port !== config.port; });
      filtered.unshift(entry);
      localStorage.setItem("clawd-history", JSON.stringify(filtered.slice(0, MAX_HISTORY)));
    }

    getHistory() { try { return JSON.parse(localStorage.getItem("clawd-history") || "[]"); } catch { return []; } }
    deleteHistory(index) { var h = this.getHistory(); h.splice(index, 1); localStorage.setItem("clawd-history", JSON.stringify(h)); }

    _updateHistoryToken(host, port, newToken) {
      var history = this.getHistory();
      for (var i = 0; i < history.length; i++) {
        if (history[i].host === host && history[i].port === port) {
          history[i].token = newToken;
        }
      }
      localStorage.setItem("clawd-history", JSON.stringify(history));
    }

    _bindVisibility() {
      var self = this;
      document.addEventListener("visibilitychange", function() {
        if (document.visibilityState !== "visible") {
          self._hiddenAt = Date.now();
          return;
        }
        if (!self.config) return;
        var hiddenFor = self._hiddenAt ? Date.now() - self._hiddenAt : 0;
        // Short tab switch: trust OPEN. Background > 30s: force reconnect (zombie guard)
        if (hiddenFor < 30000 && self.ws && self.ws.readyState === WebSocket.OPEN) return;
        log("Page visible after " + Math.round(hiddenFor / 1000) + "s, reconnecting...");
        self.retryCount = 0;
        self.reconnectDelay = 1000;
        clearTimeout(self.reconnectTimer);
        self._doConnect();
      });
    }
  }

  // === SessionRenderer ===

  class SessionRenderer {
    constructor(container) { this.container = container; this.sessions = new Map(); this.staleTimer = null; this.expandedSet = new Set(); this._startTimerUpdater(); }

    updateFromSnapshot(sessions) {
      this.sessions.clear();
      for (var sid in sessions) { if (sessions.hasOwnProperty(sid)) this.sessions.set(sid, sessions[sid]); }
      this.render();
    }

    updateState(sessionId, data) {
      var existing = this.sessions.get(sessionId) || {};
      var merged = {}; for (var k in existing) { if (existing.hasOwnProperty(k)) merged[k] = existing[k]; }
      for (var k2 in data) { if (data.hasOwnProperty(k2)) merged[k2] = data[k2]; }
      this.sessions.set(sessionId, merged);
      this.render();
    }

    removeSession(sessionId) { this.sessions.delete(sessionId); this.expandedSet.delete(sessionId); this.render(); }
    toggleExpand(sid) {
      var wasExpanded = this.expandedSet.has(sid);
      if (wasExpanded) this.expandedSet.delete(sid); else this.expandedSet.add(sid);
      this._animatingSid = sid;
      this.render();
    }

    render() {
      var self = this;
      this._updatePet();
      var entries = [];
      this.sessions.forEach(function(v, k) { entries.push([k, v]); });
      entries.sort(function(a, b) {
        var pa = (STATE_CONFIG[a[1].state] || STATE_CONFIG.idle).priority;
        var pb = (STATE_CONFIG[b[1].state] || STATE_CONFIG.idle).priority;
        return pa - pb;
      });

      if (entries.length === 0) {
        this.container.innerHTML = '<div class="empty-state"><div class="empty-icon">' + icon("paw") + '</div>' +
          '<div class="empty-text">' + esc(t("emptyTitle")) + '</div>' +
          '<div class="empty-hint">' + esc(t("emptyHint")) + '</div></div>';
        return;
      }

      var html = '<div class="section-label">' + esc(t("activeSessions")) + ' &middot; ' + entries.length + '</div>';
      for (var i = 0; i < entries.length; i++) html += this._renderCard(entries[i][0], entries[i][1]);
      this.container.innerHTML = html;
      // Touch-friendly: tapping anywhere on the card toggles it (not just the
      // little chevron). Tapping again collapses it.
      this.container.querySelectorAll(".session-card").forEach(function(el) {
        el.addEventListener("click", function() { self.toggleExpand(this.getAttribute("data-sid")); });
      });
      if (this._animatingSid) {
        var animatingSid = this._animatingSid;
        this._animatingSid = null;
        if (this.expandedSet.has(animatingSid)) {
          var cards = this.container.querySelectorAll('.session-card');
          cards.forEach(function(card) {
            if (card.getAttribute('data-sid') === animatingSid) {
              var eh = card.querySelector('.event-history');
              if (eh) requestAnimationFrame(function() { eh.classList.add('show'); });
            }
          });
        }
      }
    }

    _renderCard(sid, s) {
      var config = STATE_CONFIG[s.state] || STATE_CONFIG.idle;
      var isExpanded = this.expandedSet.has(sid);
      var events = s.recentEvents || [];
      var stateKey = s.state || "idle";
      var agentLabel = (s.agentId || "agent").toUpperCase();
      var sessionTitle = s.title || "";
      var html = '<div class="session-card" data-sid="' + sid + '">';
      html += '<div class="card-header"><div class="card-agent"><div class="agent-dot"></div>';
      html += '<span class="agent-name">' + esc(agentLabel) + '</span></div>';
      html += '<span class="state-badge ' + stateKey + '">' + config.label + '</span></div>';
      if (sessionTitle) html += '<div class="card-title">' + esc(sessionTitle) + '</div>';
      html += '<div class="card-meta">';
      if (s.basename) { html += '<span class="meta-item mono">' + icon("folder") + '<span>' + esc(s.basename) + '</span></span>'; }
      if (s.updatedAt) { html += '<span class="meta-sep">&middot;</span><span class="meta-item meta-time" data-ts="' + s.updatedAt + '">' + formatAgo(s.updatedAt) + '</span>'; }
      if (s.contextUsage && typeof s.contextUsage.percent === "number") { html += '<span class="meta-sep">&middot;</span><span class="meta-item ctx-usage' + (s.contextUsage.percent >= 80 ? ' ctx-high' : '') + '">' + s.contextUsage.percent + '% ctx</span>'; }
      html += '</div>';
      html += '<div class="card-divider"></div>';
      html += '<div class="card-footer"><div class="footer-events">' + icon("activity") + '<span>' + esc(t("recentEvents")) + '</span>';
      if (events.length) html += '<span class="event-count">' + events.length + '</span>';
      html += '</div><span class="footer-chevron">' + (isExpanded ? icon("collapse") : icon("expand")) + '</span></div>';
      if (events.length || s.assistantLastOutput) html += this._renderExpanded(s, isExpanded, this._animatingSid === sid);
      html += '</div>';
      return html;
    }

    _renderExpanded(s, expanded, animate) {
      var showClass = (expanded && !animate) ? ' show' : '';
      var html = '<div class="event-history' + showClass + '"><div class="event-timeline">';
      // Latest assistant text — read along on the phone with what it just wrote.
      if (s.assistantLastOutput) {
        html += '<div class="assistant-output">' + esc(s.assistantLastOutput) + (s.assistantLastOutputTruncated ? ' …' : '') + '</div>';
      }
      var events = s.recentEvents || [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i]; var c = STATE_CONFIG[ev.state] || STATE_CONFIG.idle;
        html += '<div class="event-row"><div class="event-dot" style="background:' + c.color + '"></div>';
        html += '<div class="event-line" style="background:' + c.color + '"></div>';
        html += '<span class="event-icon">' + eventIcon(ev.event) + '</span>';
        html += '<span class="event-label">' + esc(eventLabel(ev.event)) + '</span>';
        html += '<span class="event-time"' + (ev.at ? ' data-ts="' + ev.at + '"' : '') + '>' + formatAgo(ev.at) + '</span></div>';
      }
      return html + '</div></div>';
    }

    _startTimerUpdater() {
      var self = this;
      setInterval(function() {
        if (document.visibilityState !== 'visible') return;
        var els = self.container.querySelectorAll('.event-time[data-ts], .meta-time[data-ts]');
        for (var i = 0; i < els.length; i++) {
          var ts = parseInt(els[i].getAttribute('data-ts'), 10);
          if (!isNaN(ts)) els[i].textContent = formatAgo(ts);
        }
      }, 1000);
    }

    _updatePet() {
      var petEl = document.getElementById("pet-display");
      if (!petEl) return;
      // Aggregate state = the highest-priority (most active) session's state.
      var state = "sleeping";
      var bestP = 999;
      this.sessions.forEach(function(s) {
        var p = (STATE_CONFIG[s.state] || STATE_CONFIG.idle).priority;
        if (p < bestP) { bestP = p; state = s.state || "idle"; }
      });
      var svg = PET_SVG[state] || PET_SVG.idle;
      var img = petEl.querySelector("img.pet-img");
      if (!img) {
        petEl.innerHTML = '<img class="pet-img" alt=""><div class="pet-label"></div>';
        img = petEl.querySelector("img.pet-img");
      }
      if (img.getAttribute("data-svg") !== svg) {
        img.setAttribute("data-svg", svg);
        img.src = "/mobile/pet/" + svg;
      }
      var labelEl = petEl.querySelector(".pet-label");
      if (labelEl) labelEl.textContent = (STATE_CONFIG[state] || STATE_CONFIG.idle).label;
    }

    startStaleCleanup() {
      var self = this;
      this.staleTimer = setInterval(function() {
        var changed = false;
        self.sessions.forEach(function(s, sid) {
          if (s.state === "sleeping") { self.sessions.delete(sid); changed = true; }
        });
        if (changed) self.render();
      }, 15000);
    }
  }

  // === SettingsRenderer ===

  class SettingsRenderer {
    constructor(container) { this.container = container; }

    render(connection) {
      var self = this;
      var html = '';

      // Connection status
      html += '<div class="settings-section">';
      html += '<div class="settings-section-title">' + esc(t("settingsConnection")) + '</div>';
      var st = connection.state;
      var stCfg = CONNECTION_STATES[st] || CONNECTION_STATES.disconnected;
      html += '<div class="conn-status">';
      html += '<span class="conn-status-dot ' + stCfg.dot + '"></span>';
      html += '<span class="conn-status-text">' + stCfg.text + '</span>';
      if (connection.config) html += '<span class="conn-status-addr">' + esc(connection.config.host) + ':' + connection.config.port + '</span>';
      html += '</div>';
      html += '</div>';

      // Notifications
      if ("Notification" in window) {
        html += '<div class="settings-section">';
        html += '<div class="settings-section-title">' + esc(t("notifSection")) + '</div>';
        if (Notification.permission === "granted") {
          html += '<div class="notif-status notif-on">' + esc(t("notifOn")) + '</div>';
        } else if (Notification.permission === "denied") {
          html += '<div class="notif-status notif-blocked">' + esc(t("notifBlocked")) + '</div>';
        } else {
          html += '<button class="notif-enable-btn" id="btn-enable-notif">' + esc(t("notifEnable")) + '</button>';
        }
        html += '</div>';
      }

      // Log section (collapsed by default)
      html += '<div class="log-section">';
      html += '<button class="log-toggle" id="btn-toggle-log">' + esc(t("logLabel")) + ' (' + _logBuffer.length + ')</button>';
      html += '<div class="log-body" id="settings-log-content"></div>';
      html += '</div>';

      this.container.innerHTML = html;

      // Enable-notifications button
      var notifBtn = document.getElementById("btn-enable-notif");
      if (notifBtn) {
        notifBtn.addEventListener("click", function() {
          if (window.Notification && Notification.requestPermission) {
            Notification.requestPermission().then(function() {
              if (window._clawdApp && window._clawdApp.notifier) window._clawdApp.notifier.permission = Notification.permission;
              self.render(connection);
            });
          }
        });
      }

      // Render buffered log lines
      var logEl = document.getElementById("settings-log-content");
      if (logEl) {
        for (var li = 0; li < _logBuffer.length; li++) {
          var div = document.createElement("div");
          div.textContent = _logBuffer[li];
          logEl.appendChild(div);
        }
      }

      // Bind log toggle
      var logToggle = document.getElementById("btn-toggle-log");
      var logBody = document.getElementById("settings-log-content");
      if (logToggle && logBody) {
        logToggle.addEventListener("click", function() {
          logToggle.classList.toggle("open");
          logBody.classList.toggle("open");
          if (logBody.classList.contains("open")) logBody.scrollTop = logBody.scrollHeight;
        });
      }
    }
  }

  // === App ===

  class App {
    constructor() {
      applyStaticI18n();
      this.connection = new ConnectionManager();
      this.renderer = new SessionRenderer(document.getElementById("session-list"));
      this.settingsRenderer = new SettingsRenderer(document.getElementById("settings-content"));
      this.notifier = new NotificationManager();
      this.activeTab = "sessions";

      window._clawdApp = this;

      this._bindNav();
      this._bindConnection();
      this.renderer.startStaleCleanup();

      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/mobile/sw.js").catch(function() {});
      this._autoConnect();
    }

    _autoConnect() {
      var params = new URLSearchParams(window.location.search);
      var urlHost = params.get("host");
      var urlPort = params.get("port");
      var urlToken = params.get("token");
      // Carry the pairing params into the manifest request so iOS "Add to Home
      // Screen" captures a start_url that can connect. The server only echoes
      // params we already hold, so the token is never exposed to an
      // unauthenticated manifest request.
      if (urlHost && urlPort && urlToken) {
        var mlink = document.querySelector('link[rel="manifest"]');
        if (mlink) mlink.setAttribute("href", "/mobile/manifest.json" + window.location.search);
      }
      var history = this.connection.getHistory();
      if (urlHost && urlPort) {
        // The token rotates, but the home-screen icon (iOS) always launches the
        // same start_url. Prefer the freshest token saved for this host:port so a
        // returning client survives rotation; fall back to the URL token.
        var saved = null;
        for (var i = 0; i < history.length; i++) {
          if (history[i].host === urlHost && String(history[i].port) === String(urlPort)) { saved = history[i]; break; }
        }
        var token = (saved && saved.token) || urlToken;
        if (token) { this.connection.connect({ host: urlHost, port: parseInt(urlPort, 10), token: token }); return; }
      }
      // No usable URL params (e.g. opened from the home-screen icon after the
      // token was stripped): reconnect using the most recent saved connection.
      if (history.length > 0) { this.connection.connect(history[0]); return; }
    }

    _bindNav() {
      var self = this;
      document.querySelectorAll(".nav-tab").forEach(function(tab) {
        tab.addEventListener("click", function() { self._switchTab(this.getAttribute("data-tab")); });
      });
    }

    _switchTab(tabId) {
      this.activeTab = tabId;
      document.querySelectorAll(".nav-tab").forEach(function(t) {
        t.classList.toggle("active", t.getAttribute("data-tab") === tabId);
      });
      document.getElementById("page-sessions").classList.toggle("hidden", tabId !== "sessions");
      document.getElementById("page-settings").classList.toggle("hidden", tabId !== "settings");
      if (tabId === "settings") {
        this._renderSettings();
      }
    }

    _renderSettings() {
      this.settingsRenderer.render(this.connection);
    }

    _bindConnection() {
      var self = this;
      this.connection.onStateChange = function(state) {
        self._updateConnectionStatus(state);
        if (state === "connected") self.notifier.requestPermission();
        if (self.activeTab === "settings") self._renderSettings();
      };
      this.connection.onMessage = function(msg) {
        if (msg.type === "snapshot") { self.renderer.updateFromSnapshot(msg.sessions || {}); log("Snapshot: " + Object.keys(msg.sessions || {}).length + " sessions"); }
        else if (msg.type === "state") { self.renderer.updateState(msg.sessionId, msg.data); self.notifier.onStateChange(msg.sessionId, msg.data); }
        else if (msg.type === "session_deleted") { self.renderer.removeSession(msg.sessionId); }
        else if (msg.type === "tool_output") { var sid = msg.sessionId; var session = self.renderer.sessions.get(sid); if (session) { session.lastOutput = { toolName: msg.data.toolName, output: (msg.data.output || "").substring(0, 200), at: msg.timestamp || Date.now() }; self.renderer.render(); } }
        else if (msg.type === "token_rotate") {
          var newToken = msg.newToken;
          if (newToken && self.connection.config) {
            self.connection.config.token = newToken;
            self.connection._updateHistoryToken(self.connection.config.host, self.connection.config.port, newToken);
            self.connection.send({ type: "token_rotate_ack" });
            log("Token rotated");
            showToast(t("toastTokenUpdated"), "success");
          }
        }
      };
    }

    _updateConnectionStatus(state) {
      var config = CONNECTION_STATES[state] || CONNECTION_STATES.disconnected;
      var dot = document.getElementById("connection-dot");
      var text = document.getElementById("connection-text");
      dot.className = "connection-dot " + config.dot;
      text.textContent = state === "disconnected" ? "" : config.text;
      text.className = "connection-text" + (state === "connected" ? " connected" : "");
    }

  }

  // === Init ===
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function() { new App(); });
  else new App();
})();
