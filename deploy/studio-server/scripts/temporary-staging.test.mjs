import assert from 'node:assert/strict';
// test-style: fixture-read: Inspect generated private journals, isolated Git/Yarn fixtures and HTTP logs, never repository implementation text.
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { temporaryPlan } from './fixtures/temporary-staging-plan.mjs';
import { retainTemporaryFailure } from './temporary-staging.mjs';
import {
  temporaryAdmission,
  temporaryBinding,
  verifyTemporaryPlan,
  temporaryExpiry,
  temporaryHostname,
} from './lib/temporary-staging-contract.mjs';
import { temporaryAcmeServer } from './qualification/temporary-acme-server.mjs';
import {
  issueTemporaryCertificate,
  settleTemporaryCertificate,
  verifyTemporaryChallenge,
  temporaryAcmeHook,
  transientTemporaryChallengeError,
} from './lib/temporary-staging-certificate.mjs';
import { TemporaryStagingStore } from './lib/temporary-staging-store.mjs';
import {
  temporaryGcp,
  temporaryFoundationSpecs,
  assertTemporaryClusterNodeIdentity,
  cachedTemporaryToken,
  mintTemporaryToken,
} from './lib/temporary-staging-gcp.mjs';
import {
  verifyAnonymousStagingImage,
  stagingRegistryConfig,
  verifyPrivateStagingImages,
} from './lib/temporary-staging-images.mjs';
import { temporaryHash } from './lib/temporary-staging-contract.mjs';
import { prepareTemporaryActorContext } from './build-temporary-staging-actor.mjs';
import { actorSparsePatterns, verifyActorSource } from '../images/qualification/verify-source.mjs';
import { verifyOfflineTemporaryActor } from './lib/temporary-staging-actor.mjs';
import { installActorDependencies } from '../images/qualification/install-dependencies.mjs';
import {
  provisionTemporaryEnvironment,
  cleanupTemporaryEnvironment,
  inspectTemporaryEnvironment,
  runTemporaryQualification,
} from './lib/temporary-staging-lifecycle.mjs';
const { handler } = createRequire(import.meta.url)('../../../postman/mocks/temporary-gcp/contract.cjs');
const registryHandler = createRequire(import.meta.url)(
  '../../../postman/mocks/anonymous-registry/contract.cjs',
).handler;
const fixtureLock = async () => ({ close: async () => {} });
const cloudWrite = (request) =>
  request.method !== 'GET' &&
  !request.resource.endsWith(':testIamPermissions') &&
  !request.resource.endsWith(':getIamPolicy');
const ipPlan = (changes = {}) =>
  temporaryPlan({
    hostnameMode: 'ip-encoded-http01',
    domain: 'sslip.io',
    managedZone: null,
    certificateSha256: null,
    privateKeySha256: null,
    acme: {
      image: `certbot/certbot@sha256:${'1'.repeat(64)}`,
      termsUrl: 'https://letsencrypt.org/documents/test.pdf',
      subscriberTermsApproved: true,
      certificateIssuanceApproved: true,
    },
    ...changes,
  });
const wait = async (label, check) => {
  for (let i = 0; i < 4; i++) if (await check()) return;
  throw Error(`Local waiter blocked: ${label}`);
};

test('IP hostname admission is explicit and public HTTP serves only the current exact challenge', async (t) => {
  assert.equal(transientTemporaryChallengeError(new DOMException('cold start', 'TimeoutError')), true);
  assert.equal(
    transientTemporaryChallengeError(
      new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }) }),
    ),
    true,
  );
  assert.equal(transientTemporaryChallengeError(new TypeError('programming error')), false);
  assert.equal(transientTemporaryChallengeError(new Error('unexpected redirect')), false);
  const plan = ipPlan(),
    hostname = temporaryHostname(plan, '203.0.113.10');
  assert.equal(hostname, `${plan.operationId}.203-0-113-10.sslip.io`);
  assert.equal(temporaryHostname(temporaryPlan(), '203.0.113.10'), `${plan.operationId}.staging.example.net`);
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '224.0.0.1', '::1'])
    assert.throws(() => temporaryHostname(plan, address));
  for (const changes of [
    { managedZone: 'owned' },
    { certificateSha256: '1'.repeat(64) },
    { domain: 'litnet.com' },
    { acme: { ...plan.acme, subscriberTermsApproved: false } },
    { acme: { ...plan.acme, certificateIssuanceApproved: false } },
    { acme: { ...plan.acme, image: 'certbot/certbot:latest' } },
  ])
    assert.throws(() => ipPlan(changes));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-challenge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'challenge.json');
  const packet = { token: 'a'.repeat(24), validation: 'b'.repeat(40) };
  await fs.writeFile(file, JSON.stringify(packet));
  const server = temporaryAcmeServer(file);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = {
    resolve: async (name) => {
      assert.equal(name, hostname);
      return ['203.0.113.10'];
    },
    fetchImpl: (url, opts) => fetch(origin + new URL(url).pathname, opts),
  };
  assert.equal(await verifyTemporaryChallenge({ hostname, address: '203.0.113.10', ...packet }, options), true);
  await assert.rejects(
    verifyTemporaryChallenge({ hostname, address: '203.0.113.11', ...packet }, options),
    /owned address/,
  );
  assert.equal(
    await verifyTemporaryChallenge({ hostname, address: '203.0.113.10', ...packet, validation: 'wrong' }, options),
    false,
  );
  for (const suffix of ['', '?token=x', '/../policy.json', '%2fextra'])
    assert.equal(
      (await fetch(`${origin}/.well-known/acme-challenge/${suffix ? packet.token + suffix : 'missing'}`)).status,
      404,
    );
  assert.equal((await fetch(origin + '/.well-known/acme-challenge/' + packet.token, { method: 'POST' })).status, 404);
  await fs.writeFile(file, 'x'.repeat(2049));
  assert.equal((await fetch(origin + '/.well-known/acme-challenge/' + packet.token)).status, 404);
  assert.equal(await (await fetch(origin + '/health')).text(), 'ready');
});

test('real network-disabled certificate hook enforces hostname, exchange bytes and its original deadline', async (t) => {
  const image =
    process.env.RIVET_CERTIFICATE_TEST_IMAGE ||
    'certbot/certbot@sha256:09c5c6e899adc7d0c422c73ad181a6747cfe7399b2ecd8f61095ccb5740ef202';
  assert.match(image, /^(?:docker\.io\/)?certbot\/certbot@sha256:[a-f0-9]{64}$/);
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe', timeout: 15000 });
  } catch (error) {
    if (process.env.RIVET_CERTIFICATE_TEST_IMAGE) throw error;
    execFileSync('docker', ['pull', image], { stdio: 'pipe', timeout: 120000 });
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-acme-hook-'));
  const containers = [];
  t.after(async () => {
    for (const { name, nonce } of containers) {
      const ids = execFileSync(
        'docker',
        ['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
        { encoding: 'utf8', stdio: 'pipe', timeout: 15000 },
      ).trim();
      if (!ids) continue;
      assert.match(ids, /^[a-f0-9]{64}$/);
      const [value] = JSON.parse(
        execFileSync('docker', ['inspect', ids], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 }),
      );
      assert.equal(value.Id, ids);
      assert.equal(value.Config.Image, image);
      assert.equal(value.Config.Labels['rivet.dev/acme-hook-test'], nonce);
      assert.equal(value.HostConfig.NetworkMode, 'none');
      // Only this credential-free synthetic fixture can be force-settled.
      execFileSync('docker', ['container', 'rm', '--force', ids], { stdio: 'pipe', timeout: 15000 });
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const hostname = temporaryHostname(ipPlan(), '203.0.113.10'),
    packet = { token: 'a'.repeat(24), validation: 'b'.repeat(40) };
  for (const mode of ['valid', 'wrong hostname', 'expired']) {
    const directory = path.join(root, mode.replaceAll(' ', '-'));
    const nonce = randomUUID(),
      name = 'rivet-acme-hook-' + nonce;
    containers.push({ name, nonce });
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'auth.py'), temporaryAcmeHook);
    await fs.writeFile(
      path.join(directory, 'policy.json'),
      JSON.stringify({ hostname, deadline: Date.now() + (mode === 'expired' ? -1000 : 60000) }),
    );
    if (mode !== 'expired') await fs.writeFile(path.join(directory, 'verified'), temporaryHash(JSON.stringify(packet)));
    const run = () =>
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--label',
          'rivet.dev/acme-hook-test=' + nonce,
          '--pull=never',
          '--network=none',
          '--user',
          `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--mount',
          `type=bind,source=${directory},target=/exchange`,
          '--env',
          `CERTBOT_IDENTIFIER=${mode === 'wrong hostname' ? 'unrelated.invalid' : hostname}`,
          '--env',
          'CERTBOT_REMAINING_CHALLENGES=0',
          '--env',
          'CERTBOT_TOKEN=' + packet.token,
          '--env',
          'CERTBOT_VALIDATION=' + packet.validation,
          '--entrypoint',
          'python3',
          image,
          '/exchange/auth.py',
        ],
        { stdio: 'pipe', timeout: 30000 },
      );
    if (mode === 'valid') {
      run();
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'challenge.json'), 'utf8')), packet);
    } else assert.throws(run);
  }
});

test('certificate issuance owns one exact local worker and uncertainty never repeats account/order writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-certificate-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plan = ipPlan(),
    hostname = temporaryHostname(plan, '203.0.113.10');
  const cert = path.join(directory, 'cert.pem'),
    key = path.join(directory, 'key.pem');
  execFileSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl',
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
      '2',
      '-subj',
      '/CN=' + hostname,
      '-addext',
      'subjectAltName=DNS:' + hostname,
    ],
    { stdio: 'pipe' },
  );
  for (const mode of [
    'success',
    'changed terms',
    'lost create',
    'lost start',
    'lost remove',
    'changed identity',
    'never started',
    'paused',
  ])
    await t.test(mode, async () => {
      const store = new TemporaryStagingStore(path.join(directory, mode), { lock: fixtureLock });
      await store.initialize(plan);
      await store.locked(async () => {
        await store.change((r) => {
          r.firstBillableIntentAt = new Date().toISOString();
          r.expiresAt = new Date(Date.now() + 86400000).toISOString();
          r.hostname = { name: hostname, address: '203.0.113.10', addressId: '123' };
        });
        const calls = [];
        let worker,
          exchange,
          state,
          paused = mode === 'paused';
        const docker = async (args) => {
          calls.push([...args]);
          if (args[0] === 'container') return worker ? worker.Id : '';
          if (args[0] === 'create') {
            const mount = (target) =>
              args
                .find((value) => value.startsWith('type=bind,source=') && value.endsWith('target=' + target))
                .split(',')[1]
                .slice(7);
            exchange = mount('/exchange');
            state = mount('/state');
            worker = {
              Id: 'a'.repeat(64),
              Name: '/' + plan.operationId + '-certificate',
              Image: 'sha256:' + 'b'.repeat(64),
              Created: '2026-10-30T00:00:00Z',
              Config: { Image: plan.acme.image, Labels: { 'rivet.temporary-certificate': plan.inputHash } },
              State: { Running: false, Status: 'created', ExitCode: 0 },
            };
            assert.ok(
              args.includes('--read-only') && args.includes('no-new-privileges') && args.includes('--pull=never'),
            );
            assert.equal(args.filter((v) => v.startsWith('type=bind')).length, 2);
            if (mode === 'lost create') throw Error('lost creation acknowledgement');
            return worker.Id;
          }
          if (args[0] === 'inspect') {
            if (worker.State.Running && (await fs.stat(path.join(exchange, 'verified')).catch(() => null))) {
              const live = path.join(state, 'config/live', hostname);
              await fs.mkdir(live, { recursive: true });
              await fs.copyFile(cert, path.join(live, 'fullchain.pem'));
              await fs.copyFile(key, path.join(live, 'privkey.pem'));
              worker.State = { Running: false, Status: 'exited', ExitCode: 0 };
            }
            return JSON.stringify([worker]);
          }
          if (args[0] === 'start') {
            if (mode === 'never started') throw Error('start rejected');
            worker.State = { Running: true, Status: 'running' };
            await fs.writeFile(
              path.join(exchange, 'challenge.json'),
              JSON.stringify({ token: 'a'.repeat(24), validation: 'b'.repeat(40) }),
            );
            if (mode === 'changed identity') worker.Created = 'replacement';
            if (mode === 'lost start' || paused) throw Error('lost start acknowledgement');
            return worker.Id;
          }
          if (args[0] === 'kill') {
            assert.deepEqual(args, ['kill', '--signal=TERM', worker.Id]);
            if (!paused) worker.State = { Running: false, Status: 'exited', ExitCode: 143 };
            return '';
          }
          if (args[0] === 'rm') {
            assert.equal(args[1], worker.Id);
            worker = null;
            if (mode === 'lost remove') throw Error('lost removal acknowledgement');
            return '';
          }
          throw Error('Unexpected Docker request');
        };
        let published = 0;
        const issue = () =>
          issueTemporaryCertificate(
            store,
            {
              hostname,
              wait,
              guard: async () => {},
              publishChallenge: async () => {
                published++;
              },
            },
            {
              docker,
              fetchDirectory: async () =>
                new Response(
                  JSON.stringify({
                    meta: { termsOfService: mode === 'changed terms' ? 'https://changed.invalid' : plan.acme.termsUrl },
                  }),
                ),
            },
          );
        if (mode === 'success') {
          const issued = await issue();
          assert.deepEqual(issued.certificate, await fs.readFile(cert));
          assert.deepEqual(issued.key, await fs.readFile(key));
          assert.equal(published, 1);
        } else await assert.rejects(issue());
        if (mode === 'changed identity') {
          const before = calls.length;
          await assert.rejects(settleTemporaryCertificate(store, { wait, stop: true, docker }), /replaced/);
          assert.equal(
            calls.slice(before).some((c) => ['kill', 'rm'].includes(c[0])),
            false,
          );
          worker.Created = '2026-10-30T00:00:00Z'; // Restore only the synthetic replacement.
        }
        if (paused) {
          await assert.rejects(settleTemporaryCertificate(store, { wait, stop: true, docker }), /physical shutdown/);
          assert.equal(
            calls.some((c) => c[0] === 'rm'),
            false,
          );
          paused = false;
          worker.State = { Running: false, Status: 'exited', ExitCode: 143 }; // Release only this synthetic paused worker.
        }
        await settleTemporaryCertificate(store, { wait, stop: true, docker });
        if (mode === 'changed terms') {
          assert.equal(calls.length, 0);
          return;
        }
        assert.equal(worker, null);
        assert.equal((await store.read()).record.certificateWorker.removed, true);
        await assert.rejects(issue(), /Never repeat/);
        assert.equal(calls.filter((c) => c[0] === 'create').length, 1);
        assert.equal(calls.filter((c) => c[0] === 'start').length, mode === 'lost create' ? 0 : 1);
        assert.equal(calls.filter((c) => c[0] === 'rm').length, 1);
        await assert.rejects(
          store.change((r) => {
            r.certificateWorker.identity.id = 'replacement';
          }),
          /history changed/,
        );
      });
    });
});

test('cleanup settles the exact local certificate worker before an unavailable provider can block it', async (t) => {
  const f = await fixture(t);
  let stopped = false;
  f.runtime.settleCertificate = async () => {
    stopped = true;
  };
  f.cloud.project = async () => {
    assert.equal(stopped, true);
    throw Error('local provider unavailable');
  };
  await f.store.locked(async () => {
    await assert.rejects(cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait }), /provider unavailable/);
    assert.equal((await f.store.read()).record.complete, false);
  });
});
function offlineTestImage() {
  // This probes the Docker transport, not the complete release actor/toolchain.
  // CI may pull only this pinned public base; local runs can reuse the existing
  // housekeeping image without touching any running development container.
  const image =
    process.env.RIVET_HOUSEKEEPING_TEST_IMAGE ||
    'node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe', timeout: 15000 });
  } catch (error) {
    if (process.env.RIVET_HOUSEKEEPING_TEST_IMAGE) throw error;
    execFileSync('docker', ['pull', image], { stdio: 'pipe', timeout: 120000 });
  }
  return image;
}

test('offline actor Docker transport delivers its actual stdin packet with networking disabled', async () => {
  const image = offlineTestImage();
  const source = fileURLToPath(new URL('./fixtures/temporary-actor-preflight-tool.mjs', import.meta.url));
  const target = '/app/deploy/studio-server/scripts/qualification/temporary-actor.mjs';
  const plan = { actorImage: image, actorSourceRoot: '/app', sourceSha: 'a'.repeat(40) };
  const receipt = await verifyOfflineTemporaryActor(plan, {
    timeoutMs: 30000,
    spawnImpl: (program, args, options) => {
      assert.ok(args.includes('--network=none') && args.includes('--interactive'));
      assert.ok(!args.some((arg) => /^--(?:env|mount|volume)/.test(arg)));
      const fixtureArgs = [...args];
      fixtureArgs.splice(
        fixtureArgs.indexOf('--entrypoint'),
        0,
        '--mount',
        `type=bind,source=${source},target=${target},readonly`,
      );
      return spawn(program, fixtureArgs, options);
    },
  });
  assert.deepEqual(receipt, { sourceSha: plan.sourceSha, offlineFixturePassed: true });
});

test('offline preflight container expires independently after its exact Docker client exits', async (t) => {
  const image = offlineTestImage();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-offline-expiry-'));
  const cidFile = path.join(temp, 'container.id'),
    nonce = randomUUID();
  const source = fileURLToPath(new URL('./fixtures/temporary-actor-preflight-tool.mjs', import.meta.url));
  const target = '/app/deploy/studio-server/scripts/qualification/temporary-actor.mjs';
  const plan = { actorImage: image, actorSourceRoot: '/app', sourceSha: 'a'.repeat(40) };
  let client, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const listExact = (id) =>
    execFileSync('docker', ['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    }).trim();
  t.after(async () => {
    try {
      if (client && client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
      const id = await fs
        .readFile(cidFile, 'utf8')
        .then((v) => v.trim())
        .catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
      if (!id) return;
      assert.match(id, /^[a-f0-9]{64}$/);
      if (!listExact(id)) return;
      const value = JSON.parse(
        execFileSync('docker', ['container', 'inspect', id], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 }),
      )[0];
      assert.equal(value.Id, id);
      assert.equal(value.Config.Labels['rivet.dev/offline-expiry-test'], nonce);
      assert.equal(value.Config.Image, image);
      assert.equal(value.HostConfig.NetworkMode, 'none');
      // Only this synthetic, credential-free test container can be force-cleaned.
      execFileSync('docker', ['container', 'rm', '--force', id], { stdio: 'pipe', timeout: 15000 });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
  const result = verifyOfflineTemporaryActor(plan, {
    timeoutMs: 5000,
    spawnImpl: (program, args, options) => {
      const fixtureArgs = [...args];
      fixtureArgs.splice(
        fixtureArgs.indexOf('--entrypoint'),
        0,
        '--cidfile',
        cidFile,
        '--label',
        `rivet.dev/offline-expiry-test=${nonce}`,
        '--env',
        'RIVET_TEST_OFFLINE_HANG=1',
        '--mount',
        `type=bind,source=${source},target=${target},readonly`,
      );
      client = spawn(program, fixtureArgs, options);
      let output = '';
      client.stdout.on('data', (c) => {
        output += c;
        if (output.includes('offline-test-ready')) readyResolve();
      });
      client.on('error', readyReject);
      client.on('close', () => readyReject(Error('Offline fixture closed before readiness')));
      return client;
    },
  });
  const rejected = assert.rejects(result, /Offline actor/);
  await ready;
  const id = (await fs.readFile(cidFile, 'utf8')).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(listExact(id), id);
  assert.equal(client.kill('SIGKILL'), true);
  await rejected;
  // Five-second deadline plus the explicit ten-second termination grace.
  const deadline = Date.now() + 18000;
  while (listExact(id)) {
    assert.ok(Date.now() < deadline, 'Docker client exit left the offline actor running without independent expiry');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});
test('management credentials are single-flight, bounded and refreshed without replaying provider requests', async () => {
  let time = 0,
    calls = 0;
  const token = cachedTemporaryToken(
    async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { token: `local-only-${calls}`, expiresAt: time + 3600000 };
    },
    { now: () => time },
  );
  assert.deepEqual(await Promise.all([token(), token(), token()]), Array(3).fill('local-only-1'));
  assert.equal(calls, 1);
  time = 2999999;
  assert.equal(await token(), 'local-only-1');
  time = 3000000;
  assert.equal(await token(), 'local-only-2');
  assert.equal(calls, 2);
  const broken = cachedTemporaryToken(async () => {
    throw Error('Credential source unavailable');
  });
  await assert.rejects(broken());
  await assert.rejects(cachedTemporaryToken(async () => ({ token: 'opaque', expiresAt: NaN }))());
});
test('operator impersonation reads the real API expiry over HTTP without exposing the source credential to resource requests', async (t) => {
  const f = await fixture(t);
  const token = cachedTemporaryToken(() =>
    mintTemporaryToken(f.plan, {
      sourceToken: async () => 'local-only',
      fetchImpl: (url, options) =>
        fetch(new URL('credentials/' + new URL(url).pathname.slice('/v1/'.length), f.base), options),
    }),
  );
  assert.deepEqual(await Promise.all([token(), token()]), ['local-only', 'local-only']);
  assert.equal((await f.control('_requests')).filter((r) => r.resource.endsWith(':generateAccessToken')).length, 1);
});
test('actor build context contains only the exact current tree and one commit, never local credentials or history', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-actor-context-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'repo'),
    context = path.join(temp, 'context');
  await fs.mkdir(source);
  await fs.mkdir(context);
  const git = (...args) =>
    execFileSync('git', ['-c', `core.hooksPath=${path.join(temp, 'no-hooks')}`, ...args], {
      cwd: source,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.autocrlf', 'true'); // Actor bytes must not inherit the control host's Windows preference.
  await fs.writeFile(path.join(source, 'historical-only.txt'), 'historical content must not enter the image');
  git('add', '.');
  git('commit', '-m', 'history');
  git('rm', 'historical-only.txt');
  const dockerfile = path.join(source, 'deploy/studio-server/images/qualification/Dockerfile');
  await fs.mkdir(path.dirname(dockerfile), { recursive: true });
  await fs.writeFile(dockerfile, 'FROM scratch\n');
  await fs.writeFile(path.join(source, 'committed-text.txt'), 'first line\nsecond line\n');
  const native = path.join(source, 'packages/app/src-tauri');
  await fs.mkdir(path.join(native, 'src'), { recursive: true });
  const nativeLock = 'native desktop dependency metadata\n';
  await fs.writeFile(path.join(native, 'Cargo.lock'), nativeLock);
  await fs.writeFile(path.join(native, 'src/main.rs'), 'fn main() {}\n');
  await fs.writeFile(path.join(source, '.gitignore'), '.private\n');
  git('add', '.');
  git('commit', '-m', 'current');
  const sha = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(source, '.private'), 'local credentials');
  git('config', 'remote.origin.url', 'https://example.invalid/private');
  const template = path.join(temp, 'host-git-template');
  await fs.mkdir(path.join(template, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(template, 'hooks', 'private-host-note'), 'private control-host configuration');
  const previousTemplate = process.env.GIT_TEMPLATE_DIR;
  try {
    process.env.GIT_TEMPLATE_DIR = template;
    await prepareTemporaryActorContext(source, sha, context);
  } finally {
    if (previousTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplate;
  }
  const checkout = path.join(context, 'source');
  await assert.rejects(fs.stat(path.join(checkout, '.git/hooks/private-host-note')), { code: 'ENOENT' });
  assert.equal(
    await fs.readFile(path.join(context, 'Dockerfile'), 'utf8'),
    git('show', 'HEAD:deploy/studio-server/images/qualification/Dockerfile') + '\n',
  );
  assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), '1');
  assert.doesNotMatch(
    execFileSync('git', ['config', '--local', '--list'], { cwd: checkout, encoding: 'utf8', stdio: 'pipe' }),
    /^remote\./m,
  );
  assert.equal(
    execFileSync('git', ['config', '--local', 'core.autocrlf'], { cwd: checkout, encoding: 'utf8' }).trim(),
    'false',
  );
  assert.equal(await fs.readFile(path.join(checkout, 'committed-text.txt'), 'utf8'), 'first line\nsecond line\n');
  await verifyActorSource(checkout, sha);
  assert.equal(await fs.readFile(path.join(native, 'Cargo.lock'), 'utf8'), nativeLock);
  await assert.rejects(fs.stat(path.join(checkout, 'packages/app/src-tauri')), { code: 'ENOENT' });
  // Removing the unused component must not weaken attestation of required code.
  const actorGit = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: 'pipe' });
  await assert.rejects(verifyActorSource(checkout, 'f'.repeat(40)), /revision differs/);
  // A user's status display preference must not hide extra code from admission.
  actorGit('config', 'status.showUntrackedFiles', 'no');
  const untracked = path.join(checkout, 'unexpected-source.mjs');
  await fs.writeFile(untracked, 'unreviewed source');
  assert.equal(actorGit('status', '--porcelain').trim(), ''); // Reproduce the hidden-file case.
  await assert.rejects(verifyActorSource(checkout, sha), /exact clean source/);
  await fs.unlink(untracked);
  actorGit('config', '--unset', 'status.showUntrackedFiles');
  await verifyActorSource(checkout, sha);
  const monitor = path.join(temp, 'fsmonitor.cjs'),
    monitorMarker = path.join(temp, 'fsmonitor-called');
  await fs.writeFile(
    monitor,
    `require('node:fs').writeFileSync(${JSON.stringify(monitorMarker)}, 'called'); process.stdout.write('fixture-token\\0/\\0');`,
  );
  const monitorCommand = `"${process.execPath.replaceAll('\\', '/')}" "${monitor.replaceAll('\\', '/')}"`;
  actorGit('config', 'core.fsmonitor', monitorCommand);
  actorGit('config', 'core.fsmonitorHookVersion', '2');
  actorGit('status', '--porcelain');
  assert.equal(await fs.readFile(monitorMarker, 'utf8'), 'called'); // Prove the real hook is active.
  await fs.unlink(monitorMarker);
  await verifyActorSource(checkout, sha);
  await assert.rejects(fs.lstat(monitorMarker), { code: 'ENOENT' });
  actorGit('config', '--unset', 'core.fsmonitor');
  actorGit('config', '--unset', 'core.fsmonitorHookVersion');
  // Local replacement refs can make a different tree appear clean at the
  // expected SHA. Source admission must inspect the actual commit object.
  await fs.writeFile(path.join(checkout, 'committed-text.txt'), 'replacement source\n');
  actorGit('add', 'committed-text.txt');
  const replacement = actorGit(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    actorGit('write-tree').trim(),
    '-m',
    'Replacement fixture',
  ).trim();
  actorGit('replace', sha, replacement);
  try {
    assert.equal(actorGit('rev-parse', 'HEAD').trim(), sha);
    assert.equal(actorGit('status', '--porcelain').trim(), ''); // Reproduce substituted clean source.
    await assert.rejects(verifyActorSource(checkout, sha), /exact clean source/);
    const replacedContext = path.join(temp, 'replaced-context');
    await fs.mkdir(replacedContext);
    await assert.rejects(prepareTemporaryActorContext(checkout, sha, replacedContext), /exact clean source/);
    await assert.rejects(fs.lstat(path.join(replacedContext, 'source')), { code: 'ENOENT' });
  } finally {
    actorGit('replace', '-d', sha);
    actorGit('restore', '--source', sha, '--staged', '--worktree', '--', 'committed-text.txt');
  }
  await verifyActorSource(checkout, sha);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    actorGit('update-index', `--${flag}`, 'committed-text.txt');
    if (flag === 'skip-worktree') await fs.unlink(path.join(checkout, 'committed-text.txt'));
    else await fs.writeFile(path.join(checkout, 'committed-text.txt'), 'hidden modification');
    await assert.rejects(verifyActorSource(checkout, sha), /index flags|hides required source/);
    await fs.writeFile(path.join(checkout, 'committed-text.txt'), 'first line\nsecond line\n');
    actorGit('update-index', `--no-${flag}`, 'committed-text.txt');
    await verifyActorSource(checkout, sha);
  }
  actorGit('sparse-checkout', 'set', '--no-cone', ...actorSparsePatterns, '!/committed-text.txt');
  await assert.rejects(verifyActorSource(checkout, sha), /Unknown actor source projection/);
  actorGit('sparse-checkout', 'set', '--no-cone', ...actorSparsePatterns);
  await fs.mkdir(path.join(checkout, 'packages/app/src-tauri'), { recursive: true });
  await fs.writeFile(path.join(checkout, 'packages/app/src-tauri/Cargo.lock'), nativeLock);
  await assert.rejects(verifyActorSource(checkout, sha));
  await fs.rm(path.join(checkout, 'packages/app/src-tauri'), { recursive: true });
  await verifyActorSource(checkout, sha);
  for (const name of ['.private', 'historical-only.txt'])
    await assert.rejects(fs.stat(path.join(checkout, name)), { code: 'ENOENT' });
  // The builder must use the same admission contract before cloning, not a
  // weaker second implementation that honors the control host's preferences.
  git('config', 'status.showUntrackedFiles', 'no');
  git('config', 'core.fsmonitor', monitorCommand);
  git('config', 'core.fsmonitorHookVersion', '2');
  await fs.writeFile(path.join(source, 'unexpected-source.mjs'), 'unreviewed source');
  const rejectedContext = path.join(temp, 'rejected-context');
  await fs.mkdir(rejectedContext);
  await assert.rejects(prepareTemporaryActorContext(source, sha, rejectedContext), /exact clean source/);
  await assert.rejects(fs.lstat(path.join(rejectedContext, 'source')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(monitorMarker), { code: 'ENOENT' });
});

test('actor dependency installation preserves tracked source when switching Yarn to node-modules', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-actor-dependencies-'));
  const seedCache = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-actor-seed-cache-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  t.after(() => fs.rm(seedCache, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, '.yarn/releases'), { recursive: true });
  const yarn = path.join(temp, '.yarn/releases/yarn-4.17.1.cjs');
  await fs.copyFile(fileURLToPath(new URL('../../../.yarn/releases/yarn-4.17.1.cjs', import.meta.url)), yarn);
  await fs.writeFile(
    path.join(temp, 'package.json'),
    JSON.stringify({
      name: 'isolated-actor-fixture',
      private: true,
      packageManager: 'yarn@4.17.1',
      dependencies: { 'fixture-platform': 'file:./platform' },
    }),
  );
  await fs.mkdir(path.join(temp, 'platform'));
  await fs.writeFile(
    path.join(temp, 'platform/package.json'),
    JSON.stringify({ name: 'fixture-platform', version: '1.0.0', main: 'index.js' }),
  );
  await fs.writeFile(path.join(temp, 'platform/index.js'), 'module.exports = 42;\n');
  await fs.writeFile(path.join(temp, '.yarnrc.yml'), 'pnpEnableEsmLoader: true\n');
  await fs.writeFile(path.join(temp, '.gitignore'), 'node_modules/\n.yarn/install-state.gz\n');
  const env = {
    ...process.env,
    CI: 'true',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'true',
    YARN_ENABLE_NETWORK: '0',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_NODE_LINKER: 'pnp',
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    YARN_GLOBAL_FOLDER: path.join(seedCache, 'global'),
  };
  const runYarn = (args, overrides = {}) =>
    execFileSync(process.execPath, [yarn, ...args], {
      cwd: temp,
      env: { ...env, ...overrides },
      stdio: 'pipe',
      encoding: 'utf8',
    });
  assert.throws(
    () => runYarn(['install']),
    (error) => {
      assert.match(error.stdout, /YN0028/); // A fresh fixture has no lockfile yet.
      return true;
    },
  );
  // Only seed the disposable fixture non-immutably, then commit its lockfile.
  // The real installer and repeated CLI call below retain CI's immutable policy.
  try {
    runYarn(['install'], { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_CACHE_FOLDER: seedCache });
  } catch (error) {
    error.message += '\n' + error.stdout + '\n' + error.stderr;
    throw error;
  }
  const git = (...args) =>
    execFileSync('git', ['-c', `core.hooksPath=${path.join(temp, 'no-hooks')}`, ...args], {
      cwd: temp,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '.');
  git('commit', '-m', 'isolated dependency fixture');
  const sourceSha = git('rev-parse', 'HEAD');
  const originals = await Promise.all(
    ['.pnp.cjs', '.pnp.loader.mjs'].map((name) => fs.readFile(path.join(temp, name))),
  );
  const loaderModes = () =>
    Promise.all(
      ['.pnp.cjs', '.pnp.loader.mjs'].map(async (name) => (await fs.stat(path.join(temp, name))).mode & 0o777),
    );
  const originalModes = await loaderModes();
  const previousMask = process.umask(0o077);
  try {
    await installActorDependencies(temp, sourceSha, { env });
  } finally {
    process.umask(previousMask);
  }
  assert.deepEqual(await loaderModes(), originalModes, 'Restoring bytes must also preserve executable permissions');
  assert.equal(
    git('status', '--porcelain', '--untracked-files=no'),
    '',
    'Built actor source must still match its committed identity',
  );
  assert.deepEqual(
    await Promise.all(['.pnp.cjs', '.pnp.loader.mjs'].map((name) => fs.readFile(path.join(temp, name)))),
    originals,
  );
  await fs.stat(path.join(temp, 'node_modules'));
  assert.equal(
    execFileSync(process.execPath, ['-p', "require('fixture-platform')"], { cwd: temp, encoding: 'utf8' }).trim(),
    '42',
  );
  // Exercise the Dockerfile's actual CLI entry, including a repeated install.
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../images/qualification/install-dependencies.mjs', import.meta.url)), sourceSha],
    { cwd: temp, env, stdio: 'pipe' },
  );
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(await loaderModes(), originalModes);
  await assert.rejects(installActorDependencies(temp, 'b'.repeat(40), { env }));
  await fs.writeFile(path.join(temp, 'package.json'), 'private pending edit');
  await assert.rejects(installActorDependencies(temp, sourceSha, { env }), /exact clean source/);
  assert.equal(await fs.readFile(path.join(temp, 'package.json'), 'utf8'), 'private pending edit');
});

test('private pull configuration is exact, scoped to required hosts, helper-free and separate from Actions tokens', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-pull-input-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'pull.json'),
    image = `ghcr.io/owner/image@sha256:${'a'.repeat(64)}`;
  const config = { auths: { 'ghcr.io': { auth: Buffer.from('pull-reader:fixture-only').toString('base64') } } },
    bytes = Buffer.from(JSON.stringify(config));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const plan = temporaryPlan({ registrySecretSha256: temporaryHash(bytes) });
  assert.deepEqual(await stagingRegistryConfig(plan, file, [image]), bytes);
  await assert.rejects(stagingRegistryConfig(plan, file, ['quay.io/owner/image@sha256:' + 'a'.repeat(64)]));
  const calls = [];
  await verifyPrivateStagingImages(bytes, [image], async (bin, args) => {
    assert.equal(bin, 'docker');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(args[1], 'config.json'), 'utf8')), config);
    calls.push(args.slice(2));
  });
  assert.deepEqual(calls, [['manifest', 'inspect', image]]);
  const withHelper = Buffer.from(JSON.stringify({ ...config, credsStore: 'must-not-run' }));
  await fs.writeFile(file, withHelper);
  await assert.rejects(
    stagingRegistryConfig(temporaryPlan({ registrySecretSha256: temporaryHash(withHelper) }), file, [image]),
  );
});
test('workflow failure diagnostics are bounded and exclude arbitrary command properties', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-private-error-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const failure = Object.assign(new Error('x'.repeat(9000)), { stdout: 'private body', env: { TOKEN: 'private' } });
  await retainTemporaryFailure(temp, 'execute', failure);
  const files = await fs.readdir(temp);
  assert.equal(files.length, 1);
  const report = JSON.parse(await fs.readFile(path.join(temp, files[0]), 'utf8'));
  assert.deepEqual(Object.keys(report).sort(), ['at', 'message', 'mode', 'name']);
  assert.equal(report.mode, 'execute');
  assert.equal(report.name, 'Error');
  assert.equal(report.message, 'x'.repeat(8192));
  assert.ok(Number.isFinite(Date.parse(report.at)));
  // An unavailable diagnostic location must preserve the original operation failure.
  await retainTemporaryFailure(path.join(temp, 'absent'), 'execute', failure);
});

test('tagged Docker Hub images retain their repository and credential host', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-tagged-pull-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const digest = `sha256:${'a'.repeat(64)}`;
  const bytes = Buffer.from(
    JSON.stringify({ auths: { 'docker.io': { auth: Buffer.from('pull-reader:fixture-only').toString('base64') } } }),
  );
  const file = path.join(temp, 'pull.json');
  await fs.writeFile(file, bytes);
  const plan = temporaryPlan({ registrySecretSha256: temporaryHash(bytes) });
  for (const [image, repository] of [
    ['postgres:16.8-alpine', 'library/postgres'],
    ['library/postgres:16.8-alpine', 'library/postgres'],
    ['docker.io/library/postgres:16.8-alpine', 'library/postgres'],
    ['minio/minio:RELEASE.2025-04-22T22-12-26Z', 'minio/minio'],
  ]) {
    const reference = `${image}@${digest}`;
    await stagingRegistryConfig(plan, file, [reference]);
    let calls = 0;
    await verifyAnonymousStagingImage(reference, {
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, `https://registry-1.docker.io/v2/${repository}/manifests/${digest}`);
        assert.equal(options.method, 'HEAD');
        assert.equal(options.headers.authorization, undefined);
        return new Response(null, { status: 200, headers: { 'docker-content-digest': digest } });
      },
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(stagingRegistryConfig(plan, file, [`ghcr.io/owner/image@${digest}`]));
});

test('anonymous registry admission uses a scoped token and rejects private, changed and unsafe images before GCP', async (t) => {
  let base, server;
  if (process.env.RIVET_TEMPORARY_SIMULATION_URL)
    base = new URL('../registry/', process.env.RIVET_TEMPORARY_SIMULATION_URL).href;
  else {
    server = http.createServer(registryHandler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    t.after(() => new Promise((r) => server.close(r)));
  }
  const calls = [];
  const fetchImpl = (url, options) => {
    const parsed = new URL(url);
    calls.push({ origin: parsed.origin, path: parsed.pathname, authorization: options?.headers?.authorization });
    return fetch(new URL(parsed.pathname.slice(1) + parsed.search, base), options);
  };
  const image = (name) => `ghcr.io/owner/${name}@sha256:${'a'.repeat(64)}`;
  await verifyAnonymousStagingImage(image('public'), { fetchImpl });
  for (const name of ['private', 'changed', 'bad-realm'])
    await assert.rejects(verifyAnonymousStagingImage(image(name), { fetchImpl }));
  assert.equal(
    calls.some((c) => c.origin.includes('unsafe')),
    false,
  );
  assert.ok(calls.filter((c) => c.authorization).every((c) => c.authorization === 'Bearer local-anonymous-only'));
});
async function fixture(t, { fault, plan = temporaryPlan() } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-temp-foundation-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const store = new TemporaryStagingStore(path.join(temp, plan.operationId), { lock: fixtureLock });
  await store.initialize(plan);
  let server,
    base = process.env.RIVET_TEMPORARY_SIMULATION_URL;
  if (!base) {
    server = http.createServer(handler());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    t.after(() => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    });
  }
  assert.ok(new URL(base).hostname === '127.0.0.1');
  const control = async (route, body) => {
    const r = await fetch(new URL(route, base), {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  await control('_control', { plan, fault });
  const origins = Object.fromEntries(
    ['compute', 'container', 'crm', 'iam', 'dns'].map((k) => [k, new URL(`${k}/`, base).href]),
  );
  const cloud = temporaryGcp(plan, { origins, simulation: true, token: async () => 'local-only', timeoutMs: 100 });
  const calls = [];
  const runtime = Object.fromEntries(
    ['offlinePreflight', 'bootstrap', 'settleAndExport', 'removeEdgeAndBootstrap', 'removePermissions'].map((name) => [
      name,
      async () => {
        calls.push(name);
        if (name === 'settleAndExport') return true;
      },
    ]),
  );
  runtime.qualify = async () => ({
    control: { evidence: { passed: true } },
    autoscaling: { evidence: { passed: true } },
  });
  return { plan, store, cloud, runtime, calls, control, base, guard: async () => {} };
}

test('managed DNS admission requires a complete label boundary, not a lookalike suffix', async (t) => {
  for (const domain of ['example.net', 'staging.example.net', 'notexample.net'])
    await t.test(domain, async (child) => {
      const f = await fixture(child, { plan: temporaryPlan({ domain }) });
      await f.control('_replace', {
        resource: `projects/${f.plan.projectId}/managedZones/${f.plan.managedZone}`,
        value: { dnsName: 'example.net.' },
      });
      if (domain === 'notexample.net') await assert.rejects(f.cloud.preflight(), /outside the managed DNS zone/);
      else assert.equal((await f.cloud.preflight()).length, 3);
      assert.equal((await f.control('_requests')).some(cloudWrite), false);
    });
});

test('Autopilot creation sends the dedicated node identity through auto-provisioned pool defaults', async (t) => {
  const f = await fixture(t);
  const spec = temporaryFoundationSpecs(f.plan).find((item) => item.kind === 'cluster');
  await f.cloud.create(spec);
  const actual = await f.cloud.get(spec);
  assert.deepEqual(actual.autoscaling.autoprovisioningNodePoolDefaults, {
    serviceAccount: f.plan.nodeServiceAccount,
    oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  assert.equal(actual.nodeConfig, undefined, 'Deprecated nodeConfig cannot configure Autopilot node provisioning');
  assertTemporaryClusterNodeIdentity(f.plan, actual);
});

test('live Autopilot node identity rejects default, foreign and incompletely observed pools without losing cleanup ownership', () => {
  const plan = temporaryPlan();
  const spec = temporaryFoundationSpecs(plan).find((item) => item.kind === 'cluster');
  const cluster = {
    ...structuredClone(spec.body),
    id: 'cluster-123',
    endpoint: '192.0.2.10',
    masterAuth: { clusterCaCertificate: 'local-fixture-ca' },
    nodePools: [
      {
        config: {
          serviceAccount: plan.nodeServiceAccount,
          oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      },
    ],
  };
  assertTemporaryClusterNodeIdentity(plan, cluster);
  for (const change of [
    (value) => delete value.autoscaling,
    (value) => (value.autoscaling.autoprovisioningNodePoolDefaults.serviceAccount = 'default'),
    (value) => (value.autoscaling.autoprovisioningNodePoolDefaults.serviceAccount = plan.operatorServiceAccount),
    (value) => (value.autoscaling.autoprovisioningNodePoolDefaults.oauthScopes = []),
    (value) =>
      (value.autoscaling.autoprovisioningNodePoolDefaults.oauthScopes =
        'https://www.googleapis.com/auth/cloud-platform'),
    (value) => (value.nodePools[0].config.serviceAccount = 'default'),
    (value) => (value.nodePools[0].config.serviceAccount = plan.janitorServiceAccount),
    (value) => delete value.nodePools[0].config,
    (value) => (value.nodePools[0].config.oauthScopes = []),
    (value) => (value.nodePools[0].config.oauthScopes = 'https://www.googleapis.com/auth/cloud-platform'),
    (value) => (value.nodePools = {}),
    (value) => (value.autopilot.enabled = false),
  ]) {
    const wrong = structuredClone(cluster);
    change(wrong);
    // A plausible legacy echo cannot override the authoritative defaults/pools.
    wrong.nodeConfig = { serviceAccount: plan.nodeServiceAccount };
    assert.throws(() => assertTemporaryClusterNodeIdentity(plan, wrong), /Autopilot/);
    assert.equal(
      temporaryGcp(plan).identity(spec, wrong).id,
      cluster.id,
      'Owned misconfiguration must remain cleanable',
    );
  }
});

test('missing firewall or certificate cleanup privileges block before any infrastructure write', async (t) => {
  for (const permission of [
    'compute.firewalls.create',
    'compute.firewalls.delete',
    'compute.regionSslCertificates.delete',
    'compute.sslCertificates.delete',
  ])
    await t.test(permission, async (child) => {
      const f = await fixture(child, { fault: { type: 'missing-permission', permission } });
      await assert.rejects(
        f.store.locked(() => provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard })),
        (error) => error.message.includes(permission),
      );
      const requests = await f.control('_requests');
      assert.equal(requests.filter((request) => request.resource.endsWith(':testIamPermissions')).length, 1);
      assert.equal(requests.some(cloudWrite), false);
      const { record } = await f.store.read();
      assert.equal(record.firstBillableIntentAt, null);
      assert.deepEqual(record.resources, []);
    });
});

test('reader IAM policy reads use POST before infrastructure and preserve exact member changes', async (t) => {
  const f = await fixture(t);
  const accounts = await f.cloud.preflight();
  const id = accounts.find((account) => account.email === f.plan.janitorServiceAccount).id;
  const member = `serviceAccount:${f.plan.projectId}.svc.id.goog[${f.plan.operationId}-ctl/janitor]`;
  assert.equal(await f.cloud.readBinding(member, id), false);
  await f.cloud.iamBinding(member, false, id);
  assert.equal(await f.cloud.readBinding(member, id), true);
  await f.cloud.iamBinding(member, true, id);
  assert.equal(await f.cloud.readBinding(member, id), false);
  const requests = await f.control('_requests');
  const reads = requests.filter((request) => request.resource.endsWith(':getIamPolicy'));
  assert.equal(reads.length, 6);
  assert.ok(reads.every((request) => request.method === 'POST'));
  assert.equal(requests.filter(cloudWrite).length, 2);
  await assert.rejects(f.cloud.iamBinding(member, false, 'replaced-account'), /identity changed/);
  assert.equal((await f.control('_requests')).filter(cloudWrite).length, 2);
});

test('unreadable reader policy or missing etag stops before any infrastructure write', async (t) => {
  for (const type of ['policy-read-denied', 'policy-without-etag'])
    await t.test(type, async (child) => {
      const f = await fixture(child, { fault: { type } });
      await assert.rejects(
        f.store.locked(() => provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard })),
      );
      assert.equal((await f.control('_requests')).some(cloudWrite), false);
      const { record } = await f.store.read();
      assert.equal(record.firstBillableIntentAt, null);
      assert.deepEqual(record.resources, []);
    });
});

test('temporary plan freezes private ranges, exact images and a non-resettable parent allowance', () => {
  const plan = temporaryPlan();
  assert.equal(temporaryExpiry({ plan, expiresAt: null }), Date.parse(plan.allowance.approvalExpiresAt));
  assert.ok(Object.isFrozen(plan.cidrs));
  verifyTemporaryPlan(plan);
  for (const changes of [
    { projectId: 'wartime-storyteller' },
    { trustedClients: ['0.0.0.0/0'] },
    { cidrs: { ...plan.cidrs, proxy: plan.cidrs.nodes } },
    { actorImage: 'registry.test/latest' },
    { estimate: { ...plan.estimate, usd: 51 } },
    { allowance: { ...plan.allowance, maxSeconds: 7200 } },
    { janitorServiceAccount: plan.operatorServiceAccount },
    { nodeServiceAccount: plan.operatorServiceAccount },
    { nodeServiceAccount: plan.janitorServiceAccount },
    { unexpected: true },
  ])
    assert.throws(() => temporaryPlan(changes));
  const record = {
    plan,
    closed: false,
    complete: false,
    firstBillableIntentAt: new Date(1000).toISOString(),
    expiresAt: new Date(86401000).toISOString(),
  };
  assert.equal(temporaryBinding(record, { maxUsd: 999, operationId: 'wrong' }).maxUsd, 50);
  assert.equal(temporaryBinding(record, { operationId: 'wrong' }).operationId, plan.operationId);
  assert.throws(() => temporaryAdmission(record, { now: 86401000 }));
  assert.throws(() => temporaryAdmission(record, { now: 80000000, tests: true }));
});

test('actual REST lifecycle journals identities, settles before teardown and proves all new resources absent', async (t) => {
  const f = await fixture(t);
  await f.store.locked(async () => {
    await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
    const before = (await f.store.read()).record;
    assert.ok(before.firstBillableIntentAt && before.firstBillableActivation);
    assert.equal(before.resources.length, temporaryFoundationSpecs(f.plan).length);
    assert.ok(before.resources.every((r) => r.identity?.id && r.createOperation));
    const result = await runTemporaryQualification(f.store, f.cloud, f.runtime, { wait });
    assert.equal(result.status, 'local-functional-only');
    assert.equal(result.control.protocol, 2);
    const terminal = (await f.store.read()).record;
    assert.equal(terminal.complete, true);
    assert.equal(terminal.expiresAt, before.expiresAt);
    assert.ok(terminal.resources.every((r) => r.absent));
    assert.deepEqual(terminal.residualResources, []);
    assert.deepEqual(f.calls, [
      'offlinePreflight',
      'bootstrap',
      'settleAndExport',
      'removeEdgeAndBootstrap',
      'removePermissions',
    ]);
    const requests = await f.control('_requests');
    const deleted = requests.filter((r) => r.method === 'DELETE');
    assert.equal(deleted.length, terminal.resources.length);
    assert.ok(deleted[0].resource.includes('/clusters/'));
    assert.ok(deleted.at(-1).resource.includes('/networks/'));
    assert.equal(
      requests.some((r) => r.resource.includes('wartime-storyteller')),
      false,
    );
  });
});

test('completed cleanup recovers its original receipt without cloud calls, new dates or attribution to later work', async (t) => {
  for (const activated of [false, true])
    await t.test(activated ? 'activated environment' : 'never activated', async (child) => {
      const f = await fixture(child);
      await f.store.locked(async () => {
        if (activated) await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
        const receipt = await cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait });
        const original = structuredClone(receipt),
          revision = (await f.store.read()).revision;
        await assert.rejects(
          f.store.change((r) => {
            delete r.cleanupReceipt;
          }),
          /Missing bound cleanup receipt/,
        );
        await assert.rejects(
          f.store.change((r) => {
            r.finishedAt = new Date(Date.parse(r.finishedAt) + 1000).toISOString();
            r.cleanupReceipt.verifiedAt = r.finishedAt;
          }),
          /Frozen operation authority changed/,
        );
        await assert.rejects(
          f.store.change((r) => {
            r.resources.push({ key: 'late-item', kind: 'unknown', identity: { id: 'unexpected' } });
          }),
          /Cleanup receipt authority changed/,
        );
        // A later operation's object is not evidence about this historical cleanup.
        await f.control('_replace', {
          resource: `projects/${f.plan.projectId}/regions/${f.plan.region}/disks/later-operation`,
          value: { id: '88001', name: 'later-operation' },
        });
        const calls = (await f.control('_requests')).length;
        receipt.inventoryHash = 'caller-mutated';
        assert.deepEqual(
          await cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, {
            wait,
            now: () => Date.now() + 3600000,
          }),
          original,
        );
        assert.equal((await f.store.read()).revision, revision);
        assert.equal((await f.control('_requests')).length, calls, 'Receipt recovery must not contact the provider');
        await assert.rejects(
          runTemporaryQualification(f.store, f.cloud, f.runtime, { wait }),
          /Temporary qualification failed/,
        );
        assert.equal((await f.store.read()).revision, revision, 'Historical completion cannot reopen test admission');
      });
    });
});

test('lost create acknowledgement is inspected by exact owner and ID, never redispatched', async (t) => {
  const f = await fixture(t, { fault: { type: 'lost-create', kind: 'addresses' } });
  await f.store.locked(async () => {
    await assert.rejects(provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard }));
    const issued = (await f.store.read()).record;
    assert.ok(issued.expiresAt);
    assert.equal(issued.resources.find((r) => r.key === 'address').identity, undefined);
    await inspectTemporaryEnvironment(f.store, f.cloud);
    assert.ok((await f.store.read()).record.resources.find((r) => r.key === 'address').identity.id);
    await assert.rejects(provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard }));
    await cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait });
    assert.equal(
      (await f.control('_requests')).filter((r) => r.method === 'POST' && r.resource.endsWith('/addresses')).length,
      1,
    );
    assert.equal((await f.store.read()).record.expiresAt, issued.expiresAt);
  });
});

test('lost delete acknowledgement is resolved by exact absence without repeating deletion or inventing an operation receipt', async (t) => {
  const f = await fixture(t, { fault: { type: 'lost-delete' } });
  await f.store.locked(async () => {
    await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
    await assert.rejects(cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait }));
    await cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait });
    const record = (await f.store.read()).record,
      cluster = record.resources.find((r) => r.key === 'cluster');
    assert.equal(cluster.deleteOperation, undefined);
    assert.equal(cluster.absent, true);
    const deletes = (await f.control('_requests')).filter((r) => r.method === 'DELETE');
    assert.equal(deletes.filter((r) => r.resource.includes('/clusters/')).length, 1);
    assert.equal(record.complete, true);
  });
});
test('exact new network children are removed while pre-existing and unrelated network rules stay protected', async (t) => {
  const f = await fixture(t),
    root = `projects/${f.plan.projectId}`;
  const child = (name, id, network, kind) => ({
    resource: `${root}/global/${kind}/${name}`,
    value: {
      id,
      name,
      description: 'local controller fixture',
      network: `https://www.googleapis.com/compute/v1/${root}/global/networks/${network}`,
      selfLink: `https://www.googleapis.com/compute/v1/${root}/global/${kind}/${name}`,
    },
  });
  await f.control('_replace', child('unrelated', '900', 'untouched', 'firewalls'));
  await f.store.locked(async () => {
    await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
    for (const [name, id, kind] of [
      ['node-firewall', '901', 'firewalls'],
      ['default-route', '902', 'routes'],
    ])
      await f.control('_replace', child(name, id, f.plan.operationId, kind));
    await cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait });
    const record = (await f.store.read()).record;
    assert.equal(record.complete, true);
    assert.equal(record.resources.filter((i) => i.kind === 'network-rule' && i.absent).length, 2);
    assert.equal(
      (await f.control('_requests')).some((r) => r.method === 'DELETE' && r.resource.endsWith('/unrelated')),
      false,
    );
  });
});

test('unknown HTML/timeout outcomes never authorize retries or assumed absence', async (t) => {
  for (const type of ['html', 'hang'])
    await t.test(type, async (child) => {
      const f = await fixture(child, { fault: { type, kind: 'networks' } });
      await f.store.locked(async () => {
        await assert.rejects(provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard }));
        assert.equal(
          (await f.control('_requests')).filter((request) => request.method === 'POST' && cloudWrite(request)).length,
          1,
        );
        if (type === 'html')
          await assert.rejects(cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait }), /unknown/);
        else {
          await inspectTemporaryEnvironment(f.store, f.cloud);
          await cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait });
        }
      });
    });
});

test('resource replacement, incomplete settlement and residual inventory cannot produce a qualification', async (t) => {
  for (const mode of ['replacement', 'busy', 'residual'])
    await t.test(mode, async (child) => {
      const f = await fixture(child);
      await f.store.locked(async () => {
        await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
        const spec = temporaryFoundationSpecs(f.plan)[0];
        if (mode === 'replacement') {
          const value = await f.cloud.get(spec);
          await f.control('_replace', { resource: spec.path, value: { ...value, id: 'foreign-immutable-id' } });
        } else if (mode === 'busy')
          f.runtime.settleAndExport = async () => {
            throw Error('Exact worker remains alive');
          };
        else
          await f.control('_replace', {
            resource: `projects/${f.plan.projectId}/regions/${f.plan.region}/disks/unrecorded`,
            value: {
              id: '333',
              name: 'unrecorded',
              selfLink: `https://www.googleapis.com/compute/v1/projects/${f.plan.projectId}/regions/${f.plan.region}/disks/unrecorded`,
            },
          });
        await assert.rejects(runTemporaryQualification(f.store, f.cloud, f.runtime, { wait }));
        const record = (await f.store.read()).record;
        assert.equal(record.complete, false);
        if (mode === 'busy')
          assert.equal(
            (await f.control('_requests')).some((r) => r.method === 'DELETE'),
            false,
          );
        if (mode === 'residual') {
          assert.ok(record.residualResources.some((r) => r.id === '333'));
          const revision = (await f.store.read()).revision;
          await assert.rejects(cleanupTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait }));
          assert.equal(
            (await f.store.read()).revision,
            revision,
            'Unchanged cleanup observations must not exhaust the durable journal',
          );
        }
      });
    });
});

test('missing terminal evidence fails qualification without blocking verified infrastructure cleanup', async (t) => {
  const f = await fixture(t);
  await f.store.locked(async () => {
    await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
    f.runtime.settleAndExport = async () => false; // Accepted work is settled; diagnostics are unavailable.
    await assert.rejects(runTemporaryQualification(f.store, f.cloud, f.runtime, { wait }), /evidence/i);
    const record = (await f.store.read()).record;
    assert.equal(record.testsPassed, true);
    assert.equal(record.acceptedWorkSettled, true);
    assert.equal(record.cleanupVerified, true);
    assert.equal(record.complete, true);
    assert.equal(record.evidenceExported, false);
    assert.ok(record.resources.every((r) => r.absent));
    assert.equal((await f.control('_requests')).filter((r) => r.method === 'DELETE').length, record.resources.length);
  });
});

test('journal rejects inventory substitution, deadline extensions and a torn final snapshot', async (t) => {
  const f = await fixture(t);
  await f.store.locked(async () => {
    await provisionTemporaryEnvironment(f.store, f.cloud, f.runtime, { wait, guard: f.guard });
    await assert.rejects(
      f.store.change((r) => {
        r.expiresAt = new Date(Date.parse(r.expiresAt) + 1000).toISOString();
      }),
    );
    await assert.rejects(
      f.store.change((r) => {
        r.resources[0].identity.id = 'replacement';
      }),
    );
    for (const key of ['baseline', 'accounts'])
      await assert.rejects(
        f.store.change((r) => {
          r[key].push({ id: 'substituted-authority' });
        }),
      );
    await f.store.change((r) => {
      r.identities = { clusterUid: 'original-cluster' };
      r.writersStopped = true;
    });
    await assert.rejects(
      f.store.change((r) => {
        r.identities.clusterUid = 'replacement-cluster';
      }),
    );
    await assert.rejects(
      f.store.change((r) => {
        r.writersStopped = false;
      }),
    );
    const prior = await f.store.read();
    await fs.writeFile(path.join(f.store.directory, `state-${String(prior.revision + 1).padStart(6, '0')}.json`), '{');
    await assert.rejects(f.store.read());
  });
});
