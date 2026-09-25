import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import tls from 'node:tls';

const name = `rivet-vm-nginx-${randomUUID().slice(0, 8)}`;
const image = `rivet-vm-nginx-contract:${randomUUID().slice(0, 8)}`;
const token = createHash('sha256').update('vm-nginx-fixture:proxy-auth').digest('hex');
const redirectPort = process.env.RIVET_VM_TLS_FIXTURE_HTTPS_PORT ?? '443';

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function request(port, host, requestPath, secure = false, headers = {}) {
  return new Promise((resolve, reject) => {
    const transport = secure ? https : http;
    const req = transport.request(
      {
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        servername: secure ? host : undefined,
        rejectUnauthorized: false,
        headers: { Host: host, ...headers },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('VM gateway request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function upgrade(port, host, requestPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      servername: host,
      rejectUnauthorized: false,
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    req.setTimeout(5000, () => req.destroy(new Error('VM gateway websocket timed out')));
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`Expected upgrade, got HTTP ${res.statusCode}`)));
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.headers['x-mock-plane']);
    });
    req.end();
  });
}

function negotiatedProtocol(port, host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername: host, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] },
      () => {
        const protocol = socket.alpnProtocol;
        socket.end();
        resolve(protocol);
      },
    );
    socket.on('error', reject);
  });
}

async function main() {
  const temp = mkdtempSync(path.join(tmpdir(), 'rivet-vm-nginx-'));
  const servers = {};
  let started = false;
  let built = false;
  try {
    const cert = process.env.RIVET_VM_TLS_FIXTURE_CERT || path.join(temp, 'cert.pem');
    const key = process.env.RIVET_VM_TLS_FIXTURE_KEY || path.join(temp, 'key.pem');
    if (!process.env.RIVET_VM_TLS_FIXTURE_CERT || !process.env.RIVET_VM_TLS_FIXTURE_KEY) {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=public.test',
        ],
        { stdio: 'ignore' },
      );
    }
    docker('build', '-f', 'deploy/studio-server/images/proxy/Dockerfile', '-t', image, '.');
    built = true;
    const mapping = docker(
      'run',
      '--rm',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--entrypoint',
      'sh',
      image,
      '-c',
      'grep host.docker.internal /etc/hosts',
    );
    const gateway = mapping.match(/^([0-9]+(?:\.[0-9]+){3})\s+host\.docker\.internal/m)?.[1];
    assert.ok(gateway, 'Docker host-gateway IPv4 address is unavailable');
    for (const plane of ['web', 'api', 'execution', 'executor']) {
      const server = createMock(plane);
      await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
      servers[plane] = { server, port: server.address().port };
    }
    const args = [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--tmpfs',
      '/tmp:rw,nosuid,noexec,size=512m,uid=10001,gid=10001',
      '-p',
      '127.0.0.1::8080',
      '-p',
      '127.0.0.1::8443',
      '-e',
      'RIVET_PROXY_VM_TLS=1',
      '-e',
      `RIVET_PROXY_HTTPS_PORT=${redirectPort}`,
      '-e',
      'RIVET_PROXY_PUBLIC_HOST=public.test',
      '-e',
      'RIVET_PROXY_INTERNAL_HOST=internal.test',
      '-e',
      'RIVET_PROXY_INTERNAL_LISTEN=127.0.0.1:18081',
      '-e',
      'RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true',
      '-e',
      'RIVET_TRUSTED_FORWARDING_PROXIES=127.0.0.1/32',
      '-e',
      'RIVET_KEY=vm-nginx-fixture',
      '-v',
      `${cert}:/run/rivet/tls/cert.pem:ro`,
      '-v',
      `${key}:/run/rivet/tls/key.pem:ro`,
      '-v',
      `${path.resolve('deploy/studio-server/images/proxy/vm-tls.conf.template')}:/etc/nginx/templates/vm-tls.conf.template:ro`,
    ];
    for (const plane of ['web', 'api', 'execution', 'executor']) {
      args.push('-e', `RIVET_${plane.toUpperCase()}_UPSTREAM_HOST=${gateway}`);
      args.push('-e', `RIVET_${plane.toUpperCase()}_UPSTREAM_PORT=${servers[plane].port}`);
    }
    docker(...args, image);
    started = true;
    const port = (target) => Number(docker('port', name, `${target}/tcp`).split(':').at(-1));
    const httpPort = port(8080);
    const httpsPort = port(8443);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await request(httpPort, 'internal.test', '/api/echo')).status === 200) break;
      } catch {
        /* waiting for nginx */
      }
      if (attempt === 59) throw new Error('VM nginx gateway did not become ready');
      await delay(200);
    }
    const redirect = await request(httpPort, 'public.test', '/sample?x=1');
    assert.equal(redirect.status, 301);
    assert.equal(
      redirect.headers.location,
      `https://public.test${redirectPort === '443' ? '' : `:${redirectPort}`}/sample?x=1`,
    );
    assert.equal((await request(httpPort, 'unknown.test', '/')).status, 404);
    assert.equal((await request(httpsPort, 'internal.test', '/', true)).status, 404);
    assert.equal(await negotiatedProtocol(httpsPort, 'public.test'), 'h2');
    const api = await request(httpsPort, 'public.test', '/api/echo', true, {
      'X-Rivet-Proxy-Auth': 'spoofed',
      'X-Rivet-Executor-Auth': 'spoofed',
      'X-Rivet-Client-IP': '1.2.3.4',
      'X-Rivet-Ui-Return-To': '/spoofed',
      'X-Forwarded-For': '1.2.3.4',
      'X-Forwarded-Port': '1234',
      Forwarded: 'for=1.2.3.4;proto=http',
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'spoofed.test',
    });
    assert.equal(api.status, 200);
    const echoed = JSON.parse(api.body);
    assert.equal(echoed.plane, 'api');
    assert.equal(echoed.headers['x-rivet-proxy-auth'], token);
    assert.equal(echoed.headers['x-rivet-executor-auth'], undefined);
    assert.equal(echoed.headers['x-rivet-ui-return-to'], undefined);
    assert.equal(echoed.headers['x-forwarded-port'], undefined);
    assert.equal(echoed.headers.forwarded, undefined);
    assert.notEqual(echoed.headers['x-rivet-client-ip'], '1.2.3.4');
    assert.equal(echoed.headers['x-forwarded-proto'], 'https');
    assert.equal(echoed.headers['x-forwarded-host'], 'public.test');
    assert.equal(
      JSON.parse((await request(httpsPort, 'public.test', '/workflows/demo', true)).body).plane,
      'execution',
    );
    assert.equal(
      JSON.parse((await request(httpsPort, 'public.test', '/workflows-latest/demo', true)).body).plane,
      'api',
    );
    assert.equal((await request(httpsPort, 'public.test', '/internal/workflows/demo', true)).status, 404);
    assert.equal(await upgrade(httpsPort, 'public.test', '/ws/executor/internal'), 'executor');
    console.log('PASS: VM nginx TLS, host routing, trusted headers, published/latest planes, and executor websocket.');
  } finally {
    if (started) {
      try {
        docker('stop', name);
      } catch {
        /* may already be stopped */
      }
    }
    if (built) {
      try {
        docker('image', 'rm', image);
      } catch {
        /* keep the original failure */
      }
    }
    await Promise.all(
      Object.values(servers).map(({ server }) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      }),
    );
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
