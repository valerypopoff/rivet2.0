import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'rivet-proxy-dns-'));
const network = `rivet-proxy-dns-${process.pid}-${Date.now()}`;
const containers = new Set();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const createDockerNetwork = (subnet, gateway) => {
  const result = spawnSync(
    'docker',
    ['network', 'create', '--driver', 'bridge', '--subnet', subnet, '--gateway', gateway, network],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(result.stderr || `docker network create exited with ${result.status}.`);
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout.trim();
};
const remove = (name) => {
  docker('rm', '-f', name);
  containers.delete(name);
};
async function until(label, check, timeout = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      if (await check()) {
        console.log(`${label}: ${Date.now() - start}ms`);
        return;
      }
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new Error(`${label} timed out: ${last ?? 'condition not met'}`);
}

function fixtureSubnetCandidates() {
  // Docker only accepts `--ip` on a network whose IPAM configuration declares
  // a subnet. Spread attempts across the private 172.16.0.0/12 range so an
  // existing Docker network cannot make this disposable fixture flaky.
  const seed = Number(process.hrtime.bigint() % 4096n);
  return Array.from({ length: 64 }, (_, attempt) => {
    const index = (seed + attempt * 733) % 4096;
    return `172.${16 + Math.floor(index / 256)}.${index % 256}.0/24`;
  });
}

function createFixtureNetwork() {
  let overlapError;
  for (const subnet of fixtureSubnetCandidates()) {
    const prefix = subnet.slice(0, -5);
    const gateway = `${prefix}.1`;
    try {
      createDockerNetwork(subnet, gateway);
      const [details] = JSON.parse(docker('network', 'inspect', network));
      assert.equal(details.IPAM.Config.length, 1, 'Fixture network must have one IPAM configuration.');
      assert.equal(details.IPAM.Config[0].Subnet, subnet, 'Fixture network must retain its explicit subnet.');
      assert.equal(details.IPAM.Config[0].Gateway, gateway, 'Fixture network must retain its explicit gateway.');
      return { prefix, subnet };
    } catch (error) {
      if (!/pool overlaps with other one on this address space/i.test(String(error.stderr ?? error.message))) {
        throw error;
      }
      overlapError = error;
    }
  }
  throw new Error(`Could not allocate an isolated Docker subnet after 64 attempts: ${overlapError?.message ?? 'unknown error'}`);
}

const templates = [
  ['dev', 'deploy/studio-server/compose/nginx/default.dev.conf.template', 80, 5174],
  ['compose', 'deploy/studio-server/compose/nginx/default.conf.template', 80, 3000],
  ['image', 'deploy/studio-server/images/proxy/default.conf.template', 8080, 3000],
];
try {
  const { prefix, subnet } = createFixtureNetwork();
  console.log(`Using isolated Docker subnet ${subnet}.`);
  await writeFile(path.join(fixture, 'empty.inc'), '');
  // One worker guarantees each request uses the DNS cache warmed before the
  // replacement, instead of accidentally succeeding through a fresh worker.
  await writeFile(
    path.join(fixture, 'nginx.conf'),
    'worker_processes 1;\nerror_log /dev/stderr notice;\nevents {}\nhttp { include /etc/nginx/conf.d/default.conf; }\n',
  );
  await writeFile(
    path.join(fixture, 'mock.mjs'),
    await readFile(path.join(root, 'deploy/studio-server/scripts/fixtures/proxy-dns-upstream.mjs')),
  );
  await writeFile(
    path.join(fixture, 'health.sh'),
    (await readFile(path.join(root, 'deploy/studio-server/images/proxy/healthcheck-dev.sh'), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    ),
  );
  for (const [variant, template, proxyPort, webPort] of templates) {
    const values = {
      RIVET_PROXY_RESOLVER: '127.0.0.11',
      RIVET_TRUST_INCOMING_FORWARDED_HEADERS: '0',
      RIVET_PROXY_AUTH_TOKEN: 'fixture-secret',
      RIVET_TRUSTED_HOSTS_INCLUDE_FILE: '/fixture/empty.inc',
      RIVET_PROXY_TIMEOUT_INCLUDE_FILE: '/fixture/empty.inc',
      RIVET_PUBLIC_ROUTES_INCLUDE_FILE: '/fixture/empty.inc',
      RIVET_API_UPSTREAM_HOST: 'api',
      RIVET_API_UPSTREAM_PORT: '80',
      RIVET_EXECUTION_UPSTREAM_HOST: 'api',
      RIVET_EXECUTION_UPSTREAM_PORT: '80',
      RIVET_WEB_UPSTREAM_HOST: 'web',
      RIVET_WEB_UPSTREAM_PORT: String(webPort),
      RIVET_EXECUTOR_UPSTREAM_HOST: 'executor',
      RIVET_EXECUTOR_UPSTREAM_PORT: '21889',
    };
    const rendered = (await readFile(path.join(root, template), 'utf8')).replace(/\$\{(RIVET_[A-Z_]+)\}/g, (_, key) => {
      assert.ok(key in values, `Unresolved ${key}`);
      return values[key];
    });
    await writeFile(path.join(fixture, 'default.conf'), rendered);
    const startMock = (role, generation, host) => {
      const name = `${network}-${role}-${generation}`;
      containers.add(name);
      docker(
        'run',
        '-d',
        '--name',
        name,
        '--network',
        network,
        '--network-alias',
        role,
        '--ip',
        `${prefix}.${host}`,
        '-v',
        `${fixture}:/fixture:ro`,
        '-e',
        `ROLE=${role}`,
        '-e',
        `IDENTITY=${role}-${generation}`,
        '-e',
        `PORT=${role === 'api' ? 80 : role === 'web' ? webPort : 21889}`,
        'node:20-alpine',
        'node',
        '/fixture/mock.mjs',
      );
      return name;
    };
    let api = startMock('api', 1, 200);
    let web = startMock('web', 1, 201);
    const executor = startMock('executor', 1, 202);
    const proxy = `${network}-proxy`;
    containers.add(proxy);
    docker(
      'run',
      '-d',
      '--name',
      proxy,
      '--network',
      network,
      '-p',
      `127.0.0.1::${proxyPort}`,
      '--entrypoint',
      'nginx',
      '-v',
      `${fixture}:/fixture:ro`,
      '-v',
      `${path.join(fixture, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      '-e',
      `RIVET_HEALTH_PROXY_URL=http://127.0.0.1:${proxyPort}/`,
      '-e',
      `RIVET_HEALTH_WEB_URL=http://web:${webPort}/`,
      '--health-cmd',
      'sh /fixture/health.sh',
      '--health-interval',
      '2s',
      '--health-timeout',
      '12s',
      '--health-retries',
      '2',
      'nginx:alpine',
      '-c',
      '/fixture/nginx.conf',
      '-g',
      'daemon off;',
    );
    const binding = docker('port', proxy, String(proxyPort)).split('\n')[0];
    const base = `http://${binding}`;
    const request = (route, options = {}) =>
      fetch(`${base}${route}`, {
        headers: { cookie: 'fixture-auth=yes' },
        signal: AbortSignal.timeout(2500),
        redirect: 'manual',
        ...options,
      });
    const health = () => JSON.parse(docker('inspect', proxy))[0].State.Health.Status;
    await until(`${variant} startup`, async () => (await request('/')).status === 200 && health() === 'healthy');
    assert.equal(await (await request('/', { headers: {} })).text(), 'Fixture login');
    for (const route of ['/api/echo?x=a%2Fb&x=two', '/__rivet_auth/nested/callback?code=a%2Bb']) {
      const response = await request(route, { method: 'POST', body: 'unchanged body' });
      const data = await response.json();
      assert.equal(data.url, route.replace('/__rivet_auth/', '/ui-auth/'));
      assert.equal(data.body, 'unchanged body');
      assert.equal(data.method, 'POST');
    }
    const authority = variant === 'dev' ? 'http://api' : 'http://api:80';
    const redirected = await request(
      `/__rivet_auth/redirect?to=${encodeURIComponent(`${authority}/ui-auth/nested?x=1`)}`,
    );
    assert.equal(redirected.status, 302);
    assert.equal(new URL(redirected.headers.get('location'), base).pathname, '/__rivet_auth/nested');
    assert.equal(new URL(redirected.headers.get('location'), base).search, '?x=1');
    const relative = await request('/__rivet_auth/redirect?to=%2Fsomewhere%3Fx%3D1');
    assert.equal(relative.headers.get('location'), '/somewhere?x=1');
    const stream = await request('/api/workflows/tree/events');
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: api-1/);
    await reader.cancel();
    for (const route of ['/ws/latest-debugger', '/ws/executor', '/ws/executor/internal']) {
      await new Promise((resolve, reject) => {
        const req = http.get(`${base}${route}`, {
          headers: {
            Cookie: 'fixture-auth=yes',
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
          },
        });
        req.setTimeout(2500, () => req.destroy(new Error('Upgrade timeout')));
        req.on('error', reject);
        req.on('response', (res) => {
          res.resume();
          reject(new Error(`Upgrade failed: ${res.statusCode}`));
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          assert.equal(res.statusCode, 101);
          resolve();
        });
      });
    }
    remove(api);
    await until(`${variant} API outage health`, () => health() === 'unhealthy');
    api = startMock('api', 2, 210);
    await until(
      `${variant} API address recovery`,
      async () => (await (await request('/api/echo')).json()).identity === 'api-2',
    );
    await until(`${variant} API health recovery`, () => health() === 'healthy');
    // Warm the web cache immediately before replacing that address too.
    assert.equal((await (await request('/')).json()).identity, 'web-1');
    remove(web);
    await until(`${variant} web outage health (login still available)`, () => health() === 'unhealthy');
    web = startMock('web', 2, 211);
    await until(
      `${variant} web address recovery`,
      async () => (await (await request('/')).json()).identity === 'web-2',
    );
    await until(`${variant} web health recovery`, () => health() === 'healthy');
    assert.equal(JSON.parse(docker('inspect', proxy))[0].RestartCount, 0);
    const logs = spawnSync('docker', ['logs', proxy], { encoding: 'utf8', timeout: 10000 });
    assert.equal(logs.status, 0);
    assert.doesNotMatch(logs.stdout + logs.stderr, /reconfiguring/);
    for (const name of [proxy, api, web, executor]) remove(name);
    console.log(`${variant}: routing, auth, streams, upgrades and DNS recovery passed`);
  }
} finally {
  for (const name of containers) {
    try {
      remove(name);
    } catch {}
  }
  try {
    docker('network', 'rm', network);
  } catch {}
  await rm(fixture, { recursive: true, force: true });
}
