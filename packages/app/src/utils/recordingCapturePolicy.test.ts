import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingStatusAfterAbort, shouldCaptureExecutionRecording } from './recordingCapturePolicy.js';

test('captures recordings only for opted-in live executions', () => {
  assert.equal(shouldCaptureExecutionRecording({ recordExecutions: true, isPlayback: false }), true);
  assert.equal(shouldCaptureExecutionRecording({ recordExecutions: true, isPlayback: true }), false);
  assert.equal(shouldCaptureExecutionRecording({ recordExecutions: false, isPlayback: false }), false);
});

test('recording abort status distinguishes successful termination and preserves prior failures', () => {
  assert.equal(recordingStatusAfterAbort('succeeded', true), 'succeeded');
  assert.equal(recordingStatusAfterAbort('succeeded', false), 'suspicious');
  assert.equal(recordingStatusAfterAbort('failed', false), 'failed');
  assert.equal(recordingStatusAfterAbort('failed', true), 'failed');
  assert.equal(recordingStatusAfterAbort('suspicious', true), 'suspicious');
});
