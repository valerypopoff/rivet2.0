import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationDataset, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { EvaluationDefinitionTabs } from './EvaluationDefinitionTabs.js';
import { EvaluationFormField } from './EvaluationFormField.js';
import { EvaluationSectionTabs } from './EvaluationSectionTabs.js';
import { EvaluationSuiteSidebar } from './EvaluationSuiteSidebar.js';
import { getEvaluationSuiteWarnings } from './EvaluationSuiteRunStatus.js';

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
      onDeleteDataset={() => undefined}
      onDeleteSuite={() => undefined}
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
  assert.match(html, /data-contextmenutype="evaluation-suite"/u);
  assert.match(html, /data-contextmenutype="evaluation-dataset"/u);
  assert.match(html, /aria-current="true"/u);
  assert.match(html, /aria-label="Resize evaluations panel"/u);
});

test('suite sidebar shows a running indicator only on the suite that owns the evaluation', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);

  try {
    await act(async () =>
      root.render(
        <EvaluationSuiteSidebar
          canCreateDataset
          canCreateSuite
          datasets={[]}
          getDatasetUsage={() => '0 evaluation suites'}
          selectedSuiteId="suite-1"
          selectedDatasetId={undefined}
          suites={[
            { id: 'suite-1', name: 'First suite', targetGraphId: 'graph-1' },
            { id: 'suite-2', name: 'Second suite', targetGraphId: 'graph-2' },
          ] as EvaluationSuite[]}
          getGraphName={(suite) => `Graph ${suite.targetGraphId}`}
          getReferenceStatus={() => ({ datasetExists: true, targetGraphExists: true, evaluatorGraphsExist: true })}
          onCreateDataset={() => undefined}
          onCreateSuite={() => undefined}
          onDeleteDataset={() => undefined}
          onDeleteSuite={() => undefined}
          onImportDataset={() => undefined}
          onImportSuite={() => undefined}
          onSelectDataset={() => undefined}
          onSelectSuite={() => undefined}
          runningSuiteId="suite-2"
        />,
      ),
    );

    const indicators = dom.window.document.querySelectorAll('[role="status"]');
    assert.equal(indicators.length, 1);
    assert.equal(indicators[0]?.getAttribute('aria-label'), 'Evaluation suite “Second suite” is running');
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
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

test('definition editor tabs expose counted quality editors with the active panel relationship', () => {
  const html = renderToStaticMarkup(
    <EvaluationDefinitionTabs
      activeTab="evaluator-graphs"
      tabs={[
        { id: 'deterministic-checks', label: 'Deterministic checks', count: 2 },
        { id: 'evaluator-graphs', label: 'Evaluator graphs', count: 1 },
        { id: 'thresholds', label: 'Thresholds', count: 0 },
      ]}
      onSelect={() => undefined}
    />,
  );

  assert.match(html, /aria-label="Evaluation definition editors"/u);
  assert.match(html, />Deterministic checks \(2\)</u);
  assert.match(html, /aria-selected="true"[^>]*>Evaluator graphs \(1\)</u);
  assert.match(html, /aria-controls="evaluation-definition-panel-thresholds"/u);
});

test('additional-settings field hints can appear directly below their label', () => {
  const html = renderToStaticMarkup(
    <EvaluationFormField
      description="Seconds allowed for each target or evaluator graph."
      descriptionPlacement="after-label"
      label="Per-graph timeout, sec"
    >
      <input />
    </EvaluationFormField>,
  );

  const label = html.indexOf('Per-graph timeout, sec');
  const hint = html.indexOf('Seconds allowed for each target or evaluator graph.');
  const input = html.indexOf('<input');
  assert.ok(label >= 0 && hint > label && input > hint);
});

test('suite warnings collect global blockers and cautions for the pinned status surface', () => {
  const warnings = getEvaluationSuiteWarnings({
    mode: 'pass-fail',
    hasQualityCriteria: false,
    projectAvailable: true,
    datasetExists: true,
    targetGraphExists: true,
    evaluatorGraphsExist: true,
    executionCount: 0,
    hasInvalidDatasetDraft: false,
    hasInvalidDatasetValues: false,
    hasInvalidExecutionSetup: false,
    hasInvalidQualityChecks: false,
    hasInvalidExpectedValues: false,
    hasInvalidEvaluatorConfiguration: false,
    hasInvalidThresholdConfiguration: false,
    usesPromptDesignerDraft: true,
    hasDormantPassFailConfiguration: false,
    anotherEvaluationRunning: false,
  });

  assert.deepEqual(warnings, [
    'This suite has no required quality criteria. Add a required check, evaluator graph, or threshold to run an evaluation. You can still run it as an execution benchmark to inspect outputs, latency, and accounting without declaring the result passed or failed.',
    'Enable or add at least one dataset case before running this suite.',
    'This suite will run the current unsaved Prompt Designer configuration. That candidate is not written to the project.',
  ]);
});

test('scoring warnings do not refer to pass-fail thresholds', () => {
  const warnings = getEvaluationSuiteWarnings({
    mode: 'scoring',
    hasQualityCriteria: true,
    projectAvailable: true,
    datasetExists: true,
    targetGraphExists: true,
    evaluatorGraphsExist: true,
    executionCount: 1,
    hasInvalidDatasetDraft: false,
    hasInvalidDatasetValues: false,
    hasInvalidExecutionSetup: false,
    hasInvalidQualityChecks: false,
    hasInvalidExpectedValues: false,
    hasInvalidEvaluatorConfiguration: true,
    hasInvalidThresholdConfiguration: false,
    usesPromptDesignerDraft: false,
    hasDormantPassFailConfiguration: false,
    anotherEvaluationRunning: false,
  });

  assert.deepEqual(warnings, ['Fix the highlighted evaluator graph settings before running.']);
  assert.doesNotMatch(warnings.join('\n'), /threshold/u);
});

test('scoring warning formatting ignores stale pass-fail validation results', () => {
  const warnings = getEvaluationSuiteWarnings({
    mode: 'scoring',
    hasQualityCriteria: true,
    projectAvailable: true,
    datasetExists: true,
    targetGraphExists: true,
    evaluatorGraphsExist: true,
    executionCount: 1,
    hasInvalidDatasetDraft: false,
    hasInvalidDatasetValues: false,
    hasInvalidExecutionSetup: false,
    hasInvalidQualityChecks: true,
    hasInvalidExpectedValues: false,
    hasInvalidEvaluatorConfiguration: false,
    hasInvalidThresholdConfiguration: true,
    usesPromptDesignerDraft: false,
    hasDormantPassFailConfiguration: true,
    anotherEvaluationRunning: false,
  });

  assert.deepEqual(warnings, [
    'Existing deterministic checks and aggregate thresholds are preserved but ignored while this suite uses scoring. Switch back to Pass/fail to edit or apply them.',
  ]);
  assert.doesNotMatch(warnings.join('\n'), /Fix the highlighted|before running/u);
});

function installDomGlobals(dom: JSDOM): () => void {
  const keys = ['document', 'Element', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previousDescriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Element: { configurable: true, value: dom.window.Element },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
