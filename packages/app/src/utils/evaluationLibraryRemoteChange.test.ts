import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationLibrary } from '@valerypopoff/rivet2-evaluations';

import { describeEvaluationLibraryRemoteChange } from './evaluationLibraryRemoteChange.js';

function library(): EvaluationLibrary {
  return {
    version: 1,
    data: {
      version: 1,
      suites: [
        {
          id: 'suite-1',
          name: 'Original suite',
          targetGraphId: 'graph-1' as never,
          datasetId: 'dataset-1',
          inputBindings: [],
          assertions: [],
          evaluators: [],
        },
      ],
      baselines: [],
    },
    datasets: [
      {
        id: 'dataset-1',
        name: 'Original dataset',
        fields: [],
        cases: [],
      },
    ],
    migratedLegacyProjectIds: [],
  };
}

test('remote evaluation notification names a single suite rename', () => {
  const previous = library();
  const next: EvaluationLibrary = {
    ...previous,
    data: {
      ...previous.data,
      suites: previous.data.suites.map((suite) => ({ ...suite, name: 'Renamed suite' })),
    },
  };

  assert.equal(
    describeEvaluationLibraryRemoteChange(previous, next),
    'Evaluation suite "Original suite" was renamed to "Renamed suite" by another administrator.',
  );
});

test('remote evaluation notification distinguishes a resource update from metadata-only churn', () => {
  const previous = library();
  const changed: EvaluationLibrary = {
    ...previous,
    datasets: previous.datasets.map((dataset) => ({ ...dataset, cases: [{ id: 'case-1', name: 'Case 1', values: {} }] })),
  };

  assert.equal(
    describeEvaluationLibraryRemoteChange(previous, changed),
    'Evaluation dataset "Original dataset" was changed by another administrator.',
  );
  assert.equal(
    describeEvaluationLibraryRemoteChange(previous, { ...previous, migratedLegacyProjectIds: ['legacy' as never] }),
    undefined,
  );
});

test('remote evaluation notification aggregates simultaneous resource changes', () => {
  const previous = library();
  const next: EvaluationLibrary = {
    ...previous,
    data: {
      ...previous.data,
      suites: previous.data.suites.map((suite) => ({ ...suite, name: 'Renamed suite' })),
    },
    datasets: previous.datasets.map((dataset) => ({ ...dataset, name: 'Renamed dataset' })),
  };

  assert.equal(
    describeEvaluationLibraryRemoteChange(previous, next),
    'Evaluation library was updated by another administrator (2 resources changed).',
  );
});
