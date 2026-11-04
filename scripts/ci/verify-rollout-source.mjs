import { spawnSync } from 'node:child_process';

// Source-only: no compiled workspace exports, Docker, browser or cloud access.
const suites = [
  'deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs',
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
  'scripts/ci/release-workflow-policy.test.mjs',
  'scripts/ci/qualification-build-cache.test.mjs',
];
for (const args of [['--test', ...suites], ['scripts/checks/check-ci-workflows.mjs']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
