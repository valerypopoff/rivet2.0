import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionRecorder, RecordedEvents } from '@valerypopoff/rivet2-core';
import { formatRecordingDuration, getRecordingPresentation } from './recordingPresentation.js';

test('recording presentation preserves saved outcomes and infers legacy root evidence without replay state', () => {
  const start = { type: 'start', data: { startGraph: 'root' }, ts: 1_760_000_000_000 };
  const done = { type: 'done', data: { results: { output: { type: 'string', value: 'ok' } } }, ts: start.ts + 1234 };
  const present = (tail: unknown[], summary?: Parameters<typeof getRecordingPresentation>[0]['summary']) =>
    getRecordingPresentation({
      recorder: { events: [start, ...tail] as RecordedEvents[] } as ExecutionRecorder,
      summary,
    });
  assert.equal(present([done]).status, 'succeeded');
  assert.equal(
    present([{ ...done, data: { results: { output: { type: 'control-flow-excluded' } } } }]).status,
    'suspicious',
  );
  assert.equal(present([done, { type: 'error', data: { error: 'Late failure' }, ts: done.ts + 1 }]).status, 'failed');
  assert.equal(
    present([{ type: 'graphError', data: { graphId: 'handled-child', error: 'caught' }, ts: done.ts }, done]).status,
    'succeeded',
  );
  const scopedStart = {
    ...start,
    data: { ...start.data, execution: { rootRunId: 'run', graphRunId: 'outer', graphId: 'root' } },
  };
  const scoped = (tail: unknown[]) =>
    getRecordingPresentation({
      recorder: { events: [scopedStart, ...tail] as RecordedEvents[] } as ExecutionRecorder,
    });
  const recursiveExecution = { rootRunId: 'run', graphRunId: 'recursive', parentGraphRunId: 'outer', graphId: 'root' };
  assert.equal(
    scoped([
      {
        type: 'graphError',
        data: { graphId: 'root', error: 'Handled recursive error', execution: recursiveExecution },
        ts: done.ts,
      },
      done,
    ]).status,
    'succeeded',
  );
  assert.equal(
    scoped([
      { type: 'graphFinish', data: { graphId: 'root', outputs: {}, execution: recursiveExecution }, ts: done.ts },
    ]).label,
    'Outcome unavailable',
  );
  assert.equal(
    scoped([
      {
        type: 'graphError',
        data: { graphId: 'root', error: 'Outer failure', execution: scopedStart.data.execution },
        ts: done.ts,
      },
    ]).status,
    'failed',
  );
  assert.equal(
    getRecordingPresentation({
      recorder: {
        events: [
          { type: 'graphStart', data: { graphId: 'root', inputs: {}, execution: recursiveExecution }, ts: 0 },
          { type: 'graphFinish', data: { graphId: 'root', outputs: {}, execution: recursiveExecution }, ts: 1 },
        ] as RecordedEvents[],
      } as ExecutionRecorder,
    }).status,
    'succeeded',
  );
  assert.equal(
    getRecordingPresentation({
      recorder: { events: [{ ...start, ts: 0 }, done] as RecordedEvents[] } as ExecutionRecorder,
    }).createdAt,
    '1970-01-01T00:00:00.000Z',
  );
  assert.equal(present([]).label, 'Outcome unavailable');
  assert.match(present([], { status: 'suspicious', createdAt: '', durationMs: 0 }).detail!, /control-flow-excluded/);
  assert.equal(
    present([{ type: 'error', data: { error: 'Not the saved outcome' }, ts: done.ts }], {
      status: 'succeeded',
      createdAt: '',
      durationMs: 0,
    }).detail,
    undefined,
  );
  assert.equal(present([{ type: 'abort', data: { successful: false }, ts: done.ts }]).status, 'failed');
  for (const status of ['succeeded', 'failed', 'suspicious'] as const) {
    const saved = present([done], {
      createdAt: '2026-10-01T00:00:00Z',
      durationMs: 999,
      status,
      errorMessage: 'Saved detail',
      sourceProjectRelativePath: 'Bundle/Original.rivet-project',
      endpointNameAtExecution: 'Original endpoint',
      runKind: 'published',
    });
    assert.equal(saved.status, status);
    assert.equal(saved.detail, 'Saved detail');
    assert.equal(saved.endpoint, 'Original endpoint');
  }
  assert.equal(formatRecordingDuration(59_999), '1m 0.00s');
  assert.equal(formatRecordingDuration(NaN), 'Unavailable');
});
