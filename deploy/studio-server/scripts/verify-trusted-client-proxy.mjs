import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolated network only: no published ports or changes to existing services.
const name = `rivet-client-trust-${randomUUID().slice(0, 8)}`;
const root = await mkdtemp(path.join(os.tmpdir(), 'rivet-client-trust-'));
const containers = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
try {
  docker('network', 'create', name);
  for (const role of ['client', 'edge']) {
    const id = `${name}-${role}`;
    docker('run', '-d', '--name', id, '--network', name, 'alpine:3.20', 'sleep', '600');
    containers.push(id);
  }
  const ip = (id) => JSON.parse(docker('inspect', id))[0].NetworkSettings.Networks[name].IPAddress;
  const client = ip(containers[0]);
  const edge = ip(containers[1]);
  await writeFile(path.join(root, 'nginx.conf'), `events {}\nhttp { include /tmp/client-address.inc; server { listen 8080; location / { return 200 "$rivet_client_ip"; } } }\n`);
  const proxy = `${name}-proxy`;
  docker('run', '-d', '--name', proxy, '--network', name,
    '-e', `RIVET_TRUSTED_FORWARDING_PROXIES=${edge}/32,192.0.2.200/32,2001:db8:ffff::/48`,
    '--mount', `type=bind,source=${path.resolve('deploy/studio-server/images/proxy/client-address.sh')},target=/client-address.sh,readonly`,
    '--mount', `type=bind,source=${root},target=/fixture,readonly`,
    '--entrypoint', '/bin/sh', 'nginx:1.27-alpine', '-c',
    '. /client-address.sh && write_client_address_include /tmp/client-address.inc && exec nginx -c /fixture/nginx.conf -g "daemon off;"');
  containers.push(proxy);
  const request = (from, headers = []) => docker('run', '--rm', '--network', `container:${from}`,
    'curlimages/curl:8.10.1', '-fsS', '--retry', '5', '--retry-connrefused', '--retry-delay', '1',
    ...headers.flatMap((header) => ['-H', header]), `http://${proxy}:8080/`);
  assert.equal(request(containers[0]), client);
  assert.equal(request(containers[0], ['Host: localhost', 'X-Forwarded-For: 127.0.0.1', 'X-Rivet-Client-IP: 127.0.0.1']), client);
  assert.equal(request(containers[1], [`X-Forwarded-For: ${client}`]), client);
  assert.equal(request(containers[1]), '');
  assert.equal(request(containers[1], ['X-Forwarded-For: malformed']), '');
  assert.equal(request(containers[1], [`X-Forwarded-For: 127.0.0.1, ${client}`]), client);
  assert.equal(request(containers[1], ['X-Forwarded-For: 192.0.2.200']), '');
  assert.equal(request(containers[1], ['X-Forwarded-For: 2001:db8:ffff::1']), '');
  assert.equal(request(containers[1], [`X-Forwarded-For: ${client}, 192.0.2.200`]), client);
  assert.equal(request(containers[1], ['X-Forwarded-For: 2001:db8:1234::1, 192.0.2.200']), '2001:db8:1234::1');
  console.log('PASS: real nginx preserved direct client identity, ignored spoofing, accepted the trusted edge, rejected missing/malformed provenance, and selected the nearest untrusted hop.');

  const fixtures = path.resolve('deploy/studio-server/scripts/fixtures');
  const upstream = `${name}-upstream`;
  docker('run', '-d', '--name', upstream, '--network', name,
    '--network-alias', 'api', '--network-alias', 'web', '--network-alias', 'executor',
    '-e', `CLIENT_IP=${client}`,
    '--mount', `type=bind,source=${fixtures},target=/fixture,readonly`,
    '--mount', `type=bind,source=${path.resolve('packages/studio-server-executor/src/clientAuthorization.mts')},target=/source/clientAuthorization.mts,readonly`,
    'node:24-alpine', 'node', '/fixture/trusted-client-upstream.mjs');
  containers.push(upstream);
  const templates = [
    'deploy/studio-server/images/proxy/default.conf.template',
    'deploy/studio-server/compose/nginx/default.conf.template',
    'deploy/studio-server/compose/nginx/default.dev.conf.template',
  ];
  for (const [index, template] of templates.entries()) {
    const fullProxy = `${name}-full-${index}`;
    containers.push(fullProxy);
    const port = index === 0 ? 8080 : 80;
    docker('run', '-d', '--name', fullProxy, '--network', name,
      '-e', 'RIVET_KEY=fixture-key', '-e', 'RIVET_PROXY_RESOLVER=127.0.0.11',
      '-e', `RIVET_TRUSTED_FORWARDING_PROXIES=${edge}/32`,
      ...['WEB', 'API', 'EXECUTION', 'EXECUTOR'].flatMap((service) => [
        '-e', `RIVET_${service}_UPSTREAM_HOST=${service === 'EXECUTION' ? 'api' : service.toLowerCase()}`,
        '-e', `RIVET_${service}_UPSTREAM_PORT=${service === 'EXECUTOR' ? 21889 : service === 'WEB' ? 3000 : 8080}`,
      ]),
      '--mount', `type=bind,source=${path.resolve('deploy/studio-server/images/proxy')},target=/opt/rivet/proxy,readonly`,
      '--mount', `type=bind,source=${path.resolve(template)},target=/etc/nginx/templates/default.conf.template,readonly`,
      '--entrypoint', '/bin/sh', 'nginx:1.27-alpine', '/opt/rivet/proxy/normalize-workflow-paths.sh');
    const inspect = docker('run', '--rm', '--network', `container:${containers[0]}`,
      'curlimages/curl:8.10.1', '-fsS', '--retry', '5', '--retry-connrefused', '--retry-delay', '1',
      '-H', 'X-Rivet-Client-IP: 127.0.0.1', '-H', 'X-Rivet-Token-Free-Host: 1',
      `http://${fullProxy}:${port}/api/inspect`);
    assert.equal(JSON.parse(inspect)['x-rivet-client-ip'], client);
    assert.equal(JSON.parse(inspect)['x-rivet-token-free-host'], undefined);
    docker('exec', fullProxy, 'nginx', '-t');
    const websocket = (from, endpoint, mode) => docker('run', '--rm', '--network', `container:${from}`,
      '--mount', `type=bind,source=${fixtures},target=/fixture,readonly`,
      'node:24-alpine', 'node', '/fixture/trusted-client-websocket.mjs',
      `http://${fullProxy}:${port}${endpoint}`, mode);
    for (const endpoint of ['/ws/executor', '/ws/executor/internal']) {
      console.log(websocket(containers[0], endpoint, 'trusted'));
      console.log(websocket(containers[1], endpoint, 'cookie'));
      console.log(websocket(containers[1], endpoint, 'deny'));
    }
    console.log(websocket(containers[0], '/ws/executor', 'revoke'));
    console.log(websocket(containers[0], '/ws/executor', 'deny'));
    console.log(websocket(containers[0], '/ws/executor', 'cookie'));
    docker('exec', upstream, 'node', '-e', "fetch('http://127.0.0.1/fixture/allow').then(r=>r.text()).then(console.log)");
    console.log(`PASS: complete ${template}, generated public routes, nginx -t, executor upgrades and revocation.`);
  }
} catch (error) {
  for (const container of containers) { try { console.error(docker('logs', container)); } catch { /* diagnostics only */ } }
  throw error;
} finally {
  for (const container of containers.reverse()) { try { docker('rm', '-f', container); } catch { /* best effort fixture cleanup */ } }
  try { docker('network', 'rm', name); } catch { /* best effort fixture cleanup */ }
  await rm(root, { recursive: true, force: true });
}
