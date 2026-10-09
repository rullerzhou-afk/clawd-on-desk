// Test preloader: records every outbound http GET/POST the hook attempts as
// JSON lines in CLAWD_HOOK_HTTP_RECORD, and answers every request as a
// healthy Clawd server (x-clawd-server header), so the probe+post pipeline in
// postStateToRunningServer completes with no real server and no open ports.
// Sibling of hook-http-blocker.js — that one fails everything, this one
// succeeds and keeps the receipts for body assertions.
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");

const recordPath = process.env.CLAWD_HOOK_HTTP_RECORD;

function record(entry) {
  if (!recordPath) return;
  try {
    fs.appendFileSync(recordPath, JSON.stringify(entry) + "\n");
  } catch {}
}

function fakeResponse(callback) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = { "x-clawd-server": "clawd-on-desk" };
  res.setEncoding = () => res;
  res.resume = () => res;
  if (callback) {
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => res.emit("end"));
    });
  }
  return res;
}

function fakeRequest(method, options, callback) {
  const req = new EventEmitter();
  const chunks = [];
  let ended = false;
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  req.end = (chunk) => {
    if (ended) return req;
    ended = true;
    if (chunk) chunks.push(Buffer.from(chunk));
    record({
      method,
      port: options && options.port,
      path: options && options.path,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    fakeResponse(callback);
    return req;
  };
  return req;
}

http.get = (options, callback) => {
  const req = fakeRequest("GET", options, callback);
  // Real http.get calls req.end() implicitly; callers never do.
  process.nextTick(() => req.end());
  return req;
};
http.request = (options, callback) => fakeRequest("POST", options, callback);
