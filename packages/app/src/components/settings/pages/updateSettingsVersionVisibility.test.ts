import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleSkippedUpdateVersion } from './updateSettingsVersionVisibility.js';

test('getVisibleSkippedUpdateVersion shows skipped versions newer than the installed app', () => {
  assert.equal(getVisibleSkippedUpdateVersion('2.6.0', '2.7.0'), '2.7.0');
});

test('getVisibleSkippedUpdateVersion hides skipped versions older than the installed app', () => {
  assert.equal(getVisibleSkippedUpdateVersion('2.8.0', '2.7.0'), undefined);
});

test('getVisibleSkippedUpdateVersion hides skipped versions matching the installed app', () => {
  assert.equal(getVisibleSkippedUpdateVersion('2.7.0', '2.7.0'), undefined);
});

test('getVisibleSkippedUpdateVersion compares coercible desktop versions', () => {
  assert.equal(getVisibleSkippedUpdateVersion('Rivet 2.8.0', '2.7.0'), undefined);
  assert.equal(getVisibleSkippedUpdateVersion('2.6', 'v2.7.0'), 'v2.7.0');
});

test('getVisibleSkippedUpdateVersion keeps skipped versions visible when the installed version is unknown', () => {
  assert.equal(getVisibleSkippedUpdateVersion('', '2.7.0'), '2.7.0');
  assert.equal(getVisibleSkippedUpdateVersion(undefined, '2.7.0'), '2.7.0');
});

test('getVisibleSkippedUpdateVersion hides empty skipped versions', () => {
  assert.equal(getVisibleSkippedUpdateVersion('2.7.0', undefined), undefined);
  assert.equal(getVisibleSkippedUpdateVersion('2.7.0', ''), undefined);
});
