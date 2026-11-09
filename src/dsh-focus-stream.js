"use strict";

// Carries "open this DSH session" from Clawd (an outside process) into the DSH
// page. Only the page can switch sessions: the DSH client service
// `uiWorkspace.openSession()` is what dsh-pet and the workbench call, and a
// plugin's browser half is the only outside code allowed to run there. So Clawd
// owns a loopback SSE endpoint and its own DSH plugin subscribes to it.
//
// One slot, newest wins: a click nobody was listening for must not ambush a
// page that connects a minute later.

const HEARTBEAT_MS = 15000;
// How long a click stays replayable for a page that connects right after it.
const REPLAY_WINDOW_MS = 10000;
const MAX_ID_CHARS = 200;
// DSH ids look like `session-<uuid>`. Two page origins subscribe here: a `dsh web`
// page under a loopback http origin, and the desktop app's `dsh-app://app`
// window (registered as a CORS scheme by its Electron shell). Anything else gets
// no stream and no CORS grant.
const LOOPBACK_ORIGIN_RE = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|dsh-app:\/\/[A-Za-z0-9._-]+)$/;

function normalizeLoopbackOrigin(value) {
  if (typeof value !== "string") return null;
  const origin = value.trim();
  return LOOPBACK_ORIGIN_RE.test(origin) ? origin : null;
}

function normalizeTargetId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > MAX_ID_CHARS) return "";
  if (/[\u0000-\u001f\u007f]/.test(id)) return "";
  return id;
}

function createDshFocusStream({ now = Date.now } = {}) {
  const subscribers = new Set();
  let pending = null;

  function frame(id) {
    return `event: focus\ndata: ${JSON.stringify({ sessionId: id })}\n\n`;
  }

  function publish(sessionId) {
    const id = normalizeTargetId(sessionId);
    if (!id) return false;
    pending = { id, at: now() };
    for (const res of [...subscribers]) {
      if (res.writableEnded || res.destroyed) {
        subscribers.delete(res);
        continue;
      }
      res.write(frame(id));
    }
    return true;
  }

  // One subscriber is one open EventSource. The SSRF-shaped risk here is a
  // local page subscribing; it can only learn which session Clawd asked for and
  // trigger a view switch, never a permission or write decision.
  function handle(req, res) {
    const rawOrigin = req && req.headers ? req.headers.origin : undefined;
    const origin = normalizeLoopbackOrigin(rawOrigin);
    if (rawOrigin !== undefined && !origin) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      res.end("forbidden");
      return;
    }
    const headers = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    };
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    res.writeHead(200, headers);
    // A comment frame opens the stream so EventSource reports `open` before the
    // first real click; proxies and DevTools then keep the connection warm.
    res.write(": clawd dsh focus\n\n");
    if (pending && now() - pending.at <= REPLAY_WINDOW_MS) res.write(frame(pending.id));
    subscribers.add(res);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscribers.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  return { handle, publish, subscriberCount: () => subscribers.size };
}

const shared = createDshFocusStream();

module.exports = {
  createDshFocusStream,
  handleDshFocusStream: shared.handle,
  publishDshFocus: shared.publish,
  HEARTBEAT_MS,
  REPLAY_WINDOW_MS,
  MAX_ID_CHARS,
};
