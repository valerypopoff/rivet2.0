// Disposable DNS outage fixture, never part of a shipped image. Its control
// listener is published on loopback only by verify-proxy-dns.mjs.
import dgram from 'node:dgram';
import http from 'node:http';

let mode = 'healthy';
let addresses = { api: process.env.DNS_API_IP, web: process.env.DNS_WEB_IP, execution: process.env.DNS_EXECUTION_IP };
let queries = 0,
  failures = 0;
let dns;
const answerQuery = (packet, peer) => {
  queries++;
  if (mode === 'drop') {
    failures++;
    return;
  }
  let offset = 12;
  const labels = [];
  while (offset < packet.length && packet[offset]) {
    const length = packet[offset++];
    if (length > 63 || offset + length >= packet.length) return;
    labels.push(packet.subarray(offset, offset + length).toString('ascii'));
    offset += length;
  }
  offset++;
  if (offset + 4 > packet.length) return;
  const type = packet.readUInt16BE(offset);
  const question = packet.subarray(12, offset + 4);
  const ip = addresses[labels.join('.').toLowerCase()];
  const code = mode === 'servfail' ? 2 : mode === 'nxdomain' || !ip ? 3 : 0;
  if (code) failures++;
  const header = Buffer.alloc(12);
  packet.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180 | code, 2);
  header.writeUInt16BE(1, 4);
  const answer = code === 0 && type === 1 ? Buffer.alloc(16) : Buffer.alloc(0);
  if (answer.length) {
    header.writeUInt16BE(1, 6);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(1, 6);
    answer.writeUInt16BE(4, 10);
    ip.split('.').forEach((value, index) => {
      answer[12 + index] = Number(value);
    });
  }
  dns.send(Buffer.concat([header, question, answer]), peer.port, peer.address);
};
async function listen() {
  dns = dgram.createSocket('udp4');
  dns.on('message', answerQuery);
  await new Promise((resolve, reject) => {
    dns.once('error', reject);
    dns.bind(53, '0.0.0.0', resolve);
  });
}
await listen();
http
  .createServer(async (req, res) => {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const value = JSON.parse(body);
        if (!['healthy', 'drop', 'servfail', 'nxdomain', 'refused'].includes(value.mode)) throw Error('Invalid mode');
        if (mode === 'refused' && value.mode !== 'refused') await listen();
        if (mode !== 'refused' && value.mode === 'refused') await new Promise((resolve) => dns.close(resolve));
        mode = value.mode;
        if (value.addresses) addresses = { ...addresses, ...value.addresses };
      } catch {
        res.writeHead(400).end();
        return;
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mode, queries, failures }));
  })
  .listen(8053, '0.0.0.0');
