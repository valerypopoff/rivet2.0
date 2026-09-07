import http from 'node:http';
import { createHash } from 'node:crypto';

const role = process.env.ROLE;
const identity = process.env.IDENTITY;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (role === 'api' && req.headers['x-rivet-proxy-auth'] !== 'fixture-secret') {
    res.writeHead(403).end();
    return;
  }
  if (url.pathname === '/ui-auth/check') {
    res.writeHead(req.headers.cookie === 'fixture-auth=yes' ? 204 : 401).end();
    return;
  }
  if (url.pathname === '/ui-auth/prompt') {
    res.end('Fixture login');
    return;
  }
  if (url.pathname.endsWith('/redirect')) {
    res.writeHead(302, { Location: url.searchParams.get('to') }).end();
    return;
  }
  if (url.pathname === '/api/workflows/tree/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${identity}\n\n`);
    const timer = setTimeout(() => res.end(), 10000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ identity, url: req.url, method: req.method, body }));
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.end(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Fixture-Path: ${req.url}\r\n\r\n`,
  );
});
server.listen(Number(process.env.PORT), '0.0.0.0');
