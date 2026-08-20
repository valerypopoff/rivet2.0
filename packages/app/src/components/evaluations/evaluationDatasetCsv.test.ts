import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationDataset } from '@valerypopoff/rivet2-evaluations';
import { replaceEvaluationDatasetCasesFromCsv, serializeEvaluationDatasetCsv } from './evaluationDatasetCsv.js';

const dataset: EvaluationDataset = {
  id: 'dataset-a',
  name: 'Glossary cases',
  fields: [
    { id: 'story', name: 'Story', dataType: 'object', role: 'input' },
    { id: 'score', name: 'Score', dataType: 'number', role: 'expected' },
  ],
  cases: [
    {
      id: 'case-a',
      name: 'Example',
      enabled: false,
      tags: ['regression', 'unicode'],
      note: 'A note, with a comma',
      values: { story: { title: 'A story' }, score: 85 },
    },
  ],
};

test('CSV dataset transfer round-trips typed case values and metadata', () => {
  const imported = replaceEvaluationDatasetCasesFromCsv(dataset, serializeEvaluationDatasetCsv(dataset));

  assert.deepEqual(imported.fields, dataset.fields);
  assert.deepEqual(imported.cases, dataset.cases);
});

test('CSV dataset import rejects rows whose enabled value is ambiguous', () => {
  const source = serializeEvaluationDatasetCsv(dataset).replace(',false,', ',yes,');

  assert.throws(() => replaceEvaluationDatasetCasesFromCsv(dataset, source), /enabled value must be true or false/u);
});

test('CSV dataset import rejects values that violate the current field type', () => {
  const source = serializeEvaluationDatasetCsv(dataset).replace(
    /,85(\r?\n)/u,
    (_match, newline: string) => `,"""eighty-five"""${newline}`,
  );

  assert.throws(
    () => replaceEvaluationDatasetCasesFromCsv(dataset, source),
    /value for "Score".*declared type "number"/u,
  );
});

test('CSV dataset import rejects extra or missing row columns', () => {
  const source = `${serializeEvaluationDatasetCsv(dataset).trimEnd()},extra\r\n`;

  assert.throws(
    () => replaceEvaluationDatasetCasesFromCsv(dataset, source),
    /Invalid Record Length|exactly 7 columns/u,
  );
});
