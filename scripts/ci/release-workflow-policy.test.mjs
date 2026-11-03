import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFastReleasePolicy } from './release-workflow-policy.mjs';

function fixture() {
  const shared = { uses: './.github/workflows/studio-server-source-contracts.yml' };
  return {
    build: { jobs: { 'source-contracts': { ...shared }, 'compiled-artifacts': { needs: 'source-contracts' } } },
    images: {
      jobs: {
        'source-contracts': { ...shared },
        'build-and-push': { needs: 'source-contracts' },
        'managed-kubernetes-release-gate': {
          needs: ['scan-images'],
          strategy: { 'max-parallel': 3, 'fail-fast': false },
          steps: [
            {
              name: 'Run Managed Kubernetes Gate',
              if: "matrix.scenario == 'lostAcknowledgement'",
              env: {
                RIVET_K8S_RELEASE_GATE_CONTEXT: '${{ matrix.context }}',
                RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: '${{ matrix.context }}',
              },
            },
            { name: 'Delete Disposable Kind Cluster', if: '${{ always() }}' },
          ],
        },
      },
    },
    verify: {
      jobs: {
        'source-contracts': { ...shared },
        'build-studio-server': { needs: ['changes', 'source-contracts'] },
        'repository-contracts': { needs: ['changes', 'source-contracts'] },
        'host-compatibility': { needs: ['changes', 'source-contracts'] },
        verify: {
          needs: ['source-contracts'],
          steps: [
            { env: { SOURCE_RESULT: '${{ needs.source-contracts.result }}' }, run: 'test "$SOURCE_RESULT" = success' },
          ],
        },
      },
    },
    publisher: {
      jobs: {
        'source-contracts': { ...shared },
        publish: {
          needs: 'source-contracts',
          steps: [
            {
              name: 'Configure cache builder with classic-store output',
              with: { driver: 'docker-container', name: 'fixture' },
            },
            { uses: './.github/actions/build-cache-runtime' },
            {
              name: 'Build exact source, verify archives, scan and publish immutable images',
              env: { RIVET_QUALIFICATION_BUILDER: 'fixture' },
            },
          ],
        },
      },
    },
    source: {
      on: { workflow_call: null },
      permissions: { contents: 'read' },
      jobs: {
        source: {
          'timeout-minutes': 8,
          steps: [
            {
              uses: 'actions/checkout@fixture',
              'timeout-minutes': 5,
              env: { GIT_HTTP_LOW_SPEED_LIMIT: '1024', GIT_HTTP_LOW_SPEED_TIME: '30' },
            },
            { run: 'yarn install --immutable --immutable-cache --mode=skip-build' },
            { run: 'yarn node scripts/ci/verify-rollout-source.mjs' },
          ],
        },
      },
    },
  };
}
test('parallel build/recovery lanes retain cheap prerequisites and unconditional cleanup', () => {
  assert.doesNotThrow(() => assertFastReleasePolicy(fixture()));
});

test('cold checkout allowance stays distinct from stalled transfers and the source job deadline', () => {
  for (const mutate of [
    (job) => {
      job['timeout-minutes'] = 5;
    },
    (job) => {
      job.steps[0]['timeout-minutes'] = 2;
    },
    (job) => {
      delete job.steps[0].env.GIT_HTTP_LOW_SPEED_TIME;
    },
    (job) => {
      job.steps[0].env.GIT_HTTP_LOW_SPEED_LIMIT = '0';
    },
  ]) {
    const f = fixture();
    mutate(f.source.jobs.source);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});
test('failed, skipped or cancelled prerequisites cannot be bypassed by permissive conditions', () => {
  for (const condition of ['always()', 'failure()', 'cancelled()']) {
    const f = fixture();
    f.images.jobs['managed-kubernetes-release-gate'].if = condition;
    assert.throws(() => assertFastReleasePolicy(f), /successful prerequisites/);
  }
});
test('removing source/scan barriers, losing cleanup or reserializing expensive work is rejected', () => {
  for (const mutate of [
    (f) => (f.images.jobs['build-and-push'].needs = []),
    (f) => (f.publisher.jobs.publish.needs = []),
    (f) => (f.publisher.jobs.publish.steps[0].with.driver = 'docker'),
    (f) => (f.images.jobs['managed-kubernetes-release-gate'].needs = []),
    (f) => f.images.jobs['build-and-push'].needs.push('verify-repository'),
    (f) => (f.images.jobs['managed-kubernetes-release-gate'].steps[0].if = "matrix.scenario == 'upgrade'"),
    (f) => (f.images.jobs['managed-kubernetes-release-gate'].steps[1].if = 'success()'),
    (f) => delete f.verify.jobs.verify.steps[0].env.SOURCE_RESULT,
  ]) {
    const f = fixture();
    // Use an array for the mutation that adds a dependency.
    f.images.jobs['build-and-push'].needs = ['source-contracts'];
    mutate(f);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});
