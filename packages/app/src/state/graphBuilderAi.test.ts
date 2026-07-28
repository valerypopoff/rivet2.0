import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGraphBuilderImplementationMode } from './graphBuilderAi.js';

test('Graph Builder implementation mode fails closed to the rollout-safe legacy implementation', () => {
  assert.equal(normalizeGraphBuilderImplementationMode('legacy'), 'legacy');
  assert.equal(normalizeGraphBuilderImplementationMode('plan-b'), 'plan-b');
  assert.equal(normalizeGraphBuilderImplementationMode('unknown'), 'legacy');
  assert.equal(normalizeGraphBuilderImplementationMode(null), 'legacy');
});
