import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const successRate = new Rate("business_success");
const appLatencyMs = new Trend("app_latency_ms");

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:23333";
const API_PATH = __ENV.API_PATH || "/state";
const METHOD = (__ENV.METHOD || "POST").toUpperCase();
const SUITE = __ENV.SUITE || "quick";
const TARGET_MODE = (__ENV.TARGET_MODE || "auto").toLowerCase();
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const AUTH_HEADER = __ENV.AUTH_HEADER || "Authorization";
const AUTH_PREFIX = __ENV.AUTH_PREFIX || "Bearer";
const THINK_TIME_MS = Number(__ENV.THINK_TIME_MS || 200);
const STATE_MODE = TARGET_MODE === "state" || (TARGET_MODE === "auto" && API_PATH === "/state");

const SHORT_RATIO = Number(__ENV.SHORT_RATIO || 0.7);
const MID_RATIO = Number(__ENV.MID_RATIO || 0.25);

const SHORT_PROMPTS = [
  "Explain this error in one sentence.",
  "Summarize this code change briefly.",
  "What is a likely root cause here?",
];

const MID_PROMPTS = [
  "Review this service and list top 3 bottlenecks with fixes.",
  "Propose a rollback-safe migration plan for this API.",
  "Generate test cases for auth and permission boundaries.",
];

const LONG_PROMPTS = [
  "Analyze this architecture end-to-end, list scaling risks, and propose a phased remediation plan with milestones.",
  "Draft a detailed incident postmortem template with data collection checklist, communication timeline, and prevention actions.",
];

const STATES = [
  "thinking",
  "working",
  "idle",
  "notification",
  "attention",
  "error",
  "sweeping",
  "yawning",
  "sleeping",
];

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) {
    headers[AUTH_HEADER] = AUTH_PREFIX ? `${AUTH_PREFIX} ${AUTH_TOKEN}` : AUTH_TOKEN;
  }
  return headers;
}

function pickPrompt() {
  const r = Math.random();
  if (r < SHORT_RATIO) return SHORT_PROMPTS[Math.floor(Math.random() * SHORT_PROMPTS.length)];
  if (r < SHORT_RATIO + MID_RATIO) return MID_PROMPTS[Math.floor(Math.random() * MID_PROMPTS.length)];
  return LONG_PROMPTS[Math.floor(Math.random() * LONG_PROMPTS.length)];
}

function buildPayload() {
  if (STATE_MODE) {
    return {
      state: STATES[Math.floor(Math.random() * STATES.length)],
      session_id: `k6-${__VU}-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      source_pid: 99999,
      event: "PreToolUse",
      cwd: "/tmp",
      agent_id: "claude-code",
      headless: true,
    };
  }

  return {
    session_id: `k6-${__VU}-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    user_id: `perf-user-${(__VU % 100) + 1}`,
    message: pickPrompt(),
    meta: {
      source: "k6",
      suite: SUITE,
      vu: __VU,
      iter: __ITER,
    },
  };
}

function buildScenarios() {
  if (SUITE === "steady") {
    return {
      steady_load: {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
          { duration: "3m", target: 50 },
          { duration: "20m", target: 50 },
          { duration: "3m", target: 0 },
        ],
        gracefulRampDown: "30s",
      },
    };
  }

  if (SUITE === "spike") {
    return {
      baseline: {
        executor: "constant-vus",
        vus: 50,
        duration: "10m",
      },
      spike: {
        executor: "constant-vus",
        vus: 150,
        duration: "60s",
        startTime: "2m",
      },
    };
  }

  if (SUITE === "soak") {
    return {
      soak_8h: {
        executor: "constant-vus",
        vus: 80,
        duration: "8h",
      },
    };
  }

  return {
    quick_smoke: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "2m", target: 30 },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  };
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: {
    http_req_failed: ["rate<0.005"],
    http_req_duration: ["p(95)<800", "p(99)<1500"],
    checks: ["rate>0.995"],
    business_success: ["rate>0.995"],
  },
};

export default function () {
  const url = `${BASE_URL}${API_PATH}`;
  const payload = buildPayload();
  const headers = buildHeaders();

  const response = METHOD === "GET"
    ? http.get(url, { headers, tags: { suite: SUITE } })
    : http.request(METHOD, url, JSON.stringify(payload), { headers, tags: { suite: SUITE } });

  const ok = STATE_MODE
    ? check(response, {
      "status is 2xx": (r) => r.status >= 200 && r.status < 300,
      "state endpoint returns ok": (r) => typeof r.body === "string" && r.body.includes("ok"),
    })
    : check(response, {
      "status is 2xx": (r) => r.status >= 200 && r.status < 300,
      "has response body": (r) => typeof r.body === "string" && r.body.length > 0,
    });
  successRate.add(ok);

  let parsed = null;
  try {
    parsed = response.json();
  } catch (_) {
    parsed = null;
  }

  if (parsed && typeof parsed.latency_ms === "number") {
    appLatencyMs.add(parsed.latency_ms);
  }

  sleep(THINK_TIME_MS / 1000);
}
