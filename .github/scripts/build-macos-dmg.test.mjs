import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientMacDmgBuildFailure, runMacDmgBuildWithRetries } from './build-macos-dmg.mjs';

void test('recognizes only the hdiutil resource-busy DMG creation failure as transient', () => {
  assert.equal(
    isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: create failed - Resource busy' }),
    true,
  );
  assert.equal(isTransientMacDmgBuildFailure({ status: 0, output: 'hdiutil: create failed - Resource busy' }), false);
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'hdiutil: create failed - Permission denied' }), false);
  assert.equal(isTransientMacDmgBuildFailure({ status: 1, output: 'error: could not compile Rivet' }), false);
});

void test('cleans and retries a transient DMG failure', async () => {
  const events = [];
  const results = [
    { status: 1, output: 'hdiutil: create failed - Resource busy' },
    { status: 0, output: 'completed' },
  ];

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return results.shift();
    },
    cleanup: async () => events.push('cleanup'),
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
    warn: () => {},
  });

  assert.deepEqual(result, { status: 0, output: 'completed' });
  assert.deepEqual(events, ['run', 'cleanup', 'wait:5000', 'run']);
});

void test('returns a deterministic failure without retrying it', async () => {
  const events = [];
  const failure = { status: 1, output: 'error: could not compile Rivet' };

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return failure;
    },
    cleanup: async () => events.push('cleanup'),
    wait: async () => events.push('wait'),
    warn: () => {},
  });

  assert.equal(result, failure);
  assert.deepEqual(events, ['run']);
});

void test('stops after the bounded number of transient retries', async () => {
  const events = [];
  const failure = { status: 1, output: 'hdiutil: create failed - Resource busy' };

  const result = await runMacDmgBuildWithRetries({
    run: async () => {
      events.push('run');
      return failure;
    },
    cleanup: async () => events.push('cleanup'),
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
    warn: () => {},
  });

  assert.equal(result, failure);
  assert.deepEqual(events, ['run', 'cleanup', 'wait:5000', 'run', 'cleanup', 'wait:15000', 'run']);
});
