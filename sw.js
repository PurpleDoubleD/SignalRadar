const CACHE_NAME = 'signalradar-v2';
const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

const TILE_CACHE = 'signalradar-tiles-v1';
const MAX_TILE_CACHE = 500; // max cached tiles

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME && key !== TILE_CACHE)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Tile caching strategy: cache-first for map tiles
    if (url.hostname.includes('basemaps.cartocdn.com') || 
        url.hostname.includes('arcgisonline.com') ||
        url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(
            caches.open(TILE_CACHE).then(cache =>
                cache.match(event.request).then(cached => {
                    if (cached) return cached;
                    return fetch(event.request).then(response => {
                        if (response.ok) {
                            cache.put(event.request, response.clone());
                            // Evict old tiles if cache too large
                            cache.keys().then(keys => {
                                if (keys.length > MAX_TILE_CACHE) {
                                    keys.slice(0, keys.length - MAX_TILE_CACHE)
                                        .forEach(key => cache.delete(key));
                                }
                            });
                        }
                        return response;
                    }).catch(() => cached);
                })
            )
        );
        return;
    }
    
    // CDN resources (Leaflet, etc): stale-while-revalidate
    if (url.hostname.includes('unpkg.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache =>
                cache.match(event.request).then(cached => {
                    const fetchPromise = fetch(event.request).then(response => {
                        if (response.ok) cache.put(event.request, response.clone());
                        return response;
                    }).catch(() => cached);
                    return cached || fetchPromise;
                })
            )
        );
        return;
    }
    
    // App files: network-first
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
