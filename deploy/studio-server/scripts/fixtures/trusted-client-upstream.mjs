import http from 'node:http';
import { createHash } from 'node:crypto';
import { createHostedClientAuthorizer } from '/source/clientAuthorization.mts';

// Controlled identity provider; the executor checker is the production module.
const token = createHash('sha256').update('fixture-key:proxy-auth').digest('hex');
let trusted = true;
const allowed = (req) => req.headers['x-rivet-proxy-auth'] === token &&
  (req.headers.cookie === 'fixture-session=valid' ||
    (trusted && req.headers['x-rivet-client-ip'] === process.env.CLIENT_IP));
const authorize = createHostedClientAuthorizer({
  url: new URL('http://127.0.0.1/ui-auth/check'),
  getProxyToken: () => token,
});
const server = http.createServer((req, res) => {
  if (req.url === '/fixture/revoke' || req.url === '/fixture/allow') {
    trusted = req.url === '/fixture/allow';
    res.end('updated');
  } else if (req.url === '/ui-auth/check') {
    res.writeHead(allowed(req) ? 204 : 403).end();
  } else if (req.url === '/ui-auth/prompt') {
    res.writeHead(403).end();
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.headers));
  }
});
server.on('upgrade', async (req, socket) => {
  if (!await authorize(req)) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const timer = setInterval(async () => {
    if (!await authorize(req)) socket.destroy();
  }, 100);
  socket.once('close', () => clearInterval(timer));
});
// The three production templates use different service ports.
for (const port of [80, 3000, 5174, 8080, 21889]) {
  const listener = port === 80 ? server : http.createServer(server.listeners('request')[0]);
  if (listener !== server) listener.on('upgrade', server.listeners('upgrade')[0]);
  listener.listen(port, '0.0.0.0');
}
