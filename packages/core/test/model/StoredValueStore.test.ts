import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  RivetStoredValueController,
  cloneRivetStoredValue,
  createRivetStoredValueSnapshotStore,
  type RivetStoredValueStore,
} from '../../src/index.js';

describe('RivetStoredValueController', () => {
  it('reads through once, writes through, and reports previous values including null', async () => {
    let reads = 0;
    const values = new Map<string, unknown>([['nullable', null]]);
    const store: RivetStoredValueStore = {
      get(key) {
        reads += 1;
        return values.get(key) as never;
      },
      set(key, value) {
        values.set(key, value);
      },
    };
    const controller = new RivetStoredValueController(store);

    assert.deepEqual(await controller.get('nullable'), { found: true, value: null });
    assert.deepEqual(await controller.get('nullable'), { found: true, value: null });
    assert.equal(reads, 1);
    assert.deepEqual(await controller.set('nullable', { next: true }), {
      hadPreviousValue: true,
      previousValue: null,
      savedValue: { next: true },
    });
    assert.deepEqual(controller.getCached('nullable'), { loaded: true, found: true, value: { next: true } });
  });

  it('distinguishes missing values and resolves Wait only from an in-run Set', async () => {
    const controller = new RivetStoredValueController();
    assert.deepEqual(await controller.get('missing'), { found: false });
    assert.deepEqual(controller.getCached('missing'), { loaded: true, found: false });

    const waiting = controller.waitForSet('later');
    await controller.set('later', 'ready');
    assert.equal(await waiting, 'ready');
  });

  it('does not let an already-aborted Wait return a cached value', async () => {
    const controller = new RivetStoredValueController();
    await controller.set('present', 'ready');
    const abortController = new AbortController();
    abortController.abort(new Error('run cancelled'));

    await assert.rejects(() => controller.waitForSet('present', abortController.signal), /run cancelled/);
  });

  it('serializes same-key operations', async () => {
    const events: string[] = [];
    const store: RivetStoredValueStore = {
      async get() {
        events.push('get:start');
        await Promise.resolve();
        events.push('get:end');
        return undefined;
      },
      async set(_key, value) {
        events.push(`set:${value}:start`);
        await Promise.resolve();
        events.push(`set:${value}:end`);
      },
    };
    const controller = new RivetStoredValueController(store);

    await Promise.all([controller.set('key', 'first'), controller.set('key', 'second')]);
    assert.deepEqual(events, [
      'get:start',
      'get:end',
      'set:first:start',
      'set:first:end',
      'set:second:start',
      'set:second:end',
    ]);
    assert.deepEqual(await controller.get('key'), { found: true, value: 'second' });
  });

  it('does not silently fall back when callbacks fail', async () => {
    let readAttempts = 0;
    const readController = new RivetStoredValueController({
      get() {
        readAttempts += 1;
        throw new Error('read failed');
      },
      set() {},
    });
    await assert.rejects(() => readController.get('key'), /read failed/);
    await assert.rejects(() => readController.get('key'), /read failed/);
    assert.equal(readAttempts, 1);

    let malformedReadAttempts = 0;
    const malformedReadController = new RivetStoredValueController({
      get() {
        malformedReadAttempts += 1;
        return (() => undefined) as never;
      },
      set() {},
    });
    await assert.rejects(() => malformedReadController.get('malformed'), /portable JSON/);
    await assert.rejects(() => malformedReadController.get('malformed'), /portable JSON/);
    assert.equal(malformedReadAttempts, 1);

    const writeController = new RivetStoredValueController({
      get: () => 'old',
      set() {
        throw new Error('write failed');
      },
    });
    await assert.rejects(() => writeController.set('key', 'new'), /write failed/);
    assert.deepEqual(writeController.getCached('key'), { loaded: true, found: true, value: 'old' });
  });
});

describe('stored value portability', () => {
  it('rejects invalid keys, undefined, non-finite numbers, binary values, sparse arrays, and cycles', async () => {
    const controller = new RivetStoredValueController();
    await assert.rejects(() => controller.get(''), /non-empty string/);
    assert.throws(() => cloneRivetStoredValue(undefined), /portable JSON/);
    assert.throws(() => cloneRivetStoredValue(Number.NaN), /finite numbers/);
    assert.throws(() => cloneRivetStoredValue(new Uint8Array([1])), /plain JSON objects/);
    assert.throws(() => cloneRivetStoredValue(new Array(2)), /sparse arrays/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => cloneRivetStoredValue(cyclic), /cycles/);
  });

  it('provides an isolated snapshot store and changed-key patch', async () => {
    const snapshot = createRivetStoredValueSnapshotStore({ existing: { value: 1 } });
    assert.deepEqual(await snapshot.store.get('existing'), { value: 1 });
    await snapshot.store.set('preferences', ['compact', true, null]);
    assert.deepEqual(snapshot.getPatch(), { preferences: ['compact', true, null] });

    const patch = snapshot.getPatch();
    (patch.preferences as unknown[]).push('external mutation');
    assert.deepEqual(snapshot.getPatch(), { preferences: ['compact', true, null] });
  });

  it('supports every non-empty JSON string key without mutating object prototypes', async () => {
    const snapshot = createRivetStoredValueSnapshotStore();
    await snapshot.store.set('__proto__', { safe: true });
    await snapshot.store.set('constructor', 'value');

    assert.deepEqual(await snapshot.store.get('__proto__'), { safe: true });
    assert.equal(await snapshot.store.get('constructor'), 'value');

    const patch = snapshot.getPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, '__proto__'), true);
    assert.deepEqual(patch.__proto__, { safe: true });
    assert.equal(patch.constructor, 'value');
    assert.equal(Object.getPrototypeOf(patch), Object.prototype);
  });
});
