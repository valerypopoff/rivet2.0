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

test('lossless JSON dataset transfer preserves field and case identities in the local library', () => {
  const result = deserializeEvaluationDatasetJson(serializeEvaluationDatasetJson(dataset), { id: 'current-dataset' });

  assert.equal(result.id, 'current-dataset');
  assert.equal(result.projectId, undefined);
  assert.deepEqual(result.fields, dataset.fields);
  assert.deepEqual(result.cases, dataset.cases);
  assert.match(result.contentFingerprint ?? '', /^fnv1a64:/u);
});

test('dataset JSON import rejects unknown field values instead of silently changing a suite contract', () => {
  const source = serializeEvaluationDatasetJson(dataset)
    .replace('"labels": [', '"unknown": true, "labels": [');
  assert.throws(
    () => deserializeEvaluationDatasetJson(source, { id: 'current-dataset' }),
    /unknown field/u,
  );
});

test('dataset JSON import rejects an unsupported envelope rather than accepting arbitrary project JSON', () => {
  assert.throws(
    () => deserializeEvaluationDatasetJson('{"version":2,"dataset":{}}', { id: 'current-dataset' }),
    /Expected an evaluation dataset export/u,
  );
});

test('dataset JSON transfer rejects values that do not match their declared Rivet type', () => {
  const invalid = {
    ...dataset,
    cases: [{ ...dataset.cases[0]!, values: { ...dataset.cases[0]!.values, message: 42 } }],
  };

  assert.throws(() => serializeEvaluationDatasetJson(invalid), /values\.message.*string/u);
});

test('dataset JSON transfer rejects unsupported portable field types even when there are no values', () => {
  const invalid = {
    ...dataset,
    fields: [{ ...dataset.fields[0]!, dataType: 'image' }],
    cases: [],
  };

  assert.throws(() => serializeEvaluationDatasetJson(invalid), /dataType "image".*portable/u);
});

test('dataset JSON transfer discards retired dataset descriptions from legacy exports', () => {
  const source = JSON.stringify({
    version: 1,
    dataset: { ...dataset, description: 'Retired dataset metadata.' },
  });

  const result = deserializeEvaluationDatasetJson(source, { id: 'current-dataset' });

  assert.equal('description' in result, false);
  assert.doesNotMatch(serializeEvaluationDatasetJson(result), /description/u);
});

test('durable dataset validation preserves temporarily empty authoring labels', () => {
  const source = JSON.stringify({
    version: 1,
    dataset: {
      ...dataset,
      name: '',
      fields: dataset.fields.map((field, index) => (index === 0 ? { ...field, name: '' } : field)),
      cases: dataset.cases.map((testCase) => ({ ...testCase, name: '' })),
    },
  });

  const result = deserializeEvaluationDatasetJson(source, { id: 'current-dataset' });
  assert.equal(result.name, '');
  assert.equal(result.fields[0]?.name, '');
  assert.equal(result.cases[0]?.name, '');
});
