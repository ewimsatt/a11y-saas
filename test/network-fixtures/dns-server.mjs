import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';

const addresses = {
  public: '45.0.0.10',
  private: '10.66.0.10',
  metadata: '169.254.169.254',
  ipv6: 'fd00:dead:beef::10',
};
let rebindMode = 'public';
const queryCounts = new Map();

function parseQuestion(message) {
  if (message.length < 17) throw new Error('short DNS query');
  let offset = 12;
  const labels = [];
  while (true) {
    const length = message[offset++];
    if (length === 0) break;
    if ((length & 0xc0) !== 0 || offset + length > message.length) throw new Error('unsupported DNS name');
    labels.push(message.subarray(offset, offset + length).toString('ascii'));
    offset += length;
  }
  if (offset + 4 > message.length) throw new Error('short DNS question');
  const type = message.readUInt16BE(offset);
  const klass = message.readUInt16BE(offset + 2);
  return { name: labels.join('.').toLowerCase(), type, klass, end: offset + 4 };
}

function ipv4Bytes(address) {
  return Buffer.from(address.split('.').map((part) => Number(part)));
}

function ipv6Bytes(address) {
  const [leftRaw, rightRaw = ''] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) throw new Error(`invalid fixture IPv6 address: ${address}`);
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => result.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2));
  return result;
}

function answerData(name, type) {
  if (type === 1) {
    if (name === 'allowed.test') return [ipv4Bytes(addresses.public)];
    if (name === 'private.test') return [ipv4Bytes(addresses.private)];
    if (name === 'metadata.test') return [ipv4Bytes(addresses.metadata)];
    if (name === 'mixed.test') return [ipv4Bytes(addresses.private), ipv4Bytes(addresses.public)];
    if (name === 'rebind.test') return [ipv4Bytes(addresses[rebindMode])];
  }
  if (type === 28 && name === 'ipv6.test') return [ipv6Bytes(addresses.ipv6)];
  return [];
}

function buildResponse(query) {
  const question = parseQuestion(query);
  queryCounts.set(`${question.name}/${question.type}`, (queryCounts.get(`${question.name}/${question.type}`) ?? 0) + 1);
  const records = question.klass === 1 ? answerData(question.name, question.type) : [];
  const chunks = [];
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  chunks.push(header, query.subarray(12, question.end));
  for (const data of records) {
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(question.type, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(0, 6);
    rr.writeUInt16BE(data.length, 10);
    chunks.push(rr, data);
  }
  return Buffer.concat(chunks);
}

function respond(message, send) {
  try { send(buildResponse(message)); }
  catch (error) { console.error(`dns fixture rejected query: ${error.message}`); }
}

const udp = dgram.createSocket('udp4');
udp.on('message', (message, rinfo) => respond(message, (payload) => udp.send(payload, rinfo.port, rinfo.address)));
udp.bind(53, '0.0.0.0');

const tcp = net.createServer((socket) => {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const length = buffered.readUInt16BE(0);
      if (buffered.length < length + 2) return;
      const message = buffered.subarray(2, length + 2);
      buffered = buffered.subarray(length + 2);
      respond(message, (payload) => {
        const framed = Buffer.alloc(payload.length + 2);
        framed.writeUInt16BE(payload.length, 0);
        payload.copy(framed, 2);
        socket.write(framed);
      });
    }
  });
});
tcp.listen(53, '0.0.0.0');

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rebind/public') rebindMode = 'public';
  else if (req.method === 'POST' && req.url === '/rebind/private') rebindMode = 'private';
  else if (req.method === 'POST' && req.url === '/reset') queryCounts.clear();
  else if (req.url !== '/state') { res.writeHead(404); return res.end('not found'); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ rebindMode, queries: Object.fromEntries(queryCounts) }));
}).listen(8053, '127.0.0.1');

console.log('deterministic DNS fixture ready on UDP/TCP 53');
