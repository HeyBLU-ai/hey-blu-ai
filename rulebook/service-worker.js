const CACHE_NAME = 'heyblu-v1.0.4';
const STATIC_CACHE = 'heyblu-static-v1.0.4';
const DYNAMIC_CACHE = 'heyblu-dynamic-v1.0.4';

// Files to cache immediately (paths relative to /rulebook/ scope)
const STATIC_FILES = [
  '/rulebook/',
  '/rulebook/index.html',
  '/rulebook/app.js',
  '/rulebook/share.html',
  '/rulebook/legal.html',
  '/public/output.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js',
];

// Install event - cache static files
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('Service Worker: Caching static files');
        return cache.addAll(STATIC_FILES);
      })
      .then(() => {
        console.log('Service Worker: Static files cached');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('Service Worker: Error caching static files', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE) {
              console.log('Service Worker: Deleting old cache', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('Service Worker: Activated');
        return self.clients.claim();
      })
  );
});

// Allow the page to tell a waiting worker to activate immediately.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip unsupported schemes (chrome-extension, data, etc.)
  if (!(request.url.startsWith('http') || request.url.startsWith('https'))) {
    return;
  }

  // Handle API requests differently
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // HTML + app shell: network first so deploys reach mobile immediately
  if (request.headers.get('accept')?.includes('text/html') ||
      url.pathname === '/rulebook/app.js' ||
      url.pathname === '/rulebook/index.html' ||
      url.pathname === '/rulebook') {
    event.respondWith(handleNetworkFirstRequest(request));
    return;
  }

  // Styles + third-party libraries: stale-while-revalidate so a deploy's CSS or
  // library change is picked up automatically on the next load, without ever
  // requiring a service-worker version bump or trapping the user on old assets.
  if (url.pathname === '/public/output.css' ||
      url.pathname === '/dist/output.css' ||
      url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(handleStaleWhileRevalidate(request));
    return;
  }

  // Handle static file requests
  event.respondWith(handleStaticRequest(request));
});

// Stale-while-revalidate: serve the cached copy instantly (if any) while
// fetching a fresh copy in the background for next time.
async function handleStaleWhileRevalidate(request) {
  const cache = await caches.open(DYNAMIC_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  return cached || (await networkPromise) || fetch(request);
}

async function handleNetworkFirstRequest(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;
    throw error;
  }
}

// Handle API requests - network first, cache fallback
async function handleApiRequest(request) {
  try {
    // Try network first
    const networkResponse = await fetch(request);
    
    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
  } catch (error) {
    console.log('Service Worker: Network failed, trying cache for API request');
    
    // Fallback to cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Return offline response for API requests
    return new Response(
      JSON.stringify({ 
        error: 'You are offline. Please check your connection and try again.' 
      }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Handle static file requests - cache first, network fallback
async function handleStaticRequest(request) {
  try {
    // Try cache first
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Fallback to network
    const networkResponse = await fetch(request);
    
    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
  } catch (error) {
    console.log('Service Worker: Both cache and network failed');
    
    // Return offline page for HTML requests
    if (request.headers.get('accept').includes('text/html')) {
      return caches.match('/rulebook/index.html');
    }
    
    // Return generic offline response
    return new Response('You are offline. Please check your connection and try again.', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
}

// Background sync for offline form submissions
self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    console.log('Service Worker: Background sync triggered');
    event.waitUntil(doBackgroundSync());
  }
});

async function doBackgroundSync() {
  try {
    // Get any pending requests from IndexedDB
    const pendingRequests = await getPendingRequests();
    
    for (const request of pendingRequests) {
      try {
        await fetch(request.url, request.options);
        await removePendingRequest(request.id);
      } catch (error) {
        console.error('Service Worker: Background sync failed for request', error);
      }
    }
  } catch (error) {
    console.error('Service Worker: Background sync error', error);
  }
}

// Helper functions for IndexedDB (simplified)
async function getPendingRequests() {
  // This would be implemented with IndexedDB
  // For now, return empty array
  return [];
}

async function removePendingRequest(id) {
  // This would be implemented with IndexedDB
  // For now, do nothing
}

// Push notification handling
self.addEventListener('push', (event) => {
  console.log('Service Worker: Push notification received');
  
  const options = {
    body: event.data ? event.data.text() : 'New update available!',
    icon: '../images/BLU_B_logo2.png',
    badge: '../images/BLU_B_logo2.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'explore',
        title: 'Open App',
        icon: '../images/BLU_B_logo2.png'
      },
      {
        action: 'close',
        title: 'Close',
        icon: '../images/BLU_B_logo2.png'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification('HeyBLU.AI', options)
  );
});

// Notification click handling
self.addEventListener('notificationclick', (event) => {
  console.log('Service Worker: Notification clicked');
  
  event.notification.close();
  
  if (event.action === 'explore') {
    event.waitUntil(
      clients.openWindow('./')
    );
  }
}); 