
/* 철도비서 Service Worker
   PWA 백그라운드 푸시 및 앱 화면 캐시
*/

var SHELL_CACHE = 'rs-shell-v2';
var SHELL_KEY = 'app-shell';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) {
          return k.indexOf('rs-shell-') === 0 &&
                 k !== SHELL_CACHE;
        }).map(function (k) {
          return caches.delete(k);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ------------------------------------------------------------
   앱 화면(index.html) 빠른 업데이트
   - 화면은 폰에 저장된 것을 바로 띄우고(빠른 실행), 뒤에서 최신본을 확인
   - 주소 뒤에 ?rsv=시각 을 붙여 GitHub CDN(최대 10분) 캐시를 건너뜀
   - 먼저 가벼운 HEAD 요청으로 파일 표식(ETag)만 비교 → 바뀌었을 때만 2MB 본문 다운로드
   - 앱이 다시 화면에 나올 때마다 앱이 'rs-check'를 보내 확인 요청
   ------------------------------------------------------------ */
var shellCheckAt = 0;
function shellUrl() { return new URL('index.html', self.registration.scope).href; }
function bustUrl() { return shellUrl() + '?rsv=' + Date.now(); }
function fileTag(res) { return (res && res.headers && (res.headers.get('ETag') || res.headers.get('Last-Modified'))) || ''; }
function notifyUpdated() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage({ type: 'rs-updated' }); });
  });
}
/* 저장할 때 GitHub에 올린 시각(Last-Modified)도 함께 → 앱의 '앱 버전' 표시에 쓰임 */
function saveShell(cache, txt, tag, modified) {
  var h = { 'Content-Type': 'text/html; charset=utf-8', 'X-RS-Tag': tag || '' };
  if (modified) h['Last-Modified'] = modified;
  return cache.put(SHELL_KEY, new Response(txt, { headers: h }));
}
function modOf(res) { return (res && res.headers && res.headers.get('Last-Modified')) || ''; }
function refreshShell(force) {
  if (!force && Date.now() - shellCheckAt < 15000) return Promise.resolve(false);
  shellCheckAt = Date.now();
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(SHELL_KEY).then(function (cached) {
      var oldTag = cached ? (cached.headers.get('X-RS-Tag') || '') : '';
      var head = oldTag
        ? fetch(bustUrl(), { method: 'HEAD', cache: 'no-store' }).then(function (r) { return r && r.ok ? fileTag(r) : ''; }).catch(function () { return ''; })
        : Promise.resolve('');
      return head.then(function (tag) {
        if (oldTag && tag && tag === oldTag) return false;           /* 그대로 → 끝 */
        return fetch(bustUrl(), { cache: 'no-store' }).then(function (res) {
          if (!res || !res.ok) return false;
          var newTag = fileTag(res), newMod = modOf(res);
          return res.text().then(function (txt) {
            if (txt.length < 1000) return false;                      /* 이상한 응답은 저장 안 함 */
            var oldTxt = cached ? cached.text() : Promise.resolve(null);
            return oldTxt.then(function (old) {
              var changed = old !== null && old !== txt;
              return saveShell(cache, txt, newTag, newMod).then(function () {
                if (changed) return notifyUpdated().then(function () { return true; });
                return false;
              });
            });
          });
        });
      });
    });
  }).catch(function () { return false; });
}

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'rs-check') e.waitUntil(refreshShell(!!d.force));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var path = url.pathname.replace(self.registration.scope.replace(self.location.origin, ''), '');
  if (path !== '' && path !== 'index.html') return;

  var look = caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(SHELL_KEY).then(function (cached) { return { cache: cache, cached: cached }; });
  });
  e.respondWith(look.then(function (o) {
    if (o.cached) return o.cached;
    /* 처음 설치: 최신본을 받아 저장하고 그대로 보여줌 */
    return fetch(bustUrl(), { cache: 'no-store' }).then(function (res) {
      if (!res || !res.ok) return fetch(req);
      var tag = fileTag(res), mod = modOf(res);
      return res.text().then(function (txt) {
        return saveShell(o.cache, txt, tag, mod).then(function () {
          var h = { 'Content-Type': 'text/html; charset=utf-8' };
          if (mod) h['Last-Modified'] = mod;
          return new Response(txt, { headers: h });
        });
      });
    }).catch(function () { return fetch(req); });
  }).catch(function () { return fetch(req); }));
  /* 저장본을 띄웠으면 뒤에서 최신본 확인 */
  e.waitUntil(look.then(function (o) { return o.cached ? refreshShell(true) : null; }).catch(function () {}));
});

function readPrefs() {
  return caches.open('rs-prefs').then(function (c) {
    return c.match(
      new URL('prefs.json', self.registration.scope).href
    );
  }).then(function (r) {
    return r ? r.json() : {};
  }).catch(function () {
    return {};
  });
}

self.addEventListener('push', function (e) {
  var d = {};

  try {
    d = e.data ? e.data.json() : {};
  } catch (err) {
    d = { body: e.data ? e.data.text() : '' };
  }

  var title = d.title || '철도비서 알림';

  /* 알림을 받은 시각 기록 (앱의 알림 설정 화면에서 '마지막으로 받은 알림'으로 보여줌) */
  var mark = caches.open('rs-prefs').then(function (c) {
    return c.put(new URL('lastpush.json', self.registration.scope).href,
      new Response(JSON.stringify({ at: Date.now(), title: title }), { headers: { 'Content-Type': 'application/json' } }));
  }).catch(function () {});

  var toApp = d.pass
    ? self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      }).then(function (list) {
        list.forEach(function (c) {
          c.postMessage({
            type: 'rs-pass',
            pass: d.pass
          });
        });
      }).catch(function () {})
    : Promise.resolve();

  e.waitUntil(
    Promise.all([
      toApp,
      mark,
      readPrefs().then(function (p) {
        var sound = p.sound !== false;
        var vib = p.vib !== false;

        return self.registration.showNotification(title, {
          body: d.body || '새로운 열차 운행 알림입니다.',
          tag: d.tag || 'alarm',
          renotify: true,
          silent: !sound && !vib,
          requireInteraction: true,
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          vibrate: vib
            ? [500, 250, 500, 250, 500, 250, 500]
            : [],
          data: {
            url: self.registration.scope,
            pass: d.pass || null
          }
        });
      })
    ])
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();

  var data = e.notification.data || {};
  var url = data.url || self.registration.scope;

  if (data.pass) {
    url = self.registration.scope +
      '?passpop=' +
      encodeURIComponent(JSON.stringify(data.pass));
  }

  e.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (
          list[i].url.indexOf(self.registration.scope) === 0 &&
          'focus' in list[i]
        ) {
          if (data.pass) {
            list[i].postMessage({
              type: 'rs-pass',
              pass: data.pass,
              tap: true
            });
          }

          return list[i].focus();
        }
      }

      return self.clients.openWindow(url);
    })
  );
});
