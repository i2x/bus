// คันนี้ดีไหม? — service worker
// หน้าเว็บ: network-first (ได้ของใหม่เสมอ ถ้าเน็ตหลุดใช้ของใน cache) · ไฟล์ static/ฟอนต์: cache-first
// /api ไม่ cache เลย — รีวิว แต้ม ต้องเป็นข้อมูลสดจาก server
const CACHE = "bus-v4";
const SHELL = ["./", "index.html", "app.css", "data.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];
const STATIC_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/pitch/")) return;
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
