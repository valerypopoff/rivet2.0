import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  deserializeEvaluationDatasetJson,
  serializeEvaluationDatasetJson,
  type EvaluationDataset,
} from '../src/index.js';

const dataset: EvaluationDataset = {
  id: 'dataset-a',
  projectId: 'project-a' as ProjectId,
  name: 'Support quality',
  description: 'Structured values stay typed.',
  fields: [
    { id: 'message', name: 'Message', dataType: 'string', role: 'input', required: true },
    { id: 'labels', name: 'Labels', dataType: 'string[]', role: 'expected' },
  ],
  cases: [{
    id: 'case-a',
    name: 'Example',
    tags: ['regression'],
    values: { message: 'Need a refund', labels: ['billing', 'urgent'] },
  }],
};

test('lossless JSON dataset transfer preserves field and case identities but remains scoped to the current dataset', () => {
  const result = deserializeEvaluationDatasetJson(serializeEvaluationDatasetJson(dataset), {
    id: 'current-dataset',
    projectId: 'current-project' as ProjectId,
  });

  assert.equal(result.id, 'current-dataset');
  assert.equal(result.projectId, 'current-project');
  assert.deepEqual(result.fields, dataset.fields);
  assert.deepEqual(result.cases, dataset.cases);
  assert.match(result.contentFingerprint ?? '', /^fnv1a64:/u);
});

test('dataset JSON import rejects unknown field values instead of silently changing a suite contract', () => {
  const source = serializeEvaluationDatasetJson(dataset)
    .replace('"labels": [', '"unknown": true, "labels": [');
  assert.throws(
    () => deserializeEvaluationDatasetJson(source, { id: 'current-dataset', projectId: 'current-project' as ProjectId }),
    /unknown field/u,
  );
});

test('dataset JSON import rejects an unsupported envelope rather than accepting arbitrary project JSON', () => {
  assert.throws(
    () => deserializeEvaluationDatasetJson('{"version":2,"dataset":{}}', { id: 'current-dataset', projectId: 'current-project' as ProjectId }),
    /Expected an evaluation dataset export/u,
  );
});
