import assert from 'node:assert/strict';

const needs = (job) => [job.needs ?? []].flat();
const depends = (job, expected) => {
  assert.ok(needs(job).includes(expected), `Missing required dependency: ${expected}`);
  assert.doesNotMatch(
    String(job.if ?? ''),
    /always\(|failure\(|cancelled\(/,
    'Expensive work must require successful prerequisites',
  );
};

/** Structural owner for prerequisite failure/skip/cancellation propagation.
 * Uses GitHub's default success condition, never a custom status evaluator. */
export function assertFastReleasePolicy({ images, verify, publisher, source, build }) {
  const shared = './.github/workflows/studio-server-source-contracts.yml';
  for (const workflow of [images, verify, publisher, build])
    assert.equal(workflow.jobs['source-contracts'].uses, shared);
  depends(images.jobs['build-and-push'], 'source-contracts');
  depends(build.jobs['compiled-artifacts'], 'source-contracts');
  assert.deepEqual(
    needs(images.jobs['build-and-push']),
    ['source-contracts'],
    'Keep full verification parallel with builds',
  );
  for (const job of ['build-studio-server', 'repository-contracts', 'host-compatibility'])
    depends(verify.jobs[job], 'source-contracts');
  depends(publisher.jobs.publish, 'source-contracts');
  const builder = publisher.jobs.publish.steps.find(
    (s) => s.name === 'Configure cache builder with classic-store output',
  );
  assert.equal(builder.with.driver, 'docker-container', 'Cached publication requires the archive-compatible builder');
  const publication = publisher.jobs.publish.steps.find(
    (s) => s.name === 'Build exact source, verify archives, scan and publish immutable images',
  );
  assert.equal(publication.env.RIVET_QUALIFICATION_BUILDER, builder.with.name);
  assert.ok(publisher.jobs.publish.steps.some((s) => s.uses === './.github/actions/build-cache-runtime'));
  const kind = images.jobs['managed-kubernetes-release-gate'];
  depends(kind, 'scan-images');
  assert.ok(!needs(kind).includes('qualification-actor'), 'Kind must not wait for unrelated actor compilation');
  assert.equal(kind.strategy['max-parallel'], 3);
  assert.equal(kind.strategy['fail-fast'], false);
  const managed = kind.steps.find((s) => s.name === 'Run Managed Kubernetes Gate');
  assert.equal(
    managed.if,
    "matrix.scenario == 'lostAcknowledgement'",
    'Keep the independent managed check off the longest lane',
  );
  for (const key of ['RIVET_K8S_RELEASE_GATE_CONTEXT', 'RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT'])
    assert.equal(managed.env[key], '${{ matrix.context }}');
  assert.match(kind.steps.find((s) => s.name === 'Delete Disposable Kind Cluster').if, /always\(\)/);
  assert.ok(needs(verify.jobs.verify).includes('source-contracts'));
  assert.equal(verify.jobs.verify.steps[0].env.SOURCE_RESULT, '${{ needs.source-contracts.result }}');
  assert.match(verify.jobs.verify.steps[0].run, /"\$SOURCE_RESULT"/);
  assert.deepEqual(Object.keys(source.on), ['workflow_call']);
  assert.deepEqual(source.permissions, { contents: 'read' });
  assert.equal(source.jobs.source['timeout-minutes'], 5);
  const commands = source.jobs.source.steps.map((s) => s.run ?? '').join('\n');
  assert.match(commands, /--immutable --immutable-cache/);
  assert.match(commands, /--mode=skip-build\b/);
  assert.match(commands, /yarn node scripts\/ci\/verify-rollout-source\.mjs/);
  assert.doesNotMatch(commands, /studio-server:build|docker|kubectl|gcloud/);
}
