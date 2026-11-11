// sw.js — 서비스 워커: 앱 파일을 미리 저장해 두어 인터넷 없이도 열리게 한다.
//
//   앱 파일(HTML/CSS/JS/아이콘) : 설치할 때 미리 저장 → 저장본 우선
//   articles/index.json         : 네트워크 우선 → 실패하면 저장본
//   articles/…/날짜.json        : 저장본 우선 + 뒤에서 조용히 최신본으로 갱신
//
// 모든 경로는 상대 경로다. (GitHub Pages의 /DailyEnglish/ 하위 경로에서 동작해야 한다)
//
// 아래 "자동 생성" 구역은 `node tools/update-sw.mjs` 가 고쳐 쓴다. 앱 파일을 바꾼 뒤에는
// 반드시 그 명령을 실행한다. (테스트가 최신인지 확인한다) VERSION이 바뀌면 사용자 화면에
// "새 버전이 있어요 [새로고침]"이 뜨고, 이전 버전의 저장본은 지워진다.

/* ── 자동 생성 시작 (직접 고치지 마세요) ── */
const VERSION = '1.0.0-63a73a84';
const PRECACHE = [
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'index.html',
  'js/archive.js',
  'js/articles.js',
  'js/boot.js',
  'js/db.js',
  'js/main.js',
  'js/popup.js',
  'js/prefs.js',
  'js/pwa.js',
  'js/quiz.js',
  'js/reader.js',
  'js/review.js',
  'js/schema.js',
  'js/settings.js',
  'js/srs.js',
  'js/tts.js',
  'js/ui.js',
  'js/util.js',
  'js/version.js',
  'js/vocab.js',
  'manifest.webmanifest',
  'vendor/ts-fsrs.umd.js',
];
/* ── 자동 생성 끝 ── */

const SHELL_CACHE = `de-shell-${VERSION}`;
const ARTICLE_CACHE = 'de-articles-v1';
const SCOPE_PATH = new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 브라우저의 HTTP 캐시에 남은 옛 파일이 섞이지 않도록 서버에서 새로 받는다.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('de-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  else if (type === 'GET_VERSION') event.ports[0]?.postMessage({ version: VERSION });
});

async function shellFirst(request, fallbackUrl) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(fallbackUrl ?? request, { ignoreSearch: true });
  if (hit) return hit;
  return fetch(request);
}

async function networkFirst(request) {
  const cache = await caches.open(ARTICLE_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(ARTICLE_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request)
    .then(async (res) => {
      if (res.ok) await cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  const res = await refresh;
  if (res) return res;
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const rel = url.pathname.slice(SCOPE_PATH.length);

  if (request.mode === 'navigate') {
    // 앱 화면은 하나(index.html)뿐이다. 그 밖의 주소로 직접 들어온 경우는 브라우저에 맡긴다.
    if (rel === '' || rel === 'index.html') event.respondWith(shellFirst(request, 'index.html'));
    return;
  }
  if (rel === 'articles/index.json') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (rel.startsWith('articles/') && rel.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(request, event));
    return;
  }
  if (PRECACHE.includes(rel)) event.respondWith(shellFirst(request));
});
