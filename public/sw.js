/**
 * Phase 16 — offline service worker for the STAFF app scope.
 *
 * Policy (documented):
 *  - Network-first for API calls: fresh data whenever online; NO sensitive
 *    page/API responses are cached indiscriminately. Only navigations get a
 *    stale-while-revalidate shell so the app opens offline.
 *  - Order/POS data written offline lives in the app's IndexedDB outbox
 *    (lib/offline-outbox.ts) — NEVER in this cache.
 *  - Online gateway payments cannot be reported verified offline: the sync
 *    endpoint reconciles everything server-side, and the outbox only carries
 *    order operations (no payment state).
 */
const CACHE = "restroloop-staff-v1";
const SHELL = ["/", "/manifest.json", "/logo.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // mutations always go through the outbox when offline
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, never cache sensitive GET responses.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ offline: true }), { status: 503, headers: { "Content-Type": "application/json" } })));
    return;
  }

  // Navigations: stale-while-revalidate shell so the staff app opens offline.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("/").then((cached) => {
        const fresh = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => undefined);
            return res;
          })
          .catch(() => cached);
        return cached ?? fresh;
      }),
    );
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith("/_next/static") || url.pathname === "/logo.svg" || url.pathname === "/manifest.json")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        }),
    ),
  );
});
