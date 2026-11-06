import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { prepareHostedRelease, cleanupHostedStagingSetup } from './prepare-hosted-release.mjs';
import { waitForStagingJanitor, observeStagingJanitor } from './lib/staging-janitor-health.mjs';
import { stagingCoordinatorControlRole, stagingCoordinatorRunnerRole } from './lib/staging-coordinator-access.mjs';
import { spawnSync } from 'node:child_process';

const setupCause = (error) => (error.cause instanceof AggregateError ? error.cause.errors[0] : error.cause ?? error);

test('hosted sizing binds the explicit requests to the existing driver and cannot prepare production', async (t) => {
  const f = await fixture(t);
  const requests = { web: { cpu: '50m', memory: '128Mi' }, proxy: { cpu: '100m', memory: '128Mi' } };
  Object.assign(f.environment, {
    RIVET_QUALIFICATION_SIZING_REQUESTS: JSON.stringify(requests),
    RIVET_QUALIFICATION_DEPLOY_PRODUCTION: 'false',
  });
  f.configuration.staging.requestContinuityProfile = {};
  f.configuration.staging.developerOverlapProfile = {};
  await f.prepare();
  const settings = JSON.parse(
    await fs.readFile(path.join(path.dirname(f.setupFile), 'package/driver/settings.json'), 'utf8'),
  );
  assert.deepEqual(settings.sizingRequests, requests);
  assert.equal(settings.requestContinuityProfile, undefined);
  assert.equal(settings.developerOverlapProfile, undefined);
  await assert.rejects(prepareHostedRelease('production', { environment: { ...f.environment } }), (e) =>
    /cannot prepare production/.test(setupCause(e).message),
  );
});

test('hosted sizing rejects production-enabled input before credentials or shared writes', async (t) => {
  const f = await fixture(t);
  Object.assign(f.environment, {
    RIVET_QUALIFICATION_SIZING_REQUESTS: '{}',
    RIVET_QUALIFICATION_DEPLOY_PRODUCTION: 'true',
  });
  await assert.rejects(f.prepare(), (e) => /deployment disabled/.test(setupCause(e).message));
  assert.deepEqual(f.events, []);
});

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
    newHealthReads: 0,
    actorPods: [],
    actorJob: null,
    admittedRegistry: null,
    controlRole: stagingCoordinatorControlRole('test-control'),
    runnerRole: stagingCoordinatorRunnerRole('test-runner'),
    deployment: {
      metadata: { uid: 'janitor-deployment', generation: 1 },
      status: { observedGeneration: 1, availableReplicas: 1, updatedReplicas: 1 },
      spec: { template: { spec: { containers: [{ image: 'old-janitor' }], volumes: [] } } },
    },
    events,
    environment,
    jobEnv,
    setupFile: path.join(directory, 'rivet-staging/staging-setup.json'),
    cleanup() {
      return cleanupHostedStagingSetup({ environment, run: this.run, cloudEvidence: this.cloudEvidence });
    },
    async prepare() {
      await fs.writeFile(publicationFile, JSON.stringify(publication));
      return prepareHostedRelease('staging', {
        environment: { ...environment, RIVET_DEPLOYMENT_CONFIGURATION: JSON.stringify(configuration) },
        publicationFile,
        run: (this.run = (bin, args) => {
          const ns = args[args.indexOf('--namespace') + 1];
          const allowed = (verb, resource) => {
            const [name, ...group] = resource.split('.');
            const apiGroup = group.join('.') || ({ deployments: 'apps', jobs: 'batch' }[name] ?? '');
            const role = ns === 'test-control' ? this.controlRole : this.runnerRole;
            return role.rules.some(
              (r) => r.apiGroups.includes(apiGroup) && r.resources.includes(name) && r.verbs.includes(verb),
            );
          };
          if (args.includes('can-i')) {
            action('permission');
            assert.ok(!args.includes('--as'), 'Preflight must use the real caller');
            const at = args.indexOf('can-i');
            const subresource = args.find((arg) => arg.startsWith('--subresource='))?.split('=')[1];
            const resource = args[at + 2] + (subresource ? `/${subresource}` : '');
            if (this.noPermissionAnswer) return 'no';
            if (!allowed(args[at + 1], resource)) throw new Error('forbidden: staging setup permission denied');
            return 'yes';
          }
          if (args.includes('get') && ['test-control', 'test-runner'].includes(ns)) {
            assert.ok(
              allowed('get', args[args.indexOf('get') + 1]),
              'Runtime read is not covered by the installed namespace Role',
            );
          }
          const step =
            bin === 'gcloud'
              ? 'credentials'
              : args.includes('get')
                ? args.includes('-l')
                  ? args.includes('pods')
                    ? 'actor-pods'
                    : 'registries'
                  : args.includes('configmaps')
                    ? args.includes('rivet-qualification-janitor-health')
                      ? 'janitor-health'
                      : 'operation-registry'
                    : args.includes('pods')
                      ? 'janitor-owner'
                      : args.includes('deployments')
                        ? 'janitor-deployment'
                        : args.includes('jobs')
                          ? 'actor-job'
                          : 'cluster-identity'
                : args.includes('apply')
                  ? 'apply'
                  : 'rollout';
          action(step);
          if (step === 'registries')
            return JSON.stringify({ items: this.registries, metadata: { continue: this.registryContinuation } });
          if (step === 'actor-pods') return JSON.stringify({ items: this.actorPods });
          if (step === 'actor-job') return this.actorJob ? JSON.stringify(this.actorJob) : '';
          if (step === 'operation-registry') return this.admittedRegistry ? JSON.stringify(this.admittedRegistry) : '';
          if (step === 'janitor-deployment') return JSON.stringify(this.deployment);
          if (step === 'janitor-health') {
            if (this.updated) this.newHealthReads++;
            if (this.updated && this.pendingHealthReads-- > 0) return JSON.stringify({ data: { health: '{}' } });
            const digest = this.updated
              ? JSON.parse(readFileSync(path.join(directory, 'rivet-staging/package/package.json'), 'utf8'))
                  .driverDigest
              : 'd'.repeat(64);
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
              status: {
                phase: 'Running',
                conditions: [{ type: 'Ready', status: this.unreadyJanitor ? 'False' : 'True' }],
              },
            });
          if (step === 'cluster-identity')
            return JSON.stringify({
              metadata: { uid: failedStep === 'wrong-cluster' ? 'foreign-cluster' : 'staging-uid' },
            });
          if (step === 'apply') {
            const update = parseAllDocuments(readFileSync(args[args.indexOf('-f') + 1], 'utf8')).map((d) => d.toJS());
            this.deployment.spec = update.find((o) => o.kind === 'Deployment').spec;
            this.deployment.metadata.generation++;
            this.deployment.status.observedGeneration++;
            this.updated = true;
            this.afterApply?.(this.deployment);
            if (this.loseApplyAcknowledgement) throw new Error('fixture apply acknowledgement lost');
          }
          return '';
        }),
        cloudEvidence: (this.cloudEvidence = () => ({
          acquire: async () => {
            action('acquire');
            this.lockGeneration = '51';
            this.afterAcquire?.();
            return '51';
          },
          saveDirectory: async () => action('upload'),
          put: async (name, bytes) => {
            action('receipt');
            this.privateEvidence ??= [];
            this.privateEvidence.push({ name, bytes });
            if (this.failEvidence) throw new Error('fixture evidence failure');
          },
          assertOwner: async (generation) => {
            action('assert-owner');
            assert.equal(generation, this.lockGeneration);
          },
          release: async (generation) => {
            action('release');
            assert.equal(generation, this.lockGeneration);
            this.lockGeneration = undefined;
          },
          assertReleased: async () => {
            action('lock-absent');
            assert.equal(this.lockGeneration, undefined);
          },
        })),
      });
    },
  };
}

test('hosted staging compiles and validates the local package before accessing the provider or lock', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  for (const [first, next] of [
    ['credentials', 'permission'],
    ['permission', 'acquire'],
    ['acquire', 'apply'],
    ['apply', 'rollout'],
  ])
    assert.ok(f.events.indexOf(first) < f.events.indexOf(next));
  const receipt = JSON.parse(await fs.readFile(f.setupFile, 'utf8'));
  assert.equal(receipt.writerClosed, true);
  assert.equal(receipt.updateAcknowledged, true);
  assert.equal(f.lockGeneration, '51', 'Normal execution inherits the setup lock');
  const jobEnv = await fs.readFile(f.jobEnv, 'utf8');
  assert.match(jobEnv, /RIVET_QUALIFICATION_LOCK_GENERATION=51\n/);
  assert.ok(!jobEnv.includes('RIVET_DEPLOYMENT_CONFIGURATION'));
});

test('the administrator Role grants only Pod GET and the renderer never applies access', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.controlRole.rules.filter((rule) => rule.resources.includes('pods')),
    [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
  );
  assert.ok(
    f.controlRole.rules.every(
      (rule) => !rule.resources.some((resource) => resource.includes('/') || resource === 'secrets'),
    ),
  );
  const output = path.join(f.environment.RUNNER_TEMP, 'role.json');
  const render = () =>
    spawnSync(
      process.execPath,
      ['deploy/studio-server/scripts/render-staging-coordinator-access.mjs', 'test-control', output],
      { encoding: 'utf8', windowsHide: true },
    );
  assert.equal(render().status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), f.controlRole);
  assert.notEqual(render().status, 0, 'Rendering must not overwrite a prior reviewed file');
});

test('missing runtime Pod-read access fails as CI before locking or any shared write', async (t) => {
  const f = await fixture(t);
  f.controlRole.rules = f.controlRole.rules.filter((rule) => !rule.resources.includes('pods'));
  await assert.rejects(f.prepare(), /permissions \(permission_denied\)/);
  assert.ok(f.events.includes('permission'));
  assert.ok(!f.events.some((event) => ['acquire', 'apply', 'upload'].includes(event)));
  assert.equal((await f.cleanup()).state, 'not-started');
  const diagnostic = JSON.parse(
    await fs.readFile(path.join(path.dirname(f.setupFile), 'preparation-failure.json'), 'utf8'),
  );
  assert.equal(diagnostic.phase, 'permissions');
  assert.match(diagnostic.error.message, /forbidden/);
  assert.ok(f.privateEvidence.some((item) => item.name.endsWith('preparation-failure.json')));
});

test('missing actor creation, exec or cleanup access fails before shared setup', async (t) => {
  for (const [verb, resource] of [
    ['create', 'jobs'],
    ['delete', 'jobs'],
    ['get', 'pods'],
    ['get', 'pods/exec'],
    ['create', 'pods/exec'],
  ])
    await t.test(`${verb} ${resource}`, async (t) => {
      const f = await fixture(t);
      const rule = f.runnerRole.rules.find((rule) => rule.resources.includes(resource));
      rule.verbs = rule.verbs.filter((value) => value !== verb);
      await assert.rejects(f.prepare(), /permissions \(permission_denied\)/);
      assert.ok(!f.events.some((event) => ['acquire', 'apply', 'upload'].includes(event)));
    });
});

test('a negative permission answer preserves the exact denied check privately', async (t) => {
  const f = await fixture(t);
  f.noPermissionAnswer = true;
  await assert.rejects(f.prepare(), (error) => {
    assert.match(error.message, /permissions \(permission_denied\)/);
    assert.match(setupCause(error).message, /get pods.*test-control/);
    return true;
  });
});

test('a successful apply cannot acknowledge a different cleanup-worker image or code', async (t) => {
  for (const change of ['image', 'code', 'unmounted-code'])
    await t.test(change, async (t) => {
      const f = await fixture(t);
      f.afterApply = (deployment) => {
        if (change === 'image') deployment.spec.template.spec.containers[0].image = 'registry.test/wrong:latest';
        else if (change === 'unmounted-code') {
          const code = deployment.spec.template.spec.volumes[0];
          deployment.spec.template.spec.volumes = [
            { ...code, configMap: { name: 'wrong-code' } },
            { ...code, name: 'unused' },
          ];
        } else deployment.spec.template.spec.volumes = [];
      };
      await assert.rejects(f.prepare(), /janitor-update/);
      assert.ok(!f.events.includes('rollout'));
      assert.equal(existsSync(f.jobEnv), false);
      await assert.rejects(f.cleanup());
      assert.ok(!f.events.includes('release'));
    });
});

test('cleanup-worker identity follows the named container and its mounted code', async (t) => {
  const f = await fixture(t);
  f.afterApply = (deployment) =>
    deployment.spec.template.spec.containers.unshift({ name: 'sidecar', image: 'registry.test/sidecar:fixture' });
  await f.prepare();
  assert.equal((await f.cleanup()).state, 'closed');
});

test('failed pre-operation setup closes only its known lock after fresh health and absence checks', async (t) => {
  for (const step of ['upload', 'rollout'])
    await t.test(step, async (t) => {
      const f = await fixture(t, step);
      await assert.rejects(f.prepare());
      assert.equal((await f.cleanup()).state, 'closed');
      assert.equal(f.lockGeneration, undefined);
      assert.ok(f.events.indexOf('actor-job') < f.events.indexOf('release'));
      assert.ok(f.events.indexOf('actor-pods') < f.events.indexOf('release'));
      assert.ok(f.events.indexOf('assert-owner') < f.events.indexOf('release'));
      assert.equal(f.events.at(-1), 'lock-absent');
      assert.equal((await f.cleanup()).state, 'closed');
      assert.equal(f.events.filter((event) => event === 'release').length, 1);
      assert.equal(f.events.filter((event) => event === 'apply').length, step === 'upload' ? 0 : 1);
    });
});

test('unknown acquire or apply acknowledgements retain the setup lock without replay', async (t) => {
  for (const step of ['acquire', 'apply', 'applied-but-unacknowledged'])
    await t.test(step, async (t) => {
      const f = await fixture(t, step === 'applied-but-unacknowledged' ? undefined : step);
      f.loseApplyAcknowledgement = step === 'applied-but-unacknowledged';
      await assert.rejects(f.prepare());
      await assert.rejects(f.cleanup(), (error) => {
        assert.match(setupCause(error).message, /uncertain/);
        return true;
      });
      assert.ok(!f.events.includes('release'));
      assert.equal(f.events.filter((event) => event === 'acquire').length, 1);
      assert.ok(f.events.filter((event) => event === 'apply').length <= 1);
      if (step === 'applied-but-unacknowledged') assert.equal(f.updated, true);
      assert.ok(f.privateEvidence.some((item) => item.name.endsWith('setup-closure-failure.json')));
    });
});

test('changed ownership, admitted work or unhealthy setup prevents lock release', async (t) => {
  for (const change of [
    'lock',
    'deployment-uid',
    'terminating-worker',
    'spec',
    'actor-job',
    'actor-pods',
    'registry',
    'inventory',
    'janitor',
    'writer',
  ])
    await t.test(change, async (t) => {
      const f = await fixture(t, 'rollout');
      await assert.rejects(f.prepare());
      if (change === 'lock') f.lockGeneration = '52';
      if (change === 'deployment-uid') f.deployment.metadata.uid = 'foreign-worker';
      if (change === 'terminating-worker') f.deployment.metadata.deletionTimestamp = new Date().toISOString();
      if (change === 'spec') f.deployment.spec.template.metadata.labels.unreviewed = 'changed';
      if (change === 'actor-job') f.actorJob = { metadata: { uid: 'actor' } };
      if (change === 'actor-pods') f.actorPods = [{ metadata: { uid: 'actor' } }];
      if (change === 'registry') f.admittedRegistry = { data: { record: '{}' } };
      if (change === 'inventory') f.registryContinuation = 'next-page';
      if (change === 'janitor') f.unreadyJanitor = true;
      if (change === 'writer') {
        const receipt = JSON.parse(await fs.readFile(f.setupFile, 'utf8'));
        receipt.writerClosed = false;
        await fs.writeFile(f.setupFile, JSON.stringify(receipt));
      }
      await assert.rejects(f.cleanup(), /setup-closure/);
      assert.ok(!f.events.includes('release'));
      assert.equal(f.events.filter((event) => event === 'apply').length, 1);
    });
});

test('CLI keeps configuration parse errors private and reports a safe phase', async (t) => {
  const f = await fixture(t);
  const sentinel = 's3cret';
  const result = spawnSync(
    process.execPath,
    ['.yarn/releases/yarn-4.17.1.cjs', 'node', 'deploy/studio-server/scripts/prepare-hosted-release.mjs', 'staging'],
    {
      env: { ...process.env, ...f.environment, RIVET_DEPLOYMENT_CONFIGURATION: sentinel },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /configuration \(setup_failed\)/);
  assert.ok(!(result.stdout + result.stderr).includes(sentinel));
  const diagnostic = await fs.readFile(path.join(path.dirname(f.setupFile), 'preparation-failure.json'), 'utf8');
  assert.ok(diagnostic.includes(sentinel));
});

test('failed private evidence persistence preserves both causes without exposing them publicly', async (t) => {
  const f = await fixture(t);
  f.controlRole.rules = f.controlRole.rules.filter((rule) => !rule.resources.includes('pods'));
  f.failEvidence = true;
  await assert.rejects(f.prepare(), (error) => {
    assert.match(error.message, /permissions \(permission_denied\)/);
    assert.ok(!/forbidden|fixture/.test(error.message));
    assert.ok(error.cause instanceof AggregateError);
    assert.match(error.cause.errors[0].message, /forbidden/);
    assert.match(error.cause.errors[1].message, /evidence failure/);
    return true;
  });
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
      await assert.rejects(f.prepare(), (error) => {
        assert.match(error.cause.message, new RegExp(`fixture ${step} failure`));
        return true;
      });
      assert.equal(f.events.filter((e) => e !== 'receipt').at(-1), step);
      assert.equal(f.events.filter((event) => event === step).length, 1);
      assert.ok(!f.events.includes('release'));
      assert.equal(existsSync(f.jobEnv), false);
      if (step === 'credentials')
        assert.ok(
          f.privateEvidence.some((item) => item.name.endsWith('preparation-failure.json')),
          'Cluster credential failures must also survive hosted-runner loss',
        );
    });
});

test('a valid-looking context for the wrong cluster stops before locking or Kubernetes writes', async (t) => {
  const f = await fixture(t, 'wrong-cluster');
  await assert.rejects(f.prepare(), (error) => {
    assert.match(error.cause.message, /another cluster/);
    return true;
  });
  assert.deepEqual(
    f.events.filter((e) => e !== 'receipt'),
    ['credentials', 'credentials', 'cluster-identity'],
  );
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
      assert.equal(f.events.filter((e) => e !== 'receipt').at(-1), 'registries');
      assert.ok(!f.events.includes('acquire') && !f.events.includes('apply') && !f.events.includes('release'));
      assert.equal((await f.cleanup()).state, 'not-started');
    });
});

test('staging inventory is rechecked under the acquired lock before changing the worker', async (t) => {
  const f = await fixture(t);
  f.afterAcquire = () => {
    f.registries = [{ data: { record: JSON.stringify({ phase: 'running' }) } }];
  };
  await assert.rejects(f.prepare(), /registry/);
  assert.ok(f.events.includes('acquire'));
  assert.equal(f.events.filter((event) => event === 'registries').length, 2);
  assert.ok(!f.events.includes('apply'));
  await assert.rejects(f.cleanup());
  assert.ok(!f.events.includes('release'));
});

test('verified old operations do not block a new worker and startup waits for its first heartbeat', async (t) => {
  const f = await fixture(t);
  f.registries = [{ data: { record: JSON.stringify({ cleanupVerified: true, phase: 'cleaned', closed: true }) } }];
  f.pendingHealthReads = 1;
  await f.prepare();
  assert.equal(f.newHealthReads, 2);
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

for (const profile of ['legacy', 'one-proxy', 'wrong-hash', 'mixed-policy'])
  test(`production preparation preserves its pinned installation and rejects target drift: ${profile}`, async (t) => {
    const f = await fixture(t),
      directory = path.dirname(f.jobEnv);
    f.configuration.installationUri = 'gs://fixture-evidence/installation.json#17';
    const installation = {
      valuesBase64: Buffer.from(
        JSON.stringify(
          profile === 'legacy'
            ? { fixture: true }
            : {
                replicaCount: { proxy: 1 },
                autoscaling: { proxy: { minReplicas: 1 } },
                availability: { topologySpread: { minDomains: profile === 'mixed-policy' ? 2 : 1 } },
              },
        ),
      ).toString('base64'),
      adapters: {
        backup: Buffer.from('export const fixture = "backup";').toString('base64'),
        acceptance: Buffer.from('export const fixture = "acceptance";').toString('base64'),
      },
      policy: { backup: {}, acceptance: {} },
    };
    const valuesText = Buffer.from(installation.valuesBase64, 'base64').toString();
    if (profile !== 'legacy') {
      f.configuration.production.proxyMinimum = 1;
      f.configuration.production.valuesDigest =
        profile === 'wrong-hash'
          ? `sha256:${'0'.repeat(64)}`
          : `sha256:${createHash('sha256').update(valuesText).digest('hex')}`;
    }
    const environment = {
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      RUNNER_TEMP: directory,
      GITHUB_ENV: f.jobEnv,
      RIVET_DEPLOYMENT_CONFIGURATION: JSON.stringify(f.configuration),
    };
    const commands = [];
    const preparation = prepareHostedRelease('production', {
      environment,
      cloudEvidence: () => {
        throw new Error('Production preparation must not claim a staging lock');
      },
      run: (bin, args, commandEnvironment) => {
        assert.equal(bin, 'gcloud');
        commands.push(args);
        if (args.includes('get-credentials'))
          assert.equal(commandEnvironment.RIVET_DEPLOYMENT_CONFIGURATION, undefined);
        else {
          assert.deepEqual(args.slice(0, 3), ['storage', 'cp', f.configuration.installationUri]);
          writeFileSync(args[3], JSON.stringify(installation));
        }
        return '';
      },
    });
    if (['wrong-hash', 'mixed-policy'].includes(profile)) {
      await assert.rejects(preparation);
      await assert.rejects(fs.stat(path.join(directory, 'rivet-production/values.json')), { code: 'ENOENT' });
      return;
    }
    await preparation;
    if (profile === 'one-proxy')
      assert.match(await fs.readFile(f.jobEnv, 'utf8'), /^RIVET_QUALIFICATION_PRODUCTION_PROXY_MINIMUM=1$/m);
    assert.equal(commands.length, 2);
    const job = path.join(directory, 'rivet-production');
    assert.equal(await fs.readFile(path.join(job, 'values.json'), 'utf8'), valuesText);
    assert.equal(await fs.readFile(path.join(job, 'backup.mjs'), 'utf8'), 'export const fixture = "backup";');
    const policy = JSON.parse(await fs.readFile(path.join(job, 'policy.json'), 'utf8'));
    assert.equal(policy.backup.script, 'backup.mjs');
    assert.equal(policy.acceptance.script, 'acceptance.mjs');
    assert.equal(environment.RIVET_DEPLOYMENT_CONFIGURATION, undefined);
  });

test('hosted staging carries the reviewed proxy minimum without changing its production identity', async (t) => {
  const f = await fixture(t);
  f.configuration.production.proxyMinimum = 1;
  await f.prepare();
  const job = await fs.readFile(f.jobEnv, 'utf8');
  assert.match(job, /^RIVET_QUALIFICATION_PRODUCTION_PROXY_MINIMUM=1$/m);
  assert.match(job, /^RIVET_QUALIFICATION_PRODUCTION_VALUES_SHA256=sha256:b{64}$/m);
});

for (const minimum of [0, 3, '1', null])
  test(`hosted staging rejects invalid reviewed proxy minimum ${JSON.stringify(minimum)} before provider access`, async (t) => {
    const f = await fixture(t);
    f.configuration.production.proxyMinimum = minimum;
    await assert.rejects(f.prepare());
    assert.deepEqual(f.events, []);
  });
