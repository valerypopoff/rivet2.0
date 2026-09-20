import assert from 'node:assert/strict';
import test from 'node:test';
import { getInterpolationTextSegments } from './interpolationTextSegments.js';

test('getInterpolationTextSegments highlights only active interpolation tokens', () => {
  assert.deepEqual(getInterpolationTextSegments('before {{value.path | upper}} after'), [
    { text: 'before ', isInterpolation: false },
    { text: '{{value.path | upper}}', isInterpolation: true },
    { text: ' after', isInterpolation: false },
  ]);
});

test('getInterpolationTextSegments keeps escaped and malformed text unhighlighted while recovering later tokens', () => {
  assert.deepEqual(getInterpolationTextSegments('{{{literal}}} {{broken {{actual}}'), [
    { text: '{{{literal}}} {{broken ', isInterpolation: false },
    { text: '{{actual}}', isInterpolation: true },
  ]);
});
