import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCaptureExecutionRecording } from './recordingCapturePolicy.js';

test('captures recordings only for opted-in live executions', () => {
  assert.equal(shouldCaptureExecutionRecording({ recordExecutions: true, isPlayback: false }), true);
  assert.equal(shouldCaptureExecutionRecording({ recordExecutions: true, isPlayback: true }), false);
  assert.equal(shouldCaptureExecutionRecording({ recordExecutions: false, isPlayback: false }), false);
});
