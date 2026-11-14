import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  notifyExternalEvaluationLibraryChanged,
  notifyEvaluationLibraryChanged,
  openEvaluationLibraryEventStream,
} from '../routes/workflows/evaluation-library-events.js';

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  writableEnded = false;

  status(): this {
    return this;
  }

  setHeader(): void {}

  flushHeaders(): void {}

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}

test('Evaluation stream initialization preserves reset epochs and failed or closed reads', async (t) => {
  const previousMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'none';
  t.after(() => {
    if (previousMode === undefined) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
    else process.env.RIVET_SERVER_UI_AUTH_MODE = previousMode;
  });
  const request = Object.assign(new EventEmitter(), { headers: {}, get: () => 'browser-a' });
  for (const [snapshotRevision, notifiedRevision] of [
    [99, 1],
    [7, 6],
  ] as const) {
    const response = new FakeResponse();
    try {
      await openEvaluationLibraryEventStream(request as never, response as never, async () => {
        notifyExternalEvaluationLibraryChanged(null);
        notifyEvaluationLibraryChanged(request as never, notifiedRevision);
        return snapshotRevision;
      });
      const initial = JSON.parse(/^data: (.*)$/m.exec(response.writes[0]!)![1]!);
      const reset = JSON.parse(/^data: (.*)$/m.exec(response.writes[1]!)![1]!);
      assert.equal(initial.revision, snapshotRevision);
      assert.equal(reset.revision, notifiedRevision);
      assert.notEqual(reset.epoch, initial.epoch);
      assert.match(response.writes[1]!, /^event: library-state\n/);
      assert.equal('sourceClientId' in reset, false, 'an opening reset must not be ignored as a self notification');
      notifyExternalEvaluationLibraryChanged(notifiedRevision + 1);
      const changed = JSON.parse(/^data: (.*)$/m.exec(response.writes[2]!)![1]!);
      assert.equal(changed.epoch, reset.epoch);
      assert.equal(changed.revision, notifiedRevision + 1);
    } finally {
      response.emit('close');
    }
  }

  const failed = new FakeResponse();
  const failure = new Error('snapshot unavailable');
  await assert.rejects(
    openEvaluationLibraryEventStream(request as never, failed as never, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(failed.writes, []);

  const closed = new FakeResponse();
  await openEvaluationLibraryEventStream(request as never, closed as never, async () => {
    closed.destroyed = true;
    closed.emit('close');
    return 2;
  });
  notifyExternalEvaluationLibraryChanged(3);
  assert.deepEqual(closed.writes, []);
  assert.equal(closed.listenerCount('close'), 0);
});
