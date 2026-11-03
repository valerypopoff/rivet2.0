import { spawnSync } from 'node:child_process';

// Source-only: no compiled workspace exports, Docker, browser or cloud access.
const suites = [
  'deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs',
  'deploy/studio-server/scripts/ha-routing-withdrawal.test.mjs',
  'deploy/studio-server/scripts/ha-rollout-headroom.test.mjs',
  'deploy/studio-server/scripts/managed-disruption-transport.test.mjs',
  'scripts/ci/release-workflow-policy.test.mjs',
  'scripts/ci/qualification-build-cache.test.mjs',
];
for (const args of [['--test', ...suites], ['scripts/checks/check-ci-workflows.mjs']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
