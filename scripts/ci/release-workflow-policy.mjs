import assert from 'node:assert/strict';

const needs = (job) => [job.needs ?? []].flat();

export function assertPinnedProviderHelm(workflow) {
  for (const name of ['qualified', 'deploy']) {
    const steps = workflow.jobs[name].steps;
    const pin = steps.findIndex((s) => s.run === 'corepack yarn studio-server:setup:k8s-tools --github-env');
    const auth = steps.findIndex((s) => s.uses?.startsWith('google-github-actions/auth@'));
    assert.ok(pin >= 0 && auth > pin, `${name} must select pinned Helm before cloud authentication`);
    assert.equal(steps[pin].if, undefined, 'Pinned Helm selection must not be conditional');
    assert.equal(steps[pin]['continue-on-error'], undefined, 'Pinned Helm failure must stop provider work');
    assert.equal(steps[pin]['timeout-minutes'], 2, 'Tool setup must fail before a long provider wait');
  }
}
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
  const producer = images.jobs['build-and-push'];
  const earlyScan = producer.steps.find((s) => s.name === 'Scan every published architecture immediately');
  assert.ok(earlyScan, 'Each image must be scanned before its build job completes');
  assert.equal(earlyScan.if, undefined, 'Reused images must also be freshly scanned');
  assert.equal(earlyScan['continue-on-error'], undefined, 'Image scan failures must stop verification');
  assert.match(earlyScan.run, /node scripts\/ci\/scan-container-images\.mjs/);
  const scanGate = images.jobs['scan-images'];
  assert.equal(
    scanGate.name,
    'Scan runtime image (${{ matrix.service }})',
    'Preserve existing security status contexts',
  );
  assert.deepEqual(needs(scanGate), ['release-manifest']);
  const scanProof = scanGate.steps.find((s) => s.name === 'Verify every scanned digest and architecture');
  assert.equal(
    scanProof?.run,
    'node scripts/ci/verify-container-scan.mjs --manifest artifacts/studio-server-release-manifest/candidate-release-manifest.json --service ${{ matrix.service }} --input artifacts/container-security/${{ matrix.service }}',
  );
  assert.equal(scanProof.if, undefined);
  assert.equal(scanProof['continue-on-error'], undefined);
  const scanDownload = scanGate.steps.find((s) => s.name === 'Download component scan evidence');
  const scanUpload = producer.steps.find((s) => s.name === 'Retain container vulnerability evidence');
  const artifact = 'container-security-${{ matrix.service }}-${{ github.run_id }}-${{ github.run_attempt }}';
  assert.equal(scanDownload?.with?.name, artifact);
  assert.equal(scanDownload.with.path, 'artifacts/container-security/${{ matrix.service }}');
  assert.equal(scanUpload?.with?.name, artifact);
  assert.equal(scanUpload.if, '${{ always() }}');
  assert.equal(scanUpload.with['if-no-files-found'], 'error');
  for (const job of ['build-studio-server', 'repository-contracts', 'host-compatibility', 'deployment-command-tests'])
    depends(verify.jobs[job], 'source-contracts');
  const deploymentCommands = verify.jobs['deployment-command-tests'];
  assert.deepEqual(needs(deploymentCommands), ['changes', 'source-contracts']);
  assert.equal(deploymentCommands.if, verify.jobs['build-studio-server'].if);
  assert.equal(deploymentCommands['continue-on-error'], undefined);
  const commandTests = deploymentCommands.steps.find((step) => step.name === 'Run deployment command journeys');
  assert.equal(commandTests?.run, 'yarn node --test deploy/studio-server/scripts/deployment-command.test.mjs');
  assert.equal(commandTests.if, undefined, 'Deployment command tests must not be conditional');
  assert.equal(commandTests['continue-on-error'], undefined, 'Deployment command failures must block verification');
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
  assert.ok(needs(verify.jobs.verify).includes('deployment-command-tests'));
  assert.equal(
    verify.jobs.verify.steps[0].env.DEPLOYMENT_COMMAND_RESULT,
    '${{ needs.deployment-command-tests.result }}',
  );
  assert.match(verify.jobs.verify.steps[0].run, /for result in [^\n]*"\$DEPLOYMENT_COMMAND_RESULT"/);
  assert.deepEqual(Object.keys(source.on), ['workflow_call']);
  assert.deepEqual(source.permissions, { contents: 'read' });
  assert.equal(source.jobs.source['timeout-minutes'], 8);
  const checkout = source.jobs.source.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.['timeout-minutes'], 5);
  assert.equal(checkout.env?.GIT_HTTP_LOW_SPEED_LIMIT, '1024');
  assert.equal(checkout.env?.GIT_HTTP_LOW_SPEED_TIME, '30');
  const commands = source.jobs.source.steps.map((s) => s.run ?? '').join('\n');
  assert.match(commands, /--immutable --immutable-cache/);
  assert.match(commands, /--mode=skip-build\b/);
  assert.match(commands, /yarn node scripts\/ci\/verify-rollout-source\.mjs/);
  assert.doesNotMatch(commands, /studio-server:build|docker|gcloud/);
  const nativeTools = source.jobs.source.steps.find((s) => s.name === 'Install native provider test tools');
  assert.equal(nativeTools?.['timeout-minutes'], 2);
  assert.equal(nativeTools.env.KUBECTL_VERSION, 'v1.36.6');
  assert.equal(nativeTools.env.HELM_VERSION, 'v3.22.1');
  assert.match(nativeTools.run, /sha256sum -c -/);
  assert.match(nativeTools.run, /RIVET_K8S_HELM_BIN=.*\$GITHUB_ENV/);
  const native = source.jobs.source.steps.find(
    (s) => s.name === 'Verify packaged provider preparation and cleanup before expensive work',
  );
  assert.equal(native?.['timeout-minutes'], 2);
  for (const step of [nativeTools, native]) {
    assert.equal(step.if, undefined, 'Native provider contracts must not be conditional');
    assert.equal(step['continue-on-error'], undefined, 'Native provider contracts must block expensive work');
  }
  assert.match(
    native.run,
    /--test deploy\/studio-server\/scripts\/provider-tool-contracts.test.mjs deploy\/studio-server\/scripts\/reusable-staging.test.mjs/,
  );
  assert.ok(source.jobs.source.steps.indexOf(nativeTools) < source.jobs.source.steps.indexOf(native));
}
