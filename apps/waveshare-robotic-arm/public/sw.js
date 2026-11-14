/* Static shell cache only. No API, navigation, credentials, telemetry or POST cache. */
const CACHE_PREFIX = "roarm-static-shell-";
// Bump when the integrated cached application assets change.
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const STATIC_PATHS = new Set([
  "/app.css",
  "/reference.css",
  "/app.js",
  "/z-lift.js",
  "/arm.js",
  "/kinematics.js",
  "/wire-arm.js",
  "/wire-geometry.js",
  "/checkin.js",
  "/checkin.css",
  "/icon.svg",
  "/manifest.webmanifest",
]);

function offlinePage() {
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#101018"><title>RoArm check-in offline</title>
<style>body{margin:0;padding:2rem;background:#101018;color:#f3efff;font:16px/1.5 system-ui,sans-serif}main{max-width:36rem;margin:12vh auto;padding:2rem;border:1px solid #474359;border-radius:1rem}strong{color:#ffcb73}</style>
<main><h1>Check-in offline</h1><p><strong>Status is unavailable and may be stale.</strong> Reconnect to the private network and reload before relying on any robot status.</p><p>No API request or robot command was queued or replayed while offline.</p></main></html>`, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...STATIC_PATHS]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API/auth/status/camera data are never cached or given an offline response.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  // Never cache documents: the current index response installs a local auth cookie.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request, { cache: "no-store" }).catch(() => offlinePage()));
    return;
  }

  // Exact same-origin static allowlist only. Query-string variants are network-only.
  if (!request.url.includes("?") && STATIC_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request, { cacheName: CACHE_NAME });
        return cached || new Response("Static asset unavailable offline", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    })());
  }
});
