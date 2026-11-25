import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  resolveGuardedReleaseCommand,
  withRecordingStorageTransition,
} from '../../maintenance/recording-storage-transition.js';

const fixtureIdentity = { context: 'fixture', namespace: 'fixture', release: 'rivet', namespaceUid: 'fixture-uid' };
const credentialConfiguration = {
  protocol: 1 as const,
  identity: fixtureIdentity,
  storageIdentity: 'a'.repeat(64),
  settings: {
    databaseUrl: { kubernetesSecret: { name: 'fixture', key: 'url' } },
    encryptionKey: { value: 'fixture' },
    sslMode: 'disable' as const,
  },
};

void test('recording transition permits only the journaled checkout release entrypoint', () => {
  const entry = fileURLToPath(
    new URL('../../../../deploy/studio-server/scripts/deploy-kubernetes-release.mjs', import.meta.url),
  );
  assert.deepEqual(resolveGuardedReleaseCommand('node', [entry, '--preflight-only']), {
    program: process.execPath,
    args: [entry, '--preflight-only'],
  });
  for (const [program, args] of [
    ['bash', [entry]],
    ['node', ['other-deployment.mjs']],
    ['node', ['--eval', 'process.exit(0)']],
    ['node', []],
  ] as const)
    assert.throws(() => resolveGuardedReleaseCommand(program, [...args]), /only supports Node/);
});

void test('an already cancelled guard never reads configuration or starts an action', async () => {
  const signal = AbortSignal.abort(new Error('cancelled before acquisition'));
  const interrupts = new EventEmitter();
  await assert.rejects(
    withRecordingStorageTransition(
      { identity: { context: 'fixture', namespace: 'fixture', release: 'rivet' }, signal, interrupts },
      async () => assert.fail('Cancelled action must not start'),
    ),
    /cancelled before acquisition/,
  );
  assert.equal(interrupts.eventNames().length, 0);
});

void test('interruption during credential preparation owns its cancellation and restores listeners/environment', async () => {
  const interrupts = new EventEmitter();
  const environment = JSON.stringify(process.env);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = withRecordingStorageTransition(
    {
      identity: fixtureIdentity,
      interrupts,
      configuration: credentialConfiguration,
      run: async (_program, _args, options) =>
        new Promise((_resolve, reject) => {
          entered();
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        }),
    },
    async () => assert.fail('Interrupted preparation must not start deployment'),
  );
  const rejected = assert.rejects(done, /interrupted/);
  await ready;
  interrupts.emit('SIGTERM');
  await rejected;
  assert.equal(interrupts.eventNames().length, 0);
  assert.equal(JSON.stringify(process.env), environment);
});

void test('a foreign installation is refused before any credential request', async () => {
  let reads = 0;
  const interrupts = new EventEmitter();
  await assert.rejects(
    withRecordingStorageTransition(
      {
        identity: { ...fixtureIdentity, namespace: 'foreign' },
        configuration: credentialConfiguration,
        interrupts,
        run: async () => {
          reads++;
          throw new Error('Unexpected credential access');
        },
      },
      async () => assert.fail('Foreign deployment must not start'),
    ),
    /configuration is invalid/,
  );
  assert.equal(reads, 0);
  assert.equal(interrupts.eventNames().length, 0);
});
