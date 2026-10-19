import { rm } from 'node:fs/promises';

// Local DNS fixture finalization only. Never discover resources by prefix or
// replace a test failure with a cleanup failure.
export async function cleanupProxyDnsFixture({ containers, networkId, fixture, docker, failure }) {
  const failures = failure ? [failure] : [];
  for (const name of containers) {
    try {
      docker('rm', '-f', name);
      containers.delete(name);
    } catch (error) {
      failures.push(new Error(`Could not remove DNS fixture container ${name}`, { cause: error }));
    }
  }
  if (networkId) {
    try {
      docker('network', 'rm', networkId);
    } catch (error) {
      failures.push(new Error(`Could not remove DNS fixture network ${networkId}`, { cause: error }));
    }
  }
  try {
    await rm(fixture, { recursive: true, force: true });
  } catch (error) {
    failures.push(new Error(`Could not remove DNS fixture directory ${fixture}`, { cause: error }));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'DNS verification or fixture cleanup failed');
}
