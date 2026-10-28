import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './studio-server-release-manifest.mjs';
import {
  assertRuntimeControlEvidence,
  assertRuntimeAutoscalingEvidence,
  assertCooperativeAutoscalingEvidence,
} from './ha-release-evidence.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './execution-autoscaler.mjs';
import { assertSchemaCompatibilityEvidence } from './schema-compatibility-probe.mjs';

/** Publication consumes an existing successful main build; it never rebuilds
 * images, runs GCP tests, or turns a local functional report into a certificate.
 * Declarations are operator attestations backed by retained provider reports.
 * The report hash is provenance, not cryptographic proof of test execution. */
export function assertRuntimeQualificationBuild(run, { repository, sourceSha, runId }) {
  assert.match(String(runId), /^[1-9][0-9]*$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(run.id.toString(), runId);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_sha, sourceSha);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.path, '.github/workflows/studio-server-images.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event));
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  return { runId, runAttempt: run.run_attempt };
}

function observationTimestamp(value) {
  assert.ok(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value),
    'Provider timestamps must be UTC ISO strings',
  );
  const time = Date.parse(value);
  assert.ok(
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19),
    'Invalid provider timestamp',
  );
  return time;
}

function declaration(value, kind) {
  const keys = [
    'protocol',
    'provider',
    'scope',
    'outcome',
    'operationId',
    'projectId',
    'projectNumber',
    'reportSha256',
    'startedAt',
    'finishedAt',
    'cleanupVerified',
    'evidence',
    ...(kind === 'autoscaling' ? ['policy'] : []),
  ];
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Provider declaration has missing or unknown fields');
  assert.equal(value.protocol, 1);
  assert.equal(value.provider, 'gke');
  assert.equal(value.scope, 'isolated-provider');
  assert.equal(value.outcome, 'passed');
  assert.equal(value.cleanupVerified, true, 'Settle and clean up the approved test operation before publication');
  assert.match(value.operationId, /^[a-z0-9][a-z0-9-]{2,79}$/);
  assert.match(value.projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  assert.match(value.projectNumber, /^[1-9][0-9]{5,20}$/);
  assert.match(value.reportSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    observationTimestamp(value.startedAt) < observationTimestamp(value.finishedAt),
    'Invalid provider observation window',
  );
  return value;
}

export function assertRuntimeQualificationArtifacts({
  candidate: input,
  promoted: built,
  repository,
  sourceSha,
  build,
}) {
  const candidate = assertStudioServerReleaseManifest(input);
  const promoted = assertStudioServerReleaseManifest(built, { requirePromoted: true });
  assert.equal(candidate.state, 'candidate');
  for (const release of [candidate, promoted]) {
    assert.equal(release.source.repository, repository);
    assert.equal(release.source.ref, 'refs/heads/main');
    assert.equal(release.source.sha, sourceSha);
    assert.equal(release.evidence.candidate.runId, build.runId);
    assert.equal(release.evidence.candidate.runAttempt, build.runAttempt);
  }
  for (const key of ['images', 'chart', 'lineage', 'database', 'createdAt'])
    assert.ok(isDeepStrictEqual(candidate[key], promoted[key]), `Build artifact mismatch: ${key}`);
  assert.equal(promoted.evidence.promotion.runId, build.runId);
  assert.equal(promoted.evidence.promotion.runAttempt, build.runAttempt);
  assert.ok(promoted.evidence.ha, 'Ordinary HA qualification must already have passed');
  const from = candidate.lineage?.predecessor?.managedWorkflowSchemaVersion;
  if (from !== candidate.database.managedWorkflowSchema.version)
    assertSchemaCompatibilityEvidence(promoted.evidence.ha.schemaCompatibility, candidate, from);
  assert.ok(
    !promoted.evidence.runtimeControl && !promoted.evidence.runtimeAutoscaling,
    'This build is already qualified; inspect the existing publication instead of replacing it',
  );
  assert.match(candidate.lineage?.predecessor?.manifestDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  return { candidate, promoted };
}

export function prepareRuntimeQualification(input) {
  const { candidate, promoted } = assertRuntimeQualificationArtifacts(input);
  const { control, autoscaling } = input;
  const c = declaration(control, 'control'),
    a = declaration(autoscaling, 'autoscaling');
  for (const key of ['operationId', 'projectId', 'projectNumber'])
    assert.equal(c[key], a[key], 'Provider operations differ');
  const runtimeControl = assertRuntimeControlEvidence(c.evidence, candidate, 'compact');
  if (runtimeControl.protocol === 1)
    assert.ok(
      runtimeControl.edgeProfiles.includes('regional'),
      'Forward/reverse regional transfer is required for adoption',
    );
  assert.deepEqual(
    Object.keys(a.policy).sort(),
    Object.keys(autoscalerPolicy({})).sort(),
    'Declare the complete scaling policy',
  );
  const policy = autoscalerPolicy(a.policy);
  const runtimeAutoscaling = (
    runtimeControl.protocol === 2 ? assertCooperativeAutoscalingEvidence : assertRuntimeAutoscalingEvidence
  )(a.evidence, candidate, autoscalerPolicyDigest(policy));
  if (runtimeControl.protocol === 2)
    assert.equal(
      runtimeControl.autoscalerPolicyDigest,
      runtimeAutoscaling.policyDigest,
      'Ordinary upgrade policy differs from autoscaling qualification',
    );
  return {
    candidate: assertStudioServerReleaseManifest({
      ...candidate,
      evidence: {
        ...candidate.evidence,
        ha: promoted.evidence.ha,
        runtimeControl,
        runtimeAutoscaling,
      },
    }),
    expectedProductionDigest: getStudioServerReleaseManifestDigest(promoted, { requirePromoted: true }),
    predecessorDigest: candidate.lineage.predecessor.manifestDigest,
    declarations: {
      control: { ...c, evidence: runtimeControl },
      autoscaling: { ...a, evidence: runtimeAutoscaling, policy },
    },
  };
}

export function assertRuntimeQualificationPointer(current, expectedDigest) {
  assert.match(expectedDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    getStudioServerReleaseManifestDigest(current, { requirePromoted: true }),
    expectedDigest,
    'Production publication pointer changed; do not replace a newer or uncertain release',
  );
}
