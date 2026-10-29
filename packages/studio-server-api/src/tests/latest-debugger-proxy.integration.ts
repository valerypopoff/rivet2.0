import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { extractBracedBlock, readRepoFile } from './helpers/repo-contract-helpers.js';

// Explicit opt-in integration command; never pulls an image or touches existing
// containers. Run with a locally built proxy image's immutable sha256 identity.
void test(
  'actual NGINX templates preserve scoped debugger and custom latest endpoint URIs',
  { timeout: 90_000 },
  async () => {
    const image = process.env.RIVET_DEBUGGER_PROXY_TEST_IMAGE;
    assert.match(
      image ?? '',
      /^sha256:[a-f0-9]{64}$/,
      'Set RIVET_DEBUGGER_PROXY_TEST_IMAGE to a cached proxy image ID',
    );
    const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    const label = randomUUID();
    const directory = mkdtempSync(path.join(tmpdir(), 'rivet-debugger-proxy-'));
    let container: string | undefined;
    let network: string | undefined;
    let upstream: string | undefined;
    let failure: unknown;
    const substitute = (text: string) =>
      text
        .replaceAll('${RIVET_PROXY_AUTH_TOKEN}', 'fixture-only')
        .replaceAll('${RIVET_LATEST_WORKFLOWS_BASE_PATH}', '/custom-latest')
        .replaceAll('include ${RIVET_PROXY_TIMEOUT_INCLUDE_FILE};', 'proxy_read_timeout 10s;')
        .replaceAll('\\$', '$');
    const endpoint = substitute(
      extractBracedBlock(
        readRepoFile('deploy/studio-server/images/proxy/normalize-workflow-paths.sh'),
        /    location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{/,
      ),
    );
    try {
      network = docker('network', 'create', '--label', `rivet.debugger.fixture=${label}`, `rivet-debugger-${label}`);
      assert.match(network, /^[a-f0-9]{64}$/);
      const nodeImage = docker(
        'image',
        'inspect',
        process.env.RIVET_DEBUGGER_PROXY_TEST_NODE_IMAGE ?? 'node:24-alpine',
        '--format',
        '{{.Id}}',
      );
      assert.match(nodeImage, /^sha256:[a-f0-9]{64}$/);
      const upstreamPath = path.join(directory, 'upstream.cjs');
      writeFileSync(
        upstreamPath,
        `
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ url: request.url, method: request.method, body: Buffer.concat(chunks).toString(), auth: request.headers['x-rivet-proxy-auth'] }));
});
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  const body = Buffer.from(JSON.stringify({ url: request.url, auth: request.headers['x-rivet-proxy-auth'] }));
  if (body.length >= 126) throw new Error('Fixture response is too large');
  socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
  socket.on('error', () => {});
});
server.listen(8081, '0.0.0.0');
`,
      );
      upstream = docker(
        'create',
        '--label',
        `rivet.debugger.fixture=${label}`,
        '--network',
        network,
        '--network-alias',
        'fixture-upstream',
        '--mount',
        `type=bind,source=${upstreamPath},target=/tmp/upstream.cjs,readonly`,
        '--entrypoint',
        'node',
        nodeImage,
        '/tmp/upstream.cjs',
      );
      assert.match(upstream, /^[a-f0-9]{64}$/);
      docker('start', upstream);
      for (const template of [
        'deploy/studio-server/images/proxy/default.conf.template',
        'deploy/studio-server/compose/nginx/default.conf.template',
        'deploy/studio-server/compose/nginx/default.dev.conf.template',
      ]) {
        const debuggerRoute = substitute(
          extractBracedBlock(readRepoFile(template), /    location \/ws\/latest-debugger \{/),
        );
        const configuration = `pid /tmp/debugger-nginx.pid;
error_log stderr warn;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  resolver 127.0.0.11;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  server {
    listen 8080;
    set $api_upstream http://fixture-upstream:8081;
    set $rivet_client_ip 127.0.0.1;
    set $rivet_request_host $host;
    set $rivet_forwarded_host $host;
    set $rivet_forwarded_proto $scheme;
    location = /__rivet_ui_auth_check {
      internal;
      if ($http_x_fixture_deny = 1) { return 401; }
      return 204;
    }
    ${debuggerRoute}
    ${endpoint}
  }
}`;
        const configurationPath = path.join(directory, 'nginx.conf');
        writeFileSync(configurationPath, configuration);
        container = docker(
          'create',
          '--label',
          `rivet.debugger.fixture=${label}`,
          '--entrypoint',
          'nginx',
          '--network',
          network,
          '--mount',
          `type=bind,source=${configurationPath},target=/tmp/fixture.conf,readonly`,
          '--publish',
          '127.0.0.1::8080',
          image!,
          '-c',
          '/tmp/fixture.conf',
          '-g',
          'daemon off;',
        );
        assert.match(container, /^[a-f0-9]{64}$/);
        docker('start', container);
        try {
          docker('exec', container, 'nginx', '-t', '-c', '/tmp/fixture.conf');
        } catch (error) {
          throw new Error(`NGINX fixture failed: ${docker('logs', container)}`, { cause: error });
        }
        const hostPort = docker('port', container, '8080/tcp').split(':').at(-1)!;
        const origin = `http://127.0.0.1:${hostPort}`;
        const deadline = Date.now() + 15_000;
        while (true) {
          try {
            const response = await fetch(`${origin}/custom-latest/ready`, { signal: AbortSignal.timeout(1000) });
            assert.equal(response.status, 200);
            break;
          } catch (error) {
            if (Date.now() >= deadline)
              throw new Error(
                `Proxy unavailable at ${origin}: ${String(error)}; ${String((error as Error).cause)}; ${docker('logs', container)}`,
                { cause: error },
              );
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        for (const uri of ['/ws/latest-debugger?keep=a%2Bb', '/ws/latest-debugger@00123?keep=a%2Bb&other=x']) {
          const client = new WebSocket(`${origin.replace('http:', 'ws:')}${uri}`);
          try {
            const [raw] = await once(client, 'message', { signal: AbortSignal.timeout(10_000) });
            assert.deepEqual(JSON.parse(raw.toString()), { url: uri, auth: 'fixture-only' }, template);
          } finally {
            client.terminate();
          }
          const denied = await fetch(`${origin}${uri}`, { headers: { 'X-Fixture-Deny': '1' } });
          assert.equal(denied.status, 401, `${template} must retain the UI authentication gate`);
        }
        const uri = '/custom-latest/endpoint@00123?keep=a%2Bb';
        const response = await fetch(`${origin}${uri}`, { method: 'POST', body: 'exact-body' });
        assert.deepEqual(await response.json(), { url: uri, method: 'POST', body: 'exact-body', auth: 'fixture-only' });
        assert.equal(
          docker('inspect', container, '--format', '{{index .Config.Labels "rivet.debugger.fixture"}}'),
          label,
        );
        docker('rm', '-f', container);
        container = undefined;
      }
    } catch (error) {
      failure = error;
      try {
        if (container) docker('logs', container);
      } catch {
        /* Keep the primary failure. */
      }
      throw error;
    } finally {
      const errors: unknown[] = [];
      const clean = (action: () => void) => {
        try {
          action();
        } catch (error) {
          errors.push(error);
        }
      };
      const proxyId = container,
        upstreamId = upstream,
        networkId = network;
      if (proxyId)
        clean(() => {
          assert.equal(
            docker('inspect', proxyId, '--format', '{{index .Config.Labels "rivet.debugger.fixture"}}'),
            label,
          );
          docker('rm', '-f', proxyId);
        });
      if (upstreamId)
        clean(() => {
          assert.equal(
            docker('inspect', upstreamId, '--format', '{{index .Config.Labels "rivet.debugger.fixture"}}'),
            label,
          );
          docker('rm', '-f', upstreamId);
        });
      if (networkId)
        clean(() => {
          assert.equal(
            docker('network', 'inspect', networkId, '--format', '{{index .Labels "rivet.debugger.fixture"}}'),
            label,
          );
          docker('network', 'rm', networkId);
        });
      clean(() => {
        assert.equal(path.dirname(directory), path.resolve(tmpdir()));
        rmSync(directory, { recursive: true, force: true });
      });
      if (errors.length)
        throw new AggregateError(failure ? [failure, ...errors] : errors, 'Debugger proxy fixture cleanup failed');
    }
  },
);
