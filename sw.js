// JusticeLK Service Worker — v1.0
// Caches all platform pages for offline use

const CACHE_NAME = 'justicelk-v1';
const OFFLINE_PAGE = './index.html';

const PRECACHE_URLS = [
  './index.html',
  './about.html',
  './kids.html',
  './minor-protection.html',
  './lawyer-registration.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600;700&family=Noto+Serif+Sinhala:wght@400;700&family=Noto+Sans+Tamil:wght@400;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Noto+Serif+Sinhala:wght@400;700&family=Noto+Sans+Tamil:wght@400;700&display=swap'
];

// Install — cache all core pages
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn('Could not cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fall back to network, fall back to offline page
self.addEventListener('fetch', event => {
  // Skip non-GET and cross-origin API calls (Sheets, Groq, Anthropic)
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (
    url.hostname === 'script.google.com' ||
    url.hostname === 'api.groq.com' ||
    url.hostname === 'api.anthropic.com' ||
    url.hostname === 'localhost'
  ) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful HTML/CSS/JS/font responses
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match(OFFLINE_PAGE);
        }
      });
    })
  );
});

// Background sync — retry failed Sheets submissions when back online
self.addEventListener('sync', event => {
  if (event.tag === 'sync-cases') {
    event.waitUntil(syncPendingCases());
  }
});

async function syncPendingCases() {
  // Placeholder for future background sync implementation
  console.log('[JusticeLK SW] Background sync triggered');
}
