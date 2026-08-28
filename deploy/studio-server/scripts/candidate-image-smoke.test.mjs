import assert from 'node:assert/strict';
import test from 'node:test';

import { createCandidateWorkflowRequestBody, extractCandidateWorkflowValue } from './candidate-image-smoke.mjs';

test('candidate smoke sends a direct JSON value to a single Graph Input', () => {
  assert.equal(createCandidateWorkflowRequestBody(), '"candidate-ok"');
});

test('candidate smoke extracts Rivet any-data workflow responses', () => {
  assert.deepEqual(
    extractCandidateWorkflowValue({ value: { type: 'any', value: { environmentValue: 'candidate-ok' } } }),
    { environmentValue: 'candidate-ok' },
  );
});

test('candidate smoke accepts plain JSON workflow responses', () => {
  const value = { environmentValue: 'candidate-ok' };
  assert.equal(extractCandidateWorkflowValue(value), value);
});
