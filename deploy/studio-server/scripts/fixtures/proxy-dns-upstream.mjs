import http from 'node:http';
import { createHash } from 'node:crypto';

const role = process.env.ROLE;
const identity = process.env.IDENTITY;
let acceptedPosts = 0;
const handleRequest = async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (role === 'web' && url.pathname === '/dns-availability') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><title>DNS availability fixture</title><button id="run">Run</button><pre id="output"></pre><script>document.querySelector("#run").onclick=async()=>{const r=await fetch("/api/echo",{method:"POST",body:"browser body"});document.querySelector("#output").textContent=await r.text();};</script>',
    );
    return;
  }
  if (role === 'api' && req.headers['x-rivet-proxy-auth'] !== 'fixture-secret') {
    res.writeHead(403).end();
    return;
  }
  if (['/readyz', '/livez', '/healthz'].includes(url.pathname)) {
    if (role !== 'api') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Frontend fallback, not runtime readiness</title>');
      return;
    }
    const unavailable = url.pathname === '/readyz' && url.searchParams.get('unready') === '1';
    res.writeHead(unavailable ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        identity,
        ok: !unavailable,
        state: 'ready',
        profile: 'control',
        ...(unavailable
          ? { code: 'dependency_unavailable', checks: [{ ok: false, code: 'workflow_storage_unavailable' }] }
          : { checks: [] }),
      }),
    );
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
  if (url.pathname === '/api/workflows/tree/events' || url.pathname === '/__rivet_dev/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${identity}\n\n`);
    const timer = setTimeout(() => res.end(), 10000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method === 'POST') acceptedPosts++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ identity, url: req.url, method: req.method, body, host: req.headers.host, acceptedPosts }));
};
const handleUpgrade = (req, socket) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.end(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Fixture-Path: ${req.url}\r\nX-Fixture-Identity: ${identity}\r\n\r\n`,
  );
};
const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.listen(Number(process.env.PORT), '0.0.0.0');
if (process.env.SECONDARY_PORT) {
  const secondServer = http.createServer(handleRequest);
  secondServer.on('upgrade', handleUpgrade);
  secondServer.listen(Number(process.env.SECONDARY_PORT), '0.0.0.0');
}
