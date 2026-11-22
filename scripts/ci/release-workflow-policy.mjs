import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDocument } from 'yaml';

export function readWorkflowConfiguration(file) {
  const source = fs.readFileSync(file, 'utf8');
  const document = parseDocument(source, { prettyErrors: true, strict: true });
  if (document.errors.length > 0) {
    throw new Error(`${file} is not valid YAML:\n${document.errors.join('\n')}`);
  }
  return { source, workflow: document.toJS() };
}

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

/** The migration fixture is stateful inside its job, but owns no other lane's
 * database or files. Keep the full fixture mandatory and parallel to that lane. */
export function assertParallelMigrationVerification(workflow) {
  const job = workflow.jobs['deployment-contracts'];
  assert.deepEqual(needs(job), ['changes', 'build-studio-server']);
  assert.deepEqual(job.strategy.matrix.lane, ['managed', 'migration', 'deployment', 'gateway']);
  assert.equal(job.strategy['max-parallel'], 4);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job['continue-on-error'], undefined);
  const find = (name) => {
    const steps = job.steps.filter((step) => step.name === name);
    assert.equal(steps.length, 1, `${name} must occur once`);
    return steps[0];
  };
  const runtime = find('Verify compiled migration runtime');
  const migration = find('Verify VM-to-managed copy, retry, and exact readback');
  for (const step of [runtime, migration]) {
    assert.equal(step.if, "matrix.lane == 'migration'");
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.equal(
    migration.run,
    'node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api exec tsx src/tests/workflow-storage-migration-managed.integration.ts',
  );
  assert.equal(
    Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /workflow-storage-migration-managed\.integration|test:migration-managed/.test(step.run ?? ''))
      .length,
    1,
    'The full migration fixture must run once, without the old serial invocation',
  );
  assert.ok(job.steps.indexOf(runtime) > job.steps.indexOf(find('Verify restored compiled workspace dependencies')));
  assert.ok(job.steps.indexOf(migration) > job.steps.indexOf(runtime));
  const gate = workflow.jobs.verify;
  assert.ok(needs(gate).includes('deployment-contracts'));
  assert.equal(gate.if, 'always()');
  assert.equal(gate['continue-on-error'], undefined);
  const requireAll = gate.steps.find((step) => step.name === 'Require every applicable Studio Server gate');
  assert.equal(requireAll.if, undefined);
  assert.equal(requireAll['continue-on-error'], undefined);
  assert.equal(requireAll.env.DEPLOYMENT_RESULT, '${{ needs.deployment-contracts.result }}');
  assert.match(
    requireAll.run,
    /for result in [^\n]*"\$DEPLOYMENT_RESULT"[^\n]*; do\s+test "\$result" = success\s+done\s*$/,
  );
}

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
  assert.equal(kind.strategy['max-parallel'], 2);
  assert.equal(kind.strategy['fail-fast'], false);
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

export function assertEarlyHaPolicy(images, reusable) {
  const jobs = images.jobs;
  const early = jobs['managed-kubernetes-early-upgrade'];
  const late = jobs['managed-kubernetes-upgrade'];
  const recovery = jobs['managed-kubernetes-release-gate'];
  const native = ['changes', 'build-and-push', 'release-manifest', 'scan-images'];
  assert.deepEqual(needs(early), ['changes', 'source-contracts']);
  assert.equal(early.if, "needs.changes.outputs.require_kind == 'true' && needs.changes.outputs.early_ha == 'true'");
  assert.deepEqual(needs(recovery), native);
  assert.deepEqual(recovery.strategy, {
    'fail-fast': false,
    'max-parallel': 2,
    matrix: { scenario: ['lostAcknowledgement', 'leaseLoss'] },
  });
  assert.deepEqual(needs(late), [...native, 'managed-kubernetes-early-upgrade']);
  assert.equal(
    late.if,
    "${{ !cancelled() && needs.changes.result == 'success' && needs.build-and-push.result == 'success' && needs.release-manifest.result == 'success' && needs.scan-images.result == 'success' && needs.changes.outputs.require_kind == 'true' && ((needs.changes.outputs.early_ha == 'false' && needs.managed-kubernetes-early-upgrade.result == 'skipped') || (needs.changes.outputs.early_ha == 'true' && needs.managed-kubernetes-early-upgrade.result == 'success' && needs.managed-kubernetes-early-upgrade.outputs.outcome == 'deferred')) }}",
  );
  assert.equal(images.on.workflow_dispatch.inputs.early_ha_preparation.default, false);
  assert.equal(
    jobs.changes.outputs.early_ha,
    "${{ github.event_name == 'workflow_dispatch' && inputs.early_ha_preparation == true }}",
  );
  const ref = './.github/workflows/studio-server-ha-scenario.yml';
  for (const [job, mode, scenario] of [
    [early, 'early', 'upgrade'],
    [late, 'after-gates', 'upgrade'],
    [recovery, 'after-gates', '${{ matrix.scenario }}'],
  ]) {
    assert.equal(job.uses, ref);
    assert.deepEqual(job.permissions, { actions: 'read', contents: 'read', packages: 'read' });
    assert.deepEqual(job.with, {
      scenario,
      mode,
      run_managed_disruption:
        "${{ github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.run_managed_kubernetes_disruption == true) }}",
    });
    assert.equal(job['continue-on-error'], undefined);
    for (const key of ['steps', 'secrets', 'concurrency', 'env', 'timeout-minutes', 'runs-on'])
      assert.equal(job[key], undefined);
  }
  assert.deepEqual(Object.keys(reusable.on), ['workflow_call']);
  assert.deepEqual(reusable.permissions, early.permissions);
  assert.equal(reusable.concurrency, undefined);
  assert.equal(reusable.on.workflow_call.outputs.outcome.value, '${{ jobs.scenario.outputs.outcome }}');
  const job = reusable.jobs.scenario;
  assert.equal(job['timeout-minutes'], "${{ inputs.mode == 'early' && 95 || 75 }}");
  assert.equal(job.defaults.run.shell, 'node scripts/ci/ha-scenario-run.mjs {0}');
  assert.equal(job.env.IMAGE_NAMESPACE, 'ghcr.io/valerypopoff/rivet2.0-studio-server');
  assert.equal(job.env.RIVET_HA_MODE, '${{ inputs.mode }}');
  const step = (name) => {
    const found = job.steps.filter((s) => s.name === name);
    assert.equal(found.length, 1, name);
    return found[0];
  };
  for (const s of job.steps) assert.equal(s['continue-on-error'], undefined);
  const admit = step('Admit exact-run candidate');
  assert.equal(admit.if, "${{ inputs.mode == 'early' && env.RIVET_HA_DEFERRED != 'true' }}");
  assert.equal(admit.run, 'node scripts/ci/ha-candidate-admission.mjs wait');
  assert.equal(admit.env.RIVET_HA_PHASE, 'admission');
  assert.equal(step('Create Disposable Kind Cluster').id, 'kind-cluster');
  assert.equal(step('Delete Disposable Kind Cluster').if, "${{ always() && steps.kind-cluster.outcome != 'skipped' }}");
  assert.match(step('Start bounded HA preparation').run, /date \+%s%3N\) \+ 600000/);
  assert.equal(
    step('Download admitted candidate release manifest').with['artifact-ids'],
    '${{ steps.admission.outputs.artifact_id }}',
  );
  assert.equal(step('Download admitted candidate release manifest').with['merge-multiple'], true);
  assert.equal(
    step('Download candidate release manifest').if,
    "${{ inputs.mode == 'after-gates' && env.RIVET_HA_DEFERRED != 'true' }}",
  );
  assert.equal(
    step('Validate candidate before use').run,
    'yarn node scripts/ci/ha-candidate-admission.mjs validate "$CANDIDATE_RELEASE_MANIFEST"',
  );
  assert.equal(step('Validate candidate before use').if, "${{ env.RIVET_HA_DEFERRED != 'true' }}");
  assert.equal(step('Validate candidate before use').env.RIVET_HA_PHASE, 'candidate');
  const names = job.steps.map((s) => s.name);
  for (const [a, b] of [
    ['Create Disposable Kind Cluster', 'Admit exact-run candidate'],
    ['Verify hard-spread scheduling with tainted nodes', 'Admit exact-run candidate'],
    ['Admit exact-run candidate', 'Validate candidate before use'],
    ['Validate candidate before use', 'Resolve Candidate Image Digests'],
    ['Resolve Candidate Image Digests', 'Run HA Kubernetes Gate'],
  ])
    assert.ok(names.indexOf(a) < names.indexOf(b), `${a} must precede ${b}`);
  for (const name of [
    'Resolve manifest-bound predecessor API image',
    'Resolve Candidate Image Digests',
    'Run Managed Kubernetes Gate',
    'Run HA Kubernetes Gate',
    'Upload HA Scenario Observations',
  ]) {
    assert.match(step(name).if, /env\.RIVET_HA_DEFERRED != 'true'/);
    assert.equal(step(name).env.RIVET_HA_PHASE, 'candidate');
  }
  assert.match(step('Run Managed Kubernetes Gate').if, /inputs.scenario == 'lostAcknowledgement'/);
  assert.match(step('Run Managed Kubernetes Gate').run, /inputs.run_managed_disruption/);
  for (const name of [
    'Stop owned browser runtime',
    'Delete Disposable Kind Cluster',
    'Upload Managed Kubernetes Gate Artifacts',
  ]) {
    assert.match(step(name).if, /always\(\)/);
    assert.equal(step(name).env.RIVET_HA_PHASE, 'cleanup');
    assert.equal(step(name)['timeout-minutes'], 5);
  }
  assert.equal(step('Report completed HA path').if, undefined);
  assert.match(step('Report completed HA path').run, /test "\$HA_TEST_OUTCOME" = success/);
  assert.ok(names.indexOf('Delete Disposable Kind Cluster') < names.indexOf('Report completed HA path'));
  const assembler = jobs['managed-kubernetes-ha-evidence'];
  assert.deepEqual(needs(assembler), [
    'changes',
    'release-manifest',
    'managed-kubernetes-release-gate',
    'managed-kubernetes-early-upgrade',
    'managed-kubernetes-upgrade',
  ]);
  const check = assembler.steps.find((s) => s.name === 'Require every HA scenario and its cleanup');
  assert.equal(check.run, 'node scripts/ci/ha-candidate-admission.mjs check-results');
  for (const [key, value] of Object.entries({
    HA_EARLY_ENABLED: 'changes.outputs.early_ha',
    HA_EARLY_RESULT: 'managed-kubernetes-early-upgrade.result',
    HA_EARLY_OUTCOME: 'managed-kubernetes-early-upgrade.outputs.outcome',
    HA_LATE_RESULT: 'managed-kubernetes-upgrade.result',
    HA_LATE_OUTCOME: 'managed-kubernetes-upgrade.outputs.outcome',
    HA_RECOVERY_RESULT: 'managed-kubernetes-release-gate.result',
  }))
    assert.equal(check.env[key], '${{ needs.' + value + ' }}');
  assert.equal(check.if, undefined);
  assert.ok(assembler.steps.indexOf(check) < assembler.steps.findIndex((s) => s.name === 'Assemble exact HA evidence'));
  for (const entry of ['.github/workflows/studio-server-ha-scenario.yml', 'scripts/ci/ha-*.mjs'])
    assert.ok(images.on.push.paths.includes(entry));
}
