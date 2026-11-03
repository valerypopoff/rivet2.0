import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  qualificationSafetyDigest,
  releaseQualificationPlan,
  assertQualificationPlan,
  qualificationConfigurationDigest,
} from './lib/release-qualification-policy.mjs';

const profile = {
  protocol: 1,
  maxProtectedRequestSeconds: 300,
  backendServiceDrainSeconds: 600,
  propagationSeconds: 60,
  proxyPreStopDelaySeconds: 660,
  proxyTerminationGracePeriodSeconds: 900,
};
function fixture() {
  const installed = {
    controlPlaneMode: 'singleton',
    qualificationValues: {
      resources: {},
      postgres: {},
      requestContinuity: { enabled: true },
      lifecycle: { shutdownGraceSeconds: 120 },
    },
  };
  const input = {
    safetyDigest: 'a'.repeat(64),
    installed,
    profile,
    predecessorDigest: `sha256:${'b'.repeat(64)}`,
    policy: { minReplicas: 2 },
    candidate: { chart: { contentDigest: 'chart' }, database: { managedWorkflowSchema: { version: 1 } } },
    previous: {
      chart: { contentDigest: 'chart' },
      database: { managedWorkflowSchema: { version: 1 } },
      evidence: {
        runtimeControl: { protocol: 2, requestContinuity: { profile } },
        runtimeAutoscaling: { protocol: 2 },
      },
    },
  };
  const basis = releaseQualificationPlan({ ...input, suite: 'full' });
  assert.equal(basis.tier, 'full');
  input.previous.evidence.runtimeControl.qualification = basis;
  input.previous.evidence.runtimeAutoscaling.qualification = basis;
  return input;
}

test('ordinary continuity qualification is focused even for first adoption and changed source/configuration', () => {
  const f = fixture();
  const plan = releaseQualificationPlan(f);
  assert.equal(plan.tier, 'focused');
  assert.equal(plan.protocol, 2);
  assert.equal(plan.fullBaselineManifestDigest, undefined);
  for (const mutate of [
    (x) => {
      x.safetyDigest = 'c'.repeat(64);
    },
    (x) => {
      delete x.previous.evidence.runtimeControl.qualification;
    },
    (x) => {
      delete x.previous.evidence.runtimeAutoscaling.qualification;
    },
    (x) => {
      x.installed.qualificationValues.requestContinuity.enabled = false;
    },
    (x) => {
      x.installed.qualificationValues.postgres.poolMaxPerApiPod = 8;
    },
    (x) => {
      x.installed.qualificationValues.resources.execution = { memory: '4Gi' };
    },
    (x) => {
      x.policy.minReplicas = 3;
    },
    (x) => {
      x.candidate.chart.contentDigest = 'changed';
    },
    (x) => {
      x.candidate.database.managedWorkflowSchema.version = 2;
    },
    (x) => {
      x.profile = { ...x.profile, propagationSeconds: 90 };
    },
  ]) {
    const changed = structuredClone(f);
    mutate(changed);
    assert.equal(releaseQualificationPlan(changed).tier, 'focused');
  }
  f.previous.evidence.runtimeControl = { ...f.previous.evidence.runtimeControl, protocol: 4, qualification: plan };
  f.previous.evidence.runtimeAutoscaling = { protocol: 3, qualification: plan };
  f.predecessorDigest = `sha256:${'d'.repeat(64)}`;
  assert.equal(releaseQualificationPlan(f).fullBaselineManifestDigest, undefined);
  assert.throws(() => assertQualificationPlan({ ...plan, waiver: true }));
  assert.throws(() => assertQualificationPlan({ ...plan, fullBaselineManifestDigest: null }));
  assert.equal(releaseQualificationPlan({ ...f, suite: 'full' }).tier, 'full');
  assert.equal(releaseQualificationPlan({ ...f, profile: undefined }).tier, 'full');
  assert.equal(releaseQualificationPlan({ ...f, overlap: { poolMaxPerApiPod: 9, backendResources: {} } }).tier, 'full');
  assert.throws(() => releaseQualificationPlan({ ...f, suite: 'skip' }), /suite/);
  assert.throws(() => releaseQualificationPlan({ ...f, profile: undefined, suite: 'focused' }), /requires/);
  // Existing full/focused certificates remain readable without rewriting history.
  assert.equal(
    assertQualificationPlan({ ...plan, protocol: 1, fullBaselineManifestDigest: f.predecessorDigest }).protocol,
    1,
  );
});

test('first adoption fingerprints target settings without requiring a stress-test baseline', () => {
  const f = fixture();
  const target = qualificationConfigurationDigest(f.installed, f.policy, profile);
  f.installed.qualificationValues.requestContinuity = { enabled: false };
  f.installed.qualificationValues.lifecycle.proxy = { preStopDelaySeconds: 30, terminationGracePeriodSeconds: 60 };
  assert.equal(qualificationConfigurationDigest(f.installed, f.policy, profile), target);
  assert.equal(releaseQualificationPlan(f).tier, 'focused');
});

test('committed critical source fingerprint ignores only UI/docs and rejects hidden or dirty checkout changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-release-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Local test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  await write('packages/studio-server-api/server.mjs', 'runtime');
  await write('packages/app/page.tsx', 'page');
  let sha = commit();
  const original = await qualificationSafetyDigest(root, sha);
  await write('packages/app/page.tsx', 'new UI');
  await write('developer-docs/release.md', 'new docs');
  sha = commit();
  assert.equal(await qualificationSafetyDigest(root, sha), original);
  for (const file of [
    'yarn.lock',
    '.github/workflows/release.yml',
    'packages/studio-server-api/server.mjs',
    'packages/core/model.ts',
    'deploy/chart.yaml',
    'new-unknown-path.txt',
  ]) {
    const before = await qualificationSafetyDigest(root, sha);
    await write(file, 'critical change');
    sha = commit();
    assert.notEqual(await qualificationSafetyDigest(root, sha), before);
  }
  await write('packages/app/page.tsx', 'dirty');
  await assert.rejects(qualificationSafetyDigest(root, sha), /clean source/);
  git('update-index', '--assume-unchanged', 'packages/app/page.tsx');
  await assert.rejects(qualificationSafetyDigest(root, sha), /index flags/);
});
