import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionRecorder, ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationRecordingArtifact } from '@valerypopoff/rivet2-evaluations';
import { createEvaluationRecordingPersistence } from './evaluationRecordingPersistence.js';

const metadata = { evaluationRunId: 'evaluation', caseId: 'case', trialIndex: 2 };
const projectId = 'project' as ProjectId;
const events = [{}] as ExecutionRecorder['events'];

test('a trial persists one immutable temporary artifact even with overlapping finalization calls', async () => {
  const writes: EvaluationRecordingArtifact[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const persist = createEvaluationRecordingPersistence({
    projectId,
    metadata,
    recorder: { events, serialize: () => 'recording' },
    store: {
      putRecording: async (artifact) => {
        writes.push(artifact);
        await gate;
      },
    },
    onFailure: () => assert.fail('Unexpected persistence failure'),
  });
  const first = persist();
  assert.equal(persist(), first);
  assert.equal(writes.length, 1);
  release();
  const reference = await first;
  assert.ok(reference);
  assert.equal(await persist(), reference);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    projectId,
    runId: 'evaluation',
    trialId: 'case:2',
    reference,
    serialized: 'recording',
    createdAt: writes[0]!.createdAt,
  });
  assert.equal(reference.retention, 'temporary');
  assert.match(reference.id, /^evaluation-recording-/);
  assert.ok(Date.parse(reference.expiresAt!) > Date.parse(writes[0]!.createdAt));
});

test('empty captures are not serialized or stored', async () => {
  const persist = createEvaluationRecordingPersistence({
    projectId,
    metadata,
    recorder: {
      events: [],
      serialize: () => {
        throw new Error('Must not serialize');
      },
    },
    store: { putRecording: async () => assert.fail('Must not write') },
    onFailure: () => assert.fail('Empty is not a storage failure'),
  });
  assert.equal(await persist(), undefined);
});

for (const failure of ['serialization', 'uncertain-write'] as const) {
  test(`${failure} preserves the verdict and reports one failure without retrying`, async () => {
    const expected = new Error(failure);
    let attempts = 0;
    const failures: unknown[] = [];
    const persist = createEvaluationRecordingPersistence({
      projectId,
      metadata,
      recorder: {
        events,
        serialize: () => {
          if (failure === 'serialization') throw expected;
          return 'recording';
        },
      },
      store: {
        putRecording: async () => {
          attempts++;
          throw expected;
        },
      },
      onFailure: (error) => {
        failures.push(error);
        throw new Error('Diagnostic failure');
      },
    });
    assert.deepEqual(await Promise.all([persist(), persist()]), [undefined, undefined]);
    assert.equal(await persist(), undefined);
    assert.deepEqual(failures, [expected]);
    assert.equal(attempts, failure === 'serialization' ? 0 : 1);
  });
}
