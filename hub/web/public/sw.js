/*
 * fleetmates deck service worker (remote access). It caches the static shell and nothing else.
 *
 * Never cached, in any circumstance: `/api/*`, `/.well-known/*` (the passphrase exchange and the identity proof
 * both carry the deck token) and every non-GET request. The WebSocket does not pass through a service worker at
 * all. A navigation falls back to the cached shell only when the network fails, so a stale shell never hides a
 * deck that is answering.
 */
const CACHE = 'fleetmates-deck-shell-v1'
/** The entry points precached at install. Hashed assets join the cache as the shell requests them. */
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']
/** Extensions of the static shell: markup, code, styles, icons and fonts. */
const STATIC = /\.(?:js|mjs|css|png|svg|ico|webmanifest|woff2)$/

self.addEventListener('install', event => {
  // Each entry is added on its own: one icon that is not built yet must not fail the whole install.
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(path => cache.add(path).catch(() => {})))).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
    .then(() => self.clients.claim()))
})

/** Whether this request may ever reach the cache. */
function cacheable(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) return false
  return STATIC.test(url.pathname)
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/').then(hit => hit ?? Response.error())))
    return
  }
  if (!cacheable(event.request, url)) return
  event.respondWith(caches.match(event.request).then(hit => {
    if (hit) return hit
    return fetch(event.request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone()
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {})
      }
      return response
    })
  }))
})
