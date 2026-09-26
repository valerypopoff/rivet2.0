import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import tls from 'node:tls';

const name = `rivet-vm-nginx-${randomUUID().slice(0, 8)}`;
const image = `rivet-vm-nginx-contract:${randomUUID().slice(0, 8)}`;
const token = createHash('sha256').update('vm-nginx-fixture:proxy-auth').digest('hex');
const redirectPort = process.env.RIVET_VM_TLS_FIXTURE_HTTPS_PORT ?? '443';
const mockPorts = { web: 3300, api: 3301, execution: 3302, executor: 3303 };
const publicHost = 'public.test';
// Exercise the longest DNS name accepted by the VM launcher, not just short fixture hosts.
const internalHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;

function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: args[0] === 'build' || args[0] === 'run' ? 180_000 : 15_000,
  }).trim();
}

function startupDiagnostics(containerName) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 };
  const state = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', containerName], options);
  const logs = spawnSync('docker', ['logs', '--tail', '50', containerName], options);
  return `Docker state: ${(state.stdout || state.stderr || 'unavailable').trim()}\nRecent container logs:\n${`${logs.stdout || ''}${logs.stderr || ''}`.trim().slice(-8000)}`;
}

async function chooseLoopbackPorts() {
  const listeners = [net.createServer(), net.createServer()];
  try {
    for (const listener of listeners) {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
    }
    return listeners.map((listener) => listener.address().port);
  } finally {
    await Promise.all(
      listeners.map(
        (listener) =>
          new Promise((resolve) => {
            if (listener.listening) listener.close(resolve);
            else resolve();
          }),
      ),
    );
  }
}

function request(port, host, requestPath, secure = false, headers = {}, timeoutMs = 5000) {
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
        timeout: timeoutMs,
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
    req.on('response', (res) => {
      res.destroy();
      reject(new Error(`Expected upgrade, got HTTP ${res.statusCode}`));
    });
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
    socket.setTimeout(5000, () => socket.destroy(new Error('VM gateway TLS negotiation timed out')));
    socket.on('error', reject);
  });
}

async function main() {
  const providedCert = process.env.RIVET_VM_TLS_FIXTURE_CERT;
  const providedKey = process.env.RIVET_VM_TLS_FIXTURE_KEY;
  if (Boolean(providedCert) !== Boolean(providedKey)) {
    throw new Error('RIVET_VM_TLS_FIXTURE_CERT and RIVET_VM_TLS_FIXTURE_KEY must be supplied together');
  }
  const temp = mkdtempSync(path.join(tmpdir(), 'rivet-vm-nginx-'));
  const networkName = `${name}-network`;
  const mockName = `${name}-mock`;
  try {
    const cert = path.join(temp, 'cert.pem');
    const key = path.join(temp, 'key.pem');
    if (providedCert && providedKey) {
      copyFileSync(providedCert, cert);
      copyFileSync(providedKey, key);
    } else {
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
        { stdio: 'ignore', timeout: 30_000 },
      );
    }
    // These copies exist only for the fixture. The temp directory remains
    // private on the host, while the non-root nginx process can read the bind mounts.
    chmodSync(cert, 0o644);
    chmodSync(key, 0o644);
    docker('build', '-f', 'deploy/studio-server/images/proxy/Dockerfile', '-t', image, '.');
    docker('network', 'create', networkName);
    docker(
      'run',
      '-d',
      '--name',
      mockName,
      '--network',
      networkName,
      '--network-alias',
      'mock',
      '--read-only',
      '--cap-drop',
      'ALL',
      '-e',
      `RIVET_VM_TLS_MOCK_PORTS=${JSON.stringify(mockPorts)}`,
      '-v',
      `${path.resolve('deploy/studio-server/scripts/fixtures/vm-nginx-mock-upstreams.mjs')}:/mock-upstreams.mjs:ro`,
      'node:24-alpine',
      'node',
      '/mock-upstreams.mjs',
    );
    const [httpPort, httpsPort] = await chooseLoopbackPorts();
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      networkName,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--tmpfs',
      '/tmp:rw,nosuid,noexec,size=512m,uid=10001,gid=10001',
      '-p',
      `127.0.0.1:${httpPort}:8080`,
      '-p',
      `127.0.0.1:${httpsPort}:8443`,
      '-e',
      'RIVET_PROXY_VM_TLS=1',
      '-e',
      `RIVET_PROXY_HTTPS_PORT=${redirectPort}`,
      '-e',
      `RIVET_PROXY_PUBLIC_HOST=${publicHost}`,
      '-e',
      `RIVET_PROXY_INTERNAL_HOST=${internalHost}`,
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
    for (const [plane, port] of Object.entries(mockPorts)) {
      args.push('-e', `RIVET_${plane.toUpperCase()}_UPSTREAM_HOST=mock`);
      args.push('-e', `RIVET_${plane.toUpperCase()}_UPSTREAM_PORT=${port}`);
    }
    docker(...args, image);
    let lastReadinessResult = 'no response';
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await request(httpPort, internalHost, '/api/echo', false, {}, 1000);
        if (response.status === 200) break;
        lastReadinessResult = `HTTP ${response.status}`;
      } catch (error) {
        lastReadinessResult = error instanceof Error ? error.message : String(error);
      }
      if (attempt % 5 === 4) {
        for (const containerName of [name, mockName]) {
          if (docker('inspect', '--format', '{{.State.Running}}', containerName) !== 'true') {
            throw new Error(
              `VM TLS fixture container exited. ${startupDiagnostics(name)}\n${startupDiagnostics(mockName)}`,
            );
          }
        }
      }
      if (attempt === 59) {
        throw new Error(
          `VM nginx gateway did not become ready (${lastReadinessResult}). ${startupDiagnostics(name)}\n${startupDiagnostics(mockName)}`,
        );
      }
      await delay(200);
    }
    const redirect = await request(httpPort, publicHost, '/sample?x=1');
    assert.equal(redirect.status, 301);
    assert.equal(
      redirect.headers.location,
      `https://${publicHost}${redirectPort === '443' ? '' : `:${redirectPort}`}/sample?x=1`,
    );
    assert.equal((await request(httpPort, 'unknown.test', '/')).status, 404);
    assert.equal((await request(httpsPort, internalHost, '/', true)).status, 404);
    assert.equal(await negotiatedProtocol(httpsPort, publicHost), 'h2');
    const api = await request(httpsPort, publicHost, '/api/echo', true, {
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
    assert.equal(echoed.headers['x-forwarded-host'], publicHost);
    assert.equal(
      JSON.parse((await request(httpsPort, publicHost, '/workflows/demo', true)).body).plane,
      'execution',
    );
    assert.equal(
      JSON.parse((await request(httpsPort, publicHost, '/workflows-latest/demo', true)).body).plane,
      'api',
    );
    assert.equal((await request(httpsPort, publicHost, '/internal/workflows/demo', true)).status, 404);
    assert.equal(await upgrade(httpsPort, publicHost, '/ws/executor/internal'), 'executor');
    console.log('PASS: VM nginx TLS, host routing, trusted headers, published/latest planes, and executor websocket.');
  } finally {
    for (const args of [
      ['rm', '-f', name],
      ['rm', '-f', mockName],
      ['network', 'rm', networkName],
      ['image', 'rm', image],
    ]) {
      try {
        docker(...args);
      } catch {
        /* the resource may not have been created */
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
