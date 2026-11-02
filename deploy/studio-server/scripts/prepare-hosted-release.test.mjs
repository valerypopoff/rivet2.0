import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { prepareHostedRelease } from './prepare-hosted-release.mjs';
import { waitForStagingJanitor, observeStagingJanitor } from './lib/staging-janitor-health.mjs';

// test-style: fixture-read: checks only generated private job configuration and packages.
async function fixture(t, failedStep) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-hosted-prepare-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sha = 'a'.repeat(40),
    digest = `sha256:${'b'.repeat(64)}`;
  const configuration = {
    protocol: 1,
    evidenceBucket: 'fixture-evidence',
    janitorServiceAccount: 'janitor@isolated-staging.iam.gserviceaccount.com',
    production: {
      projectId: 'production-fixture',
      clusterName: 'production-cluster',
      region: 'europe-central2',
      context: 'production-context',
      namespace: 'rivet',
      release: 'rivet',
      namespaceUid: 'production-uid',
      valuesDigest: digest,
    },
    staging: {
      protocol: 1,
      mode: 'reusable-cluster',
      projectId: 'isolated-staging',
      projectNumber: '123456',
      clusterName: 'staging-cluster',
      region: 'europe-central2',
      clusterUid: 'staging-uid',
      context: 'staging-context',
      clusterServer: 'https://staging.invalid',
      controlNamespace: 'test-control',
      runnerNamespace: 'test-runner',
      gatewayNamespace: 'test-gateway',
      gatewayName: 'gateway',
      gatewayUid: 'gateway-uid',
      storageClassName: 'standard-rwo',
      domain: 'qualification.example.test',
      trustedClients: ['198.51.100.0/24'],
      trustedForwardingProxies: ['172.30.32.0/23', '192.0.2.1/32'],
      postgresImage: `registry.test/postgres@${digest}`,
    },
  };
  const publication = {
    protocol: 1,
    sourceSha: sha,
    ...Object.fromEntries(
      [
        ['actor', 'qualification'],
        ['minio', 'qualification-minio'],
        ['janitor', 'qualification-janitor'],
      ].map(([key, name]) => [key, { image: `ghcr.io/owner/repo-studio-server/${name}@${digest}` }]),
    ),
  };
  const publicationFile = path.join(directory, 'publication.json'),
    jobEnv = path.join(directory, 'job.env');
  const environment = {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: 'Owner/Repo',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: directory,
    GITHUB_ENV: jobEnv,
    RIVET_QUALIFICATION_MAX_SECONDS: '7200',
  };
  const events = [];
  const action = (step) => {
    // Local compilation and exact janitor update validation must precede every
    // provider command, lock acquisition and remote evidence write.
    const job = path.join(directory, 'rivet-staging');
    assert.ok(existsSync(path.join(job, 'package/driver/provider.mjs')));
    assert.ok(existsSync(path.join(job, 'package/driver/driver.json')));
    const update = parseAllDocuments(readFileSync(path.join(job, 'janitor-update.yaml'), 'utf8')).map((d) => d.toJS());
    assert.deepEqual(
      update.map((item) => item.kind),
      ['ConfigMap', 'Deployment'],
    );
    events.push(step);
    if (step === failedStep) throw new Error(`fixture ${step} failure`);
  };
  return {
    configuration,
    publication,
    registries: [],
    registryContinuation: undefined,
    pendingHealthReads: 0,
    events,
    jobEnv,
    async prepare() {
      await fs.writeFile(publicationFile, JSON.stringify(publication));
      return prepareHostedRelease('staging', {
        environment: { ...environment, RIVET_DEPLOYMENT_CONFIGURATION: JSON.stringify(configuration) },
        publicationFile,
        run: (bin, args) => {
          const step =
            bin === 'gcloud'
              ? 'credentials'
              : args.includes('get')
                ? args.includes('-l')
                  ? 'registries'
                  : args.includes('configmaps')
                    ? 'janitor-health'
                    : args.includes('pods')
                      ? 'janitor-owner'
                      : 'cluster-identity'
                : args.includes('apply')
                  ? 'apply'
                  : 'rollout';
          action(step);
          if (step === 'registries')
            return JSON.stringify({ items: this.registries, metadata: { continue: this.registryContinuation } });
          if (step === 'janitor-health') {
            if (this.pendingHealthReads-- > 0) return JSON.stringify({ data: { health: '{}' } });
            const digest = JSON.parse(
              readFileSync(path.join(directory, 'rivet-staging/package/package.json'), 'utf8'),
            ).driverDigest;
            return JSON.stringify({
              data: {
                health: JSON.stringify({
                  clusterUid: 'staging-uid',
                  driverDigest: digest,
                  observedAt: Date.now(),
                  podName: 'janitor',
                  podUid: 'janitor-uid',
                }),
              },
            });
          }
          if (step === 'janitor-owner')
            return JSON.stringify({
              metadata: { uid: 'janitor-uid' },
              status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
            });
          if (step === 'cluster-identity')
            return JSON.stringify({
              metadata: { uid: failedStep === 'wrong-cluster' ? 'foreign-cluster' : 'staging-uid' },
            });
          return '';
        },
        cloudEvidence: () => ({
          acquire: async () => {
            action('acquire');
            return '51';
          },
          saveDirectory: async () => action('upload'),
          release: async () => action('release'),
        }),
      });
    },
  };
}

test('hosted staging compiles and validates the local package before accessing the provider or lock', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  assert.deepEqual(f.events, [
    'credentials',
    'credentials',
    'cluster-identity',
    'acquire',
    'registries',
    'upload',
    'apply',
    'rollout',
    'janitor-health',
    'janitor-owner',
  ]);
  const jobEnv = await fs.readFile(f.jobEnv, 'utf8');
  assert.match(jobEnv, /RIVET_QUALIFICATION_LOCK_GENERATION=51\n/);
  assert.ok(!jobEnv.includes('RIVET_DEPLOYMENT_CONFIGURATION'));
});

test('bad local publication, settings or environment cannot strand the shared lock', async (t) => {
  for (const change of ['source', 'janitor-image', 'service-account', 'routing', 'environment', 'cluster-identity'])
    await t.test(change, async (t) => {
      const f = await fixture(t);
      if (change === 'source') f.publication.sourceSha = 'c'.repeat(40);
      if (change === 'janitor-image') f.publication.janitor.image = 'registry.test/unreviewed:latest';
      if (change === 'service-account')
        f.configuration.janitorServiceAccount = 'janitor@foreign-project.iam.gserviceaccount.com';
      if (change === 'routing') f.configuration.staging.trustedForwardingProxies = [];
      if (change === 'environment') f.configuration.production.context = 'unexpected\nGITHUB_ENV=injection';
      if (change === 'cluster-identity') delete f.configuration.staging.clusterName;
      await assert.rejects(f.prepare());
      assert.deepEqual(f.events, []);
      assert.equal(existsSync(f.jobEnv), false);
    });
});

test('provider failures do not retry mutations or release a lock with uncertain shared changes', async (t) => {
  for (const step of [
    'credentials',
    'cluster-identity',
    'acquire',
    'registries',
    'upload',
    'apply',
    'rollout',
    'janitor-health',
    'janitor-owner',
  ])
    await t.test(step, async (t) => {
      const f = await fixture(t, step);
      await assert.rejects(f.prepare(), new RegExp(`fixture ${step} failure`));
      assert.equal(f.events.at(-1), step);
      assert.equal(f.events.filter((event) => event === step).length, 1);
      assert.ok(!f.events.includes('release'));
      assert.equal(existsSync(f.jobEnv), false);
    });
});

test('a valid-looking context for the wrong cluster stops before locking or Kubernetes writes', async (t) => {
  const f = await fixture(t, 'wrong-cluster');
  await assert.rejects(f.prepare(), /another cluster/);
  assert.deepEqual(f.events, ['credentials', 'credentials', 'cluster-identity']);
  assert.equal(existsSync(f.jobEnv), false);
});

test('an unresolved or incomplete staging inventory preserves the existing cleanup worker', async (t) => {
  for (const mode of ['active', 'incomplete', 'malformed'])
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      if (mode === 'active') f.registries = [{ data: { record: JSON.stringify({ phase: 'deleting', closed: true }) } }];
      if (mode === 'malformed') f.registries = [{ data: { record: 'invalid-json' } }];
      if (mode === 'incomplete') f.registryContinuation = 'next';
      await assert.rejects(f.prepare());
      assert.equal(f.events.at(-1), 'registries');
      assert.ok(!f.events.includes('apply') && !f.events.includes('release'));
    });
});

test('verified old operations do not block a new worker and startup waits for its first heartbeat', async (t) => {
  const f = await fixture(t);
  f.registries = [{ data: { record: JSON.stringify({ cleanupVerified: true, phase: 'cleaned', closed: true }) } }];
  f.pendingHealthReads = 1;
  await f.prepare();
  assert.equal(f.events.filter((step) => step === 'janitor-health').length, 2);
  assert.equal(f.events.at(-1), 'janitor-owner');
});

test('janitor health polling has a deadline and never retries denied reads', async () => {
  const settings = { clusterUid: 'cluster' };
  await assert.rejects(
    waitForStagingJanitor(async () => null, settings, 'driver', { timeoutMs: 10, intervalMs: 1 }),
    /not freshly healthy/,
  );
  let reads = 0;
  await assert.rejects(
    waitForStagingJanitor(
      async () => {
        reads++;
        throw new Error('fixture denied read');
      },
      settings,
      'driver',
    ),
    /denied read/,
  );
  assert.equal(reads, 1);
  let clock = 1000;
  assert.equal(
    await observeStagingJanitor(
      async (resource) => {
        if (resource === 'configmaps')
          return {
            data: {
              health: JSON.stringify({
                clusterUid: 'cluster',
                driverDigest: 'driver',
                podName: 'janitor',
                podUid: 'uid',
                observedAt: 1000,
              }),
            },
          };
        clock += 60000;
        return {
          metadata: { uid: 'uid' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        };
      },
      settings,
      'driver',
      () => clock,
    ),
    undefined,
    'Health that expires during the Pod read cannot admit an operation',
  );
});

test('production preparation preserves its pinned read-only installation fetch and private adapter files', async (t) => {
  const f = await fixture(t),
    directory = path.dirname(f.jobEnv);
  f.configuration.installationUri = 'gs://fixture-evidence/installation.json#17';
  const installation = {
    valuesBase64: Buffer.from('{"fixture":true}').toString('base64'),
    adapters: {
      backup: Buffer.from('export const fixture = "backup";').toString('base64'),
      acceptance: Buffer.from('export const fixture = "acceptance";').toString('base64'),
    },
    policy: { backup: {}, acceptance: {} },
  };
  const environment = {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: directory,
    GITHUB_ENV: f.jobEnv,
    RIVET_DEPLOYMENT_CONFIGURATION: JSON.stringify(f.configuration),
  };
  const commands = [];
  await prepareHostedRelease('production', {
    environment,
    cloudEvidence: () => {
      throw new Error('Production preparation must not claim a staging lock');
    },
    run: (bin, args, commandEnvironment) => {
      assert.equal(bin, 'gcloud');
      commands.push(args);
      if (args.includes('get-credentials')) assert.equal(commandEnvironment.RIVET_DEPLOYMENT_CONFIGURATION, undefined);
      else {
        assert.deepEqual(args.slice(0, 3), ['storage', 'cp', f.configuration.installationUri]);
        writeFileSync(args[3], JSON.stringify(installation));
      }
      return '';
    },
  });
  assert.equal(commands.length, 2);
  const job = path.join(directory, 'rivet-production');
  assert.equal(await fs.readFile(path.join(job, 'values.json'), 'utf8'), '{"fixture":true}');
  assert.equal(await fs.readFile(path.join(job, 'backup.mjs'), 'utf8'), 'export const fixture = "backup";');
  const policy = JSON.parse(await fs.readFile(path.join(job, 'policy.json'), 'utf8'));
  assert.equal(policy.backup.script, 'backup.mjs');
  assert.equal(policy.acceptance.script, 'acceptance.mjs');
  assert.equal(environment.RIVET_DEPLOYMENT_CONFIGURATION, undefined);
});
