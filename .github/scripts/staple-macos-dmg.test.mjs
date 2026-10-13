import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientStaplerFailure, stapleMacDmgWithRetries } from './staple-macos-dmg.mjs';

const networkLoss = {
  status: 68,
  output:
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.\n',
};
const success = { status: 0, output: 'The staple and validate action worked!\n' };

test('only explicit transient Apple network errors qualify for stapler retry', () => {
  for (const code of [1001, 1004, 1005, 1009]) {
    assert.equal(
      isTransientStaplerFailure({
        status: 68,
        output: `Error Domain=NSURLErrorDomain Code=-${code} "network failure"`,
      }),
      true,
    );
  }
  for (const result of [
    { status: 0, output: networkLoss.output },
    { status: 65, output: networkLoss.output },
    { status: null, output: networkLoss.output },
    { status: 68, output: 'CloudKit response inconsistent. No valid ticket.' },
    { status: 68, output: 'Error Domain=NSURLErrorDomain Code=-1202 "Untrusted certificate"' },
    { status: 68, output: 'The staple and validate action failed! Error 68.' },
    { status: 68, output: 'Error Domain=NSURLErrorDomain Code=-10050' },
  ])
    assert.equal(isTransientStaplerFailure(result), false);
});

function fixture(results) {
  const commands = [],
    waits = [],
    output = [],
    warnings = [];
  return {
    commands,
    waits,
    output,
    warnings,
    options: {
      run: async (program, args) => {
        commands.push([program, args]);
        return results.shift();
      },
      wait: async (delay) => waits.push(delay),
      write: (text) => output.push(text),
      warn: (text) => warnings.push(text),
    },
  };
}

test('a lost ticket connection retries the same accepted DMG without signing, submission or rebuilding', async () => {
  const f = fixture([networkLoss, success]);
  const path = 'bundles/Rivet 2_2.26.0_x64.dmg';
  assert.equal(await stapleMacDmgWithRetries(path, f.options), success);
  assert.deepEqual(
    f.commands,
    Array.from({ length: 2 }, () => ['xcrun', ['stapler', 'staple', path]]),
  );
  assert.deepEqual(f.waits, [5000]);
  assert.deepEqual(f.output, [networkLoss.output, success.output]);
  assert.equal(f.warnings.length, 1);
});

test('persistent network loss fails after three attempts, preserving the last native failure', async () => {
  const f = fixture([networkLoss, networkLoss, networkLoss]);
  assert.equal(await stapleMacDmgWithRetries('release.dmg', f.options), networkLoss);
  assert.equal(f.commands.length, 3);
  assert.deepEqual(f.waits, [5000, 15000]);
  assert.equal(f.warnings.length, 2);
});

test('a permanent failure after a transient one stops immediately', async () => {
  const failure = { status: 68, output: 'No valid ticket.' };
  const f = fixture([networkLoss, failure, success]);
  assert.equal(await stapleMacDmgWithRetries('release.dmg', f.options), failure);
  assert.equal(f.commands.length, 2);
  assert.deepEqual(f.waits, [5000]);
});

test('unexpected execution exceptions are not converted into a retry or success', async () => {
  const error = new Error('unexpected command failure');
  const events = [];
  await assert.rejects(
    stapleMacDmgWithRetries('release.dmg', {
      run: async () => {
        events.push('run');
        throw error;
      },
      wait: async () => events.push('wait'),
    }),
    (actual) => actual === error,
  );
  assert.deepEqual(events, ['run']);
});

test('successful and permanent failures complete once without a retry', async () => {
  for (const result of [
    success,
    { status: 68, output: 'No valid ticket.' },
    { status: 65, output: 'Invalid signed DMG.' },
    { status: null, output: '', error: new Error('xcrun unavailable') },
  ]) {
    const f = fixture([result]);
    assert.equal(await stapleMacDmgWithRetries('release.dmg', f.options), result);
    assert.equal(f.commands.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.warnings, []);
  }
});
