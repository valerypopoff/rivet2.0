import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { RivetStoredValueController } from '../../src/model/StoredValueStore.js';

void describe('Stored Value wait cancellation', () => {
  void it('cleans cancelled waiters without retaining abort listeners or poisoning later waits', async () => {
    const controller = new RivetStoredValueController();
    for (let attempt = 0; attempt < 2; attempt++) {
      const abortController = new AbortController();
      const waiting = controller.waitForSet('key', abortController.signal);
      const rejected = assert.rejects(waiting, /cancelled/);
      await setImmediate();
      assert.equal(getEventListeners(abortController.signal, 'abort').length, 1);
      abortController.abort(new Error('cancelled'));
      await rejected;
      assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
    }
    const waiting = controller.waitForSet('key');
    await controller.set('key', 'ready');
    assert.equal(await waiting, 'ready');
  });

  void it('observes cancellation during waiter registration without an orphan rejected promise', async (t) => {
    const controller = new RivetStoredValueController();
    const abortController = new AbortController();
    const originalAdd = abortController.signal.addEventListener.bind(abortController.signal);
    t.mock.method(
      abortController.signal,
      'addEventListener',
      (...args: Parameters<AbortSignal['addEventListener']>) => {
        originalAdd(...args);
        queueMicrotask(() => abortController.abort(new Error('cancelled during registration')));
      },
    );

    await assert.rejects(controller.waitForSet('key', abortController.signal), /cancelled during registration/);
    await setImmediate();
    assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
  });
});
