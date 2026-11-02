/* 철도비서 알림 도우미 (Service Worker)
   - index.html과 같은 폴더에 올려야 합니다.
   - 서버에서 보낸 출근 알람을 앱이 꺼져 있어도 알림으로 보여줍니다.
   - 화면·데이터를 저장(캐시)하지 않으므로, index.html을 고쳐 올리면 바로 반영됩니다. */

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || '출근 알람';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '출근 시간이 다가오고 있어요.',
    tag: d.tag || 'alarm',
    renotify: true,
    silent: false,
    requireInteraction: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [500, 250, 500, 250, 500, 250, 500],   /* 안드로이드 8 이상은 폰의 알림 진동 설정이 우선 */
    data: { url: self.registration.scope }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
