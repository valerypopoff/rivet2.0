import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphInputStreamRelay } from '../../src/model/GraphInputStream.js';

test('input relay bounds pending snapshots, reports coalescing, and snapshots terminal data', async () => {
  const relay = new GraphInputStreamRelay();
  const value = { type: 'object' as const, value: { text: 'one' } };
  relay.publish(value);
  value.value.text = 'two';
  relay.publish(value);
  value.value.text = 'mutated';
  const seen: unknown[] = [];
  relay.subscribe((snapshot, coalesced) => seen.push([snapshot.value, coalesced]));
  assert.deepEqual(seen, [[{ text: 'two' }, 1]]);
  relay.finish({ value });
  value.value.text = 'later';
  relay.publish(value);
  relay.finish({ error: new Error('late failure') });
  assert.deepEqual((await relay.settled).value?.value, { text: 'mutated' });
  assert.equal(seen.length, 1);
});

test('input relay ignores late delivery after unsubscribe and settles failure once', async () => {
  const relay = new GraphInputStreamRelay();
  const seen: unknown[] = [];
  const unsubscribe = relay.subscribe((value) => seen.push(value));
  unsubscribe();
  unsubscribe();
  relay.publish({ type: 'string', value: 'late' });
  relay.subscribe((value) => seen.push(value));
  const error = new Error('producer failed');
  relay.finish({ error });
  relay.finish({ value: { type: 'string', value: 'late terminal' } });
  assert.equal((await relay.settled).error, error);
  assert.deepEqual(seen, []);
});

test('a subscriber that fails during startup is disposed before later delivery', () => {
  const relay = new GraphInputStreamRelay();
  relay.publish({ type: 'string', value: 'buffered' });
  let calls = 0;
  assert.throws(
    () =>
      relay.subscribe(() => {
        calls++;
        throw new Error('startup failed');
      }),
    /startup failed/,
  );
  relay.publish({ type: 'string', value: 'late' });
  assert.equal(calls, 1);
});

for (const outcome of ['failure', 'exclusion'] as const) {
  test(`${outcome} before subscription discards obsolete buffered partials`, () => {
    const relay = new GraphInputStreamRelay();
    relay.publish({ type: 'string', value: 'obsolete' });
    relay.finish(
      outcome === 'failure'
        ? { error: new Error('source failed') }
        : { value: { type: 'control-flow-excluded', value: undefined } },
    );
    const seen: unknown[] = [];
    relay.subscribe((value) => seen.push(value));
    assert.deepEqual(seen, []);
    assert.ok(relay.result);
  });
}
