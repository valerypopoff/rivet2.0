import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationDataset, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvaluationSectionTabs } from './EvaluationSectionTabs.js';
import { EvaluationSuiteSidebar } from './EvaluationSuiteSidebar.js';

test('suite sidebar renders resource rows with an explicit current selection', () => {
  const suites = [
    { id: 'suite-1', name: 'First suite', targetGraphId: 'graph-1' },
    { id: 'suite-2', name: 'Second suite', targetGraphId: 'graph-2' },
  ] as EvaluationSuite[];
  const datasets = [
    { id: 'dataset-1', projectId: 'project-1' as ProjectId, name: 'Shared cases', fields: [], cases: [] },
  ] as EvaluationDataset[];
  const html = renderToStaticMarkup(
    <EvaluationSuiteSidebar
      canCreateDataset
      canCreateSuite
      datasets={datasets}
      getDatasetUsage={() => '2 evaluation suites'}
      selectedSuiteId="suite-2"
      selectedDatasetId={undefined}
      suites={suites}
      getGraphName={(suite) => `Graph ${suite.targetGraphId}`}
      getReferenceStatus={() => ({ datasetExists: true, targetGraphExists: true, evaluatorGraphsExist: true })}
      onCreateDataset={() => undefined}
      onCreateSuite={() => undefined}
      onImportDataset={() => undefined}
      onImportSuite={() => undefined}
      onSelectDataset={() => undefined}
      onSelectSuite={() => undefined}
    />,
  );

  assert.match(html, /aria-label="Evaluations resources"/u);
  assert.match(html, /First suite/u);
  assert.match(html, /Second suite/u);
  assert.match(html, /Datasets/u);
  assert.match(html, /Shared cases/u);
  assert.match(html, /aria-label="Import evaluation suite and dataset"/u);
  assert.match(html, /aria-label="Import evaluation dataset"/u);
  assert.match(html, /aria-current="true"/u);
});

test('suite tabs expose definition, runs, and comparison availability without button-style navigation', () => {
  const html = renderToStaticMarkup(
    <EvaluationSectionTabs activeView="definition" compareAvailable={false} onSelect={() => undefined} />,
  );

  assert.match(html, /role="tablist"/u);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>Definition/u);
  assert.doesNotMatch(html, />Dataset</u);
  assert.match(html, /disabled=""[^>]*>Compare/u);
});
