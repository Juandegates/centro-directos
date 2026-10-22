// Mínimo para que la app se pueda instalar en la pantalla de inicio. No guarda nada en caché:
// todo viene siempre en vivo de tu PC.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
