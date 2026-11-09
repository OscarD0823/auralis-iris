const cacheName = "auralis-iris-0.1.0-beta.1";
const home = self.registration.scope;
const files = [
  "styles.css", "app.js", "scan.js", "store.js", "pair.js",
  "iris.svg", "iris-192.png", "iris-512.png", "manifest.webmanifest",
  "vendor/pdf-lib.js", "vendor/qrcode.js", "vendor/jsqr.js"
];
const urls = new Set([home, ...files.map((file) => new URL(file, home).href)]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...urls])));
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
    event.respondWith(caches.match(home).then((hit) => hit || fetch(request)));
  } else if (urls.has(request.url)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
  }
});
