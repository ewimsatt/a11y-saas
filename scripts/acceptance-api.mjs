const [method, path, body = ''] = process.argv.slice(2);
if (!['GET', 'POST'].includes(method) || !path?.startsWith('/')) {
  throw new Error('usage: acceptance-api.mjs <GET|POST> </path> [json-body]');
}
const response = await fetch(`http://127.0.0.1:3001${path}`, {
  method,
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body || undefined
});
const text = await response.text();
if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
process.stdout.write(text);
