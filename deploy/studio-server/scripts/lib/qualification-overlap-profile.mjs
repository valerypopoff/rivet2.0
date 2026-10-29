import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** An explicitly reviewed staging target, never an automatic production repair.
 * Keep the worker ceiling and database allowance in the observed sizing envelope.
 * Helm remains the single owner of full connection-budget arithmetic. */
export function overlapQualificationProfile(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    'backendResources',
    'maxConnections',
    'poolMaxPerApiPod',
    'protocol',
    'reservedConnections',
  ]);
  assert.equal(value.protocol, 1);
  assert.ok(Number.isSafeInteger(value.poolMaxPerApiPod) && value.poolMaxPerApiPod > 0);
  assert.ok(Number.isSafeInteger(value.maxConnections) && value.maxConnections > 0);
  assert.ok(
    Number.isSafeInteger(value.reservedConnections) &&
      value.reservedConnections >= 0 &&
      value.reservedConnections < value.maxConnections,
  );
  const resources = value.backendResources;
  assert.ok(resources && typeof resources === 'object' && !Array.isArray(resources));
  assert.ok(Object.keys(resources).every((k) => ['requests', 'limits'].includes(k)));
  assert.ok(resources.requests?.cpu && resources.requests?.memory && resources.requests?.['ephemeral-storage']);
  assert.ok(resources.limits?.memory && resources.limits?.['ephemeral-storage']);
  const normalize = (items) => Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));
  for (const items of Object.values(resources)) {
    assert.ok(items && !Array.isArray(items));
    assert.ok(Object.keys(items).every((k) => ['cpu', 'memory', 'ephemeral-storage'].includes(k)));
    for (const quantity of Object.values(items)) {
      assert.match(quantity, /^(?:[1-9][0-9]*|[0-9]+\.[0-9]+)(?:m|Ki|Mi|Gi|Ti)?$/);
      assert.ok(Number.parseFloat(quantity) > 0);
    }
  }
  return {
    protocol: 1,
    poolMaxPerApiPod: value.poolMaxPerApiPod,
    maxConnections: value.maxConnections,
    reservedConnections: value.reservedConnections,
    backendResources: Object.fromEntries(
      Object.keys(resources)
        .sort()
        .map((k) => [k, normalize(resources[k])]),
    ),
  };
}

export function overlapProfileDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(overlapQualificationProfile(value)))
    .digest('hex');
}

export function applyOverlapQualificationProfile(values, profile) {
  const target = structuredClone(values);
  const normalized = overlapQualificationProfile(profile);
  assert.equal(
    target.postgres.maxConnections,
    normalized.maxConnections,
    'Overlap must retain the observed database allowance',
  );
  assert.equal(
    target.postgres.reservedConnections,
    normalized.reservedConnections,
    'Overlap must retain the observed database reserve',
  );
  target.postgres.poolMaxPerApiPod = normalized.poolMaxPerApiPod;
  target.resources.backendOverlap = normalized.backendResources;
  return target;
}

export function assertOverlapQualificationValues(values, profile) {
  const normalized = overlapQualificationProfile(profile);
  assert.equal(values.postgres?.poolMaxPerApiPod, normalized.poolMaxPerApiPod, 'Qualified pool size changed');
  assert.equal(values.postgres?.maxConnections, normalized.maxConnections);
  assert.equal(values.postgres?.reservedConnections, normalized.reservedConnections);
  assert.deepEqual(values.resources?.backendOverlap, normalized.backendResources, 'Qualified backend sizing changed');
}
