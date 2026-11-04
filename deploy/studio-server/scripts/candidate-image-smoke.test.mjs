import assert from 'node:assert/strict';
import test from 'node:test';

import { createCandidateWorkflowRequestBody, extractCandidateWorkflowValue } from './candidate-image-smoke.mjs';
import { pullImageWithRetry } from './lib/docker-image-pull.mjs';
import { run as runRehearsalCommand } from './local-upgrade-image-rehearsal.mjs';

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

test('image download recovers from the observed registry reset using the same reference', async () => {
  const image = 'ghcr.io/example/api:candidate-exact-source';
  const calls = [];
  const delays = [];
  const warnings = [];
  const result = { code: 0, output: 'Digest: sha256:fixture' };
  assert.equal(
    await pullImageWithRetry(
      image,
      async (reference) => {
        calls.push(reference);
        if (calls.length === 1)
          throw Error('failed to copy: read tcp 10.0.0.1:40714->192.0.2.1:443: read: connection reset by peer');
        return result;
      },
      { wait: async (delay) => delays.push(delay), warn: (message) => warnings.push(message) },
    ),
    result,
  );
  assert.deepEqual(calls, [image, image]);
  assert.deepEqual(delays, [5_000]);
  assert.equal(warnings.length, 1);
});

test('persistent image transport errors stop after three attempts and retain the final failure', async () => {
  const failure = Error('TLS handshake timeout');
  const delays = [];
  let calls = 0;
  await assert.rejects(
    pullImageWithRetry(
      'ghcr.io/example/api@sha256:fixture',
      async () => {
        calls++;
        throw failure;
      },
      { wait: async (delay) => delays.push(delay), warn: () => {} },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5_000, 15_000]);
});

test('image download fails immediately for deterministic or unknown errors', async (t) => {
  for (const message of [
    'unauthorized: authentication required',
    'denied: requested access to the resource is denied; connection reset by peer',
    'manifest unknown',
    'no matching manifest for linux/amd64',
    'invalid reference format',
    'filesystem layer verification failed: digest mismatch',
    'no space left on device',
    'spawn docker ENOENT',
    'unrecognised pull failure',
  ]) {
    await t.test(message, async () => {
      const failure = Error(message);
      let calls = 0;
      await assert.rejects(
        pullImageWithRetry('ghcr.io/example/api:fixture', async () => {
          calls++;
          throw failure;
        }),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    });
  }
});

test('pull retries recognise the complete stderr from an actual failed command', async () => {
  let calls = 0;
  const result = await pullImageWithRetry(
    'ghcr.io/example/web:fixture',
    async () => {
      calls++;
      return runRehearsalCommand(
        process.execPath,
        [
          '--eval',
          calls === 1 ? "process.stderr.write('unexpected EOF'); process.exitCode = 1" : "console.log('downloaded')",
        ],
        process.env,
      );
    },
    { wait: async () => {}, warn: () => {} },
  );
  assert.equal(calls, 2);
  assert.match(result.output, /downloaded/);
});
