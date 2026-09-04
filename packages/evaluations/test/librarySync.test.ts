import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEvaluationLibraryMutation,
  diffEvaluationLibraryMutation,
  normalizeEvaluationLibrary,
  type EvaluationDataset,
  type EvaluationLibrary,
} from '../src/index.js';

function dataset(id: string, name = id): EvaluationDataset {
  return {
    id,
    name,
    fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input' }],
    cases: [{ id: 'case', name: 'Case', values: { input: id } }],
  };
}

function library(): EvaluationLibrary {
  return {
    version: 1,
    data: {
      version: 1,
      suites: [
        {
          id: 'suite-a',
          name: 'Suite A',
          targetGraphId: 'graph-a' as EvaluationLibrary['data']['suites'][number]['targetGraphId'],
          datasetId: 'dataset-a',
          inputBindings: [],
          assertions: [],
          evaluators: [],
        },
      ],
      baselines: [],
    },
    datasets: [dataset('dataset-a'), dataset('dataset-b')],
    migratedLegacyProjectIds: [],
  };
}

test('library mutation diffs keep unrelated suite and dataset edits separate', () => {
  const previous = normalizeEvaluationLibrary(library());
  const next = normalizeEvaluationLibrary({
    ...previous,
    data: {
      ...previous.data,
      suites: previous.data.suites.map((suite) => ({ ...suite, name: 'Renamed Suite A' })),
    },
    datasets: previous.datasets.map((item) =>
      item.id === 'dataset-b' ? { ...item, name: 'Renamed Dataset B' } : item,
    ),
  });

  const mutation = diffEvaluationLibraryMutation(previous, next, {
    suites: { 'suite-a': 'suite-a-v1' },
    datasets: { 'dataset-a': 'dataset-a-v1', 'dataset-b': 'dataset-b-v1' },
  });

  assert.deepEqual(mutation?.changes.map((change) => change.kind), ['put-dataset', 'put-suite']);
  assert.deepEqual(mutation?.changes.map((change) => change.id), ['dataset-b', 'suite-a']);
  assert.deepEqual(applyEvaluationLibraryMutation(previous, mutation!), next);
});

test('library mutation diffs require a current token only for changed existing resources', () => {
  const previous = normalizeEvaluationLibrary(library());
  const added = normalizeEvaluationLibrary({ ...previous, datasets: [...previous.datasets, dataset('dataset-c')] });
  const addedMutation = diffEvaluationLibraryMutation(previous, added, {
    suites: { 'suite-a': 'suite-a-v1' },
    datasets: { 'dataset-a': 'dataset-a-v1', 'dataset-b': 'dataset-b-v1' },
  });
  assert.equal(addedMutation?.changes[0]?.kind, 'put-dataset');
  assert.equal(addedMutation?.changes[0]?.expectedVersion, null);

  const changed = normalizeEvaluationLibrary({
    ...previous,
    datasets: previous.datasets.map((item) => (item.id === 'dataset-a' ? { ...item, name: 'Changed' } : item)),
  });
  assert.throws(
    () => diffEvaluationLibraryMutation(previous, changed, { suites: { 'suite-a': 'suite-a-v1' }, datasets: {} }),
    /dataset "dataset-a" has no synchronization version/u,
  );
});

test('library mutation diffs ignore equivalent resource property ordering', () => {
  const previous = library();
  const source = previous.datasets[0]!;
  const reordered = Object.fromEntries(Object.entries(source).reverse()) as EvaluationDataset;
  const next = { ...previous, datasets: [reordered, ...previous.datasets.slice(1)] };

  assert.equal(
    diffEvaluationLibraryMutation(previous, next, {
      suites: { 'suite-a': 'suite-a-v1' },
      datasets: { 'dataset-a': 'dataset-a-v1', 'dataset-b': 'dataset-b-v1' },
    }),
    undefined,
  );
});
