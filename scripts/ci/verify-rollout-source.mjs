import { spawnSync } from 'node:child_process';

// Source-only: no compiled workspace exports, Docker, browser or cloud access.
const suites = [
  'deploy/studio-server/scripts/ensure-k8s-tools.test.mjs',
  'deploy/studio-server/scripts/release-tooling.test.mjs',
  'deploy/studio-server/scripts/qualified-deployment-inputs.test.mjs',
  'deploy/studio-server/scripts/qualified-deployment-command.test.mjs',
  'deploy/studio-server/scripts/ha-background-probe.test.mjs',
  'deploy/studio-server/scripts/ha-runner-space.test.mjs',
  'deploy/studio-server/scripts/fast-rollout-failure.test.mjs',
  'deploy/studio-server/scripts/candidate-image-smoke.test.mjs',
  'deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs',
  'deploy/studio-server/scripts/deployment-workflow.test.mjs',
  'deploy/studio-server/scripts/deployment-readiness.test.mjs',
  'deploy/studio-server/scripts/runtime-qualification-execution.test.mjs',
  'deploy/studio-server/scripts/release-operation-journal.test.mjs',
  'deploy/studio-server/scripts/read-concurrently.test.mjs',
  'deploy/studio-server/scripts/acceptance-concurrency.test.mjs',
  'deploy/studio-server/scripts/component-image-reuse.test.mjs',
  'deploy/studio-server/scripts/execution-pool-transition.test.mjs',
  'deploy/studio-server/scripts/execution-pool-evidence.test.mjs',
  'deploy/studio-server/scripts/execution-pool-autoscaling.test.mjs',
  'deploy/studio-server/scripts/ha-template-readiness.test.mjs',
  'deploy/studio-server/scripts/kubernetes-release-settlement.test.mjs',
  'deploy/studio-server/scripts/ha-routing-withdrawal.test.mjs',
  'deploy/studio-server/scripts/ha-rollout-headroom.test.mjs',
  'deploy/studio-server/scripts/managed-disruption-transport.test.mjs',
  'deploy/studio-server/scripts/provider-rollout-observation.test.mjs',
  'deploy/studio-server/scripts/request-continuity-provider.test.mjs',
  'deploy/studio-server/scripts/request-continuity-evidence.test.mjs',
  'deploy/studio-server/scripts/proxy-continuity-transition.test.mjs',
  'deploy/studio-server/scripts/resource-sizing.test.mjs',
  'deploy/studio-server/scripts/prepare-hosted-release.test.mjs',
  'deploy/studio-server/scripts/reusable-staging-coordinator.test.mjs',
  'deploy/studio-server/scripts/reusable-staging-transport.test.mjs',
  'deploy/studio-server/scripts/retained-staging-application.test.mjs',
  'scripts/ci/release-workflow-policy.test.mjs',
  'scripts/ci/qualification-build-cache.test.mjs',
  'scripts/ci/qualification-admission.test.mjs',
  'scripts/ci/qualification-operator.test.mjs',
];
for (const args of [
  ['--test', ...suites],
  [
    '--test',
    '--test-name-pattern',
    'ordinary observation keeps a single truthful window:.*(?:502|proxy-(?:settings|recovery|zero))$',
    'deploy/studio-server/scripts/runtime-upgrade-qualification.test.mjs',
  ],
  [
    '--test',
    '--test-name-pattern',
    'shutdown proof|timed-out adapter',
    'deploy/studio-server/scripts/maintenance-deployment-plan.test.mjs',
  ],
  ['scripts/checks/check-ci-workflows.mjs'],
  ['scripts/checks/check-rollout-entrypoints.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
