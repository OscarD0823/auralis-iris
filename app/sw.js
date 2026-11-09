const cacheName = "auralis-iris-0.1.0-beta.3";
const home = self.registration.scope;
const files = [
  "styles.css", "app.js", "scan.js", "store.js", "pair.js", "export.js", "export-worker.js", "images.js", "pdf.js",
  "iris.svg", "iris-192.png", "iris-512.png", "manifest.webmanifest",
  "vendor/pdf-lib.js", "vendor/qrcode.js", "vendor/jsqr.js", "vendor/fflate.js"
];
const urls = new Set([home, ...files.map((file) => new URL(file, home).href)]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...urls].map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("auralis-iris-") && key !== cacheName)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.mode === "navigate" && (request.url === home || request.url === home + "index.html")) {
    event.respondWith(caches.match(home, { cacheName }).then((hit) => hit || fetch(request)));
  } else if (urls.has(request.url)) {
    event.respondWith(caches.match(request, { cacheName }).then((hit) => hit || fetch(request)));
  }
});
