import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecordedNodeTiming, getRecordedNodeTimingPatch, getReplayRecordedAt } from './recordedNodeTiming.js';

test('recorded node timing keeps valid historical zero and terminal bounds', () => {
  assert.deepEqual(getRecordedNodeTimingPatch({ replayRecordedAt: 0 }, 'start'), {
    recordedTiming: { startedAt: 0 },
  });
  assert.deepEqual(getRecordedNodeTimingPatch({ replayRecordedAt: 96_000 }, 'terminal'), {
    recordedTiming: { finishedAt: 96_000 },
  });
  assert.deepEqual(getRecordedNodeTimingPatch({ replayRecordedAt: 50_000 }, 'excluded'), {
    recordedTiming: { startedAt: 50_000, finishedAt: 50_000 },
  });
});

test('recorded node timing rejects malformed replay provenance', () => {
  for (const replayRecordedAt of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '50_000']) {
    assert.deepEqual(getRecordedNodeTimingPatch({ replayRecordedAt }, 'terminal'), {});
  }
});

test('recorded timing exposes one shared, bounded replay timestamp reader', () => {
  assert.equal(getReplayRecordedAt({ replayRecordedAt: 12_345 }), 12_345);
  assert.equal(getReplayRecordedAt({ replayRecordedAt: -1 }), undefined);
  assert.equal(getReplayRecordedAt(undefined), undefined);
  assert.deepEqual(getRecordedNodeTiming({ replayRecordedAt: 12_345 }, 'terminal'), { finishedAt: 12_345 });
});
