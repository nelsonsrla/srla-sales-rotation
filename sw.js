// No caching — always load fresh from the network.
// This service worker exists only to receive push notifications.

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

// ── Push notification handler ──────────────────────────
self.addEventListener('push', function(e) {
  var data = { title: "New Lead — You're Up!", body: 'Open the app to see details.' };
  try { data = e.data.json(); } catch (err) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:     data.body,
      icon:     '/icon-192.png',
      badge:    '/icon-192.png',
      vibrate:  [200, 100, 200, 100, 200],
      tag:      'lead-rotation',
      renotify: true,
      data:     { url: self.location.origin }
    })
  );
});

// ── Tap notification → open app ────────────────────────
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      var existing = list.find(function(c) { return c.url.startsWith(self.location.origin); });
      if (existing) return existing.focus();
      var url = (e.notification.data && e.notification.data.url) || '/';
      return clients.openWindow(url);
    })
  );
});
