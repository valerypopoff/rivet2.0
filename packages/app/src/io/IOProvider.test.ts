import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import { deserializeLegacyEvaluationProjectData } from './IOProvider.js';

test('invalid legacy evaluation attachments do not block project migration', () => {
  assert.deepEqual(deserializeLegacyEvaluationProjectData({ suites: 'not-an-array' }), createEmptyEvaluationProjectData());
});
