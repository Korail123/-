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

self.addEventListener('fetch', function (e) {
  var req = e.request;

  if (req.method !== 'GET' || req.mode !== 'navigate') return;

  var url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

  var path = url.pathname.replace(
    self.registration.scope.replace(self.location.origin, ''),
    ''
  );

  if (path !== '' && path !== 'index.html') return;

  var job = caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(SHELL_KEY).then(function (cached) {
      var oldCopy = cached ? cached.clone() : null;

      var net = fetch(req, { cache: 'no-store' }).then(function (res) {
        if (!res || !res.ok || res.type !== 'basic') {
          return { res: res, save: null };
        }

        var save = res.clone().text().then(function (txt) {
          var put = cache.put(
            SHELL_KEY,
            new Response(txt, {
              headers: {
                'Content-Type': 'text/html; charset=utf-8'
              }
            })
          );

          if (!cached) return put;

          return oldCopy.text().then(function (old) {
            if (old === txt) return put;

            return put.then(function () {
              return self.clients.matchAll({
                type: 'window'
              }).then(function (list) {
                list.forEach(function (c) {
                  c.postMessage({ type: 'rs-updated' });
                });
              });
            });
          });
        });

        return { res: res, save: save };
      });

      return { cached: cached, net: net };
    });
  });

  e.respondWith(
    job.then(function (o) {
      if (o.cached) return o.cached;
      return o.net.then(function (x) {
        return x.res;
      });
    })
  );

  e.waitUntil(
    job.then(function (o) {
      return o.net.then(function (x) {
        return x.save;
      });
    }).catch(function () {})
  );
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
