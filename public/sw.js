// Service worker CR Simulator — hanya meng-cache app shell statis.
// /api/* SENGAJA tidak pernah disentuh: data kasus, chat AI, dan grading
// harus selalu live dari server.
const CACHE = "cr-sim-v2";
const ASSETS = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // selalu network, tanpa cache

  // Navigasi: network dulu, fallback ke shell yang ter-cache saat offline.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/index.html")));
    return;
  }

  // Aset shell: stale-while-revalidate — tampil instan dari cache,
  // diam-diam diperbarui di belakang.
  if (ASSETS.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fresh = fetch(e.request)
          .then((res) => {
            if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
  // Selain itu (mis. gambar kasus): biarkan lewat ke network seperti biasa.
});
