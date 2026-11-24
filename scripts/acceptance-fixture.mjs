import http from 'node:http';

const pages = {
  '/clean': { status: 200, html: '<!doctype html><html lang="en"><head><title>Clean fixture</title></head><body><main><h1>Clean fixture</h1><p>Accessible fixture page.</p></main></body></html>' },
  '/violations': { status: 200, html: '<!doctype html><title>Known violations</title><main><h1>Known violations</h1><img class="first-bad" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><img class="second-bad" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></main>' },
  '/failure': { status: 503, html: '<!doctype html><title>Unavailable</title><main>Fixture unavailable</main>' },
  '/discovery': { status: 200, html: '<!doctype html><title>Discovery seed</title><main><a href="/discovered-one">One</a><a href="/discovered-two#first">Two first</a><a href="/discovered-two#second">Two second</a><a href="#local">Local</a><a href="https://outside.test/ignore">Outside</a><a href="mailto:test@allowed.test">Mail</a></main>' },
  '/discovered-one': { status: 200, html: '<!doctype html><title>Discovered one</title><main>Discovered one</main>' },
  '/discovered-two': { status: 200, html: '<!doctype html><title>Discovered two</title><main>Discovered two</main>' }
};

http.createServer((req, res) => {
  const page = pages[new URL(req.url ?? '/', 'http://allowed.test').pathname] ?? { status: 404, html: 'not found' };
  res.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page.html);
}).listen(80, '0.0.0.0', () => console.log('acceptance fixture listening on test-only egress route'));
