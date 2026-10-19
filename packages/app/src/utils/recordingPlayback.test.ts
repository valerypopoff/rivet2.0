import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, RecordedEvents } from '@valerypopoff/rivet2-core';
import { getRecordingPlaybackGraphId, requireRecordingRootGraphId } from './recordingPlayback.js';

test('recording playback resolves the root start graph rather than an earlier nested graph event', () => {
  const targetGraphId = 'target' as GraphId;
  const events = [
    { type: 'graphStart', data: { graphId: 'nested' }, ts: 1 },
    { type: 'start', data: { startGraph: targetGraphId }, ts: 2 },
  ] as unknown as RecordedEvents[];

  assert.equal(requireRecordingRootGraphId(events), targetGraphId);
  assert.equal(getRecordingPlaybackGraphId(events), targetGraphId);
});

test('hosted playback resolves a child graphStart without relaxing the strict evaluation loader', () => {
  const events = [{ type: 'graphStart', data: { graphId: 'child' as GraphId, inputs: {} }, ts: 1 }] as RecordedEvents[];
  assert.equal(getRecordingPlaybackGraphId(events), 'child');
  assert.equal(getRecordingPlaybackGraphId([]), undefined);
  assert.throws(() => requireRecordingRootGraphId(events), /does not declare a root start graph/);
});

test('recording playback rejects an artifact without an authored root graph', () => {
  assert.throws(() => requireRecordingRootGraphId([]), /does not declare a root start graph/);
  assert.throws(
    () => requireRecordingRootGraphId([{ type: 'start', data: {}, ts: 1 } as unknown as RecordedEvents]),
    /does not declare a root start graph/,
  );
});
