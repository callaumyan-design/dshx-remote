// Minimal service worker: only the app shell is cached (for "add to home
// screen" and fast cold starts). API calls always go to the network.
const SHELL = 'dshx-remote-shell-v1'
const FILES = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  // Network first so updates land immediately; cache as offline fallback.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) caches.open(SHELL).then((cache) => cache.put(event.request, response.clone())).catch(() => {})
      return response
    }).catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))),
  )
})
