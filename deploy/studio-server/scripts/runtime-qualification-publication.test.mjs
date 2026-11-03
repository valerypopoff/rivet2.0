import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import {
  HA_REQUIRED_CHECKS,
  HA_RUNTIME_CONTROL_CHECKS,
  HA_COMPACT_EDGE_CHECKS,
  HA_AUTOSCALING_CHECKS,
  HA_ORDINARY_RUNTIME_CHECKS,
  HA_COOPERATIVE_AUTOSCALING_CHECKS,
} from './lib/ha-release-evidence.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  assertRuntimeQualificationBuild,
  prepareRuntimeQualification,
  assertRuntimeQualificationPointer,
} from './lib/runtime-qualification-publication.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const repository = 'valerypopoff/rivet2.0',
  sourceSha = 'a'.repeat(40),
  build = { runId: '123', runAttempt: 1 };
const evidence = { workflow: 'Build Images', ...build };
const images = (prefix) =>
  Object.fromEntries(
    ['api', 'web', 'proxy', 'executor'].map((role, i) => [
      role,
      { repository: `example.test/${prefix}/${role}`, digest: 'sha256:' + String(i + 1).repeat(64) },
    ]),
  );
const create = (source, prefix, predecessorRelease = null) =>
  createStudioServerReleaseManifest({
    rootDir,
    source: { repository, ref: 'refs/heads/main', sha: source },
    images: images(prefix),
    candidateEvidence: evidence,
    predecessorRelease,
  });
function fixture() {
  const prior = promoteStudioServerReleaseManifest(create('b'.repeat(40), 'prior'), { promotionEvidence: evidence });
  const candidate = create(sourceSha, 'next', prior);
  const ha = {
    protocol: 3,
    mode: 'bootstrap',
    candidateSourceSha: sourceSha,
    candidateImages: candidate.images,
    chartDigest: candidate.chart.contentDigest,
    requestSamples: 100,
    failedRequests: 0,
    checks: [...HA_REQUIRED_CHECKS],
    browserContract: { protocol: 2, baseline: { sourceSha, image: candidate.images.web } },
  };
  const promoted = promoteStudioServerReleaseManifest(
    { ...candidate, evidence: { ...candidate.evidence, ha } },
    { promotionEvidence: evidence },
  );
  const common = {
    protocol: 1,
    provider: 'gke',
    scope: 'isolated-provider',
    outcome: 'passed',
    operationId: 'rivet-runtime-proof-20261021',
    projectId: 'test-project-123',
    projectNumber: '123456789',
    reportSha256: 'c'.repeat(64),
    startedAt: '2026-10-21T00:00:00Z',
    finishedAt: '2026-10-21T01:00:00Z',
    cleanupVerified: true,
  };
  const policy = autoscalerPolicy({ maxReplicas: 7 });
  return {
    repository,
    sourceSha,
    build,
    candidate,
    promoted,
    control: {
      ...common,
      evidence: {
        protocol: 1,
        candidateSourceSha: sourceSha,
        candidateImages: candidate.images,
        chartDigest: candidate.chart.contentDigest,
        requestSamples: 250,
        failedRequests: 0,
        edgeProfiles: ['regional', 'compact'],
        predecessorSourceSha: prior.source.sha,
        predecessorImages: prior.images,
        checks: [...HA_RUNTIME_CONTROL_CHECKS, ...HA_COMPACT_EDGE_CHECKS],
      },
    },
    autoscaling: {
      ...common,
      policy,
      evidence: {
        protocol: 1,
        provider: 'gke',
        candidateSourceSha: sourceSha,
        candidateImages: candidate.images,
        chartDigest: candidate.chart.contentDigest,
        policyDigest: autoscalerPolicyDigest(policy),
        requestSamples: 250,
        failedRequests: 0,
        checks: [...HA_AUTOSCALING_CHECKS],
      },
    },
  };
}

test('temporary infrastructure declarations cannot publish before matching outer cleanup is verified', () => {
  const f = fixture();
  const cleanup = {
    protocol: 1,
    operationId: f.control.operationId,
    inputHash: 'a'.repeat(64),
    inventoryHash: 'b'.repeat(64),
    cleanupVerified: true,
    verifiedAt: '2026-10-21T02:00:00Z',
  };
  for (const key of ['control', 'autoscaling']) {
    f[key].protocol = 2;
    f[key].temporaryEnvironment = structuredClone(cleanup);
  }
  assert.ok(prepareRuntimeQualification(f));
  for (const change of [
    (x) => {
      x.control.temporaryEnvironment.cleanupVerified = false;
    },
    (x) => {
      x.autoscaling.temporaryEnvironment.inputHash = 'c'.repeat(64);
    },
    (x) => {
      delete x.control.temporaryEnvironment;
    },
    (x) => {
      x.control.temporaryEnvironment.verifiedAt = '2026-10-21T00:30:00Z';
    },
  ]) {
    const broken = structuredClone(f);
    change(broken);
    assert.throws(() => prepareRuntimeQualification(broken));
  }
});

test('ordinary compact publication does not invent adoption checks and still requires cooperative autoscaling', () => {
  const f = fixture();
  f.control.evidence = {
    ...f.control.evidence,
    protocol: 2,
    purpose: 'ordinary-upgrade',
    controlPlaneMode: 'singleton',
    edgeProfiles: ['compact'],
    predecessorManifestDigest: f.candidate.lineage.predecessor.manifestDigest,
    autoscalerPolicyDigest: autoscalerPolicyDigest(f.autoscaling.policy),
    checks: [...HA_ORDINARY_RUNTIME_CHECKS],
  };
  assert.throws(() => prepareRuntimeQualification(f), /full or certified focused autoscaling/);
  f.autoscaling.evidence.protocol = 2;
  f.autoscaling.evidence.checks = [...HA_COOPERATIVE_AUTOSCALING_CHECKS];
  const result = prepareRuntimeQualification(f);
  assert.equal(result.candidate.evidence.runtimeControl.protocol, 2);
  assert.deepEqual(result.candidate.evidence.runtimeControl.edgeProfiles, ['compact']);
  assert.ok(!result.candidate.evidence.runtimeControl.checks.includes('reverse-control-transfer'));
  f.control.evidence.autoscalerPolicyDigest = 'f'.repeat(64);
  assert.throws(() => prepareRuntimeQualification(f), /policy differs/);
});

test('qualification publication requires the exact successful main image-build run, never a fork or PR', () => {
  const run = {
    id: 123,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: sourceSha,
    head_branch: 'main',
    path: '.github/workflows/studio-server-images.yml',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    run_attempt: 1,
  };
  assert.deepEqual(assertRuntimeQualificationBuild(run, { repository, sourceSha, runId: '123' }), build);
  for (const change of [
    { head_sha: 'd'.repeat(40) },
    { head_branch: 'develop' },
    { conclusion: 'failure' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'fork/repo' } },
    { event: 'pull_request' },
  ])
    assert.throws(() =>
      assertRuntimeQualificationBuild({ ...run, ...change }, { repository, sourceSha, runId: '123' }),
    );
  for (const runId of ['../123', '123;echo bad', '', '0'])
    assert.throws(() => assertRuntimeQualificationBuild(run, { repository, sourceSha, runId }));
});

test('qualification promotion uses the frozen publication baseline, not a separately selected installed predecessor', () => {
  const f = fixture();
  const published = promoteStudioServerReleaseManifest(create('c'.repeat(40), 'published'), {
    promotionEvidence: evidence,
  });
  const reference = {
    manifestDigest: getStudioServerReleaseManifestDigest(published),
    sourceSha: published.source.sha,
    managedWorkflowSchemaVersion: published.database.managedWorkflowSchema.version,
    images: published.images,
  };
  f.candidate.lineage.publicationHead = reference;
  f.promoted.lineage.publicationHead = reference;
  const result = prepareRuntimeQualification(f);
  assert.equal(result.publicationBaselineDigest, reference.manifestDigest);
  assert.equal(result.predecessorDigest, f.candidate.lineage.predecessor.manifestDigest);
  assert.notEqual(result.publicationBaselineDigest, result.predecessorDigest);
  assertRuntimeQualificationPointer(f.promoted, result.expectedProductionDigest);
  assert.throws(() => assertRuntimeQualificationPointer(published, result.expectedProductionDigest));
});

test('qualification preserves candidate lineage/images/schema and binds both provider declarations and exact policy', () => {
  const f = fixture(),
    result = prepareRuntimeQualification(f);
  assert.deepEqual(result.candidate.images, f.candidate.images);
  assert.deepEqual(result.candidate.database, f.candidate.database);
  assert.deepEqual(result.candidate.lineage, f.candidate.lineage);
  assert.equal(result.candidate.evidence.runtimeAutoscaling.policyDigest, autoscalerPolicyDigest(f.autoscaling.policy));
  assert.equal(result.candidate.state, 'candidate');
  assertRuntimeQualificationPointer(f.promoted, result.expectedProductionDigest);
  assert.throws(() => assertRuntimeQualificationPointer(f.promoted, 'sha256:' + 'f'.repeat(64)));
  assert.equal(f.candidate.evidence.runtimeControl, undefined, 'input artifacts must not be modified');
});

test('provider publication cannot turn a legacy startup-only schema check into rolling qualification', () => {
  const f = fixture();
  f.candidate.lineage.predecessor.managedWorkflowSchemaVersion = 17;
  f.promoted.lineage.predecessor.managedWorkflowSchemaVersion = 17;
  assert.throws(() => prepareRuntimeQualification(f), /schema compatibility evidence/);
  const runId = 'd'.repeat(32);
  f.promoted.evidence.ha.schemaCompatibility = {
    protocol: 1,
    from: 17,
    to: 18,
    runId,
    predecessorApi: f.candidate.lineage.predecessor.images.api,
    candidateApi: f.candidate.images.api,
    lockContention: true,
    repositories: [
      ['previous', 17],
      ['candidate', 18],
    ].map(([role, version]) => ({ role, version, runId, rounds: 2, peerRowsRead: 2 })),
  };
  assert.equal(prepareRuntimeQualification(f).candidate.evidence.ha.schemaCompatibility.runId, runId);
});

test('local/failed/uncleaned or incomplete declarations cannot become provider evidence', () => {
  for (const change of [
    { provider: 'local' },
    { scope: 'local-functional-only' },
    { outcome: 'failed' },
    { cleanupVerified: false },
    { reportSha256: '' },
    { projectId: '' },
    { finishedAt: 'invalid' },
    { secret: 'must-not-be-accepted' },
  ]) {
    const f = fixture();
    Object.assign(f.control, change);
    assert.throws(() => prepareRuntimeQualification(f));
  }
  const f = fixture();
  f.control.evidence.checks.pop();
  assert.throws(() => prepareRuntimeQualification(f));
});

test('provider windows require actual UTC timestamp strings, not coerced or normalized dates', () => {
  for (const kind of ['control', 'autoscaling']) {
    for (const key of ['startedAt', 'finishedAt']) {
      for (const value of [
        ['2026-10-21T00:30:00Z'],
        '2026-10-21',
        'October 21, 2026 00:30:00 GMT',
        '2026-02-30T00:30:00Z',
        null,
        2026,
      ]) {
        const f = fixture();
        f[kind][key] = value;
        assert.throws(() => prepareRuntimeQualification(f), `${kind}.${key}: ${JSON.stringify(value)}`);
      }
    }
    const f = fixture();
    f[kind].finishedAt = f[kind].startedAt;
    assert.throws(() => prepareRuntimeQualification(f), 'A completed window must end after it starts');
    f[kind].finishedAt = '2026-10-20T23:00:00Z';
    assert.throws(() => prepareRuntimeQualification(f), 'Reversed windows are invalid');
  }
  const f = fixture();
  f.control.startedAt = '2026-10-21T00:00:00.1234567Z';
  f.autoscaling.finishedAt = '2026-10-21T01:00:00.123Z';
  const result = prepareRuntimeQualification(f);
  assert.equal(result.declarations.control.startedAt, f.control.startedAt);
  assert.equal(result.declarations.autoscaling.finishedAt, f.autoscaling.finishedAt);
});

test('changed build artifacts, source, operation, evidence identities and policy fail closed', () => {
  for (const mutate of [
    (f) => {
      f.promoted.images.api.digest = 'sha256:' + 'e'.repeat(64);
    },
    (f) => {
      f.promoted.evidence.promotion.runAttempt = 2;
    },
    (f) => {
      f.sourceSha = 'd'.repeat(40);
    },
    (f) => {
      f.autoscaling.operationId = 'another-proof';
    },
    (f) => {
      f.autoscaling.policy.maxReplicas = 8;
    },
    (f) => {
      f.autoscaling.evidence.candidateSourceSha = 'd'.repeat(40);
    },
    (f) => {
      f.control.evidence.edgeProfiles = ['compact'];
      f.control.evidence.checks = [...HA_RUNTIME_CONTROL_CHECKS, ...HA_COMPACT_EDGE_CHECKS];
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => prepareRuntimeQualification(f));
  }
});

test('invalid publication input does not echo declaration values into CI logs', () => {
  const marker = 'private-fixture-input-must-not-be-logged';
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./prepare-runtime-qualification.mjs', import.meta.url)), 'validate-run-id'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: repository, BUILD_RUN_ID: marker },
    },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
  assert.match(result.stderr, /No declaration values were logged/);
});
