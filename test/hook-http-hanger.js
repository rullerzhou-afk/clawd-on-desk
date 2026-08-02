// Test preloader: leaves every outbound HTTP request permanently unsettled.
// The hook's own safety deadline must be what exits the process; unlike
// hook-http-blocker.js, this emits no error and invokes no timeout callback.
const http = require("http");
const { EventEmitter } = require("events");

function hangingRequest() {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.write = () => true;
  req.end = () => req;
  return req;
}

http.get = () => hangingRequest();
http.request = () => hangingRequest();
