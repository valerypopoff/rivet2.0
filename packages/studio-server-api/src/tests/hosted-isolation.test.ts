import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { PrototypePool } from '../scripts/hosted-isolation/pool.js';
import type { PrototypeDefinition } from '../scripts/hosted-isolation/protocol.js';
import { assemblePrototypeInput } from '../scripts/hosted-isolation/request.js';

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
