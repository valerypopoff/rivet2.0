import assert from 'node:assert/strict';
import http from 'node:http';

const [url, mode] = process.argv.slice(2);
const headers = {
  Connection: 'Upgrade', Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  // The proxy must overwrite these, not forward the caller's claims.
  'X-Rivet-Proxy-Auth': 'forged', 'X-Rivet-Client-IP': '127.0.0.1',
  'X-Rivet-Token-Free-Host': '1',
  ...(mode === 'cookie' ? { Cookie: 'fixture-session=valid' } : {}),
};
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket fixture timed out')), 10_000);
  const request = http.get(url, { headers });
  request.on('error', reject);
  request.on('response', (res) => {
    clearTimeout(timer);
    res.resume();
    try { assert.equal(mode, 'deny'); assert.equal(res.statusCode, 403); resolve(); } catch (error) { reject(error); }
  });
  request.on('upgrade', async (res, socket) => {
    try {
      assert.notEqual(mode, 'deny');
      assert.equal(res.statusCode, 101);
      if (mode === 'revoke') {
        const closed = new Promise((done) => socket.once('close', done));
        socket.resume();
        await fetch('http://api/fixture/revoke', { method: 'POST' });
        await closed;
      }
      socket.destroy();
      clearTimeout(timer);
      resolve();
    } catch (error) { socket.destroy(); clearTimeout(timer); reject(error); }
  });
});
console.log('PASS websocket', mode, url);
