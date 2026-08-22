import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasAuthoritativeEvaluationCriteria,
  type EvaluationBaselineSnapshot,
  type EvaluationDataset,
  type EvaluationRun,
  type EvaluationSuite,
  type EvaluationThreshold,
} from '@valerypopoff/rivet2-evaluations';
import type { GraphId, GraphInputNode, Project, ProjectId } from '@valerypopoff/rivet2-core';
import {
  canCompareEvaluationSuite,
  getEvaluationTargetOutputPath,
  getUnusedExpectedFields,
  getEvaluationSuiteReferenceStatus,
  getEvaluationRunQualityPresentation,
  formatEvaluationDurationSeconds,
  getEvaluationAssertionAuthoringIssue,
  getEvaluationEvaluatorAuthoringIssue,
  getEvaluationInputBindingAuthoringIssues,
  getEvaluationDatasetValueTypeAuthoringIssues,
  getEvaluationExpectedValueAuthoringIssues,
  getEvaluationExecutionConfigurationAuthoringIssues,
  getEvaluationThresholdAuthoringIssue,
  resolveComparableEvaluationRun,
  mergeEvaluationRunHistory,
  meanEvaluationTrialScore,
  resolveProjectEvaluationDataset,
  resolvePromptDesignerEvaluationProject,
  resolveSelectedEvaluationSuite,
  reassignEvaluationSuiteDataset,
  reassignEvaluationSuiteTarget,
  removeEvaluationDatasetField,
  removeEvaluationDatasetFieldReferences,
  suggestEvaluationAssertionOperator,
  sortEvaluationRunsByScore,
  sortEvaluationTrialsByScore,
} from './evaluationWorkspaceModel.js';

const suite = {
  id: 'suite-1',
  name: 'Suite',
  targetGraphId: 'graph-1',
  datasetId: 'dataset-1',
} as EvaluationSuite;

test('suite selection is explicit and never falls back to the first suite', () => {
  assert.equal(resolveSelectedEvaluationSuite([suite], undefined), undefined);
  assert.equal(resolveSelectedEvaluationSuite([suite], 'missing'), undefined);
  assert.equal(resolveSelectedEvaluationSuite([suite], suite.id), suite);
});

test('runs and trials sort by score without mutating their execution order', () => {
  const weighted = {
    id: 'weighted',
    observations: [
      { score: 0.9, scoreWeight: 2 },
      { score: 0.4, scoreWeight: 1 },
    ],
  } as unknown as EvaluationRun['trials'][number];
  const low = { id: 'low', observations: [{ score: 0.2 }] } as unknown as EvaluationRun['trials'][number];
  const missing = { id: 'missing', observations: [] } as unknown as EvaluationRun['trials'][number];
  const trials = [low, missing, weighted];

  assert.ok(Math.abs((meanEvaluationTrialScore(weighted) ?? 0) - 11 / 15) < Number.EPSILON);
  assert.deepEqual(
    sortEvaluationTrialsByScore(trials, 'score-desc').map((trial) => trial.id),
    ['weighted', 'low', 'missing'],
  );
  assert.deepEqual(
    sortEvaluationTrialsByScore(trials, 'score-asc').map((trial) => trial.id),
    ['low', 'weighted', 'missing'],
  );
  assert.deepEqual(trials.map((trial) => trial.id), ['low', 'missing', 'weighted']);

  const runs = [
    { id: 'low-run', aggregate: { meanScore: 0.2 } },
    { id: 'unscored-run', aggregate: {} },
    { id: 'high-run', aggregate: { meanScore: 0.9 } },
  ] as unknown as EvaluationRun[];
  assert.deepEqual(
    sortEvaluationRunsByScore(runs, 'score-desc').map((run) => run.id),
    ['high-run', 'low-run', 'unscored-run'],
  );
  assert.deepEqual(runs.map((run) => run.id), ['low-run', 'unscored-run', 'high-run']);
});

test('evaluation durations are consistently presented in seconds', () => {
  assert.equal(formatEvaluationDurationSeconds(8_546), '8.55 sec');
  assert.equal(formatEvaluationDurationSeconds(13_799), '13.8 sec');
  assert.equal(formatEvaluationDurationSeconds(undefined), 'Unavailable');
  assert.equal(formatEvaluationDurationSeconds(-1), 'Unavailable');
});

test('resource reassignment clears only evaluator bindings owned by the changed resource', () => {
  const boundSuite = {
    ...suite,
    targetGraphId: 'old-target' as GraphId,
    datasetId: 'old-dataset',
    inputBindings: [{ graphInputId: 'story', datasetFieldId: 'story-field' }],
    assertions: [
      {
        id: 'reference-check',
        name: 'Reference check',
        outputPath: '$',
        operator: 'equals',
        expected: { kind: 'dataset-field', fieldId: 'reference-field' },
      },
    ],
    evaluators: [
      {
        id: 'judge',
        name: 'Judge',
        graphId: 'judge' as GraphId,
        inputBindings: [
          { graphInputId: 'candidate', source: { kind: 'target-output', outputId: 'candidate' } },
          { graphInputId: 'reference', source: { kind: 'dataset-field', fieldId: 'reference-field' } },
          { graphInputId: 'metadata', source: { kind: 'context', context: 'case' } },
        ],
      },
    ],
  } satisfies EvaluationSuite;

  const reassignedDataset = reassignEvaluationSuiteDataset(boundSuite, 'new-dataset');
  assert.equal(reassignedDataset.datasetId, 'new-dataset');
  assert.deepEqual(reassignedDataset.inputBindings, []);
  assert.deepEqual(reassignedDataset.assertions[0]?.expected, { kind: 'literal', value: null });
  assert.deepEqual(
    reassignedDataset.evaluators[0]?.inputBindings?.map((binding) => binding.source.kind),
    ['target-output', 'context'],
  );

  const reassignedTarget = reassignEvaluationSuiteTarget(boundSuite, 'new-target' as GraphId);
  assert.equal(reassignedTarget.targetGraphId, 'new-target');
  assert.deepEqual(reassignedTarget.inputBindings, []);
  assert.deepEqual(
    reassignedTarget.evaluators[0]?.inputBindings?.map((binding) => binding.source.kind),
    ['dataset-field', 'context'],
  );
  assert.equal(reassignedTarget.assertions[0]?.outputPath, '');
  assert.equal(reassignedTarget.assertions[0]?.expected.kind, 'dataset-field');
});

test('removing a dataset field clears every suite reference while preserving unrelated bindings', () => {
  const dataset = {
    id: 'dataset',
    projectId: 'project' as ProjectId,
    name: 'Dataset',
    fields: [
      { id: 'story', name: 'Story', role: 'input', dataType: 'string' },
      { id: 'reference', name: 'Reference', role: 'expected', dataType: 'object' },
    ],
    cases: [{ id: 'case', name: 'Case', values: { story: 'Story', reference: { terms: [] } } }],
  } satisfies EvaluationDataset;
  const suiteWithReferences = {
    ...suite,
    datasetId: dataset.id,
    inputBindings: [{ graphInputId: 'storyInput', datasetFieldId: 'story' }],
    assertions: [
      {
        id: 'reference-check',
        name: 'Reference check',
        outputPath: '$',
        operator: 'equals',
        expected: { kind: 'dataset-field', fieldId: 'reference' },
      },
    ],
    evaluators: [
      {
        id: 'judge',
        name: 'Judge',
        graphId: 'judge' as GraphId,
        inputBindings: [
          { graphInputId: 'reference', source: { kind: 'dataset-field', fieldId: 'reference' } },
          { graphInputId: 'case', source: { kind: 'context', context: 'case' } },
        ],
      },
    ],
  } satisfies EvaluationSuite;

  const withoutReference = removeEvaluationDatasetField(dataset, 'reference');
  assert.deepEqual(
    withoutReference.fields.map((field) => field.id),
    ['story'],
  );
  assert.deepEqual(withoutReference.cases[0]?.values, { story: 'Story' });

  const repairedSuite = removeEvaluationDatasetFieldReferences(suiteWithReferences, 'reference');
  assert.deepEqual(repairedSuite.inputBindings, suiteWithReferences.inputBindings);
  assert.deepEqual(repairedSuite.assertions[0]?.expected, { kind: 'literal', value: null });
  assert.deepEqual(repairedSuite.evaluators[0]?.inputBindings, [
    { graphInputId: 'case', source: { kind: 'context', context: 'case' } },
  ]);
});

test('suite references report missing graphs and datasets independently', () => {
  const projectId = 'project' as ProjectId;
  const project = { metadata: { id: projectId }, graphs: { 'graph-1': {} } } as unknown as Project;
  const dataset = { id: 'dataset-1', projectId } as EvaluationDataset;

  assert.deepEqual(getEvaluationSuiteReferenceStatus(suite, project, [dataset]), {
    datasetExists: true,
    targetGraphExists: true,
    evaluatorGraphsExist: true,
  });
  assert.deepEqual(
    getEvaluationSuiteReferenceStatus(suite, { metadata: { id: projectId }, graphs: {} } as unknown as Project, []),
    {
      datasetExists: false,
      targetGraphExists: false,
      evaluatorGraphsExist: true,
    },
  );
});

test('a same-ID evaluation dataset from another project is unavailable', () => {
  const projectId = 'project-a' as ProjectId;
  const otherProjectId = 'project-b' as ProjectId;
  const foreignDataset = { id: suite.datasetId, projectId: otherProjectId } as EvaluationDataset;
  const project = { metadata: { id: projectId }, graphs: { [suite.targetGraphId]: {} } } as unknown as Project;

  assert.equal(resolveProjectEvaluationDataset([foreignDataset], projectId, suite.datasetId), undefined);
  assert.deepEqual(getEvaluationSuiteReferenceStatus(suite, project, [foreignDataset]), {
    datasetExists: false,
    targetGraphExists: true,
    evaluatorGraphsExist: true,
  });
});

test('a local evaluation dataset is available to the currently open project', () => {
  const projectId = 'project-a' as ProjectId;
  const localDataset = { id: suite.datasetId } as EvaluationDataset;
  const project = { metadata: { id: projectId }, graphs: { [suite.targetGraphId]: {} } } as unknown as Project;

  assert.equal(resolveProjectEvaluationDataset([localDataset], projectId, suite.datasetId), localDataset);
  assert.deepEqual(getEvaluationSuiteReferenceStatus(suite, project, [localDataset]), {
    datasetExists: true,
    targetGraphExists: true,
    evaluatorGraphsExist: true,
  });
});

test('a missing evaluator graph is visible before running the suite', () => {
  const projectId = 'project' as ProjectId;
  const dataset = { id: suite.datasetId, projectId } as EvaluationDataset;
  const suiteWithEvaluator = { ...suite, evaluators: [{ id: 'evaluator', graphId: 'missing' }] } as EvaluationSuite;
  const project = { metadata: { id: projectId }, graphs: { [suite.targetGraphId]: {} } } as unknown as Project;

  assert.deepEqual(getEvaluationSuiteReferenceStatus(suiteWithEvaluator, project, [dataset]), {
    datasetExists: true,
    targetGraphExists: true,
    evaluatorGraphsExist: false,
  });
});

test('compare requires a baseline or two completed runs for the selected suite', () => {
  const completedRun = (id: string, suiteId = suite.id) =>
    ({
      id,
      suiteId,
      executionStatus: 'completed',
      aggregate: {},
    }) as EvaluationRun;

  assert.equal(canCompareEvaluationSuite(suite.id, [], []), false);
  assert.equal(canCompareEvaluationSuite(suite.id, [completedRun('run-1')], []), false);
  assert.equal(canCompareEvaluationSuite(suite.id, [completedRun('run-1'), completedRun('run-2')], []), true);
  assert.equal(canCompareEvaluationSuite(suite.id, [completedRun('run-1'), completedRun('run-2', 'other')], []), false);
  assert.equal(canCompareEvaluationSuite(suite.id, [], [{ suiteId: suite.id } as EvaluationBaselineSnapshot]), true);
});

test('compare ignores completed history that does not have an aggregate', () => {
  const completedWithoutAggregate = (id: string) =>
    ({ id, suiteId: suite.id, executionStatus: 'completed' }) as EvaluationRun;

  assert.equal(
    canCompareEvaluationSuite(suite.id, [completedWithoutAggregate('run-1'), completedWithoutAggregate('run-2')], []),
    false,
  );
});

test('compare ignores failed history when choosing its initial run', () => {
  const failedRun = { id: 'failed', suiteId: suite.id, executionStatus: 'error' } as EvaluationRun;
  const completedRun = {
    id: 'completed',
    suiteId: suite.id,
    executionStatus: 'completed',
    aggregate: {},
  } as unknown as EvaluationRun;

  assert.equal(
    resolveComparableEvaluationRun(suite.id, [failedRun, completedRun], failedRun.id, undefined),
    completedRun,
  );
});

test('run history keeps the terminal in-memory run when a delayed store read is stale', () => {
  const stalePersistedRun = {
    id: 'run-1',
    suiteId: suite.id,
    revision: 4,
    executionStatus: 'running',
  } as EvaluationRun;
  const completedRun = {
    ...stalePersistedRun,
    revision: 5,
    executionStatus: 'completed',
    aggregate: {},
  } as EvaluationRun;

  assert.deepEqual(mergeEvaluationRunHistory([stalePersistedRun], completedRun), [completedRun]);
});

test('run history favors a terminal snapshot when revisions are equal', () => {
  const stalePersistedRun = {
    id: 'run-1',
    suiteId: suite.id,
    revision: 5,
    executionStatus: 'running',
  } as EvaluationRun;
  const completedRun = {
    ...stalePersistedRun,
    executionStatus: 'completed',
    aggregate: {},
  } as EvaluationRun;

  assert.deepEqual(mergeEvaluationRunHistory([stalePersistedRun], completedRun), [completedRun]);
});

test('run history preserves a stored user-assigned name while merging a live execution snapshot', () => {
  const persistedRun = {
    id: 'named-run',
    suiteId: suite.id,
    name: 'Regression check',
    revision: 1,
    executionStatus: 'running',
  } as EvaluationRun;
  const liveRun = { ...persistedRun, name: undefined, revision: 2, executionStatus: 'running' as const };

  assert.equal(mergeEvaluationRunHistory([persistedRun], liveRun)[0]?.name, 'Regression check');
});

test('quality presentation remains passed when provider accounting is partial', () => {
  const run = {
    qualityStatus: 'passed',
    qualityReason: { code: 'checks-passed', message: 'Every required check passed.' },
    accountingStatus: 'partial',
    executionStatus: 'completed',
  } as unknown as EvaluationRun;

  assert.deepEqual(getEvaluationRunQualityPresentation(run), {
    label: 'Passed',
    explanation: 'Every required check passed.',
  });
});

test('quality presentation preserves the engine reason for a failed run', () => {
  const run = {
    qualityStatus: 'failed',
    qualityReason: { code: 'threshold-failed', message: 'P95 latency exceeded 1,000 ms.' },
    accountingStatus: 'complete',
    executionStatus: 'completed',
  } as unknown as EvaluationRun;

  assert.deepEqual(getEvaluationRunQualityPresentation(run), {
    label: 'Failed',
    explanation: 'P95 latency exceeded 1,000 ms.',
  });
});

test('quality presentation labels complete scoring runs without calling them passed', () => {
  const run = {
    qualityStatus: 'scored',
    qualityReason: { code: 'scores-complete', message: 'Every requested trial produced a score.' },
    accountingStatus: 'complete',
    executionStatus: 'completed',
  } as unknown as EvaluationRun;

  assert.deepEqual(getEvaluationRunQualityPresentation(run), {
    label: 'Scored',
    explanation: 'Every requested trial produced a score.',
  });
});

test('quality presentation explains a benchmark without calling it passed', () => {
  const run = {
    qualityStatus: 'not-evaluated',
    qualityReason: { code: 'benchmark', message: 'This run measured execution without evaluating output quality.' },
    executionStatus: 'completed',
  } as unknown as EvaluationRun;

  assert.deepEqual(getEvaluationRunQualityPresentation(run), {
    label: 'Not evaluated',
    explanation: 'This run measured execution without evaluating output quality.',
  });
});

test('quality-check helpers preserve exact output IDs and suggest collection-aware operators', () => {
  assert.equal(getEvaluationTargetOutputPath('answer'), '$["answer"]');
  assert.equal(getEvaluationTargetOutputPath('answer.with punctuation'), '$["answer.with punctuation"]');
  assert.equal(suggestEvaluationAssertionOperator('string', 'string[]'), 'contains-all');
  assert.equal(suggestEvaluationAssertionOperator('string[]', 'string'), 'array-includes');
  assert.equal(suggestEvaluationAssertionOperator('object', 'object'), 'equals');
});

test('unused expected fields stay visible until an explicit assertion consumes them', () => {
  const fields = [
    { id: 'input', name: 'topic', role: 'input', dataType: 'string' },
    { id: 'expected-a', name: 'keywords', role: 'expected', dataType: 'string[]' },
    { id: 'expected-b', name: 'tone', role: 'expected', dataType: 'string' },
  ] as EvaluationDataset['fields'];
  const assertions = [
    {
      id: 'assertion',
      name: 'Keywords',
      outputPath: '$["output"]',
      operator: 'contains-all',
      expected: { kind: 'dataset-field', fieldId: 'expected-a' },
    },
  ] as EvaluationSuite['assertions'];

  assert.deepEqual(
    getUnusedExpectedFields(fields, assertions).map((field) => field.id),
    ['expected-b'],
  );
});

test('quality-check authoring catches incompatible outputs and expected values before execution', () => {
  const outputs = [
    { id: 'answer', dataType: 'string', outputPath: '$["answer"]' },
    { id: 'score', dataType: 'number', outputPath: '$["score"]' },
  ] as const;
  const fields = [
    { id: 'keywords', name: 'keywords', role: 'expected', dataType: 'string[]' },
    { id: 'minimum', name: 'minimum', role: 'expected', dataType: 'number' },
  ] as EvaluationDataset['fields'];

  assert.equal(
    getEvaluationAssertionAuthoringIssue(
      {
        id: 'contains',
        name: 'Contains keywords',
        outputPath: '$["answer"]',
        operator: 'contains-all',
        expected: { kind: 'dataset-field', fieldId: 'keywords' },
      },
      outputs,
      fields,
    ),
    undefined,
  );
  assert.equal(
    getEvaluationAssertionAuthoringIssue(
      {
        id: 'numeric',
        name: 'Numeric comparison',
        outputPath: '$["answer"]',
        operator: 'number-at-least',
        expected: { kind: 'dataset-field', fieldId: 'minimum' },
      },
      outputs,
      fields,
    )?.code,
    'incompatible-output',
  );
  assert.equal(
    getEvaluationAssertionAuthoringIssue(
      {
        id: 'missing',
        name: 'Missing field',
        outputPath: '$["answer"]',
        operator: 'equals',
        expected: { kind: 'dataset-field', fieldId: 'missing' },
      },
      outputs,
      fields,
    )?.code,
    'missing-expected-field',
  );
  assert.equal(
    getEvaluationAssertionAuthoringIssue(
      {
        id: 'range',
        name: 'Bad range',
        outputPath: '$["score"]',
        operator: 'number-between',
        expected: { kind: 'literal', value: [10, 5] },
      },
      outputs,
      fields,
    )?.code,
    'incompatible-expected-value',
  );
  assert.equal(
    getEvaluationAssertionAuthoringIssue(
      {
        id: 'equals-mismatched-literal',
        name: 'Bad literal comparison',
        outputPath: '$["answer"]',
        operator: 'equals',
        expected: { kind: 'literal', value: 42 },
      },
      outputs,
      fields,
    )?.code,
    'incompatible-expected-value',
  );
  assert.equal(
    getEvaluationAssertionAuthoringIssue(
      {
        id: 'equals-mismatched-types',
        name: 'Bad equality comparison',
        outputPath: '$["answer"]',
        operator: 'equals',
        expected: { kind: 'dataset-field', fieldId: 'minimum' },
      },
      outputs,
      fields,
    )?.code,
    'incompatible-expected-value',
  );
});

test('quality-check authoring uses the runtime JSON-path grammar before execution', () => {
  const outputs = [{ id: 'answer', dataType: 'string', outputPath: '$["answer"]' }] as const;
  const assertion = {
    id: 'path-check',
    name: 'Path check',
    operator: 'equals',
    expected: { kind: 'literal', value: 'expected' },
  } as const;

  for (const outputPath of ['$', '  $["answer"]  ', '$.answer']) {
    assert.equal(getEvaluationAssertionAuthoringIssue({ ...assertion, outputPath }, outputs, []), undefined);
  }
  for (const outputPath of ['answer', '$.answer!', '$[answer]', '$.items[-1]']) {
    assert.equal(
      getEvaluationAssertionAuthoringIssue({ ...assertion, outputPath }, outputs, [])?.code,
      'invalid-output-path',
    );
  }
  for (const outputPath of ['$.result.score', '$["quoted-key"][0]', "$['quoted-key']"]) {
    assert.equal(
      getEvaluationAssertionAuthoringIssue({ ...assertion, outputPath }, outputs, [])?.code,
      'missing-output',
    );
  }
});

test('input-binding authoring catches missing bindings and case values before execution', () => {
  const input = {
    id: 'node-input',
    type: 'graphInput',
    data: { id: 'topic', dataType: 'string', useDefaultValueInput: false },
  } as GraphInputNode;
  const dataset = {
    id: 'dataset',
    projectId: 'project' as ProjectId,
    name: 'Dataset',
    fields: [{ id: 'topic-field', name: 'topic', role: 'input', dataType: 'string' }],
    cases: [{ id: 'case', name: 'Case 1', enabled: true, values: {} }],
  } as EvaluationDataset;
  const unboundSuite = { ...suite, inputBindings: [] } as EvaluationSuite;
  assert.match(getEvaluationInputBindingAuthoringIssues(unboundSuite, dataset, [input])[0]!, /Bind target input/);

  const boundSuite = {
    ...suite,
    inputBindings: [{ graphInputId: 'topic', datasetFieldId: 'topic-field' }],
  } as EvaluationSuite;
  assert.match(getEvaluationInputBindingAuthoringIssues(boundSuite, dataset, [input])[0]!, /has no value/);
  assert.deepEqual(
    getEvaluationInputBindingAuthoringIssues(
      boundSuite,
      { ...dataset, cases: [{ ...dataset.cases[0]!, values: { 'topic-field': 'Michael Jackson' } }] },
      [input],
    ),
    [],
  );
});

test('expected-value authoring catches absent and operator-incompatible case values', () => {
  const dataset = {
    id: 'dataset',
    projectId: 'project' as ProjectId,
    name: 'Dataset',
    fields: [{ id: 'keywords', name: 'keywords', role: 'expected', dataType: 'string[]' }],
    cases: [{ id: 'case', name: 'Case 1', enabled: true, values: {} }],
  } as EvaluationDataset;
  const suiteWithCheck = {
    ...suite,
    assertions: [
      {
        id: 'check',
        name: 'Contains keywords',
        outputPath: '$["output"]',
        operator: 'contains-all',
        expected: { kind: 'dataset-field', fieldId: 'keywords' },
      },
    ],
  } as EvaluationSuite;

  assert.match(getEvaluationExpectedValueAuthoringIssues(suiteWithCheck, dataset)[0]!, /no required value/);
  assert.match(
    getEvaluationExpectedValueAuthoringIssues(suiteWithCheck, {
      ...dataset,
      cases: [{ ...dataset.cases[0]!, values: { keywords: [] } }],
    })[0]!,
    /does not provide a non-empty array of text values/,
  );
  assert.match(
    getEvaluationExpectedValueAuthoringIssues(suiteWithCheck, {
      ...dataset,
      cases: [{ ...dataset.cases[0]!, values: { keywords: 'singer' } }],
    })[0]!,
    /not compatible with its declared string\[\] type/,
  );
  assert.deepEqual(
    getEvaluationExpectedValueAuthoringIssues(suiteWithCheck, {
      ...dataset,
      cases: [{ ...dataset.cases[0]!, values: { keywords: ['singer'] } }],
    }),
    [],
  );

  const scoringSuite = { ...suiteWithCheck, evaluationMode: 'scoring' as const };
  assert.deepEqual(getEvaluationExpectedValueAuthoringIssues(scoringSuite, dataset), []);
  assert.match(
    getEvaluationExpectedValueAuthoringIssues(scoringSuite, {
      ...dataset,
      fields: [{ ...dataset.fields[0]!, required: true }],
    })[0]!,
    /no required value/,
  );
});

test('dataset value type authoring checks every enabled supplied cell independently of quality mode', () => {
  const dataset = {
    id: 'dataset',
    projectId: 'project' as ProjectId,
    name: 'Dataset',
    fields: [
      { id: 'input', name: 'input', role: 'input', dataType: 'string' },
      { id: 'metadata', name: 'retries', role: 'metadata', dataType: 'number' },
    ],
    cases: [
      { id: 'enabled', name: 'Enabled case', enabled: true, values: { input: 'hello', metadata: 'three' } },
      { id: 'disabled', name: 'Disabled case', enabled: false, values: { metadata: 'also invalid' } },
    ],
  } as EvaluationDataset;

  assert.deepEqual(getEvaluationDatasetValueTypeAuthoringIssues(dataset), [
    'Case “Enabled case” value for “retries” is not compatible with its declared number type.',
  ]);
});

test('evaluator authoring preserves the legacy object-shaped reserved input contract', () => {
  const evaluator = {
    id: 'evaluator',
    name: 'Judge',
    graphId: 'evaluator-graph',
  } as EvaluationSuite['evaluators'][number];
  const reservedInputs = ['case', 'inputs', 'expected', 'outputs', 'run'].map((id) => ({
    id: `${id}-node`,
    type: 'graphInput',
    data: { id, dataType: 'object', useDefaultValueInput: false },
  }));
  const resultOutput = {
    id: 'result-node',
    type: 'graphOutput',
    data: { id: 'result', dataType: 'object' },
  };
  const projectWithNodes = (nodes: unknown[]) =>
    ({
      graphs: {
        'evaluator-graph': { nodes },
      },
    }) as unknown as Project;

  assert.equal(
    getEvaluationEvaluatorAuthoringIssue(evaluator, projectWithNodes([...reservedInputs, resultOutput])),
    undefined,
  );
  assert.match(
    getEvaluationEvaluatorAuthoringIssue(
      evaluator,
      projectWithNodes([
        ...reservedInputs.map((node) =>
          node.data.id === 'outputs' ? { ...node, data: { ...node.data, dataType: 'string' } } : node,
        ),
        resultOutput,
      ]),
    )!,
    /Legacy evaluator input “outputs” must use the object or any data type/,
  );
  assert.match(
    getEvaluationEvaluatorAuthoringIssue(
      evaluator,
      projectWithNodes([...reservedInputs, { ...reservedInputs[0], id: 'duplicate-case' }, resultOutput]),
    )!,
    /duplicate Graph Input ids/,
  );
});

test('evaluator authoring validates direct target-output and dataset-field mappings', () => {
  const projectId = 'project' as ProjectId;
  const directSuite = {
    id: 'suite',
    name: 'Suite',
    targetGraphId: 'target' as GraphId,
    datasetId: 'dataset',
    inputBindings: [],
    assertions: [],
    evaluators: [],
  } as EvaluationSuite;
  const directDataset = {
    id: 'dataset',
    projectId,
    name: 'Dataset',
    fields: [{ id: 'reference-field', name: 'Reference', role: 'expected', dataType: 'object' }],
    cases: [{ id: 'case', name: 'Case', values: { 'reference-field': { terms: [] } } }],
  } as EvaluationDataset;
  const directEvaluator = {
    id: 'judge',
    name: 'Judge',
    graphId: 'judge',
    inputBindings: [
      { graphInputId: 'candidate', source: { kind: 'target-output', outputId: 'candidate-output' } },
      { graphInputId: 'reference', source: { kind: 'dataset-field', fieldId: 'reference-field' } },
    ],
  } as EvaluationSuite['evaluators'][number];
  const project = {
    metadata: { id: projectId },
    graphs: {
      target: {
        nodes: [
          {
            id: 'candidate-output-node',
            type: 'graphOutput',
            data: { id: 'candidate-output', dataType: 'object' },
          },
        ],
      },
      judge: {
        nodes: [
          { id: 'candidate-input', type: 'graphInput', data: { id: 'candidate', dataType: 'object' } },
          { id: 'reference-input', type: 'graphInput', data: { id: 'reference', dataType: 'object' } },
          { id: 'result-output', type: 'graphOutput', data: { id: 'result', dataType: 'object' } },
        ],
      },
    },
  } as unknown as Project;

  assert.equal(getEvaluationEvaluatorAuthoringIssue(directEvaluator, project, directSuite, directDataset), undefined);
  assert.match(
    getEvaluationEvaluatorAuthoringIssue(
      { ...directEvaluator, inputBindings: directEvaluator.inputBindings?.slice(0, 1) },
      project,
      directSuite,
      directDataset,
    )!,
    /Choose a source for evaluator input “reference”/,
  );
});

test('execution-setting authoring catches invalid worker and seed configuration before execution', () => {
  const seedInput = {
    id: 'seed-node',
    type: 'graphInput',
    data: { id: 'seed', dataType: 'number', useDefaultValueInput: false },
  } as GraphInputNode;
  assert.deepEqual(
    getEvaluationExecutionConfigurationAuthoringIssues(
      {
        ...suite,
        inputBindings: [],
        configuration: { trialCount: 1.5, concurrency: 33, seed: -1 },
      } as EvaluationSuite,
      [seedInput],
    ),
    [
      'Trials must be a positive whole number.',
      'Concurrency must be a whole number from 1 to 32.',
      'Suite seed must be a non-negative whole number.',
      'Choose the numeric target input that receives each derived seed.',
    ],
  );
  assert.deepEqual(
    getEvaluationExecutionConfigurationAuthoringIssues(
      {
        ...suite,
        inputBindings: [],
        configuration: { trialCount: 2, concurrency: 4, seed: 42, seedGraphInputId: 'seed' },
      } as EvaluationSuite,
      [seedInput],
    ),
    [],
  );
});

test('threshold authoring rejects unsupported and context-free quality metrics', () => {
  const base = { ...suite, assertions: [], evaluators: [], thresholds: [] } as EvaluationSuite;
  assert.match(
    getEvaluationThresholdAuthoringIssue(
      { id: 'legacy', metric: 'mystery', operator: 'at-most', value: 1 } as unknown as EvaluationThreshold,
      base,
    )!,
    /not supported/,
  );
  assert.match(
    getEvaluationThresholdAuthoringIssue(
      { id: 'pass-rate', metric: 'pass-rate', operator: 'at-least', value: 1 },
      base,
    )!,
    /requires at least one required/,
  );
  assert.equal(
    getEvaluationThresholdAuthoringIssue(
      { id: 'out-of-range-rate', metric: 'pass-rate', operator: 'at-least', value: 1.01 },
      base,
    ),
    'Rate and score thresholds must be between 0% and 100%.',
  );
  assert.equal(
    getEvaluationThresholdAuthoringIssue(
      { id: 'latency', metric: 'p95-latency-ms', operator: 'at-most', value: 2_000 },
      base,
    ),
    undefined,
  );
});

test('only required checks, required evaluators, or thresholds enable a quality evaluation', () => {
  const base = { ...suite, assertions: [], evaluators: [], thresholds: [] } as EvaluationSuite;
  assert.equal(hasAuthoritativeEvaluationCriteria(base), false);
  assert.equal(
    hasAuthoritativeEvaluationCriteria({
      ...base,
      assertions: [
        {
          id: 'check',
          name: 'Informational',
          outputPath: '$',
          operator: 'equals',
          expected: { kind: 'literal', value: null },
          required: false,
        },
      ],
    }),
    false,
  );
  assert.equal(
    hasAuthoritativeEvaluationCriteria({
      ...base,
      thresholds: [{ id: 'latency', metric: 'p95-latency-ms', operator: 'at-most', value: 1000 }],
    }),
    true,
  );
  assert.equal(
    hasAuthoritativeEvaluationCriteria({
      ...base,
      evaluationMode: 'scoring',
      evaluators: [{ id: 'judge', name: 'Informational in pass/fail', graphId: base.targetGraphId, required: false }],
    }),
    true,
  );
});

test('an unsaved Prompt Designer draft cannot cross a project boundary', () => {
  const projectA = 'project-a' as ProjectId;
  const projectB = 'project-b' as ProjectId;
  const draftProject = { metadata: { id: projectA } } as unknown as Project;
  const override = {
    project: draftProject,
    projectId: projectA,
    graphId: suite.targetGraphId,
  } as const;

  assert.equal(resolvePromptDesignerEvaluationProject(override, projectA, suite.targetGraphId), draftProject);
  assert.equal(resolvePromptDesignerEvaluationProject(override, projectB, suite.targetGraphId), undefined);
  assert.equal(resolvePromptDesignerEvaluationProject(override, projectA, 'other-graph' as GraphId), undefined);
});
