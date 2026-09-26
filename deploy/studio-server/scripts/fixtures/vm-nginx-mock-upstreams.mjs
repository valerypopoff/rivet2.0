import { createHash } from 'node:crypto';
import http from 'node:http';

const token = createHash('sha256').update('vm-nginx-fixture:proxy-auth').digest('hex');
const ports = JSON.parse(process.env.RIVET_VM_TLS_MOCK_PORTS);
if (!['web', 'api', 'execution', 'executor'].every((plane) => Number.isInteger(ports[plane]) && ports[plane] > 1023)) {
  throw new Error('Invalid VM TLS mock port configuration');
}

function createMock(plane) {
  const server = http.createServer((req, res) => {
    if (plane === 'api' && req.url === '/ui-auth/check') {
      res.writeHead(req.headers['x-rivet-proxy-auth'] === token ? 204 : 403);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ plane, path: req.url, headers: req.headers }));
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Mock-Plane: ${plane}\r\n\r\n`,
    );
    socket.end();
  });
  return server;
}

await Promise.all(
  Object.entries(ports).map(
    ([plane, port]) =>
      new Promise((resolve, reject) => {
        const server = createMock(plane);
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      }),
  ),
);
