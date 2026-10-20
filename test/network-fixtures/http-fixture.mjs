import http from 'node:http';

const counters = new Map();
const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>fixture</title></head><body>${body}</body></html>`;

function normalizedAddress(address = '') {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function targetClass(req, port) {
  const address = normalizedAddress(req.socket.localAddress);
  if (port === 8080) return 'denied-port';
  if (address === '45.0.0.10') return 'public';
  if (address === '10.66.0.10') return 'private';
  if (address === '169.254.169.254') return 'metadata';
  if (address.toLowerCase() === 'fd00:dead:beef::10') return 'ipv6';
  return `other:${address}`;
}

function increment(req, port, protocol = 'http') {
  const key = `${targetClass(req, port)}:${protocol}:${req.url}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

function snapshot() {
  const byTarget = { public: 0, private: 0, metadata: 0, ipv6: 0, 'denied-port': 0 };
  for (const [key, value] of counters) {
    const target = key.split(':', 1)[0];
    if (target in byTarget) byTarget[target] += value;
  }
  return { byTarget, requests: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))) };
}

function serve(req, res, port) {
  if (req.url === '/__counters') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(snapshot()));
  }
  if (req.method === 'POST' && req.url === '/__reset') {
    counters.clear();
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(snapshot()));
  }
  increment(req, port);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');

  const redirects = {
    '/redirect-private': 'http://10.66.0.10/trap-redirect-private',
    '/redirect-metadata': 'http://169.254.169.254/trap-redirect-metadata',
    '/redirect-ipv6': 'http://[fd00:dead:beef::10]/trap-redirect-ipv6',
    '/redirect-private-dns': 'http://private.test/trap-redirect-private-dns',
  };
  if (redirects[req.url]) {
    res.writeHead(302, { location: redirects[req.url] });
    return res.end();
  }
  if (req.url === '/subresources') {
    return res.end(html(`
      <main id="subresources">owned subresource fixture</main>
      <img src="http://10.66.0.10/trap-image">
      <script src="http://169.254.169.254/trap-script"></script>
      <link rel="stylesheet" href="http://[fd00:dead:beef::10]/trap-style">
      <iframe src="http://private.test/trap-frame"></iframe>
      <script>
        fetch('http://10.66.0.10/trap-fetch').catch(() => {});
        new EventSource('http://169.254.169.254/trap-events');
        const ws = new WebSocket('ws://10.66.0.10/trap-websocket');
        ws.onerror = () => ws.close();
      </script>
    `));
  }
  if (req.url === '/service-worker') {
    return res.end(html(`<main id="service-worker">service worker test</main><script>
      window.swResult = navigator.serviceWorker
        ? navigator.serviceWorker.register('/sw.js').then(() => 'registered', error => 'blocked:' + error.name)
        : Promise.resolve('blocked:Unavailable');
    </script>`));
  }
  if (req.url === '/sw.js') {
    res.setHeader('content-type', 'application/javascript');
    return res.end(`self.addEventListener('install', event => event.waitUntil(fetch('http://10.66.0.10/trap-sw')));`);
  }
  if (req.url.startsWith('/trap')) {
    res.statusCode = 418;
    return res.end('forbidden trap reached');
  }
  if (req.url.startsWith('/rebind')) res.setHeader('connection', 'close');
  res.end(html('<main id="allowed">owned fixture reached through Smokescreen</main>'));
}

for (const port of [80, 8080]) {
  const server = http.createServer((req, res) => serve(req, res, port));
  server.on('upgrade', (req, socket) => {
    increment(req, port, 'websocket');
    socket.end('HTTP/1.1 418 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.listen({ port, host: '::', ipv6Only: false }, () => console.log(`fixture listening on dual-stack port ${port}`));
}
