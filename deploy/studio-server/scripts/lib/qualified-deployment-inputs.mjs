import assert from 'node:assert/strict';
import { qualificationConfigurationDigest } from './release-qualification-policy.mjs';
import { releaseToolingSource } from './release-tooling.mjs';
import { getStudioServerReleaseManifestDigest } from './studio-server-release-manifest.mjs';

export function assertQualifiedPublicationRun(run, { repository, runId }) {
  assert.match(runId ?? '', /^[1-9][0-9]*$/);
  assert.equal(String(run.id), runId);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_branch, 'main');
  assert.match(run.head_sha ?? '', /^[a-f0-9]{40}$/);
  assert.ok(
    [
      '.github/workflows/studio-server-runtime-qualification.yml',
      '.github/workflows/studio-server-qualify-release.yml',
    ].includes(run.path),
  );
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  return `studio-server-release-manifest-${runId}-${run.run_attempt}`;
}

export function qualifiedDeploymentSelection({ manifest, declarations, publicationRun, repository }) {
  const digest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
  assert.equal(manifest.source.repository, repository);
  assert.equal(manifest.source.ref, 'refs/heads/main');
  const sourceSha = releaseToolingSource(manifest);
  assert.equal(publicationRun.head_sha, sourceSha, 'Publication did not execute the qualified source');
  assert.equal(String(manifest.evidence.promotion.runId), String(publicationRun.id));
  assert.equal(manifest.evidence.promotion.runAttempt, publicationRun.run_attempt);
  assertPublishedDeclarations(manifest, declarations);
  const match = /^rivet-q-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(declarations.control.operationId);
  assert.ok(match, 'Qualification operation has no original workflow identity');
  return { digest, sourceSha, operationId: match[0], runId: match[1], runAttempt: match[2] };
}

export function assertPublishedDeclarations(manifest, declarations) {
  for (const [kind, evidence] of [
    ['control', manifest.evidence.runtimeControl],
    ['autoscaling', manifest.evidence.runtimeAutoscaling],
  ]) {
    const value = declarations[kind];
    assert.ok(evidence, 'A published runtime qualification is required');
    assert.equal(value?.provider, 'gke');
    assert.equal(value.scope, 'isolated-provider');
    assert.equal(value.outcome, 'passed');
    assert.equal(value.cleanupVerified, true, 'Qualification cleanup must be verified');
    assert.deepEqual(value.evidence, evidence, 'Declaration differs from the published certificate');
    assert.equal(value.operationId, declarations.control.operationId);
  }
}

/** An archived receipt supplies the original production baseline, never values,
 * adapters or executable code. The existing deployment still owns live checks. */
export function assertQualifiedDeploymentReceipt(operation, { manifest, declarations }) {
  assertPublishedDeclarations(manifest, declarations);
  assert.equal(operation.protocol, 1);
  assert.equal(operation.sizingRequests, undefined);
  assert.equal(operation.operationId, declarations.control.operationId);
  assert.match(operation.inputHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(operation.driverBundleSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(operation.candidate.sourceSha, manifest.source.sha);
  assert.deepEqual(operation.candidate.images, manifest.images);
  assert.equal(operation.candidate.chartDigest, manifest.chart.contentDigest);
  assert.equal(operation.predecessorManifestDigest, manifest.lineage.predecessor.manifestDigest);
  assert.equal(operation.installed.manifestDigest, operation.predecessorManifestDigest);
  for (const key of ['valuesDigest', 'settingsDigest'])
    assert.match(operation.installed[key] ?? '', /^sha256:[a-f0-9]{64}$/);
  for (const key of ['namespaceUid', 'clusterUid'])
    assert.ok(typeof operation.installed[key] === 'string' && operation.installed[key]);
  assert.equal(operation.installed.controlPlaneMode, 'singleton');
  const control = manifest.evidence.runtimeControl;
  assert.ok(control.qualification, 'Standalone deployment requires the existing qualification plan');
  assert.deepEqual(operation.tooling, control.qualification.tooling);
  assert.deepEqual(operation.installed.policy, declarations.autoscaling.policy);
  assert.equal(
    qualificationConfigurationDigest(
      operation.installed,
      declarations.autoscaling.policy,
      control.requestContinuity?.profile,
    ),
    control.qualification.configurationDigest,
    'Receipt settings differ from the staged configuration',
  );
  return operation;
}

export function recoveredOperationReference(uri, sha256, bucket) {
  assert.match(sha256 ?? '', /^sha256:[a-f0-9]{64}$/);
  const match = /^gs:\/\/([a-z0-9][a-z0-9.-]+)\/(qualification-receipts\/[a-zA-Z0-9/_-]+\.json)#([1-9][0-9]*)$/.exec(
    uri ?? '',
  );
  assert.ok(match, 'Recovery receipt must be an immutable private qualification object');
  assert.equal(match[1], bucket, 'Recovery receipt must use the configured production evidence bucket');
  assert.ok(!match[2].includes('..'));
  return uri;
}
