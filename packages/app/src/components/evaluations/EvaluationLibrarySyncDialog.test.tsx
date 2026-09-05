import assert from 'node:assert/strict';
import test from 'node:test';
import { getEvaluationLibrarySyncDialogPresentation } from './evaluationLibrarySyncDialogPresentation.js';

function dataset(name: string) {
  return { id: 'dataset-1', name, fields: [], cases: [] };
}

test('shared evaluation conflict dialog model exposes deliberate server and copy choices', () => {
  const presentation = getEvaluationLibrarySyncDialogPresentation({
    id: 'conflict-1',
    kind: 'conflict',
    message: 'The dataset changed.',
    conflicts: [
      {
        kind: 'dataset',
        id: 'dataset-1',
        expectedVersion: 'version-1',
        currentVersion: 'version-2',
        local: { kind: 'dataset', id: 'dataset-1', value: dataset('My pending dataset') },
        server: { kind: 'dataset', id: 'dataset-1', value: dataset('Shared dataset') },
      },
    ],
  });

  assert.deepEqual(presentation, {
    title: 'Resolve shared evaluation conflict',
    conflict: {
      canKeepMineAsCopy: true,
      draft: {
        kind: 'dataset',
        id: 'dataset-1',
        expectedVersion: 'version-1',
        currentVersion: 'version-2',
        local: { kind: 'dataset', id: 'dataset-1', value: dataset('My pending dataset') },
        server: { kind: 'dataset', id: 'dataset-1', value: dataset('Shared dataset') },
      },
      description:
        'The dataset “Shared dataset” was changed by another browser after your edit began. Choose which version to retain; Rivet will never overwrite the other editor automatically.',
      localTitle: 'My pending dataset',
      serverTitle: 'Shared dataset',
    },
  });
});

test('shared evaluation conflict dialog model marks a pending deletion as unavailable to copy', () => {
  const presentation = getEvaluationLibrarySyncDialogPresentation({
    id: 'conflict-2',
    kind: 'conflict',
    message: 'The dataset changed.',
    conflicts: [
      {
        kind: 'dataset',
        id: 'dataset-1',
        expectedVersion: 'version-1',
        currentVersion: 'version-2',
        local: { kind: 'dataset', id: 'dataset-1', value: undefined },
        server: { kind: 'dataset', id: 'dataset-1', value: dataset('Shared dataset') },
      },
    ],
  });

  assert.equal(presentation?.conflict?.localTitle, 'Deleted');
  assert.equal(presentation?.conflict?.canKeepMineAsCopy, false);
  assert.equal(presentation?.conflict?.draft.local.value, undefined);
});

test('retryable evaluation-library failures retain their message and retry presentation', () => {
  const presentation = getEvaluationLibrarySyncDialogPresentation({
    id: 'retry-1',
    kind: 'retryable',
    message: 'The server is temporarily unavailable.',
  });

  assert.deepEqual(presentation, {
    title: 'Evaluation library save needs attention',
    message: 'The server is temporarily unavailable. Your pending changes remain in this browser until you retry the save.',
  });
});

test('an invalid empty conflict falls back to retryable save presentation', () => {
  const presentation = getEvaluationLibrarySyncDialogPresentation({
    id: 'conflict-empty',
    kind: 'conflict',
    message: 'The conflict details are no longer available.',
    conflicts: [],
  });

  assert.deepEqual(presentation, {
    title: 'Evaluation library save needs attention',
    message: 'The conflict details are no longer available. Your pending changes remain in this browser until you retry the save.',
  });
});
