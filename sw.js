/* 철도비서 Service Worker
   - 앱 화면(index.html) 저장 · 빠른 실행 · 뒤에서 최신본 확인
   - 백그라운드 푸시 알림
*/
var SHELL_CACHE = 'rs-shell-v2';
var SHELL_KEY = 'app-shell';
var NOTI_ICON = 'icon-192.png';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('rs-shell-') === 0 && k !== SHELL_CACHE;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 열려 있는 철도비서 화면 모두에 메시지 보내기 */
function allWindows() { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); }
function broadcast(msg) {
  return allWindows().then(function (list) {
    list.forEach(function (c) { c.postMessage(msg); });
  }).catch(function () {});
}
function scopeUrl(name) { return new URL(name, self.registration.scope).href; }

/* ------------------------------------------------------------
   앱 화면(index.html) 빠른 업데이트
   - 폰에 저장된 화면을 바로 띄우고(빠른 실행), 뒤에서 최신본 확인
   - 주소 뒤에 ?rsv=시각 을 붙여 GitHub CDN(최대 10분) 캐시를 건너뜀
   - 먼저 가벼운 HEAD 요청으로 파일 표식(ETag)만 비교 → 바뀌었을 때만 본문(약 5MB) 다운로드
   - 앱이 다시 화면에 나올 때마다 'rs-check'를 보내 확인 요청 (15초 안에 다시 오면 건너뜀)
   ------------------------------------------------------------ */
var shellCheckAt = 0;
function bustUrl() { return scopeUrl('index.html') + '?rsv=' + Date.now(); }
function header(res, k) { return (res && res.headers && res.headers.get(k)) || ''; }
function fileTag(res) { return header(res, 'ETag') || header(res, 'Last-Modified'); }

/* 저장할 때 GitHub에 올린 시각(Last-Modified)도 함께 → 앱의 '앱 버전' 표시에 쓰임 */
function htmlHeaders(modified, tag) {
  var h = { 'Content-Type': 'text/html; charset=utf-8' };
  if (tag !== undefined) h['X-RS-Tag'] = tag || '';
  if (modified) h['Last-Modified'] = modified;
  return h;
}
function openShell() {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(SHELL_KEY).then(function (cached) { return { cache: cache, cached: cached }; });
  });
}
/* 최신본 받아서 저장 → { txt, mod } (이상한 응답이면 null) */
function downloadShell(cache) {
  return fetch(bustUrl(), { cache: 'no-store' }).then(function (res) {
    if (!res || !res.ok) return null;
    var tag = fileTag(res), mod = header(res, 'Last-Modified');
    return res.text().then(function (txt) {
      if (txt.length < 1000) return null;
      return cache.put(SHELL_KEY, new Response(txt, { headers: htmlHeaders(mod, tag) }))
        .then(function () { return { txt: txt, mod: mod }; });
    });
  });
}

function refreshShell(force) {
  if (!force && Date.now() - shellCheckAt < 15000) return Promise.resolve(false);
  shellCheckAt = Date.now();
  return openShell().then(function (o) {
    var oldTag = o.cached ? (o.cached.headers.get('X-RS-Tag') || '') : '';
    var head = oldTag
      ? fetch(bustUrl(), { method: 'HEAD', cache: 'no-store' })
          .then(function (r) { return r && r.ok ? fileTag(r) : ''; })
          .catch(function () { return ''; })
      : Promise.resolve('');
    return head.then(function (tag) {
      if (oldTag && tag === oldTag) return false;                    /* 그대로 → 끝 */
      var oldTxt = o.cached ? o.cached.clone().text() : Promise.resolve(null);
      return downloadShell(o.cache).then(function (got) {
        if (!got) return false;
        return oldTxt.then(function (old) {
          if (old === null || old === got.txt) return false;
          return broadcast({ type: 'rs-updated' }).then(function () { return true; });
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

  var look = openShell();
  e.respondWith(look.then(function (o) {
    if (o.cached) return o.cached;
    /* 처음 설치: 최신본을 받아 저장하고 그대로 보여줌 */
    return downloadShell(o.cache).then(function (got) {
      return got ? new Response(got.txt, { headers: htmlHeaders(got.mod) }) : fetch(req);
    });
  }).catch(function () { return fetch(req); }));
  /* 저장본을 띄웠으면 뒤에서 최신본 확인 */
  e.waitUntil(look.then(function (o) { return o.cached ? refreshShell(true) : null; }).catch(function () {}));
});

/* ------------------------------------------------------------
   푸시 알림
   ------------------------------------------------------------ */
function readPrefs() {
  return caches.open('rs-prefs').then(function (c) { return c.match(scopeUrl('prefs.json')); })
    .then(function (r) { return r ? r.json() : {}; })
    .catch(function () { return {}; });
}

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || '철도비서 알림';

  /* 알림을 받은 시각 기록 (알림 설정 화면의 '마지막으로 받은 알림') */
  var mark = caches.open('rs-prefs').then(function (c) {
    return c.put(scopeUrl('lastpush.json'), new Response(JSON.stringify({ at: Date.now(), title: title }),
      { headers: { 'Content-Type': 'application/json' } }));
  }).catch(function () {});

  var toApp = d.pass ? broadcast({ type: 'rs-pass', pass: d.pass }) : Promise.resolve();

  var show = readPrefs().then(function (p) {
    /* 알림 종류별 설정(운휴 · 통과/도착 · 출근): 팝업 · 소리 · 진동. 종류 설정이 없으면 공통 설정 */
    var kind = d.kind || (d.pass ? 'pass' : (/^nx-/.test(d.tag || '') ? 'nx' : 'alarm'));
    var kp = (p.kinds && p.kinds[kind]) || {};
    function pick(k) { return (typeof kp[k] === 'boolean' ? kp[k] : p[k]) !== false; }
    var popup = pick('popup'), sound = popup && pick('sound'), vib = popup && pick('vib');
    return self.registration.showNotification(title, {
      body: d.body || '새로운 열차 운행 알림입니다.',
      tag: d.tag || 'alarm',
      renotify: popup,
      silent: !sound && !vib,
      requireInteraction: popup,          /* 팝업을 끄면 알림창에만 조용히 쌓임 */
      icon: NOTI_ICON,
      badge: NOTI_ICON,
      vibrate: vib ? [500, 250, 500, 250, 500, 250, 500] : [],
      data: { url: self.registration.scope, pass: d.pass || null }
    });
  }).then(function () {
    /* 알림을 띄웠으면 서버에 '받았음' → 서버는 다시 보내지 않음 (못 띄웠으면 2분 뒤 다시 옴) */
    return pushAck(d.ack);
  });

  e.waitUntil(Promise.all([toApp, mark, show]));
});

function pushAck(a) {
  if (!a || !a.u || !a.id) return Promise.resolve();
  var h = { 'Content-Type': 'application/json' };
  if (a.k) { h.apikey = a.k; h.Authorization = 'Bearer ' + a.k; }
  function once() { return fetch(a.u, { method: 'POST', headers: h, body: JSON.stringify({ p: { id: a.id } }), cache: 'no-store' }); }
  return once().catch(function () {
    return new Promise(function (r) { setTimeout(r, 1500); }).then(once);
  }).catch(function () {});
}

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var data = e.notification.data || {};
  var scope = self.registration.scope;
  var url = data.pass ? scope + '?passpop=' + encodeURIComponent(JSON.stringify(data.pass)) : (data.url || scope);

  e.waitUntil(allWindows().then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(scope) === 0 && 'focus' in c) {
        if (data.pass) c.postMessage({ type: 'rs-pass', pass: data.pass, tap: true });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
