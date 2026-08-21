import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';

import { evaluationRecordingRetentionUpdates } from './evaluationRecordingRetentionUpdates.js';

test('preserves each target and evaluator recording retention decision', () => {
  const projectId = 'evaluation-project' as ProjectId;
  const expiresAt = '2026-08-17T00:00:00.000Z';

  assert.deepEqual(
    evaluationRecordingRetentionUpdates(projectId, [
      {
        recording: { id: 'successful-target', retention: 'temporary', expiresAt },
        observations: [
          { recording: { id: 'failed-evaluator', retention: 'failure' } },
          { recording: { id: 'pinned-evaluator', retention: 'retained' } },
        ],
      },
      {
        recording: { id: 'baseline-target', retention: 'baseline' },
        observations: [{}, { recording: { id: 'successful-evaluator', retention: 'temporary', expiresAt } }],
      },
    ]),
    [
      { projectId, recordingId: 'successful-target', retention: 'temporary', expiresAt },
      { projectId, recordingId: 'failed-evaluator', retention: 'failure' },
      { projectId, recordingId: 'pinned-evaluator', retention: 'retained' },
      { projectId, recordingId: 'baseline-target', retention: 'baseline' },
      { projectId, recordingId: 'successful-evaluator', retention: 'temporary', expiresAt },
    ],
  );
});
