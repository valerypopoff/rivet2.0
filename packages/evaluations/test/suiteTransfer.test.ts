import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  deserializeEvaluationSuiteBundleJson,
  serializeEvaluationSuiteBundleJson,
  type EvaluationDataset,
  type EvaluationSuite,
} from '../src/index.js';

const dataset: EvaluationDataset = {
  id: 'dataset-a',
  projectId: 'project-a' as ProjectId,
  name: 'Support quality',
  fields: [
    { id: 'message', name: 'Message', dataType: 'string', role: 'input', required: true },
    { id: 'expected', name: 'Expected', dataType: 'string', role: 'expected' },
  ],
  cases: [{ id: 'case-a', name: 'Example', values: { message: 'Need a refund', expected: 'Refund policy' } }],
};

const suite: EvaluationSuite = {
  id: 'suite-a',
  name: 'Support evaluation',
  targetGraphId: 'target-graph',
  datasetId: dataset.id,
  inputBindings: [{ graphInputId: 'message', datasetFieldId: 'message' }],
  assertions: [
    {
      id: 'assertion-a',
      name: 'Expected answer',
      outputPath: '$.answer',
      operator: 'contains',
      expected: { kind: 'dataset-field', fieldId: 'expected' },
    },
  ],
  evaluators: [{ id: 'evaluator-a', name: 'Judge', graphId: 'judge-graph' }],
};

test('suite bundles import as new linked project resources while retaining field and graph references', () => {
  const result = deserializeEvaluationSuiteBundleJson(serializeEvaluationSuiteBundleJson(suite, dataset), {
    projectId: 'destination-project' as ProjectId,
    suiteId: 'destination-suite',
    datasetId: 'destination-dataset',
  });

  assert.equal(result.suite.id, 'destination-suite');
  assert.equal(result.suite.datasetId, 'destination-dataset');
  assert.equal(result.dataset.id, 'destination-dataset');
  assert.equal(result.dataset.projectId, 'destination-project');
  assert.deepEqual(result.suite.inputBindings, suite.inputBindings);
  assert.deepEqual(result.suite.assertions, suite.assertions);
  assert.deepEqual(result.suite.evaluators, suite.evaluators);
  assert.deepEqual(result.dataset.fields, dataset.fields);
  assert.deepEqual(result.dataset.cases, dataset.cases);
});

test('suite bundle transfer rejects a dataset that is not the suite dependency', () => {
  assert.throws(
    () => serializeEvaluationSuiteBundleJson(suite, { ...dataset, id: 'other-dataset' }),
    /referenced by its suite/u,
  );
});

test('suite bundle import rejects unsupported exports', () => {
  assert.throws(
    () =>
      deserializeEvaluationSuiteBundleJson('{"version":2}', {
        projectId: 'destination-project' as ProjectId,
        suiteId: 'destination-suite',
        datasetId: 'destination-dataset',
      }),
    /Expected an evaluation suite export/u,
  );
});
