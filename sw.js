/* 철도비서 도우미 (Service Worker)
   - index.html과 같은 폴더에 올려야 합니다.
   - 서버에서 보낸 출근 알람을 앱이 꺼져 있어도 알림으로 보여줍니다.
   - 앱 화면(index.html)을 폰에 저장해 두었다가 바로 띄웁니다 → 시작할 때 하얀 로고 화면이 거의 안 보임.
     새로 올린 index.html은 뒤에서 받아 저장하고, 화면에 '새로 받았다'고 알려 줍니다(막 연 참이면 바로 새로고침).
   - 근무표·로그인 같은 데이터(Supabase)는 저장하지 않습니다. */

var SHELL_CACHE = 'rs-shell-v1';
var SHELL_KEY = 'app-shell';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('rs-shell-') === 0 && k !== SHELL_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 앱 화면 열기: 저장본을 바로 보여주고, 동시에 새 버전을 받아 저장 */
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var path = url.pathname.replace(self.registration.scope.replace(self.location.origin, ''), '');
  if (path !== '' && path !== 'index.html') return;   /* 앱 첫 화면만 */
  var job = caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(SHELL_KEY).then(function (cached) {
      var oldCopy = cached ? cached.clone() : null;   /* 화면에 쓰기 전에 비교용으로 복사 */
      var net = fetch(req, { cache: 'no-store' }).then(function (res) {
        if (!res || !res.ok || res.type !== 'basic') return { res: res, save: null };
        var save = res.clone().text().then(function (txt) {
          var put = cache.put(SHELL_KEY, new Response(txt, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
          if (!cached) return put;
          return oldCopy.text().then(function (old) {
            if (old === txt) return put;
            return put.then(function () {   /* 새 버전 받음 → 열려 있는 화면에 알림 */
              return self.clients.matchAll({ type: 'window' }).then(function (list) {
                list.forEach(function (c) { c.postMessage({ type: 'rs-updated' }); });
              });
            });
          });
        });
        return { res: res, save: save };
      });
      return { cached: cached, net: net };
    });
  });
  e.respondWith(job.then(function (o) {
    if (o.cached) return o.cached;
    return o.net.then(function (x) { return x.res; });
  }));
  e.waitUntil(job.then(function (o) { return o.net.then(function (x) { return x.save; }); }).catch(function () {}));
});

/* 철도비서 화면의 '알림 설정'(소리·진동)을 읽어 옴 */
function readPrefs() {
  if (!self.caches) return Promise.resolve({});
  return caches.open('rs-prefs').then(function (c) {
    return c.match(new URL('prefs.json', self.registration.scope).href);
  }).then(function (r) { return r ? r.json() : {}; }).catch(function () { return {}; });
}

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || '출근 알람';
  /* 역 통과·곧 도착 알림: 앱이 열려 있으면 앱 화면에 열차 애니메이션 팝업도 띄움 */
  var toApp = d.pass ? self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage({ type: 'rs-pass', pass: d.pass }); });
  }).catch(function () {}) : Promise.resolve();
  e.waitUntil(Promise.all([toApp, readPrefs().then(function (p) {
    var sound = p.sound !== false, vib = p.vib !== false;
    return self.registration.showNotification(title, {
      body: d.body || '출근 시간이 다가오고 있어요.',
      tag: d.tag || 'alarm',
      renotify: true,
      silent: !sound && !vib,                                   /* 소리·진동 모두 끄면 조용한 알림 */
      requireInteraction: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: vib ? [500, 250, 500, 250, 500, 250, 500] : [],  /* 안드로이드 8 이상은 폰의 알림 진동 설정이 우선 */
      data: { url: self.registration.scope, pass: d.pass || null }
    });
  })]));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var data = e.notification.data || {};
  var url = data.url || self.registration.scope;
  /* 역 통과·곧 도착 알림을 누르면 앱에서 열차 애니메이션 팝업을 다시 보여줌 */
  if (data.pass) url = self.registration.scope + '?passpop=' + encodeURIComponent(JSON.stringify(data.pass));
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
        if (data.pass) list[i].postMessage({ type: 'rs-pass', pass: data.pass, tap: true });
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
