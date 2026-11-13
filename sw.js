// アプリを更新したら、この番号を上げてください（古いキャッシュが削除されます）
const CACHE_PREFIX = 'deposit-app-';
const CACHE_NAME = CACHE_PREFIX + 'v3';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './salary.js',
  './script.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// 古いバージョンのキャッシュを削除
// ※ github.io では同じユーザーの別アプリとキャッシュ領域を共有するため、
//   このアプリのキャッシュ（deposit-app-）だけを対象にする
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先：オンラインなら最新のファイルを取得してキャッシュを更新、
// オフラインのときだけキャッシュを使う
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return response;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
