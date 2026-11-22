import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFastReleasePolicy,
  assertParallelMigrationVerification,
  assertPinnedProviderHelm,
} from './release-workflow-policy.mjs';

test('each provider job must pin Helm before credentials and stop if selection fails', () => {
  const workflow = {
    jobs: Object.fromEntries(
      ['qualified', 'deploy'].map((name) => [
        name,
        {
          steps: [
            { run: 'corepack yarn studio-server:setup:k8s-tools --github-env', 'timeout-minutes': 2 },
            { uses: 'google-github-actions/auth@fixture' },
          ],
        },
      ]),
    ),
  };
  assert.doesNotThrow(() => assertPinnedProviderHelm(workflow));
  for (const name of ['qualified', 'deploy']) {
    for (const change of [
      (s) => s.reverse(),
      (s) => s.shift(),
      (s) => {
        s[0].if = 'false';
      },
      (s) => {
        s[0]['continue-on-error'] = true;
      },
    ]) {
      const broken = structuredClone(workflow);
      change(broken.jobs[name].steps);
      assert.throws(() => assertPinnedProviderHelm(broken));
    }
  }
});

function migrationFixture() {
  return {
    jobs: {
      'deployment-contracts': {
        needs: ['changes', 'build-studio-server'],
        strategy: {
          'max-parallel': 4,
          'fail-fast': false,
          matrix: { lane: ['managed', 'migration', 'deployment', 'gateway'] },
        },
        steps: [
          { name: 'Verify restored compiled workspace dependencies', run: 'yarn check:compiled-workspace-exports' },
          { name: 'Verify compiled migration runtime', if: "matrix.lane == 'migration'", run: 'test -s fixture' },
          {
            name: 'Verify VM-to-managed copy, retry, and exact readback',
            if: "matrix.lane == 'migration'",
            run: 'node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api exec tsx src/tests/workflow-storage-migration-managed.integration.ts',
          },
        ],
      },
      verify: {
        if: 'always()',
        needs: ['deployment-contracts'],
        steps: [
          {
            name: 'Require every applicable Studio Server gate',
            env: { DEPLOYMENT_RESULT: '${{ needs.deployment-contracts.result }}' },
            run: 'for result in "$DEPLOYMENT_RESULT"; do\n  test "$result" = success\ndone',
          },
        ],
      },
    },
  };
}

test('the complete migration fixture remains parallel and required after verified compilation', () => {
  assert.doesNotThrow(() => assertParallelMigrationVerification(migrationFixture()));
});

test('migration coverage cannot be skipped, filtered, duplicated, serialized or allowed to fail', () => {
  for (const mutate of [
    (w) => {
      w.jobs['deployment-contracts'].needs.pop();
    },
    (w) => {
      w.jobs['deployment-contracts'].strategy.matrix.lane.splice(1, 1);
    },
    (w) => {
      w.jobs['deployment-contracts'].strategy['max-parallel'] = 3;
    },
    (w) => {
      w.jobs['deployment-contracts'].strategy['fail-fast'] = true;
    },
    (w) => {
      w.jobs['deployment-contracts']['continue-on-error'] = true;
    },
    (w) => {
      w.jobs['deployment-contracts'].steps[1].if = 'false';
    },
    (w) => {
      w.jobs['deployment-contracts'].steps.reverse();
    },
    (w) => {
      w.jobs['deployment-contracts'].steps[2].if = "matrix.lane == 'managed'";
    },
    (w) => {
      w.jobs['deployment-contracts'].steps[2]['continue-on-error'] = true;
    },
    (w) => {
      w.jobs['deployment-contracts'].steps[2].run += ' --supervised-restore-only';
    },
    (w) => {
      w.jobs['deployment-contracts'].steps.push({ run: 'yarn workspace api run test:migration-managed' });
    },
    (w) => {
      w.jobs.verify.needs = [];
    },
    (w) => {
      w.jobs.verify.if = 'success()';
    },
    (w) => {
      w.jobs.verify.steps[0]['continue-on-error'] = true;
    },
    (w) => {
      delete w.jobs.verify.steps[0].env.DEPLOYMENT_RESULT;
    },
    (w) => {
      w.jobs.verify.steps[0].run = 'echo passed';
    },
    (w) => {
      w.jobs.verify.steps[0].run = w.jobs.verify.steps[0].run.replace('= success', '= success || true');
    },
  ]) {
    const workflow = migrationFixture();
    mutate(workflow);
    assert.throws(() => assertParallelMigrationVerification(workflow), String(mutate));
  }
});

function fixture() {
  const shared = { uses: './.github/workflows/studio-server-source-contracts.yml' };
  return {
    build: { jobs: { 'source-contracts': { ...shared }, 'compiled-artifacts': { needs: 'source-contracts' } } },
    images: {
      jobs: {
        'source-contracts': { ...shared },
        'build-and-push': {
          needs: 'source-contracts',
          steps: [
            { name: 'Scan every published architecture immediately', run: 'node scripts/ci/scan-container-images.mjs' },
            {
              name: 'Retain container vulnerability evidence',
              if: '${{ always() }}',
              with: {
                name: 'container-security-${{ matrix.service }}-${{ github.run_id }}-${{ github.run_attempt }}',
                'if-no-files-found': 'error',
              },
            },
          ],
        },
        'scan-images': {
          name: 'Scan runtime image (${{ matrix.service }})',
          needs: ['release-manifest'],
          steps: [
            {
              name: 'Verify every scanned digest and architecture',
              run: 'node scripts/ci/verify-container-scan.mjs --manifest artifacts/studio-server-release-manifest/candidate-release-manifest.json --service ${{ matrix.service }} --input artifacts/container-security/${{ matrix.service }}',
            },
            {
              name: 'Download component scan evidence',
              with: {
                name: 'container-security-${{ matrix.service }}-${{ github.run_id }}-${{ github.run_attempt }}',
                path: 'artifacts/container-security/${{ matrix.service }}',
              },
            },
          ],
        },
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
        'deployment-command-tests': {
          needs: ['changes', 'source-contracts'],
          steps: [
            {
              name: 'Run deployment command journeys',
              run: 'yarn node --test deploy/studio-server/scripts/deployment-command.test.mjs',
            },
          ],
        },
        verify: {
          needs: ['source-contracts', 'deployment-command-tests'],
          steps: [
            {
              env: {
                SOURCE_RESULT: '${{ needs.source-contracts.result }}',
                DEPLOYMENT_COMMAND_RESULT: '${{ needs.deployment-command-tests.result }}',
              },
              run: 'for result in "$SOURCE_RESULT" "$DEPLOYMENT_COMMAND_RESULT"; do test "$result" = success; done',
            },
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
            {
              name: 'Install native provider test tools',
              'timeout-minutes': 2,
              env: { KUBECTL_VERSION: 'v1.36.6', HELM_VERSION: 'v3.22.1' },
              run: 'sha256sum -c -\necho "RIVET_K8S_HELM_BIN=$tools/helm" >> "$GITHUB_ENV"',
            },
            {
              name: 'Verify packaged provider preparation and cleanup before expensive work',
              'timeout-minutes': 2,
              run: 'yarn node --test deploy/studio-server/scripts/provider-tool-contracts.test.mjs deploy/studio-server/scripts/reusable-staging.test.mjs',
            },
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
    for (const [workflow, job] of [
      ['images', 'managed-kubernetes-release-gate'],
      ['verify', 'deployment-command-tests'],
    ]) {
      const f = fixture();
      f[workflow].jobs[job].if = condition;
      assert.throws(() => assertFastReleasePolicy(f), /successful prerequisites/);
    }
  }
});

test('native preparation checks cannot be removed, skipped or allowed to fail', () => {
  for (const mutate of [
    (steps) => steps.pop(),
    (steps) => {
      steps.at(-1).if = 'false';
    },
    (steps) => {
      steps.at(-1)['continue-on-error'] = true;
    },
    (steps) => {
      steps.find((s) => s.name === 'Install native provider test tools').env.KUBECTL_VERSION = 'latest';
    },
    (steps) => {
      steps.find((s) => s.name === 'Install native provider test tools').run = 'download without checksums';
    },
    (steps) => {
      steps.find((s) => s.name === 'Install native provider test tools').run = 'sha256sum -c -';
    },
  ]) {
    const f = fixture();
    mutate(f.source.jobs.source.steps);
    assert.throws(() => assertFastReleasePolicy(f));
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

test('deployment command coverage and failure results are mandatory after splitting the jobs', () => {
  for (const mutate of [
    (f) => (f.verify.jobs['deployment-command-tests'].needs = ['changes', 'build-studio-server']),
    (f) => (f.verify.jobs['deployment-command-tests'].if = 'false'),
    (f) => (f.verify.jobs['deployment-command-tests']['continue-on-error'] = true),
    (f) => (f.verify.jobs['deployment-command-tests'].steps[0].if = 'false'),
    (f) => (f.verify.jobs['deployment-command-tests'].steps[0]['continue-on-error'] = true),
    (f) => (f.verify.jobs['deployment-command-tests'].steps[0].run += ' --test-name-pattern=smoke'),
    (f) => (f.verify.jobs.verify.needs = ['source-contracts']),
    (f) => delete f.verify.jobs.verify.steps[0].env.DEPLOYMENT_COMMAND_RESULT,
    (f) => (f.verify.jobs.verify.steps[0].run = 'test "$SOURCE_RESULT" = success'),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});

test('early image scans remain mandatory and their evidence must match the final manifest', () => {
  for (const mutate of [
    (f) => {
      f.images.jobs['build-and-push'].steps.shift();
    },
    (f) => {
      f.images.jobs['build-and-push'].steps[0].if = 'false';
    },
    (f) => {
      f.images.jobs['build-and-push'].steps[0]['continue-on-error'] = true;
    },
    (f) => {
      f.images.jobs['scan-images'].steps[0].if = 'false';
    },
    (f) => {
      f.images.jobs['scan-images'].steps[0]['continue-on-error'] = true;
    },
    (f) => {
      f.images.jobs['scan-images'].steps[0].run = 'echo passed';
    },
    (f) => {
      f.images.jobs['scan-images'].steps[1].with.name = 'previous-run';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});
