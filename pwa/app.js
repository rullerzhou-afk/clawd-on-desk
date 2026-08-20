(function() {
  "use strict";

  // === Constants ===

  var STATE_CONFIG = {
    error:        { icon: "error",        color: "#ef4444", priority: 0, label: "错误" },
    attention:    { icon: "attention",    color: "#b45309", priority: 1, label: "需要关注" },
    working:      { icon: "working",      color: "#22c55e", priority: 2, label: "工作中" },
    juggling:     { icon: "juggling",     color: "#22c55e", priority: 2, label: "多任务" },
    thinking:     { icon: "thinking",     color: "#3b82f6", priority: 3, label: "思考中" },
    notification: { icon: "notification", color: "#d97757", priority: 4, label: "通知" },
    sweeping:     { icon: "sweeping",     color: "#71717a", priority: 5, label: "清理中" },
    carrying:     { icon: "carrying",     color: "#71717a", priority: 5, label: "搬运中" },
    idle:         { icon: "idle",         color: "#71717a", priority: 6, label: "空闲" },
    sleeping:     { icon: "sleeping",     color: "#a1a1aa", priority: 7, label: "休眠" },
  };

  var CONNECTION_STATES = {
    connected:    { dot: "connected", text: "已连接", color: "#22c55e" },
    connecting:   { dot: "connecting", text: "连接中...", color: "#b45309" },
    reconnecting: { dot: "reconnecting", text: "重连中...", color: "#ef4444" },
    disconnected: { dot: "", text: "", color: "#52525b" },
    auth_failed:  { dot: "", text: "认证失败", color: "#ef4444" },
  };

  var EVENT_LABELS_CN = {
    UserPromptSubmit: "用户输入", PreToolUse: "工具启动", PostToolUse: "工具完成",
    PostToolUseFailure: "工具失败", Stop: "已完成", SessionStart: "会话开始",
    SessionEnd: "会话结束", PermissionRequest: "需要权限", Notification: "通知",
    SubagentStart: "子代理启动", SubagentStop: "子代理停止",
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
    if (sec < 5) return "刚刚";
    if (sec < 60) return sec + "秒前";
    if (sec < 3600) return Math.floor(sec / 60) + "分钟前";
    return Math.floor(sec / 3600) + "小时前";
  }

  function monotonicNow() {
    return (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
  }

  function formatWaitingAge(ms) {
    var sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (sec < 5) return "刚刚出现";
    if (sec < 60) return "已等待 " + sec + " 秒";
    if (sec < 3600) return "已等待 " + Math.floor(sec / 60) + " 分钟";
    return "已等待 " + Math.floor(sec / 3600) + " 小时";
  }

  function normalizePermissionFeature(feature) {
    return {
      supported: !!(feature && feature.supported === true),
      enabled: !!(feature && feature.supported === true && feature.enabled === true),
    };
  }

  function eventLabel(eventName) {
    return EVENT_LABELS_CN[eventName] || (typeof EVENT_LABELS !== "undefined" && EVENT_LABELS[eventName]) || eventName || "";
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
    constructor() {
      this.permission = "default";
      this.lastStates = new Map();
      this.activePermissionIds = new Set();
      this.pendingPermissionNotifications = new Map();
      this.fallbackPermissionNotifications = new Map();
    }

    requestPermission() {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") { this.permission = "granted"; return; }
      if (Notification.permission !== "denied") {
        var self = this;
        Notification.requestPermission().then(function(p) { self.permission = p; });
      }
    }

    onStateChange(sessionId, data) {
      if (this.permission !== "granted" || document.visibilityState === "visible") return;
      var prev = this.lastStates.get(sessionId);
      this.lastStates.set(sessionId, data.state);
      var s = data.state;
      var config = STATE_CONFIG[s];
      if (!config) return;
      var label = data.title || data.agentId || "Agent";
      if (s === "error" || s === "attention") {
        this._notify(config.label, label + " - " + config.label, s);
      } else if ((prev === "working" || prev === "thinking") && s === "idle") {
        this._notify("任务完成", label + " 已完成任务", "idle");
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

    syncPermissionIds(ids) {
      var next = new Set(ids || []);
      var self = this;
      this.activePermissionIds.forEach(function(requestId) {
        if (!next.has(requestId)) self.dismissPermission(requestId);
      });
      next.forEach(function(requestId) { self.activePermissionIds.add(requestId); });
      this._closeInactiveServiceWorkerPermissionNotifications();
    }

    notifyPermission(requestId) {
      if (!requestId || this.activePermissionIds.has(requestId)) return false;
      this.activePermissionIds.add(requestId);
      if (this.permission !== "granted" || document.visibilityState === "visible") return false;

      var self = this;
      var attempt = {};
      var tag = "clawd-perm-" + requestId;
      this.pendingPermissionNotifications.set(requestId, attempt);

      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(function(reg) {
            if (!self.activePermissionIds.has(requestId)
                || self.pendingPermissionNotifications.get(requestId) !== attempt) return;
            self.pendingPermissionNotifications.delete(requestId);
            return Promise.resolve(reg.showNotification("Clawd 需要权限", {
              body: "Clawd 有一个待处理的权限请求。",
              tag: tag,
              icon: "/mobile/icons/icon-256.png",
            })).then(function() {
              // The notification API may settle after a retract already tried
              // (and found nothing) to close. Re-check after the platform says
              // the notification landed so a late result cannot resurrect it.
              if (self.activePermissionIds.has(requestId)) return;
              if (!reg || typeof reg.getNotifications !== "function") return;
              return reg.getNotifications({ tag: tag }).then(function(notifications) {
                (notifications || []).forEach(function(notification) {
                  try { notification.close(); } catch {}
                });
              });
            });
          }).catch(function() {});
        } else {
          if (!self.activePermissionIds.has(requestId)
              || self.pendingPermissionNotifications.get(requestId) !== attempt) return false;
          self.pendingPermissionNotifications.delete(requestId);
          var notification = new Notification("Clawd 需要权限", {
            body: "Clawd 有一个待处理的权限请求。",
            tag: tag,
          });
          self.fallbackPermissionNotifications.set(requestId, notification);
        }
      } catch {
        this.pendingPermissionNotifications.delete(requestId);
        return false;
      }
      return true;
    }

    dismissPermission(requestId) {
      if (!requestId) return;
      this.activePermissionIds.delete(requestId);
      this.pendingPermissionNotifications.delete(requestId);

      var fallback = this.fallbackPermissionNotifications.get(requestId);
      this.fallbackPermissionNotifications.delete(requestId);
      try { if (fallback && typeof fallback.close === "function") fallback.close(); } catch {}

      var tag = "clawd-perm-" + requestId;
      var self = this;
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
          navigator.serviceWorker.ready.then(function(reg) {
            if (self.activePermissionIds.has(requestId)) return [];
            if (!reg || typeof reg.getNotifications !== "function") return [];
            return reg.getNotifications({ tag: tag });
          }).then(function(notifications) {
            (notifications || []).forEach(function(notification) {
              try { notification.close(); } catch {}
            });
          }).catch(function() {});
        }
      } catch {}
    }

    clearPermissionNotifications() {
      var ids = new Set();
      this.activePermissionIds.forEach(function(id) { ids.add(id); });
      this.pendingPermissionNotifications.forEach(function(_attempt, id) { ids.add(id); });
      this.fallbackPermissionNotifications.forEach(function(_notification, id) { ids.add(id); });
      var self = this;
      ids.forEach(function(id) { self.dismissPermission(id); });
      this._closeInactiveServiceWorkerPermissionNotifications();
    }

    _closeInactiveServiceWorkerPermissionNotifications() {
      var self = this;
      try {
        if (!navigator.serviceWorker || !navigator.serviceWorker.ready) return;
        navigator.serviceWorker.ready.then(function(reg) {
          if (!reg || typeof reg.getNotifications !== "function") return [];
          return reg.getNotifications();
        }).then(function(notifications) {
          (notifications || []).forEach(function(notification) {
            var tag = notification && notification.tag;
            if (typeof tag !== "string" || tag.indexOf("clawd-perm-") !== 0) return;
            var requestId = tag.slice("clawd-perm-".length);
            if (!self.activePermissionIds.has(requestId)) {
              try { notification.close(); } catch {}
            }
          });
        }).catch(function() {});
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
      this.authBlocked = false;
      this.onStateChange = null; this.onMessage = null; this.onDisconnected = null; this.onAccessReset = null;
      this._hiddenAt = 0;
      this._bindVisibility();
    }

    connect(config) {
      this.config = config;
      this.authBlocked = false;
      this.retryCount = 0;
      this.reconnectDelay = 1000;
      clearTimeout(this.reconnectTimer);
      this._saveToHistory(config);
      this._doConnect();
    }

    _doConnect() {
      if (!this.config || this.authBlocked) return;
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
        self._setState("connected"); log("Connected"); showToast("已连接到桌面端", "success");
        // Dismiss any persistent toasts (e.g. retry hint)
        var persisted = document.querySelectorAll(".toast-persist");
        for (var i = 0; i < persisted.length; i++) { persisted[i].remove(); }
        // Strip query params from URL so stale ?token= from QR codes
        // won't overwrite a rotated token in history on next auto-connect.
        if (window.location.search) { history.replaceState(null, "", window.location.pathname); }
      };
      socket.onmessage = function(event) {
        if (socket !== self.ws) return;
        try { var msg = JSON.parse(event.data); if (self.onMessage) self.onMessage(msg); } catch {}
      };
      socket.onclose = function(event) {
        if (socket !== self.ws) return; // stale socket — ignore
        if (event.code === 1008) {
          self.authBlocked = true;
          clearTimeout(self.reconnectTimer);
          self.reconnectTimer = null;
          if (self.onAccessReset) self.onAccessReset(event);
          self._setState("auth_failed");
          var accessReset = /access[-_\s]?reset|reset|regenerat/i.test(event.reason || "");
          log(accessReset ? "Mobile access reset" : "Auth failed");
          showToast(accessReset ? "桌面端已重置访问权限，请重新配对" : "Token 已过期，请重新连接", "error");
          return;
        }
        if (connected) log("Disconnected (code: " + event.code + ")");
        if (self.onDisconnected) self.onDisconnected();
        self._scheduleReconnect();
      };
      socket.onerror = function() {};
    }

    send(data) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(typeof data === "string" ? data : JSON.stringify(data)); }

    _scheduleReconnect() {
      if (!this.config || this.authBlocked) return;
      this.retryCount++;
      this._setState("reconnecting");
      // After several retries, give actionable feedback (don't stop — just inform)
      if (this.retryCount === 5) {
        showToast("仍在重连…请检查地址、端口或桌面端是否已开启", "info", true);
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
        if (!self.config || self.authBlocked) return;
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

  // === Shared relative-time ticker ===

  class RelativeTimeTicker {
    constructor() {
      this.callbacks = new Set();
      var self = this;
      this.timer = setInterval(function() {
        if (document.visibilityState !== "visible") return;
        self.callbacks.forEach(function(callback) {
          try { callback(); } catch {}
        });
      }, 1000);
    }

    register(callback) {
      this.callbacks.add(callback);
      var self = this;
      return function() { self.callbacks.delete(callback); };
    }
  }

  // === PermissionBanner ===

  class PermissionBanner {
    constructor(container, notifier, relativeTimeTicker) {
      this.container = container;
      this.notifier = notifier;
      this.records = new Map();
      this.feature = normalizePermissionFeature(null);
      this.featureKnown = false;
      this.disconnected = true;
      var self = this;
      this.unregisterTicker = relativeTimeTicker && relativeTimeTicker.register(function() {
        self._updateRelativeTimes();
      });
      this.render();
    }

    setFeature(feature) {
      this.feature = normalizePermissionFeature(feature);
      this.featureKnown = true;
      if (!this.feature.enabled) {
        this.records.clear();
        this.notifier.syncPermissionIds([]);
      }
      this.render();
    }

    replace(feature, records, envelopeTimestamp) {
      this.feature = normalizePermissionFeature(feature);
      this.featureKnown = true;
      this.disconnected = false;
      var next = new Map();
      var list = this.feature.enabled && Array.isArray(records) ? records : [];
      for (var i = 0; i < list.length; i++) {
        var entry = this._makeEntry(list[i], envelopeTimestamp);
        if (entry) next.set(entry.record.requestId, entry);
      }
      this.notifier.syncPermissionIds(Array.from(next.keys()));
      this.records = next;
      this.render();
    }

    upsert(record, envelopeTimestamp) {
      if (!this.feature.supported || !this.feature.enabled) return false;
      var entry = this._makeEntry(record, envelopeTimestamp);
      if (!entry) return false;
      var requestId = entry.record.requestId;
      var isNew = !this.records.has(requestId);
      this.disconnected = false;
      this.records.set(requestId, entry);
      this.render();
      if (isNew) this.notifier.notifyPermission(requestId);
      return isNew;
    }

    retract(requestId) {
      if (!requestId || !this.records.has(requestId)) return false;
      this.records.delete(requestId);
      this.notifier.dismissPermission(requestId);
      this.render();
      return true;
    }

    setDisconnected(disconnected) {
      this.disconnected = disconnected === true;
      this.render();
    }

    clearForAccessReset() {
      this.records.clear();
      this.disconnected = true;
      this.notifier.clearPermissionNotifications();
      this.render();
    }

    _makeEntry(record, envelopeTimestamp) {
      if (!record || typeof record !== "object"
          || typeof record.requestId !== "string"
          || !/^[0-9a-f]{32}$/.test(record.requestId)) return null;
      var presentedAt = Number(record.presentedAt);
      var serverNow = Number(envelopeTimestamp);
      if (!Number.isFinite(presentedAt)) presentedAt = Number.isFinite(serverNow) ? serverNow : 0;
      if (!Number.isFinite(serverNow)) serverNow = presentedAt;
      return {
        record: {
          requestId: String(record.requestId),
          agentId: String(record.agentId || ""),
          toolName: String(record.toolName || ""),
          summary: String(record.summary || ""),
          folder: String(record.folder || ""),
          presentedAt: presentedAt,
        },
        ageAtReceipt: Math.max(0, serverNow - presentedAt),
        receivedAt: monotonicNow(),
      };
    }

    _stateName() {
      if (!this.featureKnown) return "unknown";
      if (!this.feature.supported) return "unsupported";
      if (!this.feature.enabled) return "disabled";
      if (this.disconnected) return "stale";
      if (this.records.size === 0) return "empty";
      return "pending";
    }

    render() {
      var state = this._stateName();
      this.container.className = "permission-banner-container permission-state-" + state;
      this.container.setAttribute("data-state", state);
      this.container.classList.remove("hidden");

      if (state === "unknown") {
        this.container.classList.add("hidden");
        this.container.innerHTML = "";
        return;
      }

      if (state === "unsupported") {
        this.container.innerHTML = '<div class="permission-state-message">桌面端不支持权限预览</div>';
        return;
      }
      if (state === "disabled") {
        this.container.innerHTML = '<div class="permission-state-message">桌面端未开启权限预览</div>';
        return;
      }
      if (this.records.size === 0) {
        this.container.innerHTML = '<div class="permission-state-message">' +
          (state === "stale" ? "连接已断开，等待重新同步" : "权限预览已开启，暂无待处理请求") + '</div>';
        return;
      }

      var html = '<div class="permission-section-label">待处理权限 · ' + this.records.size + '</div>';
      if (this.disconnected) html += '<div class="permission-stale-note">连接已断开，以下状态可能已过期</div>';
      this.records.forEach(function(entry) {
        var record = entry.record;
        html += '<article class="permission-card">';
        html += '<div class="permission-card-header"><span class="permission-agent">' + esc(record.agentId || "AGENT") + '</span>';
        html += '<span class="permission-readonly-badge">只读</span></div>';
        html += '<div class="permission-tool">' + esc(record.toolName || "权限请求") + '</div>';
        if (record.summary) html += '<div class="permission-summary">' + esc(record.summary) + '</div>';
        html += '<div class="permission-card-meta">';
        if (record.folder) html += '<span class="permission-folder">' + esc(record.folder) + '</span>';
        html += '<span class="permission-time" aria-live="off" aria-hidden="true" data-permission-id="' + esc(record.requestId) + '">' +
          formatWaitingAge(entry.ageAtReceipt) + '</span></div>';
        html += '<div class="permission-notice">请在桌面端处理此请求</div></article>';
      });
      this.container.innerHTML = html;
    }

    _updateRelativeTimes() {
      var self = this;
      var now = monotonicNow();
      var elements = this.container.querySelectorAll(".permission-time[data-permission-id]");
      for (var i = 0; i < elements.length; i++) {
        var requestId = elements[i].getAttribute("data-permission-id");
        var entry = self.records.get(requestId);
        if (entry) elements[i].textContent = formatWaitingAge(entry.ageAtReceipt + Math.max(0, now - entry.receivedAt));
      }
    }
  }

  // === SessionRenderer ===

  class SessionRenderer {
    constructor(container, relativeTimeTicker) {
      this.container = container;
      this.sessions = new Map();
      this.staleTimer = null;
      this.expandedSet = new Set();
      var self = this;
      this.unregisterTicker = relativeTimeTicker.register(function() { self._updateRelativeTimes(); });
    }

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
      var entries = [];
      this.sessions.forEach(function(v, k) { entries.push([k, v]); });
      entries.sort(function(a, b) {
        var pa = (STATE_CONFIG[a[1].state] || STATE_CONFIG.idle).priority;
        var pb = (STATE_CONFIG[b[1].state] || STATE_CONFIG.idle).priority;
        return pa - pb;
      });

      if (entries.length === 0) {
        this.container.innerHTML = '<div class="empty-state"><div class="empty-icon">' + icon("paw") + '</div>' +
          '<div class="empty-text">连接桌面端开始监控</div>' +
          '<div class="empty-hint">前往设置页配置连接</div></div>';
        return;
      }

      var html = '<div class="section-label">活跃会话 &middot; ' + entries.length + '</div>';
      for (var i = 0; i < entries.length; i++) html += this._renderCard(entries[i][0], entries[i][1]);
      this.container.innerHTML = html;
      this.container.querySelectorAll(".card-footer").forEach(function(el) {
        el.addEventListener("click", function() { self.toggleExpand(this.getAttribute("data-sid")); });
      });
      if (this._animatingSid) {
        var animatingSid = this._animatingSid;
        this._animatingSid = null;
        if (this.expandedSet.has(animatingSid)) {
          var cards = this.container.querySelectorAll('.session-card');
          cards.forEach(function(card) {
            var footer = card.querySelector('.card-footer');
            if (footer && footer.getAttribute('data-sid') === animatingSid) {
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
      var html = '<div class="session-card">';
      html += '<div class="card-header"><div class="card-agent"><div class="agent-dot"></div>';
      html += '<span class="agent-name">' + esc(agentLabel) + '</span></div>';
      html += '<span class="state-badge ' + stateKey + '">' + config.label + '</span></div>';
      if (sessionTitle) html += '<div class="card-title">' + esc(sessionTitle) + '</div>';
      html += '<div class="card-meta">';
      if (s.basename) { html += '<span class="meta-item mono">' + icon("folder") + '<span>' + esc(s.basename) + '</span></span>'; }
      if (s.updatedAt) { html += '<span class="meta-sep">&middot;</span><span class="meta-item meta-time" data-ts="' + s.updatedAt + '">' + formatAgo(s.updatedAt) + '</span>'; }
      html += '</div>';
      html += '<div class="card-divider"></div>';
      html += '<div class="card-footer" data-sid="' + sid + '"><div class="footer-events">' + icon("activity") + '<span>最近事件</span>';
      if (events.length) html += '<span class="event-count">' + events.length + '</span>';
      html += '</div><span class="footer-chevron">' + (isExpanded ? icon("collapse") : icon("expand")) + '</span></div>';
      if (events.length) html += this._renderEvents(events, isExpanded, this._animatingSid === sid);
      html += '</div>';
      return html;
    }

    _renderEvents(events, expanded, animate) {
      var showClass = (expanded && !animate) ? ' show' : '';
      var html = '<div class="event-history' + showClass + '"><div class="event-timeline">';
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

    _updateRelativeTimes() {
      var els = this.container.querySelectorAll('.event-time[data-ts], .meta-time[data-ts]');
      for (var i = 0; i < els.length; i++) {
        var ts = parseInt(els[i].getAttribute('data-ts'), 10);
        if (!isNaN(ts)) els[i].textContent = formatAgo(ts);
      }
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
      var html = '';

      // Connection status
      html += '<div class="settings-section">';
      html += '<div class="settings-section-title">连接</div>';
      var st = connection.state;
      var stCfg = CONNECTION_STATES[st] || CONNECTION_STATES.disconnected;
      html += '<div class="conn-status">';
      html += '<span class="conn-status-dot ' + stCfg.dot + '"></span>';
      html += '<span class="conn-status-text">' + stCfg.text + '</span>';
      if (connection.config) html += '<span class="conn-status-addr">' + esc(connection.config.host) + ':' + connection.config.port + '</span>';
      html += '</div>';
      html += '</div>';

      // Log section (collapsed by default)
      html += '<div class="log-section">';
      html += '<button class="log-toggle" id="btn-toggle-log">日志 (' + _logBuffer.length + ')</button>';
      html += '<div class="log-body" id="settings-log-content"></div>';
      html += '</div>';

      this.container.innerHTML = html;

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
      this.connection = new ConnectionManager();
      this.notifier = new NotificationManager();
      this.relativeTimeTicker = new RelativeTimeTicker();
      this.renderer = new SessionRenderer(document.getElementById("session-list"), this.relativeTimeTicker);
      this.permissionBanner = new PermissionBanner(
        document.getElementById("permission-banner-container"),
        this.notifier,
        this.relativeTimeTicker
      );
      this.settingsRenderer = new SettingsRenderer(document.getElementById("settings-content"));
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
      if (urlHost && urlPort && urlToken) {
        this.connection.connect({ host: urlHost, port: parseInt(urlPort, 10), token: urlToken });
        return;
      }
      var history = this.connection.getHistory();
      if (history.length > 0) { this.connection.connect(history[0]); return; }
      // M1: no auto-connect without token. User must open via clawd:// URL (from Settings page)
      // or manually enter host/port/token in the connection history.
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
        else self.permissionBanner.setDisconnected(true);
        if (self.activeTab === "settings") self._renderSettings();
      };
      this.connection.onDisconnected = function() {
        self.permissionBanner.setDisconnected(true);
      };
      this.connection.onAccessReset = function() {
        self.permissionBanner.clearForAccessReset();
      };
      this.connection.onMessage = function(msg) {
        if (msg.type === "snapshot") {
          self.renderer.updateFromSnapshot(msg.sessions || {});
          var features = msg.features;
          if (features && Object.prototype.hasOwnProperty.call(features, "permissionPreview")) {
            self.permissionBanner.setFeature(features.permissionPreview);
          } else {
            self.permissionBanner.replace({ supported: false, enabled: false }, [], msg.timestamp);
          }
          log("Snapshot: " + Object.keys(msg.sessions || {}).length + " sessions");
        }
        else if (msg.type === "state") { self.renderer.updateState(msg.sessionId, msg.data); self.notifier.onStateChange(msg.sessionId, msg.data); }
        else if (msg.type === "session_deleted") { self.renderer.removeSession(msg.sessionId); }
        else if (msg.type === "tool_output") { var sid = msg.sessionId; var session = self.renderer.sessions.get(sid); if (session) { session.lastOutput = { toolName: msg.data.toolName, output: (msg.data.output || "").substring(0, 200), at: msg.timestamp || Date.now() }; self.renderer.render(); } }
        else if (msg.type === "permission_snapshot") {
          self.permissionBanner.replace(msg.feature, msg.permissions, msg.timestamp);
          log("Permission snapshot: " + (Array.isArray(msg.permissions) ? msg.permissions.length : 0));
        }
        else if (msg.type === "permission_request") {
          if (self.permissionBanner.upsert(msg.permission, msg.timestamp)) log("Permission request received");
        }
        else if (msg.type === "permission_dismissed") {
          if (self.permissionBanner.retract(msg.requestId, { reason: msg.reason, decided: msg.decided })) {
            log("Permission request dismissed: " + (msg.reason || "unknown"));
          }
        }
        else if (msg.type === "token_rotate") {
          var newToken = msg.newToken;
          if (newToken && self.connection.config) {
            self.connection.config.token = newToken;
            self.connection._updateHistoryToken(self.connection.config.host, self.connection.config.port, newToken);
            self.connection.send({ type: "token_rotate_ack" });
            log("Token rotated");
            showToast("令牌已更新", "success");
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

  if (window.__CLAWD_MOBILE_TEST__) {
    window.__CLAWD_MOBILE_TEST__.exports = {
      App: App,
      ConnectionManager: ConnectionManager,
      NotificationManager: NotificationManager,
      PermissionBanner: PermissionBanner,
      RelativeTimeTicker: RelativeTimeTicker,
      SessionRenderer: SessionRenderer,
      formatWaitingAge: formatWaitingAge,
    };
  }

  // === Init ===
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function() { new App(); });
  else new App();
})();
