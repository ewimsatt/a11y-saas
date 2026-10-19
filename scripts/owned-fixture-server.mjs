import http from 'node:http';

const port = Number(process.env.FIXTURE_PORT ?? 4310);
const pages = {
  '/clean': { status: 200, html: '<!doctype html><html lang="en"><head><title>Clean fixture</title></head><body><main><h1>Clean fixture</h1><p>Accessible fixture page.</p></main></body></html>' },
  '/violations': { status: 200, html: '<!doctype html><title>Known violations</title><main><h1>Known violations</h1><img class="first-bad" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><img class="second-bad" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></main>' },
  '/failure': { status: 503, html: '<!doctype html><title>Unavailable</title><main>Fixture unavailable</main>' }
};

http.createServer((req, res) => {
  const page = pages[new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname] ?? { status: 404, html: 'not found' };
  res.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page.html);
}).listen(port, '127.0.0.1', () => console.log(`owned fixture server listening on ${port}`));
