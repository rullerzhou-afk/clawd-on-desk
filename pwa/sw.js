const CACHE_NAME = "clawd-mobile-v8";
// Versioned static assets only. The HTML document is intentionally NOT precached:
// the LAN server injects the desktop UI language into it, so it must come fresh
// from the network (with a cached fallback when offline).
const STATIC_ASSETS = [
  "/mobile/style.css",
  "/mobile/icons.js",
  "/mobile/i18n.js",
  "/mobile/app.js",
  "/mobile/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Do not intercept WS requests
  if (event.request.url.includes("/ws")) return;

  // HTML/navigation: network-first so the document always reflects the current
  // desktop language and latest build; fall back to a cached copy when offline.
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/mobile/index.html", clone));
          }
          return response;
        })
        .catch(() => caches.match("/mobile/index.html"))
    );
    return;
  }

  // Static assets: cache-first (busted by CACHE_NAME on each release).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// Notification click: focus the existing window
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/mobile/");
    })
  );
});
