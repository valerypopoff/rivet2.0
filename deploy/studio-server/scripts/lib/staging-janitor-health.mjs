import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

/** Read-only health shared by hosted preparation and operation admission. A
 * started Pod alone does not prove the new cleanup program has run. */
export async function observeStagingJanitor(read, settings, driverDigest, now = Date.now) {
  const object = await read('configmaps', 'rivet-qualification-janitor-health');
  const health = JSON.parse(object?.data?.health ?? '{}');
  const fresh = () => {
    const age = now() - health.observedAt;
    return Number.isFinite(health.observedAt) && age >= 0 && age < 60000;
  };
  if (
    health.clusterUid !== settings.clusterUid ||
    health.driverDigest !== driverDigest ||
    !fresh() ||
    typeof health.podUid !== 'string' ||
    !health.podUid ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(health.podName ?? '')
  )
    return;
  const pod = await read('pods', health.podName);
  if (
    pod?.metadata?.uid === health.podUid &&
    !pod.metadata.deletionTimestamp &&
    pod.status?.phase === 'Running' &&
    pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') &&
    fresh()
  )
    return health;
}

export async function waitForStagingJanitor(
  read,
  settings,
  driverDigest,
  { timeoutMs = 60000, intervalMs = 1000, now = Date.now } = {},
) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const health = await observeStagingJanitor(read, settings, driverDigest, now);
    if (health) return health;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  assert.fail('Independent janitor is not freshly healthy for this exact driver');
}
