/* Offline support.
   - App shell (HTML, CSS, JS, map data, Leaflet): cache-first, updated in background.
   - Forecast data (data/latest.json): network-first, fall back to the last
     cached copy so a farmer with no signal still sees the last known
     forecast. The app itself displays how old that data is.
   BUMP THE VERSION NUMBERS below every time app.js, style.css, or
   index.html change, or phones keep running the old copy. */

const SHELL_CACHE = "burnwise-shell-v8";
const DATA_CACHE = "burnwise-data-v8";

const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "parishes.geojson",
  "states.geojson",
  "reference.geojson",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL_CACHE, DATA_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.endsWith("latest.json")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put("latest.json", copy));
          return res;
        })
        .catch(() => caches.open(DATA_CACHE).then((c) => c.match("latest.json")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
