import { writeFile } from 'node:fs/promises';
import http from 'node:http';

const countPath = process.env.CANARY_COUNT_PATH ?? '/tmp/a11y-pdf-canary-count';
let count = 0;
await writeFile(countPath, '0\n', { mode: 0o600 });
const server = http.createServer(async (_request, response) => {
  count += 1;
  await writeFile(countPath, `${count}\n`, { mode: 0o600 });
  response.writeHead(200, { 'content-type': 'image/png' });
  response.end(Buffer.from('not-a-real-image'));
});
server.listen(3999, '0.0.0.0', () => console.log('pdf request canary listening on 3999'));
