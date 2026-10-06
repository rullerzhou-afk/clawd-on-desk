"use strict";

// Minimal, dependency-free fake of the Electron `net.request` surface used by
// official-theme-download. It lets unit tests drive redirects, headers, chunked
// bodies, stalls and aborts without touching a real network or Electron runtime.

const { EventEmitter } = require("node:events");

function createFakeNet(onRequest) {
  const requests = [];
  const net = {
    requests,
    request(options) {
      const req = new EventEmitter();
      req.options = options;
      req.followRedirect = () => { req.followedRedirects = (req.followedRedirects || 0) + 1; };
      req.end = () => { onRequest(req, options); };
      req.abort = () => { req.aborted = true; };
      requests.push(req);
      return req;
    },
  };
  return net;
}

function makeResponse(options = {}) {
  const response = new EventEmitter();
  response.statusCode = options.statusCode === undefined ? 200 : options.statusCode;
  response.headers = options.headers || {};
  response.paused = false;
  response.resume = () => { response.paused = false; };
  response.pause = () => { response.paused = true; };
  response.destroy = () => { response.destroyed = true; };
  return response;
}

// Emits a response, then its chunks, then (unless disabled) end. `emitEnd:
// false` leaves the stream open so a test can drive a stall/abort.
function streamResponse(req, options = {}) {
  const response = makeResponse(options);
  req.emit("response", response);
  const chunks = options.chunks || [];
  for (const chunk of chunks) {
    if (response.destroyed) break;
    response.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (options.emitEnd !== false && !response.destroyed) response.emit("end");
  return response;
}

module.exports = { createFakeNet, makeResponse, streamResponse };
