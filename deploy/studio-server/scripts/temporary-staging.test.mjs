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
import {
  temporaryAdmission,
  temporaryBinding,
  verifyTemporaryPlan,
  temporaryExpiry,
} from './lib/temporary-staging-contract.mjs';
import { TemporaryStagingStore } from './lib/temporary-staging-store.mjs';
import {
  temporaryGcp,
  temporaryFoundationSpecs,
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
const wait = async (label, check) => {
  for (let i = 0; i < 4; i++) if (await check()) return;
  throw Error(`Local waiter blocked: ${label}`);
};
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
  await fs.writeFile(path.join(source, 'historical-only.txt'), 'historical content must not enter the image');
  git('add', '.');
  git('commit', '-m', 'history');
  git('rm', 'historical-only.txt');
  const dockerfile = path.join(source, 'deploy/studio-server/images/qualification/Dockerfile');
  await fs.mkdir(path.dirname(dockerfile), { recursive: true });
  await fs.writeFile(dockerfile, 'FROM scratch\n');
  await fs.writeFile(path.join(source, 'committed-text.txt'), 'first line\nsecond line\n');
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
  for (const name of ['.private', 'historical-only.txt'])
    await assert.rejects(fs.stat(path.join(checkout, name)), { code: 'ENOENT' });
});

test('actor dependency installation preserves tracked source when switching Yarn to node-modules', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-actor-dependencies-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, '.yarn/releases'), { recursive: true });
  const yarn = path.join(temp, '.yarn/releases/yarn-4.17.1.cjs');
  await fs.copyFile(fileURLToPath(new URL('../../../.yarn/releases/yarn-4.17.1.cjs', import.meta.url)), yarn);
  await fs.writeFile(
    path.join(temp, 'package.json'),
    JSON.stringify({ name: 'isolated-actor-fixture', private: true, packageManager: 'yarn@4.17.1' }),
  );
  await fs.writeFile(path.join(temp, '.yarnrc.yml'), 'pnpEnableEsmLoader: true\n');
  await fs.writeFile(path.join(temp, '.gitignore'), 'node_modules/\n.yarn/install-state.gz\n');
  const env = { ...process.env, YARN_ENABLE_NETWORK: '0', YARN_ENABLE_TELEMETRY: '0', YARN_NODE_LINKER: 'pnp' };
  const runYarn = (args) => execFileSync(process.execPath, [yarn, ...args], { cwd: temp, env, stdio: 'pipe' });
  runYarn(['install']);
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
  await installActorDependencies(temp, sourceSha, { env });
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
  // Exercise the Dockerfile's actual CLI entry, including a repeated install.
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../images/qualification/install-dependencies.mjs', import.meta.url)), sourceSha],
    { cwd: temp, env, stdio: 'pipe' },
  );
  assert.equal(git('status', '--porcelain'), '');
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
        assert.equal((await f.control('_requests')).filter((r) => r.method === 'POST').length, 1);
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
