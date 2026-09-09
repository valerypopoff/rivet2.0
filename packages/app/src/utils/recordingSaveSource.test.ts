import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecordingSaveSource, serializeRecordingSaveSource } from './recordingSaveSource.js';

test('loaded recording takes precedence over the last live recording and serializes only when saved', () => {
  let serializeCalls = 0;
  const recorder = {
    serialize: () => {
      serializeCalls += 1;
      return 'loaded-original';
    },
  };

  const source = getRecordingSaveSource({
    loadedRecording: { recorder: recorder as never },
    lastLiveRecording: 'last-live',
  });

  assert.deepEqual(source?.kind, 'loaded-recording');
  assert.equal(serializeCalls, 0);
  assert.equal(serializeRecordingSaveSource(source!), 'loaded-original');
  assert.equal(serializeCalls, 1);
});

test('last live recording remains the fallback after a loaded recording is gone', () => {
  assert.deepEqual(getRecordingSaveSource({ loadedRecording: undefined, lastLiveRecording: 'last-live' }), {
    kind: 'last-live-recording',
    serialized: 'last-live',
  });
  assert.equal(getRecordingSaveSource({ loadedRecording: undefined, lastLiveRecording: undefined }), undefined);
});
