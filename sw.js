// AgendIt — Service Worker: recebe notificações Web Push e abre a página do pedido.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = (event.data && event.data.json()) || {}; } catch {}
  const title = data.title || 'AgendIt';
  const options = {
    body: data.body || '',
    icon: data.icon || '/Logo_Agendit.jpg',
    badge: data.badge || '/Agendit_logo-wt-nobg.png',
    data: { url: data.url || '/agendamento.html' },
    vibrate: [120, 60, 120]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/agendamento.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          try { client.navigate(url); } catch {}
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('notificationclose', (event) => { event.notification.close(); });
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });