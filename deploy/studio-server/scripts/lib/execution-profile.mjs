import assert from 'node:assert/strict';
import { resourceQuantity } from './pod-resource-requests.mjs';

/** Installation-specific requests, admission and idle floor. No limits, images,
 * credentials or autoscaler timing are selected by a profile. */
export function executionProfile(value, { staging = false } = {}) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), ['maxActiveRunsPerPod', 'minReplicas', 'requests']);
  assert.ok(
    staging ? [1, 2].includes(value.minReplicas) : value.minReplicas === 2,
    'Production retains two workers; staging may idle at one',
  );
  assert.ok(
    Number.isSafeInteger(value.maxActiveRunsPerPod) &&
      value.maxActiveRunsPerPod >= 2 &&
      value.maxActiveRunsPerPod <= 10000,
  );
  assert.deepEqual(Object.keys(value.requests ?? {}).sort(), ['cpu', 'memory']);
  for (const resource of ['cpu', 'memory']) {
    const quantity = value.requests[resource];
    assert.ok(typeof quantity === 'string' && quantity.length <= 32);
    const amount = resourceQuantity(quantity, resource);
    assert.ok(Number.isFinite(amount) && amount > 0, 'Execution requests must be positive finite quantities');
  }
  return structuredClone(value);
}

export function applyExecutionProfile(values, profile) {
  const result = structuredClone(values);
  result.resources.execution.requests = { ...result.resources.execution.requests, ...profile.requests };
  result.publishedExecutionAdmission = {
    ...result.publishedExecutionAdmission,
    mode: 'enforce',
    maxActiveRunsPerPod: profile.maxActiveRunsPerPod,
  };
  return result;
}

export function assertExecutionProfile(values, profile) {
  for (const resource of ['cpu', 'memory'])
    assert.equal(
      resourceQuantity(values.resources?.execution?.requests?.[resource], resource),
      resourceQuantity(profile.requests[resource], resource),
      `Execution ${resource} request differs from its profile`,
    );
  assert.equal(values.publishedExecutionAdmission?.mode, 'enforce');
  assert.equal(values.publishedExecutionAdmission.maxActiveRunsPerPod, profile.maxActiveRunsPerPod);
}
