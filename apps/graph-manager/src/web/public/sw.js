// graph-manager's service worker: it caches nothing. It only replaces the browser's error page when a page
// navigation can't reach the server (an installed app has no address bar or reload button).
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>graph-manager is not reachable</title>
<style>
  html, body { margin: 0; min-height: 100%; }
  body {
    background: #0a0b0d;
    color: #d6d9de;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 100vh;
    box-sizing: border-box;
    padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 500; }
  p { margin: 0 0 24px; max-width: 32em; }
  button { height: 44px; padding: 0 24px; border: 1px solid #7aa2ff; border-radius: 8px; background: transparent; color: #7aa2ff; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<h1>graph-manager is not reachable</h1>
<p>Check that the server is running and that this device can reach it.</p>
<button type="button" onclick="location.reload()">Retry</button>
</body>
</html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // every other request goes to the network as usual
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
    ),
  );
});
