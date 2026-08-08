import { strict as assert } from 'node:assert';
import test from 'node:test';
import { formatRunActivityDuration } from './runActivityDuration.js';

test('formats short and long Run Activity durations with the shared compact policy', () => {
  assert.equal(formatRunActivityDuration(750), '750ms');
  assert.equal(formatRunActivityDuration(85_050), '1m 25.05s');
});
