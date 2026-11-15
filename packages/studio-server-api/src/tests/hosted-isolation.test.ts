import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { PrototypePool } from '../scripts/hosted-isolation/pool.js';
import type { PrototypeDefinition } from '../scripts/hosted-isolation/protocol.js';
import { assemblePrototypeInput } from '../scripts/hosted-isolation/request.js';
import { evaluateLatencyBudget, percentile } from '../scripts/hosted-isolation/latency-budget.js';
import { ParentStoredValues } from '../scripts/hosted-isolation/stored-values.js';

test(
  'accepted host-store writes retain request context and drain after lost replies without replay',
  { timeout: 5000 },
  async () => {
    const context = new AsyncLocalStorage<string>();
    let writes = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope = context.run(
      'accepting request',
      () =>
        new ParentStoredValues(1, {
          get: () => undefined,
          set: async () => {
            writes++;
            assert.equal(context.getStore(), 'accepting request');
            entered();
            await gate;
          },
        }),
    );
    context.run('unrelated message handler', () =>
      scope.handle({ rootId: 1, operationId: 1, method: 'set', key: 'key', value: 42 }, () => {
        throw new Error('Worker already exited');
      }),
    );
    try {
      await started;
      assert.equal(scope.pending, 1);
      let drained = false;
      const closed = scope.close().then(() => {
        drained = true;
      });
      await Promise.resolve();
      assert.equal(drained, false, 'Worker loss must not hide an accepted parent write from drain.');
      let rejected = false;
      scope.handle({ rootId: 1, operationId: 1, method: 'set', key: 'key', value: 43 }, (reply) => {
        rejected = !!reply.failure;
      });
      assert.equal(rejected, true);
      release();
      await closed;
      assert.equal(scope.pending, 0);
      assert.equal(writes, 1, 'An uncertain write is never replayed.');
    } finally {
      release();
      await scope.close();
    }
  },
);

test('latency budgets use nearest-rank p95 and require matched, sufficient observations', () => {
  assert.equal(
    percentile(
      Array.from({ length: 20 }, (_, index) => index + 1),
      0.95,
    ),
    19,
  );
  const direct = Array(200).fill(2) as number[];
  assert.equal(evaluateLatencyBudget(direct, Array(200).fill(3), 1).status, 'met');
  assert.equal(evaluateLatencyBudget(direct, Array(200).fill(3.01), 1).status, 'exceeded');
  assert.equal(evaluateLatencyBudget(direct, Array(199).fill(2), 1).status, 'insufficient-evidence');
  assert.equal(evaluateLatencyBudget([2], [1], 1).status, 'insufficient-evidence');
  for (const samples of [[], [NaN], [Infinity], [-1]]) assert.throws(() => percentile(samples, 0.95));
});

test('HTTP input assembly preserves JSON across fragmented UTF-8 chunks and transfer', () => {
  for (const value of [null, 42, 'Привет 🚀', { text: '日本語', items: [1, true, null] }]) {
    const source = Buffer.from(JSON.stringify(value));
    const chunks = Array.from({ length: source.length }, (_, index) => source.subarray(index, index + 1));
    const direct = assemblePrototypeInput(chunks, false);
    const isolated = assemblePrototypeInput(chunks, true);
    assert.equal(direct.retainedBytes, source.length);
    assert.equal(isolated.retainedBytes, source.length);
    assert.deepEqual(direct.request.inputs?.input, { type: 'any', value });
    const owned = isolated.request.inputJson!;
    const received = structuredClone(owned, { transfer: [owned] });
    assert.equal(owned.byteLength, 0);
    assert.deepEqual(JSON.parse(Buffer.from(received).toString()), value);
    assert.equal(source.toString(), JSON.stringify(value), 'Transferring assembled bytes cannot detach caller chunks.');
  }
});

test('transfer assembly copies only a supplied buffer slice without exposing or detaching adjacent bytes', () => {
  const backing = Buffer.from('prefix42suffix');
  const slice = backing.subarray(6, 8);
  const assembled = assemblePrototypeInput([new Uint8Array(), slice], true);
  const received = structuredClone(assembled.request.inputJson!, { transfer: [assembled.request.inputJson!] });
  assert.equal(Buffer.from(received).toString(), '42');
  assert.equal(assembled.retainedBytes, 2);
  assert.equal(backing.toString(), 'prefix42suffix');
});

test('malformed HTTP JSON fails decoding but can be assembled for worker-side decoding', () => {
  const source = Buffer.from('{invalid');
  assert.throws(() => assemblePrototypeInput([source], false), SyntaxError);
  const assembled = assemblePrototypeInput([source], true);
  assert.equal(Buffer.from(assembled.request.inputJson!).toString(), source.toString());
  assert.equal(assembled.retainedBytes, source.length);
});

test('pool rejects invalid thread counts and queue bounds', async () => {
  const definition: PrototypeDefinition = {
    project: { metadata: { id: 'bounds-fixture' as ProjectId, title: 'Bounds fixture', description: '' }, graphs: {} },
    projectPath: '/local-prototype/main.rivet-project',
    runtimeLibrariesRoot: '/local-prototype/no-libraries',
    executionEnvironment: {},
  };
  const defaults = { size: 1, lifecycle: 'reuse' as const };
  const cases = [
    ...[0, -1, 1.5, 9, NaN, Infinity].map((size) => ({ ...defaults, size })),
    ...[0, -1, 1.5, NaN, Infinity].flatMap((value) => [
      { ...defaults, maxQueued: value },
      { ...defaults, maxQueuedBytes: value },
    ]),
  ];
  for (const options of cases) {
    let pool: PrototypePool | undefined;
    try {
      assert.throws(() => {
        pool = new PrototypePool(definition, options);
      }, /thread count|queue bounds/);
    } finally {
      // A broken validation must fail the test without leaking a newly created pool.
      await pool?.close();
    }
  }
});
