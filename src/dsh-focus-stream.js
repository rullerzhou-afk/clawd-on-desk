"use strict";

// Carries "open this DSH session" from Clawd (an outside process) into the DSH
// page. Only the page can switch sessions: the DSH client service
// `uiWorkspace.openSession()` is what dsh-pet and the workbench call, and a
// plugin's browser half is the only outside code allowed to run there. So Clawd
// owns a loopback SSE endpoint and its own DSH plugin subscribes to it.
//
// One slot, newest wins: a click nobody was listening for must not ambush a
// page that connects a minute later.

const { randomUUID } = require("node:crypto");

// A quiet stream still sends traffic often enough to keep the connection warm.
const HEARTBEAT_MS = 15000;
// Desktop cold starts can take over ten seconds; page deduplication makes a
// thirty-second replay safe without pulling the user back on every reconnect.
const REPLAY_WINDOW_MS = 30000;
// DSH ids look like `session-<uuid>`; leave room without retaining arbitrary text.
const MAX_ID_CHARS = 200;
// Web and desktop share sessions, but only the main desktop window may switch.
const DESKTOP_ORIGIN = "dsh-app://app";

function isLoopbackHost(value) {
  const host = typeof value === "string"
    ? /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(value)
    : null;
  return !!host && (host[1] === undefined || (Number(host[1]) >= 1 && Number(host[1]) <= 65535));
}

function normalizeTargetId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > MAX_ID_CHARS) return "";
  if (/[\u0000-\u001f\u007f]/.test(id)) return "";
  return id;
}

function createDshFocusStream({ now = Date.now } = {}) {
  // A new boot cannot collide with click ids remembered by a still-open page.
  const bootId = randomUUID();
  // Each response represents one page's active subscription.
  const subscribers = new Set();
  // The latest valid click remains replayable even after an attempted delivery.
  let pending = null;
  // Increasing within this boot distinguishes repeated clicks on one session.
  let sequence = 0;

  function frame({ id, clickId }) {
    return `event: focus\ndata: ${JSON.stringify({ sessionId: id, clickId })}\n\n`;
  }

  function publish(sessionId) {
    const id = normalizeTargetId(sessionId);
    if (!id) return false;
    pending = { id, clickId: `${bootId}:${++sequence}`, at: now() };
    for (const res of [...subscribers]) {
      if (res.writableEnded || res.destroyed) {
        subscribers.delete(res);
        continue;
      }
      res.write(frame(pending));
    }
    return true;
  }

  // The desktop page's cross-origin EventSource always sends Origin. Requiring
  // it and a loopback Host excludes web tabs and other dsh-app windows.
  function handle(req, res) {
    const requestHeaders = (req && req.headers) || {};
    if (requestHeaders.origin !== DESKTOP_ORIGIN || !isLoopbackHost(requestHeaders.host)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      res.end("forbidden");
      return;
    }
    const headers = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": DESKTOP_ORIGIN,
    };
    res.writeHead(200, headers);
    // A comment frame opens the stream so EventSource reports `open` before the
    // first real click; proxies and DevTools then keep the connection warm.
    res.write(": clawd dsh focus\n\n");
    // Do not clear pending on delivery: a disconnecting page can lose the frame.
    // Each page deduplicates by clickId when the next connection replays it.
    if (pending && now() - pending.at <= REPLAY_WINDOW_MS) res.write(frame(pending));
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
