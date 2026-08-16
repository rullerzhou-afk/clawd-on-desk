"use strict";

const telegramApprovalSettings = require("./telegram-approval-settings");

const DEFAULT_STATUS_SESSION_LIMIT = 5;
const STATUS_TEXT_MAX = 3600;

const STATUS_LOCALES = Object.freeze({
  en: {
    title: "Clawd Telegram status",
    labels: {
      transport: "Transport",
      health: "Health",
      nativePolling: "Native polling",
      approval: "Approval",
      completionNotifications: "Completion notifications",
      completionOutput: "output",
      completionBare: "bare fallback",
      token: "Token",
      config: "Config",
      pendingApprovals: "Pending approvals",
      nativeApprovalCards: "Native approval cards",
      lastError: "Last error",
      sessions: "Sessions",
      latestSession: "Latest session",
    },
    words: {
      none: "none",
      unknown: "unknown",
      on: "on",
      off: "off",
      running: "running",
      stopped: "stopped",
      available: "available",
      unavailable: "unavailable",
      stored: "stored",
      missing: "missing",
      complete: "complete",
      incomplete: "incomplete",
    },
    transport: { native: "native", off: "off" },
    health: {
      off: "off",
      failed: "failed",
      "setup-needed": "setup-needed",
      testing: "testing",
      healthy: "healthy",
      inactive: "inactive",
      starting: "starting",
      unknown: "unknown",
    },
    age: {
      unknown: "unknown",
      now: "now",
      sec: "{n}s ago",
      min: "{n}m ago",
      hour: "{n}h ago",
      day: "{n}d ago",
    },
    session: {
      state: "state",
      badge: "badge",
      lastHook: "last hook",
      updated: "updated",
    },
    error: { scope: "scope", code: "code", event: "event" },
    completionOutputMode: { off: "off", full: "full answer" },
    completionInactiveSuffix: " (inactive until native is running)",
    truncated: "... truncated",
  },
  zh: {
    title: "Clawd Telegram 状态",
    labels: {
      transport: "传输",
      health: "健康状态",
      nativePolling: "原生轮询",
      approval: "审批",
      completionNotifications: "完成通知",
      completionOutput: "输出",
      completionBare: "裸通知",
      token: "Token",
      config: "配置",
      pendingApprovals: "待处理审批",
      nativeApprovalCards: "原生审批卡片",
      lastError: "最近错误",
      sessions: "会话",
      latestSession: "最新会话",
    },
    words: {
      none: "无",
      unknown: "未知",
      on: "开启",
      off: "关闭",
      running: "运行中",
      stopped: "已停止",
      available: "可用",
      unavailable: "不可用",
      stored: "已保存",
      missing: "缺失",
      complete: "完整",
      incomplete: "未完成",
    },
    transport: { native: "原生", off: "关闭" },
    health: {
      off: "关闭",
      failed: "失败",
      "setup-needed": "需要设置",
      testing: "测试中",
      healthy: "正常",
      inactive: "未运行",
      starting: "启动中",
      unknown: "未知",
    },
    age: {
      unknown: "未知",
      now: "刚刚",
      sec: "{n} 秒前",
      min: "{n} 分钟前",
      hour: "{n} 小时前",
      day: "{n} 天前",
    },
    session: {
      state: "状态",
      badge: "标记",
      lastHook: "最近 hook",
      updated: "更新于",
    },
    error: { scope: "范围", code: "代码", event: "事件" },
    completionOutputMode: { off: "关闭", full: "完整回答" },
    completionInactiveSuffix: "（原生运行后生效）",
    truncated: "... 已截断",
  },
  "zh-TW": {
    title: "Clawd Telegram 狀態",
    labels: {
      transport: "傳輸",
      health: "健康狀態",
      nativePolling: "原生輪詢",
      approval: "審批",
      completionNotifications: "完成通知",
      completionOutput: "輸出",
      completionBare: "裸通知",
      token: "Token",
      config: "設定",
      pendingApprovals: "待處理審批",
      nativeApprovalCards: "原生審批卡片",
      lastError: "最近錯誤",
      sessions: "工作階段",
      latestSession: "最新工作階段",
    },
    words: {
      none: "無",
      unknown: "未知",
      on: "開啟",
      off: "關閉",
      running: "執行中",
      stopped: "已停止",
      available: "可用",
      unavailable: "不可用",
      stored: "已儲存",
      missing: "缺少",
      complete: "完整",
      incomplete: "未完成",
    },
    transport: { native: "原生", off: "關閉" },
    health: {
      off: "關閉",
      failed: "失敗",
      "setup-needed": "需要設定",
      testing: "測試中",
      healthy: "正常",
      inactive: "未執行",
      starting: "啟動中",
      unknown: "未知",
    },
    age: {
      unknown: "未知",
      now: "剛剛",
      sec: "{n} 秒前",
      min: "{n} 分鐘前",
      hour: "{n} 小時前",
      day: "{n} 天前",
    },
    session: {
      state: "狀態",
      badge: "標記",
      lastHook: "最近 hook",
      updated: "更新於",
    },
    error: { scope: "範圍", code: "代碼", event: "事件" },
    completionOutputMode: { off: "關閉", full: "完整回答" },
    completionInactiveSuffix: "（原生執行後生效）",
    truncated: "... 已截斷",
  },
  ko: {
    title: "Clawd Telegram 상태",
    labels: {
      transport: "전송",
      health: "상태",
      nativePolling: "네이티브 폴링",
      approval: "승인",
      completionNotifications: "완료 알림",
      completionOutput: "출력",
      completionBare: "기본 알림",
      token: "토큰",
      config: "설정",
      pendingApprovals: "대기 중인 승인",
      nativeApprovalCards: "네이티브 승인 카드",
      lastError: "최근 오류",
      sessions: "세션",
      latestSession: "최근 세션",
    },
    words: {
      none: "없음",
      unknown: "알 수 없음",
      on: "켜짐",
      off: "꺼짐",
      running: "실행 중",
      stopped: "중지됨",
      available: "사용 가능",
      unavailable: "사용 불가",
      stored: "저장됨",
      missing: "없음",
      complete: "완료",
      incomplete: "미완료",
    },
    transport: { native: "네이티브", off: "꺼짐" },
    health: {
      off: "꺼짐",
      failed: "실패",
      "setup-needed": "설정 필요",
      testing: "테스트 중",
      healthy: "정상",
      inactive: "비활성",
      starting: "시작 중",
      unknown: "알 수 없음",
    },
    age: {
      unknown: "알 수 없음",
      now: "방금",
      sec: "{n}초 전",
      min: "{n}분 전",
      hour: "{n}시간 전",
      day: "{n}일 전",
    },
    session: {
      state: "상태",
      badge: "배지",
      lastHook: "최근 hook",
      updated: "업데이트",
    },
    error: { scope: "범위", code: "코드", event: "이벤트" },
    completionOutputMode: { off: "꺼짐", full: "전체 답변" },
    completionInactiveSuffix: " (네이티브 실행 후 활성)",
    truncated: "... 잘림",
  },
  ja: {
    title: "Clawd Telegram ステータス",
    labels: {
      transport: "送信方式",
      health: "状態",
      nativePolling: "ネイティブポーリング",
      approval: "承認",
      completionNotifications: "完了通知",
      completionOutput: "出力",
      completionBare: "完了のみ通知",
      token: "トークン",
      config: "設定",
      pendingApprovals: "保留中の承認",
      nativeApprovalCards: "ネイティブ承認カード",
      lastError: "直近のエラー",
      sessions: "セッション",
      latestSession: "最新セッション",
    },
    words: {
      none: "なし",
      unknown: "不明",
      on: "オン",
      off: "オフ",
      running: "実行中",
      stopped: "停止中",
      available: "利用可能",
      unavailable: "利用不可",
      stored: "保存済み",
      missing: "未設定",
      complete: "完了",
      incomplete: "未完了",
    },
    transport: { native: "ネイティブ", off: "オフ" },
    health: {
      off: "オフ",
      failed: "失敗",
      "setup-needed": "設定が必要",
      testing: "テスト中",
      healthy: "正常",
      inactive: "非アクティブ",
      starting: "起動中",
      unknown: "不明",
    },
    age: {
      unknown: "不明",
      now: "たった今",
      sec: "{n}秒前",
      min: "{n}分前",
      hour: "{n}時間前",
      day: "{n}日前",
    },
    session: {
      state: "状態",
      badge: "バッジ",
      lastHook: "直近 hook",
      updated: "更新",
    },
    error: { scope: "範囲", code: "コード", event: "イベント" },
    completionOutputMode: { off: "オフ", full: "全文" },
    completionInactiveSuffix: "（ネイティブ実行後に有効）",
    truncated: "... 省略",
  },
  "pt-BR": {
    title: "Status do Telegram no Clawd",
    labels: {
      transport: "Transporte",
      health: "Saúde",
      nativePolling: "Polling nativo",
      approval: "Aprovação",
      completionNotifications: "Notificações de conclusão",
      completionOutput: "saída",
      completionBare: "fallback simples",
      token: "Token",
      config: "Configuração",
      pendingApprovals: "Aprovações pendentes",
      nativeApprovalCards: "Cards de aprovação nativos",
      lastError: "Último erro",
      sessions: "Sessões",
      latestSession: "Sessão mais recente",
    },
    words: {
      none: "nenhum",
      unknown: "desconhecido",
      on: "ligado",
      off: "desligado",
      running: "em execução",
      stopped: "parado",
      available: "disponível",
      unavailable: "indisponível",
      stored: "guardado",
      missing: "ausente",
      complete: "completa",
      incomplete: "incompleta",
    },
    transport: { native: "nativo", off: "desligado" },
    health: {
      off: "desligado",
      failed: "falhou",
      "setup-needed": "precisa de configuração",
      testing: "testando",
      healthy: "saudável",
      inactive: "inativo",
      starting: "iniciando",
      unknown: "desconhecido",
    },
    age: {
      unknown: "desconhecido",
      now: "agora",
      sec: "há {n}s",
      min: "há {n}min",
      hour: "há {n}h",
      day: "há {n}d",
    },
    session: {
      state: "estado",
      badge: "marcador",
      lastHook: "último hook",
      updated: "atualizada",
    },
    error: { scope: "escopo", code: "código", event: "evento" },
    completionOutputMode: { off: "desligada", full: "resposta completa" },
    completionInactiveSuffix: " (inativo até o nativo estar rodando)",
    truncated: "... truncado",
  },
  es: {
    title: "Estado de Telegram en Clawd",
    labels: {
      transport: "Transporte",
      health: "Estado",
      nativePolling: "Sondeo nativo",
      approval: "Aprobación",
      completionNotifications: "Notificaciones de finalización",
      completionOutput: "salida",
      completionBare: "respaldo básico",
      token: "Token",
      config: "Configuración",
      pendingApprovals: "Aprobaciones pendientes",
      nativeApprovalCards: "Tarjetas de aprobación nativas",
      lastError: "Último error",
      sessions: "Sesiones",
      latestSession: "Sesión más reciente",
    },
    words: {
      none: "ninguno",
      unknown: "desconocido",
      on: "activado",
      off: "desactivado",
      running: "en ejecución",
      stopped: "detenido",
      available: "disponible",
      unavailable: "no disponible",
      stored: "guardado",
      missing: "ausente",
      complete: "completa",
      incomplete: "incompleta",
    },
    transport: { native: "nativo", off: "desactivado" },
    health: {
      off: "desactivado",
      failed: "falló",
      "setup-needed": "requiere configuración",
      testing: "probando",
      healthy: "correcto",
      inactive: "inactivo",
      starting: "iniciando",
      unknown: "desconocido",
    },
    age: {
      unknown: "desconocido",
      now: "ahora",
      sec: "hace {n} s",
      min: "hace {n} min",
      hour: "hace {n} h",
      day: "hace {n} d",
    },
    session: {
      state: "estado",
      badge: "insignia",
      lastHook: "último hook",
      updated: "actualizada",
    },
    error: { scope: "ámbito", code: "código", event: "evento" },
    completionOutputMode: { off: "desactivada", full: "respuesta completa" },
    completionInactiveSuffix: " (inactivo hasta que el modo nativo esté en ejecución)",
    truncated: "... truncado",
  },
});

function isNativeTelegramApprovalSelected(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  return snapshot.state === "NATIVE_ACTIVE"
    || snapshot.state === "TESTING_NATIVE";
}

function buildNativeTelegramApprovalStatus({ config, token, migrationSnapshot, nativePolling }) {
  if (!isNativeTelegramApprovalSelected(migrationSnapshot)) return null;

  const ready = telegramApprovalSettings.readiness(
    { ...config, enabled: true },
    token,
  );
  const polling = nativePolling === true;
  const migrationState = migrationSnapshot && migrationSnapshot.state
    ? migrationSnapshot.state
    : "";
  const active = migrationState === "NATIVE_ACTIVE" && polling;
  const testing = migrationState === "TESTING_NATIVE";
  const status = active
    ? "running"
    : (testing ? "starting" : "stopped");
  let reason = ready.reason || "";
  let message = ready.message || "";
  if (ready.ready === true) {
    if (testing) {
      reason = "native-testing";
      message = "Native Telegram approval test is already in progress";
    } else if (!active) {
      reason = "native-inactive";
      message = "Native Telegram approval is not active";
    } else {
      reason = "";
      message = "";
    }
  }

  return {
    status,
    transport: "native",
    native: true,
    enabled: active || testing,
    configured: ready.ready === true,
    reason,
    message,
    tokenStored: token && token.tokenStored === true,
    nativePolling: polling,
    migrationState,
  };
}

function buildTelegramApprovalStatus({
  config,
  token,
  migrationSnapshot,
  nativePolling,
}) {
  const nativeStatus = buildNativeTelegramApprovalStatus({
    config,
    token,
    migrationSnapshot,
    nativePolling,
  });
  if (nativeStatus) return nativeStatus;

  const ready = telegramApprovalSettings.readiness({ ...config, enabled: true }, token);
  const migrationState = migrationSnapshot && migrationSnapshot.state
    ? migrationSnapshot.state
    : "IDLE";
  const required = migrationState === "NATIVE_MIGRATION_REQUIRED";
  const lastTestResult = migrationSnapshot && migrationSnapshot.lastTestResult;
  return {
    status: lastTestResult ? "failed" : "stopped",
    transport: "off",
    native: false,
    enabled: false,
    configured: ready.ready === true,
    reason: required ? "native-migration-required" : (ready.reason || "disabled"),
    message: ready.message || "",
    tokenStored: token && token.tokenStored === true,
    nativePolling: false,
    migrationState,
    lastTestResult: lastTestResult || null,
  };
}

function sanitizeStatusText(value, maxLen = 160) {
  let text = typeof value === "string" ? value : String(value == null ? "" : value);
  text = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, "<redacted:telegram-token>");
  text = text.replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, "<redacted:token>");
  text = text.replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>");
  text = text.replace(/\b(command|tool[_ -]?input|transcript)\s*[:=]?\s+[^;|]+/gi, "$1 <redacted>");
  text = text.replace(/\b(?:telegram:)?-?\d{7,}(?::\d+){0,2}\b/g, "<redacted:id>");
  text = text.replace(/\b[A-Za-z]:\\[^\s]+/g, "<redacted:path>");
  text = text.replace(/(^|\s)\/(?:Users|home|private|var|tmp|mnt|Volumes)\/[^\s]+/g, "$1<redacted:path>");
  if (text.length > maxLen) text = `${text.slice(0, Math.max(0, maxLen - 3))}...`;
  return text;
}

function normalizeTransport({ approvalStatus, migrationSnapshot, config } = {}) {
  const snap = migrationSnapshot && typeof migrationSnapshot === "object" ? migrationSnapshot : {};
  const state = typeof snap.state === "string" ? snap.state : "";
  if (state === "NATIVE_ACTIVE" || state === "TESTING_NATIVE") return "native";
  if (approvalStatus && approvalStatus.transport === "native") return "native";
  return "off";
}

function normalizeNativeRunnerStatus(value) {
  if (!value || typeof value !== "object") return {};
  return {
    polling: value.polling === true,
    pendingApprovalCount: Number.isFinite(value.pendingApprovalCount)
      ? Math.max(0, Math.floor(value.pendingApprovalCount))
      : 0,
    pendingTest: value.pendingTest === true,
    lastError: value.lastError && typeof value.lastError === "object"
      ? {
          scope: sanitizeStatusText(value.lastError.scope || "", 48),
          errorClass: sanitizeStatusText(value.lastError.errorClass || value.lastError.code || "", 48),
          at: Number.isFinite(value.lastError.at) ? value.lastError.at : null,
        }
      : null,
  };
}

function normalizeLastError({ approvalStatus, migrationSnapshot, nativeRunnerStatus } = {}) {
  const snap = migrationSnapshot && typeof migrationSnapshot === "object" ? migrationSnapshot : {};
  if (nativeRunnerStatus && nativeRunnerStatus.lastError) {
    return {
      source: "native",
      code: nativeRunnerStatus.lastError.errorClass || "unknown",
      scope: nativeRunnerStatus.lastError.scope || "",
      at: nativeRunnerStatus.lastError.at || null,
    };
  }
  if (snap.lastError && typeof snap.lastError === "object") {
    return {
      source: "migration",
      code: sanitizeStatusText(snap.lastError.code || "unknown", 64),
      eventType: sanitizeStatusText(snap.lastError.eventType || "", 64),
      message: sanitizeStatusText(snap.lastError.message || "", 160),
    };
  }
  if (approvalStatus && approvalStatus.status === "failed") {
    return {
      source: "approval",
      code: sanitizeStatusText(approvalStatus.reason || "failed", 64),
      message: sanitizeStatusText(approvalStatus.message || "", 160),
    };
  }
  return null;
}

function ageSeconds(at, now) {
  const n = Number(now);
  const t = Number(at);
  if (!Number.isFinite(n) || !Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.floor((n - t) / 1000));
}

function formatTemplate(template, values = {}) {
  return String(template || "").replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : `{${key}}`);
}

function getStatusLocale(lang) {
  return STATUS_LOCALES[lang] || STATUS_LOCALES.en;
}

function statusWord(locale, key) {
  return (locale.words && locale.words[key])
    || (STATUS_LOCALES.en.words && STATUS_LOCALES.en.words[key])
    || key;
}

function statusValue(locale, group, key) {
  const safeKey = typeof key === "string" && key ? key : "unknown";
  return (locale[group] && locale[group][safeKey])
    || (STATUS_LOCALES.en[group] && STATUS_LOCALES.en[group][safeKey])
    || safeKey;
}

function formatAge(seconds, locale = STATUS_LOCALES.en) {
  const s = Number(seconds);
  const age = (locale && locale.age) || STATUS_LOCALES.en.age;
  if (!Number.isFinite(s)) return age.unknown || statusWord(locale, "unknown");
  if (s < 1) return age.now || STATUS_LOCALES.en.age.now;
  if (s < 60) return formatTemplate(age.sec || STATUS_LOCALES.en.age.sec, { n: Math.floor(s) });
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return formatTemplate(age.min || STATUS_LOCALES.en.age.min, { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatTemplate(age.hour || STATUS_LOCALES.en.age.hour, { n: hours });
  return formatTemplate(age.day || STATUS_LOCALES.en.age.day, { n: Math.floor(hours / 24) });
}

function shortId(id) {
  const s = sanitizeStatusText(id, 32);
  if (!s) return "";
  return s.length > 8 ? s.slice(0, 8) : s;
}

function summarizeSession(entry, now) {
  if (!entry || typeof entry !== "object") return null;
  const lastEvent = entry.lastEvent && typeof entry.lastEvent === "object"
    ? entry.lastEvent
    : null;
  return {
    id: shortId(entry.id),
    agentId: sanitizeStatusText(entry.agentId || "unknown", 48) || "unknown",
    state: sanitizeStatusText(entry.state || "idle", 32) || "idle",
    badge: sanitizeStatusText(entry.badge || "idle", 32) || "idle",
    host: sanitizeStatusText(entry.host || "", 64),
    lastEvent: lastEvent
      ? {
          rawEvent: sanitizeStatusText(lastEvent.rawEvent || "", 64),
          ageSeconds: ageSeconds(lastEvent.at, now),
        }
      : null,
    updatedAgeSeconds: ageSeconds(entry.updatedAt, now),
  };
}

function sessionSort(a, b) {
  const au = Number(a && a.updatedAt);
  const bu = Number(b && b.updatedAt);
  const at = Number.isFinite(au) ? au : 0;
  const bt = Number.isFinite(bu) ? bu : 0;
  if (bt !== at) return bt - at;
  return String(a && a.id || "").localeCompare(String(b && b.id || ""));
}

function summarizeSessions(sessionSnapshot, { now, all = false, limit = DEFAULT_STATUS_SESSION_LIMIT } = {}) {
  const entries = sessionSnapshot && Array.isArray(sessionSnapshot.sessions)
    ? sessionSnapshot.sessions.slice().sort(sessionSort)
    : [];
  const max = all ? Math.max(1, Math.floor(limit || DEFAULT_STATUS_SESSION_LIMIT)) : 1;
  return entries.slice(0, max).map((entry) => summarizeSession(entry, now)).filter(Boolean);
}

function buildHealth({ transport, approvalStatus, migrationSnapshot, nativePolling, configured } = {}) {
  const state = migrationSnapshot && migrationSnapshot.state ? migrationSnapshot.state : "";
  if (transport === "off") return "off";
  if (!configured) return "setup-needed";
  if (transport === "native") {
    if (state === "TESTING_NATIVE") return "testing";
    return nativePolling ? "healthy" : "inactive";
  }
  return "inactive";
}

function buildTelegramStatusDiagnostic({
  config,
  token,
  approvalStatus,
  migrationSnapshot,
  nativeRunnerStatus,
  nativePolling,
  pendingApprovalCount,
  sessionSnapshot,
  now = Date.now(),
  all = false,
} = {}) {
  const normalizedConfig = telegramApprovalSettings.normalizeTelegramApproval(config);
  const runnerStatus = normalizeNativeRunnerStatus(nativeRunnerStatus);
  const transport = normalizeTransport({ approvalStatus, migrationSnapshot, config: normalizedConfig });
  const owner = migrationSnapshot && migrationSnapshot.ownerSnapshot && typeof migrationSnapshot.ownerSnapshot === "object"
    ? migrationSnapshot.ownerSnapshot
    : {};
  const polling = nativePolling === true || runnerStatus.polling === true || owner.nativePolling === true;
  const tokenStored = !!(token && token.tokenStored === true) || approvalStatus?.tokenStored === true;
  const recipientConfigured = !!(normalizedConfig.allowedTgUserId && normalizedConfig.targetSessionKey);
  const completionOutputMode = telegramApprovalSettings.normalizeCompletionOutputMode(
    normalizedConfig.completionOutputMode
  );
  const completionConfigured = normalizedConfig.notifyOnComplete === true || completionOutputMode !== "off";
  const completionEnabled = transport !== "off" && completionConfigured;
  // For diagnostics, "configured" means the required pieces are present. It
  // intentionally does not fold in the enable/transport flag, otherwise an
  // explicit OFF state would misleadingly look like missing setup.
  const configured = !!(tokenStored && recipientConfigured);
  const health = buildHealth({
    transport,
    approvalStatus,
    migrationSnapshot,
    nativePolling: polling,
    configured,
  });
  const approvalAvailable = transport === "native" && health === "healthy";
  const pendingCount = Number.isFinite(pendingApprovalCount)
    ? Math.max(0, Math.floor(pendingApprovalCount))
    : 0;
  return {
    transport,
    health,
    migrationState: sanitizeStatusText(migrationSnapshot && migrationSnapshot.state || "", 48),
    nativePolling: polling,
    approvalAvailable,
    completionNotifications: {
      enabled: completionEnabled,
      effective: transport === "native" && polling && completionConfigured,
      configured: completionConfigured,
      outputMode: completionOutputMode,
      bare: normalizedConfig.notifyOnComplete === true,
    },
    tokenStored,
    recipientConfigured,
    configured,
    pendingApprovals: {
      total: pendingCount,
      nativeCards: runnerStatus.pendingApprovalCount || 0,
    },
    lastError: normalizeLastError({ approvalStatus, migrationSnapshot, nativeRunnerStatus: runnerStatus }),
    sessions: summarizeSessions(sessionSnapshot, { now, all }),
  };
}

function formatSessionLine(session, locale = STATUS_LOCALES.en) {
  const sessionLabels = (locale && locale.session) || STATUS_LOCALES.en.session;
  if (!session) return statusWord(locale, "none");
  const parts = [
    session.agentId,
    session.id ? `#${session.id}` : null,
    `${sessionLabels.state || "state"}=${session.state}`,
    `${sessionLabels.badge || "badge"}=${session.badge}`,
  ].filter(Boolean);
  const event = session.lastEvent && session.lastEvent.rawEvent
    ? `${session.lastEvent.rawEvent} ${formatAge(session.lastEvent.ageSeconds, locale)}`
    : `${sessionLabels.updated || "updated"} ${formatAge(session.updatedAgeSeconds, locale)}`;
  return `${parts.join(" ")}; ${sessionLabels.lastHook || "last hook"}: ${event}`;
}

function formatLastError(error, locale = STATUS_LOCALES.en) {
  if (!error) return statusWord(locale, "none");
  const errorLabels = (locale && locale.error) || STATUS_LOCALES.en.error;
  const parts = [
    error.source || statusWord(locale, "unknown"),
    error.scope ? `${errorLabels.scope || "scope"}=${error.scope}` : null,
    error.code ? `${errorLabels.code || "code"}=${error.code}` : null,
    error.eventType ? `${errorLabels.event || "event"}=${error.eventType}` : null,
    error.message || null,
  ].filter(Boolean);
  return parts.join(" ");
}

function completionOutputModeWord(locale, mode) {
  const key = mode === "full" ? "full" : "off";
  const map = locale && locale.completionOutputMode
    ? locale.completionOutputMode
    : STATUS_LOCALES.en.completionOutputMode;
  return map[key] || STATUS_LOCALES.en.completionOutputMode[key] || key;
}

function formatCompletionNotificationStatus(completion, locale = STATUS_LOCALES.en) {
  const labels = (locale && locale.labels) || STATUS_LOCALES.en.labels;
  const c = completion && typeof completion === "object" ? completion : {};
  const enabled = c.enabled === true;
  const base = `${statusWord(locale, enabled ? "on" : "off")}, `
    + `${labels.completionOutput || "output"}=${completionOutputModeWord(locale, c.outputMode)}, `
    + `${labels.completionBare || "bare fallback"}=${statusWord(locale, c.bare === true ? "on" : "off")}`;
  return base + (enabled && c.effective !== true ? locale.completionInactiveSuffix : "");
}

function formatTelegramStatusDiagnostic(diagnostic, { all = false, lang = "en" } = {}) {
  const d = diagnostic && typeof diagnostic === "object" ? diagnostic : {};
  const locale = getStatusLocale(lang);
  const labels = locale.labels || STATUS_LOCALES.en.labels;
  const lines = [
    locale.title || STATUS_LOCALES.en.title,
    `${labels.transport}: ${statusValue(locale, "transport", d.transport || "off")}`,
    `${labels.health}: ${statusValue(locale, "health", d.health || "unknown")}`,
    `${labels.nativePolling}: ${statusWord(locale, d.nativePolling === true ? "running" : "stopped")}`,
    `${labels.approval}: ${statusWord(locale, d.approvalAvailable === true ? "available" : "unavailable")}`,
    `${labels.completionNotifications}: ${formatCompletionNotificationStatus(d.completionNotifications, locale)}`,
    `${labels.token}: ${statusWord(locale, d.tokenStored === true ? "stored" : "missing")}`,
    `${labels.config}: ${statusWord(locale, d.configured === true ? "complete" : "incomplete")}`,
    `${labels.pendingApprovals}: ${d.pendingApprovals && Number.isFinite(d.pendingApprovals.total) ? d.pendingApprovals.total : 0}`,
    `${labels.nativeApprovalCards}: ${d.pendingApprovals && Number.isFinite(d.pendingApprovals.nativeCards) ? d.pendingApprovals.nativeCards : 0}`,
    `${labels.lastError}: ${formatLastError(d.lastError, locale)}`,
  ];
  const sessions = Array.isArray(d.sessions) ? d.sessions : [];
  if (all) {
    lines.push(`${labels.sessions}:`);
    if (!sessions.length) lines.push(`- ${statusWord(locale, "none")}`);
    for (const session of sessions) lines.push(`- ${formatSessionLine(session, locale)}`);
  } else {
    lines.push(`${labels.latestSession}: ${formatSessionLine(sessions[0], locale)}`);
  }
  const text = lines.join("\n");
  return text.length > STATUS_TEXT_MAX
    ? `${text.slice(0, STATUS_TEXT_MAX - 16)}\n${locale.truncated || STATUS_LOCALES.en.truncated}`
    : text;
}

module.exports = {
  isNativeTelegramApprovalSelected,
  buildNativeTelegramApprovalStatus,
  buildTelegramApprovalStatus,
  buildTelegramStatusDiagnostic,
  formatTelegramStatusDiagnostic,
  sanitizeStatusText,
};
