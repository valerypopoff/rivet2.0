import test from 'node:test';
import assert from 'node:assert/strict';
import { HaReleaseGate, runHaReleaseRollout, validateHaCertificationManifest } from './kubernetes-ha-release-gate.mjs';
import { HaReleaseProbes } from './lib/ha-release-probes.mjs';
import { ProviderHaReleaseGate } from './kubernetes-ha-provider-gate.mjs';
import { verifyHaReleaseRecovery } from './lib/ha-release-recovery-probes.mjs';
import { parseAllDocuments } from 'yaml';
import { publishHaBrowserBaseline } from './lib/ha-browser-probe.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));

test('cross-owner notification fixture authenticates its streams and mutations as a UI operator', async () => {
  const key = 'disposable-notification-test-key';
  const hash = (suffix) => createHash('sha256').update(`${key}:${suffix}`).digest('hex');
  const streams = new Set();
  let revision = 1;
  let library = { migratedLegacyProjectIds: [] };
  let authenticated = 0;
  const server = createServer(async (req, res) => {
    if (req.headers['x-rivet-proxy-auth'] !== hash('proxy-auth') ||
        req.headers.cookie !== `rivet_ui_token=${hash('ui-session')}`) {
      res.writeHead(403).end();
      return;
    }
    authenticated++;
    const emit = (stream, event) => stream.write(`event: ${event}\ndata: ${JSON.stringify({ revision })}\n\n`);
    if (req.url.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.add(res);
      res.on('close', () => streams.delete(res));
      emit(res, 'snapshot');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    let result;
    if (req.url.endsWith('/library')) {
      if (req.method === 'PUT') {
        library = body.library;
        revision++;
        for (const stream of streams) emit(stream, 'library-changed');
      }
      result = { revision, library };
    } else {
      revision++;
      for (const stream of streams) emit(stream, 'tree-changed');
      result = { project: { relativePath: 'synthetic.rivet-project' } };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const child = spawn(process.execPath, [
      path.join(rootDir, 'deploy/studio-server/scripts/fixtures/ha-notification-probe.mjs'), 'localhost',
    ], {
      env: { ...process.env, PORT: String(server.address().port), RIVET_KEY: key, RIVET_HA_HEADLESS_SERVICE: '' },
      windowsHide: true,
      timeout: 20_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).directions.length, 2);
    assert.equal(authenticated, 14);
  } finally {
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recovery faults require the same approved context before traffic or cluster access', async () => {
  await assert.rejects(
    verifyHaReleaseRecovery(
      {
        assertProofContext: async () => {
          throw Error('unapproved recovery context');
        },
        requestWorkflow: async () => {
          throw Error('must not send traffic');
        },
        kubectl: async () => {
          throw Error('must not access cluster');
        },
      },
      'https://staging.example.test',
      rootDir,
    ),
    /unapproved recovery context/,
  );
});

test('shared HA rollout refuses an unapproved proof context before reading keys or changing resources', async () => {
  let touched = false;
  await assert.rejects(
    runHaReleaseRollout(
      {
        config: { images: {} },
        assertProofContext: async () => {
          throw Error('unapproved provider context');
        },
        loadWorkflowKey: async () => {
          touched = true;
        },
      },
      'https://staging.example.test',
    ),
    /unapproved provider context/,
  );
  assert.equal(touched, false);
});

test('provider proof reads the real managed database without creating a local PostgreSQL fixture', async () => {
  const queries = [];
  const probes = new HaReleaseProbes(
    {
      config: { namespace: 'rivet-staging-proof' },
      readProofSql: async (query) => {
        queries.push(query);
        return [{ accepted: true }];
      },
      kubectl: async () => {
        throw Error('local database must not be used');
      },
    },
    'https://staging.example.test',
    rootDir,
  );
  assert.deepEqual(await probes.sql('SELECT accepted'), [{ accepted: true }]);
  assert.deepEqual(queries, ['SELECT accepted']);
});

test('provider proof refuses a changed cluster endpoint, namespace UID or ownership label before mutation', async () => {
  for (const changed of ['endpoint', 'uid', 'label']) {
    const identity = {
      clusterServer: 'https://staging.gke.goog',
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      operation: 'staging-proof',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    const gate = new ProviderHaReleaseGate({ namespace: 'rivet-staging-proof' }, 'unused', 'unused', {
      values: {},
      identity,
    });
    gate.assertContext = async () => {};
    gate.kubectl = async (args) => ({
      stdout: JSON.stringify(
        args[0] === 'config'
          ? {
              clusters: [
                { cluster: { server: changed === 'endpoint' ? 'https://other.gke.goog' : identity.clusterServer } },
              ],
            }
          : {
              metadata: {
                uid: changed === 'uid' ? 'replacement' : identity.namespaceUid,
                labels: { 'rivet.dev/ha-rehearsal': changed === 'label' ? 'someone-else' : identity.operation },
              },
            },
      ),
    });
    await assert.rejects(gate.assertProofContext(), /changed|replaced|not owned/);
  }
});

test('provider proof cannot send its UI credentials to a different origin or execute SQL writes', async () => {
  const gate = new ProviderHaReleaseGate(
    { namespace: 'rivet-staging-proof', baseUrl: 'https://staging.example.test' },
    'unused',
    'unused',
    {
      values: {},
      identity: {
        clusterServer: 'https://staging.gke.goog',
        namespaceUid: '11111111-1111-4111-8111-111111111111',
        operation: 'staging-proof',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    },
  );
  assert.throws(() => gate.requestWorkflow('https://production.example.test', '/api/config'), /staging origin/);
  await assert.rejects(gate.readProofSql('DELETE FROM workflows'), /read-only/);
});

function providerFixture(config = {}, expiresAt = '2099-01-01T00:00:00Z') {
  return new ProviderHaReleaseGate({ namespace: 'rivet-staging-proof', ...config }, 'unused', 'unused', {
    values: {},
    identity: {
      clusterServer: 'https://staging.gke.goog',
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      operation: 'staging-proof',
      expiresAt,
    },
  });
}

test('provider close retains its operator namespace even when local cleanup is requested', async () => {
  const gate = providerFixture({ keepNamespace: false });
  gate.kubectl = async () => {
    throw Error('provider close must not access or delete infrastructure');
  };
  let stopped = 0;
  gate.portForward = {
    killed: false,
    kill() {
      this.killed = true;
      stopped++;
    },
  };
  await gate.close();
  await gate.close();
  assert.equal(stopped, 1);
  assert.equal(gate.config.keepNamespace, true);
});

test('expired provider rehearsal refuses work before contacting the cluster or reading credentials', async () => {
  const gate = providerFixture({}, '2000-01-01T00:00:00Z');
  gate.assertContext = gate.loadWorkflowKey = async () => {
    throw Error('must not contact resources');
  };
  await assert.rejects(gate.seed(), /expired/);
});

test('uncertain provider seed cannot replay any application mutation', async () => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-provider-seed-'));
  try {
    const gate = providerFixture({ artifactsDir });
    gate.assertProofContext = gate.loadWorkflowKey = async () => {};
    let writes = 0;
    gate.requestWorkflow = async () => {
      writes++;
      throw Error('lost response after acceptance');
    };
    await assert.rejects(gate.seed(), /lost response/);
    await assert.rejects(gate.seed(), { code: 'EEXIST' });
    assert.equal(writes, 1);
  } finally {
    await fs.rm(artifactsDir, { recursive: true, force: true });
  }
});

test('provider observations run inside a database read-only transaction even for SELECT with side effects', async () => {
  const gate = providerFixture({ release: 'rivet-staging-proof' });
  gate.kubectl = async (args) => {
    assert.ok(args.includes('rivet-staging-proof-ha-backend-0'));
    assert.match(args[args.indexOf('-e') + 1], /BEGIN READ ONLY/);
    assert.equal(args.at(-1), 'SELECT destructive_function()');
    return { stdout: '7' };
  };
  assert.equal(await gate.readProofSql('SELECT destructive_function()'), 7);
});

test('provider browser uses the ordinary authenticated session without following redirects', async () => {
  const gate = providerFixture({ baseUrl: 'https://staging.example.test' });
  gate.secrets = { rivetKey: 'test-only-key' };
  await gate.authenticateBrowser({
    request: {
      post: async (url, options) => {
        assert.equal(url, 'https://staging.example.test/__rivet_auth');
        assert.deepEqual(options, { data: { key: 'test-only-key' }, maxRedirects: 0 });
        return { status: () => 204 };
      },
    },
  });
  await assert.rejects(
    gate.authenticateBrowser({ request: { post: async () => ({ status: () => 302 }) } }),
    /real authenticated/,
  );
});

test('provider HTTP login uses the public proxy contract and retains only its session cookie', async () => {
  const server = createServer(async (req, res) => {
    if (req.url !== '/__rivet_auth') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(body), { key: 'test-only-key' });
    res
      .writeHead(204, { 'set-cookie': 'rivet_ui_token=test-only-session; Path=/; HttpOnly; Secure; SameSite=Lax' })
      .end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const gate = providerFixture({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    gate.providerValues.auth = { keySecretName: 'fixture' };
    gate.kubectl = async () => ({
      stdout: JSON.stringify({ data: { RIVET_KEY: Buffer.from('test-only-key').toString('base64') } }),
    });
    await gate.loadWorkflowKey();
    assert.deepEqual(gate.probeHeaders, { cookie: 'rivet_ui_token=test-only-session' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
function certificationFixture(predecessorRelease = null) {
  const images = Object.fromEntries(
    ['proxy', 'web', 'api', 'executor'].map((key, index) => [
      key,
      { repository: `example.test/rivet/${key}`, digest: `sha256:${String(index + 1).repeat(64)}` },
    ]),
  );
  const sourceSha = 'a'.repeat(40);
  const manifest = createStudioServerReleaseManifest({
    rootDir,
    source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: sourceSha },
    images,
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    predecessorRelease,
  });
  return { manifest, options: { rootDir, sourceSha, images, previous: predecessorRelease } };
}

test('HA certification accepts exact candidates without treating them as deployable releases', () => {
  const { manifest, options } = certificationFixture();
  assert.equal(validateHaCertificationManifest(manifest, options).mode, 'bootstrap');
  const reordered = Object.fromEntries(Object.entries(options.images).reverse());
  assert.equal(validateHaCertificationManifest(manifest, { ...options, images: reordered }).mode, 'bootstrap');
  const promoted = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  assert.throws(() => validateHaCertificationManifest(promoted, options), /requires a candidate/);
});

test('HA candidate preflight preserves source, chart, image and exact predecessor checks', () => {
  const { manifest, options } = certificationFixture();
  assert.throws(
    () => validateHaCertificationManifest(manifest, { ...options, sourceSha: 'b'.repeat(40) }),
    /current checkout/,
  );
  assert.throws(
    () =>
      validateHaCertificationManifest(
        {
          ...manifest,
          chart: { ...manifest.chart, contentDigest: `sha256:${'f'.repeat(64)}` },
        },
        options,
      ),
    /current Helm chart/,
  );
  assert.throws(
    () =>
      validateHaCertificationManifest(manifest, {
        ...options,
        images: { ...options.images, api: { ...options.images.api, digest: `sha256:${'f'.repeat(64)}` } },
      }),
    /HA images must match/,
  );
  const previous = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  const next = certificationFixture(previous);
  assert.equal(validateHaCertificationManifest(next.manifest, next.options).mode, 'bootstrap');
  assert.throws(
    () => validateHaCertificationManifest(next.manifest, { ...next.options, previous: null }),
    /predecessor/,
  );
});

test('disposable PostgreSQL really provides the HA fixture connection budget', async () => {
  const gate = new HaReleaseGate({ namespace: 'fixture' }, 'unused', 'unused');
  let postgres;
  gate.kubectl = async (args, extra) => {
    if (args[0] === 'get') return { stdout: 'local-node' };
    if (extra?.input)
      for (const doc of parseAllDocuments(extra.input)) {
        assert.equal(doc.errors.length, 0);
        const resource = doc.toJSON();
        if (resource?.kind === 'Deployment' && resource.metadata.name === 'release-gate-postgres')
          postgres = resource.spec.template.spec.containers[0];
      }
    return { stdout: '' };
  };
  gate.waitForDependency = async () => {};
  await gate.installDependencies();
  assert.deepEqual(postgres.args, ['postgres', '-c', 'max_connections=250']);
});

test('HA preparation never deletes or rotates Secrets in an existing namespace', async () => {
  const gate = new HaReleaseGate({ namespace: 'existing' }, 'unused', 'unused');
  const calls = [];
  gate.assertLocalContext = async () => {};
  gate.kubectl = async (args) => {
    calls.push(args);
    return { stdout: 'namespace/existing\n' };
  };
  gate.createNamespace = async () => {
    throw Error('must not mutate');
  };
  await assert.rejects(gate.prepare(), /fresh disposable namespace/);
  assert.deepEqual(calls, [['get', 'namespace', 'existing', '--ignore-not-found', '-o', 'name']]);
});

test('the local proof cannot select a production context, even when allow-context matches', async () => {
  const gate = new HaReleaseGate({ context: 'gke-production', allowedContext: 'gke-production' }, 'unused', 'unused');
  gate.kubectl = async () => {
    throw Error('must not access cluster');
  };
  await assert.rejects(gate.assertLocalContext(), /disposable local cluster/);
});

test('baseline publisher is isolated, digest-pinned and cleaned up after success or failure', async () => {
  for (const failure of [false, true]) {
    const calls = [];
    const gate = {
      config: { namespace: 'disposable', release: 'fixture' },
      assertLocalContext: async () => {},
      kubectl: async (args, options) => {
        const command = args[2];
        calls.push({ command, args, options });
        if (command === 'get')
          return {
            stdout: JSON.stringify({
              items: [
                {
                  status: { conditions: [{ type: 'Ready', status: 'True' }] },
                  spec: {
                    containers: [
                      {
                        name: 'web',
                        image: 'current',
                        lifecycle: { preStop: { exec: { command: ['sleep', '120'] } } },
                        env: [{ name: 'RIVET_WEB_ASSETS_INSTALLATION', value: 'disposable/fixture' }],
                      },
                    ],
                  },
                },
              ],
            }),
          };
        if (command === 'exec') {
          if (failure) throw Error('publication failed');
          return { stdout: 'a'.repeat(64) };
        }
        return { stdout: '' };
      },
    };
    const image = { repository: 'registry/web', digest: `sha256:${'b'.repeat(64)}` };
    if (failure) await assert.rejects(publishHaBrowserBaseline(gate, image), /publication failed/);
    else assert.deepEqual(await publishHaBrowserBaseline(gate, image), { ...image, build: 'a'.repeat(64) });
    const pod = JSON.parse(calls.find((c) => c.command === 'create').options.input);
    assert.equal(pod.spec.containers[0].image, `${image.repository}@${image.digest}`);
    assert.equal(pod.spec.containers[0].lifecycle, undefined, 'non-serving publisher needs no edge-drain hook');
    assert.equal(pod.metadata.labels, undefined, 'publisher must not enter a release Service');
    assert.equal(calls.at(-1).command, 'delete');
  }
});
