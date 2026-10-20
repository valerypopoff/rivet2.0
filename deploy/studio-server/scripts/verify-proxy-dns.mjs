import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProxyDnsFixture } from './fixtures/proxy-dns-cleanup.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'rivet-proxy-dns-'));
const network = `rivet-proxy-dns-${process.pid}-${Date.now()}`;
const containers = new Set();
let networkId;
let failure;
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

async function verifyUpgrades(base, identity) {
  for (const [route, upstreamPath] of [
    ['/ws/latest-debugger', '/ws/latest-debugger'],
    ['/ws/executor', '/'],
    ['/ws/executor/internal', '/internal'],
  ]) {
    const response = await new Promise((resolve, reject) => {
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
        resolve(res);
      });
    });
    assert.equal(response.statusCode, 101);
    assert.equal(response.headers['x-fixture-path'], upstreamPath, `${route} must retain its upstream path`);
    assert.equal(response.headers['x-fixture-identity'], identity, `${route} must reach the current backend`);
  }
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
      networkId = createDockerNetwork(subnet, gateway);
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
  throw new Error(
    `Could not allocate an isolated Docker subnet after 64 attempts: ${overlapError?.message ?? 'unknown error'}`,
  );
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
  await writeFile(
    path.join(fixture, 'public-routes.inc'),
    `location /workflows/fixture {
    proxy_pass $execution_upstream;
    proxy_set_header X-Rivet-Proxy-Auth fixture-secret;
    proxy_set_header Host $rivet_request_host;
}`,
  );
  // The production bootstrap generates this include before nginx renders a
  // template. The DNS fixture bypasses that bootstrap, but templates still
  // require its variables even when no forwarding peers are configured.
  await writeFile(
    path.join(fixture, 'client-address.inc'),
    `real_ip_header X-Forwarded-For;
real_ip_recursive on;
geo $remote_addr $rivet_resolved_forwarding_peer {
    default 0;
}
map $rivet_resolved_forwarding_peer $rivet_client_ip {
    default "";
    0 $remote_addr;
}
`,
  );
  // One worker guarantees each request uses the DNS cache warmed before the
  // replacement, instead of accidentally succeeding through a fresh worker.
  await writeFile(
    path.join(fixture, 'nginx.conf'),
    `worker_processes 1;
error_log /dev/stderr notice;
events {}
http {
    log_format fixture 'fixture-worker=$pid status=$status path=$uri';
    access_log /dev/stdout fixture;
    include /etc/nginx/conf.d/default.conf;
}
`,
  );
  await writeFile(
    path.join(fixture, 'mock.mjs'),
    await readFile(path.join(root, 'deploy/studio-server/scripts/fixtures/proxy-dns-upstream.mjs')),
  );
  await writeFile(
    path.join(fixture, 'dns.mjs'),
    await readFile(path.join(root, 'deploy/studio-server/scripts/fixtures/proxy-dns-resolver.mjs')),
  );
  await writeFile(
    path.join(fixture, 'health.sh'),
    (await readFile(path.join(root, 'deploy/studio-server/images/proxy/healthcheck-dev.sh'), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    ),
  );
  for (const [variant, template, proxyPort, webPort] of templates) {
    const dnsName = `${network}-dns`;
    containers.add(dnsName);
    docker(
      'run',
      '-d',
      '--name',
      dnsName,
      '--network',
      network,
      '--ip',
      `${prefix}.53`,
      '-p',
      '127.0.0.1::8053',
      '-v',
      `${fixture}:/fixture:ro`,
      '-e',
      `DNS_API_IP=${prefix}.200`,
      '-e',
      `DNS_WEB_IP=${prefix}.201`,
      '-e',
      `DNS_EXECUTION_IP=${prefix}.202`,
      'node:20-alpine',
      'node',
      '/fixture/dns.mjs',
    );
    const dnsUrl = `http://${docker('port', dnsName, '8053').split('\n')[0]}`;
    const dnsControl = async (mode, addresses) => {
      const response = await fetch(dnsUrl, {
        method: 'POST',
        body: JSON.stringify({ mode, addresses }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    await until(`${variant} fixture DNS startup`, async () => (await dnsControl('healthy')).mode === 'healthy');
    const values = {
      RIVET_PROXY_RESOLVER: `${prefix}.53`,
      RIVET_PROXY_INTERNAL_LISTEN: String(proxyPort),
      RIVET_TRUST_INCOMING_FORWARDED_HEADERS: '0',
      RIVET_PROXY_AUTH_TOKEN: 'fixture-secret',
      RIVET_PROXY_HEALTH_UPSTREAM: 'http://rivet_api',
      RIVET_TRUSTED_HOSTS_INCLUDE_FILE: '/fixture/empty.inc',
      RIVET_CLIENT_ADDRESS_INCLUDE_FILE: '/fixture/client-address.inc',
      RIVET_PROXY_TIMEOUT_INCLUDE_FILE: '/fixture/empty.inc',
      RIVET_PUBLIC_ROUTES_INCLUDE_FILE: '/fixture/public-routes.inc',
      RIVET_API_UPSTREAM_HOST: 'api',
      RIVET_API_UPSTREAM_PORT: '80',
      RIVET_EXECUTION_UPSTREAM_HOST: 'execution',
      RIVET_EXECUTION_UPSTREAM_PORT: '80',
      RIVET_WEB_UPSTREAM_HOST: 'web',
      RIVET_WEB_UPSTREAM_PORT: String(webPort),
      RIVET_EXECUTOR_UPSTREAM_HOST: 'api',
      RIVET_EXECUTOR_UPSTREAM_PORT: '21889',
    };
    const rendered = (await readFile(path.join(root, template), 'utf8'))
      .replace(/\$\{(RIVET_[A-Z_]+)\}/g, (_, key) => {
        assert.ok(key in values, `Unresolved ${key}`);
        return values[key];
      })
      .replace('resolver 127.0.0.11 ', `resolver ${prefix}.53 `);
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
        `ROLE=${role === 'execution' ? 'api' : role}`,
        '-e',
        `IDENTITY=${role}-${generation}`,
        '-e',
        `PORT=${role === 'web' ? webPort : 80}`,
        ...(role === 'api' ? ['-e', 'SECONDARY_PORT=21889'] : []),
        'node:20-alpine',
        'node',
        '/fixture/mock.mjs',
      );
      return name;
    };
    let api = startMock('api', 1, 200);
    let web = startMock('web', 1, 201);
    let execution = variant === 'image' ? startMock('execution', 1, 202) : null;
    let executionPosts = 0;
    const proxy = `${network}-proxy`;
    const startProxy = (name) => {
      containers.add(name);
      docker(
        'run',
        '-d',
        '--name',
        name,
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
        // Match the pinned production and compatibility proxy version.
        'nginx:1.27.5-alpine',
        '-c',
        '/fixture/nginx.conf',
        '-g',
        'daemon off;',
      );
      return `http://${docker('port', name, String(proxyPort)).split('\n')[0]}`;
    };
    const base = startProxy(proxy);
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
    // A frontend fallback or login page must never certify API readiness.
    // Exercise public health routes without an operator session through real nginx.
    for (const route of ['/readyz', '/livez', '/healthz']) {
      const response = await request(route, { headers: {} });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('content-type') ?? '',
        /application\/json/,
        `${variant} ${route} must reach the API, not the UI`,
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(JSON.parse(body), {
        identity: 'api-1',
        ok: true,
        state: 'ready',
        profile: 'control',
        checks: [],
      });
      const head = await request(route, { method: 'HEAD', headers: {} });
      assert.equal(head.status, 200, `${variant} ${route} must support bodyless HEAD probes`);
      assert.equal(head.headers.get('cache-control'), 'no-store');
      assert.equal(await head.text(), '');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const blocked = await request(route, { method, headers: {}, body: 'must not reach the API' });
        await blocked.body?.cancel();
        assert.equal(blocked.status, 405, `${variant} ${route} must reject ${method} before forwarding`);
        assert.equal(blocked.headers.get('allow'), 'GET, HEAD');
      }
    }
    const unready = await request('/readyz?unready=1', { headers: {} });
    assert.equal(unready.status, 503, `${variant} must preserve API readiness failure`);
    assert.equal(unready.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await unready.json(), {
      identity: 'api-1',
      ok: false,
      state: 'ready',
      profile: 'control',
      code: 'dependency_unavailable',
      checks: [{ ok: false, code: 'workflow_storage_unavailable' }],
    });
    const unreadyHead = await request('/readyz?unready=1', { method: 'HEAD', headers: {} });
    assert.equal(unreadyHead.status, 503);
    assert.equal(await unreadyHead.text(), '');
    const anonymousApi = await request('/api/echo', { headers: {} });
    assert.equal(anonymousApi.status, 200);
    assert.equal(
      await anonymousApi.text(),
      'Fixture login',
      `${variant} public health routes must not bypass operator API authentication`,
    );
    for (const route of ['/readyz-extra', '/readyz/nested']) {
      assert.equal(
        (await (await request(route)).json()).identity,
        'web-1',
        `${variant} must not broaden health routing`,
      );
    }
    // Exercise actual nginx forwarding, not template text. Operator Origin
    // checks need the exact browser authority, including ports and IPv6.
    for (const authority of ['localhost:8081', '[::1]:8081', 'example.test']) {
      for (const route of ['/api/echo', '/__rivet_auth/nested/callback', '/']) {
        // Node fetch can replace a supplied Host header with the URL host.
        // Native HTTP sends the exact authority we intend to exercise.
        const response = await new Promise((resolve, reject) => {
          const req = http.request(
            `${base}${route}`,
            {
              method: 'POST',
              headers: { Cookie: 'fixture-auth=yes', Host: authority, Origin: `http://${authority}` },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('error', reject);
              res.on('end', () => {
                try {
                  resolve({ status: res.statusCode, body: JSON.parse(body) });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.setTimeout(2500, () => req.destroy(new Error('Authority probe timeout')));
          req.on('error', reject);
          req.end('generated fixture body');
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.host, authority, `${variant} must preserve ${route} authority`);
      }
    }
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
    if (variant !== 'compose') {
      const anonymousBuild = await request('/__rivet_dev/events', { headers: {} });
      assert.equal(await anonymousBuild.text(), 'Fixture login', `${variant} development events require UI auth`);
      const build = await request('/__rivet_dev/events', { signal: AbortSignal.timeout(3000) });
      const buildReader = build.body.getReader();
      assert.match(new TextDecoder().decode((await buildReader.read()).value), /data: web-1/);
      await buildReader.cancel();
    }
    await verifyUpgrades(base, 'api-1');
    // This is a DNS outage, not a backend outage. Keep known API/web addresses
    // alive and exceed the real 30-second resolver validity without retrying a
    // single failed request. Include a negative control with the old routing.
    let legacy;
    let legacyBase;
    let reloadProxy;
    let reloadBase;
    if (variant === 'image') {
      reloadProxy = `${network}-reload`;
      reloadBase = startProxy(reloadProxy);
      await until('reload proxy warmup', async () => (await fetch(`${reloadBase}/readyz`)).status === 200);
      await writeFile(
        path.join(fixture, 'legacy.conf'),
        `worker_processes 1;
events {} http { resolver ${prefix}.53 valid=1s ipv6=off; resolver_timeout 1s;
server { listen 8080; location / { set $target http://api:80; proxy_pass $target;
proxy_set_header X-Rivet-Proxy-Auth fixture-secret; } } }`,
      );
      legacy = `${network}-legacy`;
      containers.add(legacy);
      docker(
        'run',
        '-d',
        '--name',
        legacy,
        '--network',
        network,
        '-p',
        '127.0.0.1::8080',
        '-v',
        `${fixture}:/fixture:ro`,
        '--entrypoint',
        'nginx',
        'nginx:1.27.5-alpine',
        '-c',
        '/fixture/legacy.conf',
        '-g',
        'daemon off;',
      );
      legacyBase = `http://${docker('port', legacy, '8080').split('\n')[0]}`;
      await until(
        'legacy DNS negative control warmup',
        async () => (await fetch(`${legacyBase}/api/echo`)).status === 200,
      );
    }
    for (const mode of variant === 'image' ? ['refused', 'servfail', 'drop'] : ['refused']) {
      const before = await dnsControl(mode);
      const end = Date.now() + 35_000;
      let samples = 0;
      try {
        while (Date.now() < end) {
          const echo = await request('/api/echo?dns=outage', { method: 'POST', body: 'one unchanged POST' });
          assert.equal(echo.status, 200, `${variant} ${mode}: API failed during DNS outage`);
          const payload = await echo.json();
          assert.equal(payload.body, 'one unchanged POST');
          assert.equal(payload.identity, 'api-1');
          const ready = await request('/readyz', { headers: {} });
          assert.equal(ready.status, 200, `${variant} ${mode}: readiness lost on DNS outage`);
          await ready.body.cancel();
          const web = await request('/');
          assert.equal(web.status, 200, `${variant} ${mode}: web failed during DNS outage`);
          assert.equal((await web.json()).identity, 'web-1');
          if (execution) {
            const response = await request('/workflows/fixture?query=unchanged', {
              method: 'POST',
              body: 'accepted once',
            });
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.equal(result.identity, 'execution-1');
            assert.equal(result.body, 'accepted once');
            assert.equal(result.acceptedPosts, ++executionPosts, 'accepted workflow POST must not be replayed');
          }
          samples++;
          await delay(500);
        }
        if (mode === 'refused' && legacyBase) {
          const response = await fetch(`${legacyBase}/api/echo`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 502, 'old request-time DNS routing must fail the same outage');
          await response.body.cancel();
          // Startup/route refresh may reload nginx. Its resolved peer set must
          // survive that reload, not turn a warm proxy into a cold one.
          const beforeReload = spawnSync('docker', ['logs', reloadProxy], { encoding: 'utf8', timeout: 10000 });
          assert.equal(beforeReload.status, 0);
          const oldWorker = /start worker process (\d+)/.exec(beforeReload.stderr)?.[1];
          assert.ok(oldWorker, 'reload fixture must record its original worker');
          docker('kill', '--signal=HUP', reloadProxy);
          for (let sample = 0; sample < 10; sample++) {
            const ready = await fetch(`${reloadBase}/readyz`, { signal: AbortSignal.timeout(2500) });
            assert.equal(ready.status, 200, 'reload must retain known peers during DNS outage');
            await ready.body.cancel();
            await delay(500);
          }
          const reloadLogs = spawnSync('docker', ['logs', reloadProxy], { encoding: 'utf8', timeout: 10000 });
          assert.equal(reloadLogs.status, 0);
          assert.match(reloadLogs.stdout + reloadLogs.stderr, /reconfiguring/);
          const newWorker = [...reloadLogs.stderr.matchAll(/start worker process (\d+)/g)].at(-1)?.[1];
          assert.ok(newWorker && newWorker !== oldWorker, 'reload must start a new worker');
          assert.match(
            reloadLogs.stdout,
            new RegExp(`fixture-worker=${newWorker} status=200 path=/readyz`),
            'a new worker, not just the draining old one, must serve readiness during the DNS outage',
          );
          remove(reloadProxy);
          const cold = `${network}-cold`;
          const coldBase = startProxy(cold);
          await until('cold proxy cannot claim readiness without a DNS answer', async () => {
            const response = await fetch(`${coldBase}/readyz`, { signal: AbortSignal.timeout(2500) });
            await response.body.cancel();
            return response.status === 502;
          });
          // The browser starts only after DNS has been unavailable beyond TTL.
          execFileSync(
            process.execPath,
            [
              path.join(root, '.yarn/releases/yarn-4.17.1.cjs'),
              'studio-server:ui:observe',
              'proxy-dns-availability.spec.ts',
            ],
            {
              cwd: root,
              stdio: 'inherit',
              timeout: 180_000,
              env: {
                ...process.env,
                PLAYWRIGHT_HEADLESS: '1',
                PLAYWRIGHT_SLOW_MO: '0',
                PLAYWRIGHT_BASE_URL: base,
                RIVET_PROXY_DNS_FIXTURE: '1',
              },
            },
          );
          await dnsControl('healthy');
          await until(
            'cold proxy recovers without restart',
            async () => (await fetch(`${coldBase}/readyz`)).status === 200,
          );
          assert.equal(JSON.parse(docker('inspect', cold))[0].RestartCount, 0);
          remove(cold);
        }
        const after = await (await fetch(dnsUrl)).json();
        if (mode !== 'refused') assert.ok(after.failures > before.failures, 'DNS failures must actually be exercised');
        console.log(`${variant}: ${mode} DNS outage exceeded TTL; ${samples} rounds, zero failed requests`);
      } finally {
        await dnsControl('healthy');
      }
    }
    if (legacy) remove(legacy);
    if (variant === 'image') {
      await dnsControl('nxdomain');
      await until('authoritative NXDOMAIN removes obsolete addresses', async () => {
        const response = await request('/readyz', { headers: {} });
        await response.body.cancel();
        return response.status === 502;
      });
      await dnsControl('healthy');
      await until(
        'DNS records recover after NXDOMAIN',
        async () => (await request('/readyz', { headers: {} })).status === 200,
      );
    }
    remove(api);
    await until(`${variant} API outage health`, () => health() === 'unhealthy');
    // Allow nginx's five-second upstream connect deadline to produce its error
    // response instead of aborting the client at the fixture's normal 2.5 seconds.
    const unavailableReady = await request('/readyz', { headers: {}, signal: AbortSignal.timeout(7_500) });
    await unavailableReady.body?.cancel();
    assert.ok(
      [502, 504].includes(unavailableReady.status),
      `${variant} must not serve SPA success while the API is down`,
    );
    api = startMock('api', 2, 210);
    await dnsControl('healthy', { api: `${prefix}.210` });
    await until(
      `${variant} API address recovery`,
      async () => (await (await request('/api/echo')).json()).identity === 'api-2',
    );
    await until(`${variant} API health recovery`, () => health() === 'healthy');
    assert.equal((await (await request('/readyz', { headers: {} })).json()).identity, 'api-2');
    await until(`${variant} debugger and executor address recovery`, async () => {
      await verifyUpgrades(base, 'api-2');
      return true;
    });
    if (execution) {
      remove(execution);
      execution = startMock('execution', 2, 212);
      await dnsControl('healthy', { execution: `${prefix}.212` });
      await until(
        'published execution address recovery',
        async () => (await (await request('/workflows/fixture')).json()).identity === 'execution-2',
      );
    }
    // Warm the web cache immediately before replacing that address too.
    assert.equal((await (await request('/')).json()).identity, 'web-1');
    remove(web);
    await until(`${variant} web outage health (login still available)`, () => health() === 'unhealthy');
    web = startMock('web', 2, 211);
    await dnsControl('healthy', { web: `${prefix}.211` });
    await until(
      `${variant} web address recovery`,
      async () => (await (await request('/')).json()).identity === 'web-2',
    );
    await until(`${variant} web health recovery`, () => health() === 'healthy');
    assert.equal(JSON.parse(docker('inspect', proxy))[0].RestartCount, 0);
    const logs = spawnSync('docker', ['logs', proxy], { encoding: 'utf8', timeout: 10000 });
    assert.equal(logs.status, 0);
    assert.doesNotMatch(logs.stdout + logs.stderr, /reconfiguring/);
    for (const name of [proxy, api, web, dnsName, execution].filter(Boolean)) remove(name);
    console.log(`${variant}: routing, auth, streams, upgrades and DNS recovery passed`);
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error('DNS verification failed', { cause: error });
} finally {
  await cleanupProxyDnsFixture({ containers, networkId, fixture, docker, failure });
}
