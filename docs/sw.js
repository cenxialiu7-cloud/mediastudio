/*
 * Kill-switch Service Worker.
 *
 * 先前此檔由 Monetag 通用標籤註冊為推播廣告 Service Worker
 * (domain 3nbf4.com)，會在訪客瀏覽器常駐並隨時推播 popup 廣告。
 * 現以此自我反註冊版本覆蓋：訪客下次造訪時瀏覽器會自動更新此 SW，
 * 它會解除自身註冊、清除所有快取，徹底停止推播廣告。
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* ignore */ }
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
