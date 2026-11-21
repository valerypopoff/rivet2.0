import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveGuardedReleaseCommand,
  waitForGuardedStorageCommand,
} from '../../maintenance/recording-storage-transition.js';

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

void test('guarded normal and failed commands wait for close and clean listeners', async () => {
  for (const failure of [undefined, new Error('cannot signal child')]) {
    const child = new EventEmitter() as ChildProcess;
    const interrupts = new EventEmitter();
    const done = waitForGuardedStorageCommand(child, new AbortController().signal, async () => {}, interrupts);
    let settled = false;
    const expected = (failure ? assert.rejects(done, (error) => error === failure) : done).then(() => {
      settled = true;
    });
    if (failure) {
      child.emit('error', failure);
      child.emit('error', failure);
    }
    await setImmediate();
    assert.equal(settled, false);
    child.emit('close', 0);
    await expected;
    assert.equal(interrupts.listenerCount('SIGINT'), 0);
    assert.equal(interrupts.listenerCount('SIGTERM'), 0);
    assert.equal(child.listenerCount('error'), 0);
  }
});

void test('guarded command never reports interrupted zero exit as success or releases before close', async () => {
  for (const event of ['SIGINT', 'SIGTERM', 'lease-lost', 'already-aborted'] as const) {
    const child = new EventEmitter() as ChildProcess;
    let kills = 0;
    child.kill = () => {
      kills++;
      return true;
    };
    const controller = new AbortController();
    if (event === 'already-aborted') controller.abort();
    const interrupts = new EventEmitter();
    let settled = false;
    const done = waitForGuardedStorageCommand(child, controller.signal, async () => {}, interrupts);
    const rejected = assert.rejects(done, /Helper and remote work may remain unconfirmed/).then(() => {
      settled = true;
    });
    if (event === 'lease-lost') controller.abort();
    else if (event !== 'already-aborted') interrupts.emit(event);
    await setImmediate();
    assert.equal(kills, 1);
    assert.equal(settled, false, 'Coordination must outlive an unconfirmed termination request.');
    interrupts.emit('SIGINT');
    assert.equal(kills, 2, 'Repeated interruption must remain supervised until close.');
    child.emit('close', 0);
    await rejected;
    assert.equal(interrupts.eventNames().length, 0);
  }
});
