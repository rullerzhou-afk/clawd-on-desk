const CACHE_NAME = "clawd-mobile-v8";
const STATIC_ASSETS = [
  "/mobile/",
  "/mobile/index.html",
  "/mobile/style.css",
  "/mobile/icons.js",
  "/mobile/app.js",
  "/mobile/manifest.json",
  "/mobile/icons/icon-256.png",
  "/mobile/icons/icon-512.png",
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
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/mobile/") || event.request.method !== "GET") return;
  const navigation = event.request.mode === "navigate";
  const networkFirst = navigation || /\.(js|css)$/.test(url.pathname);
  // Navigation credentials must never become cache keys.
  const key = navigation ? "/mobile/" : networkFirst ? url.pathname : event.request;
  const fromNetwork = () => fetch(event.request).then((response) => {
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)));
    }
    return response;
  });
  event.respondWith(networkFirst
    ? fromNetwork().catch(() => caches.match(key))
    : caches.match(key).then((cached) => cached || fromNetwork()));
});

// 通知点击：聚焦到已有窗口
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
