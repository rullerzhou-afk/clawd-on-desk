"use strict";

async function startMobilePreviewServerSafely(server, options = {}) {
  if (!server || typeof server.start !== "function") return null;
  const source = options.source || "runtime";
  const onError = typeof options.onError === "function"
    ? options.onError
    : (err) => console.warn(
      `[mobile-preview] ${source} start failed:`,
      err && err.message ? err.message : err,
    );
  try {
    return await server.start();
  } catch (err) {
    // Error reporting is best-effort too. A custom logger must not turn a
    // contained server-start failure back into an unhandled rejection at the
    // fire-and-forget main-process call sites.
    try { onError(err, source); } catch {}
    return null;
  }
}

module.exports = { startMobilePreviewServerSafely };
