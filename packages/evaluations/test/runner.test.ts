import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import {
  createEmptyEvaluationProjectData,
  createEvaluationBaselineSnapshot,
  EvaluationGraphExecutionError,
  finalizeEvaluationRecordingRetention,
  runEvaluationCases,
  runEvaluationWorkPool,
  runEvaluationSuite,
  summarizeEvaluationRun,
  type EvaluationDataset,
  type EvaluationGraphRunner,
  type EvaluationProjectData,
  type EvaluationRun,
  type EvaluationSuite,
  type EvaluationTrial,
  type PortableJson,
} from '../src/index.js';

const project = {
  metadata: {
    id: 'evaluation-project' as ProjectId,
    title: 'Evaluation project',
    description: '',
    mainGraphId: 'target',
  },
  graphs: {
    target: {
      metadata: { id: 'target', name: 'Target' },
      nodes: [{ id: 'input-node', type: 'graphInput', data: { id: 'input', dataType: 'string' } }],
      connections: [],
    },
    evaluator: {
      metadata: { id: 'evaluator', name: 'Evaluator' },
      nodes: [
        ...['case', 'inputs', 'expected', 'outputs', 'run'].map((id) => ({
          id: `${id}-input`,
          type: 'graphInput',
          data: { id, dataType: 'object' },
        })),
        { id: 'result-output', type: 'graphOutput', data: { id: 'result', dataType: 'object' } },
      ],
      connections: [],
    },
  },
} as unknown as Project;

function dataset(values: readonly string[] = ['one']): EvaluationDataset {
  return {
    id: 'dataset',
    projectId: project.metadata.id,
    name: 'Dataset',
    fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input', required: true }],
    cases: values.map((value, index) => ({ id: `case-${index}`, name: `Case ${index}`, values: { input: value } })),
  };
}

function suite(overrides: Partial<EvaluationSuite> = {}): EvaluationSuite {
  return {
    id: 'suite',
    name: 'Suite',
    targetGraphId: 'target',
    datasetId: 'dataset',
    inputBindings: [{ graphInputId: 'input', datasetFieldId: 'input' }],
    // Most runner tests exercise scheduling, accounting, retention, or
    // provenance rather than authoring validation. Give them one harmless,
    // authoritative quality check so they remain normal evaluations under
    // the v2 contract. Tests for criteria-free suites opt out explicitly.
    assertions: [
      {
        id: 'output-object',
        name: 'Target returned outputs',
        outputPath: '$',
        operator: 'type-is',
        expected: { kind: 'literal', value: 'object' },
        required: true,
      },
    ],
    evaluators: [],
    configuration: { concurrency: 2, trialCount: 1 },
    thresholds: [],
    ...overrides,
  } as EvaluationSuite;
}

function data(value: EvaluationSuite): EvaluationProjectData {
  return { ...createEmptyEvaluationProjectData(), suites: [value] };
}

function trial(
  id: string,
  executionStatus: EvaluationTrial['executionStatus'],
  qualityStatus: EvaluationTrial['qualityStatus'],
): EvaluationTrial {
  return {
    id,
    caseId: id,
    caseName: id,
    caseIndex: 0,
    trialIndex: 0,
    executionStatus,
    qualityStatus,
    qualityReason: {
      code:
        executionStatus === 'canceled'
          ? 'canceled'
          : executionStatus === 'error'
            ? 'target-error'
            : qualityStatus === 'passed'
              ? 'checks-passed'
              : qualityStatus === 'failed'
                ? 'checks-failed'
                : qualityStatus === 'unable-to-evaluate'
                  ? 'required-check-error'
                  : 'no-trial-quality-checks',
      message: id,
    },
    inputs: {},
    expected: {},
    outputs: {},
    observations: [],
    targetMetrics: { durationMs: 1 },
    evaluatorMetrics: { durationMs: 0 },
    totalMetrics: { durationMs: 1 },
  };
}

test('rejects a normal evaluation with no authoritative quality criteria', async () => {
  await assert.rejects(
    runEvaluationSuite({
      project,
      evaluationData: data(suite({ assertions: [], evaluators: [], thresholds: [] })),
      dataset: dataset(),
      suiteId: 'suite',
      runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
    }),
    /has no required quality check or threshold/,
  );
});

test('an execution benchmark runs only the target and never claims a quality result', async () => {
  const calls: string[] = [];
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        assertions: [
          {
            id: 'would-fail',
            name: 'Would fail',
            outputPath: '$.result',
            operator: 'equals',
            expected: { kind: 'literal', value: 'not the target output' },
            required: true,
          },
        ],
        evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    purpose: 'execution-benchmark',
    runGraph: async ({ graphId }) => {
      calls.push(graphId);
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });

  assert.deepEqual(calls, ['target']);
  assert.equal(result.purpose, 'execution-benchmark');
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.qualityStatus, 'not-evaluated');
  assert.equal(result.trials[0]?.executionStatus, 'completed');
  assert.equal(result.trials[0]?.qualityStatus, 'not-evaluated');
  assert.deepEqual(result.trials[0]?.observations, []);
});

test('progress updates are detached immutable revisions', async () => {
  const updates: EvaluationRun[] = [];
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: dataset(['one', 'two']),
    suiteId: 'suite',
    runGraph: async ({ inputs }) => ({
      outputs: { result: inputs.input },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
    onUpdate: (update) => updates.push(update),
  });

  assert.ok(updates.length >= 3);
  assert.equal(updates[0]?.revision, 1);
  assert.equal(updates[0]?.trials.length, 0);
  assert.equal(updates[0]?.provenance.accountingComplete, true);
  assert.deepEqual(updates[0]?.warnings, []);
  assert.equal(updates.at(-1)?.provenance.accountingComplete, false);

  result.provenance.accountingComplete = true;
  result.warnings.push('mutation after completion');
  result.trials[0]!.outputs.result = 'mutated';
  assert.equal(updates.at(-1)?.provenance.accountingComplete, false);
  assert.equal(updates.at(-1)?.warnings.includes('mutation after completion'), false);
  assert.equal(updates.at(-1)?.trials[0]?.outputs.result, 'one');
});

test('an execution benchmark ignores missing required reference fields but still requires bound inputs', async () => {
  const benchmarkDataset: EvaluationDataset = {
    id: 'dataset',
    projectId: project.metadata.id,
    name: 'Benchmark dataset',
    fields: [
      { id: 'input', name: 'Input', dataType: 'string', role: 'input', required: true },
      { id: 'expected', name: 'Expected answer', dataType: 'string', role: 'expected', required: true },
      { id: 'metadata', name: 'Reference metadata', dataType: 'object', role: 'metadata', required: true },
    ],
    cases: [{ id: 'case', name: 'Case', values: { input: 'one' } }],
  };
  let targetCalls = 0;
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: benchmarkDataset,
    suiteId: 'suite',
    purpose: 'execution-benchmark',
    runGraph: async ({ inputs }) => {
      targetCalls += 1;
      assert.deepEqual(inputs, { input: 'one' });
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });

  assert.equal(targetCalls, 1);
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.qualityStatus, 'not-evaluated');

  targetCalls = 0;
  await assert.rejects(
    runEvaluationSuite({
      project,
      evaluationData: data(suite()),
      dataset: { ...benchmarkDataset, cases: [{ id: 'case', name: 'Case', values: {} }] },
      suiteId: 'suite',
      purpose: 'execution-benchmark',
      runGraph: async () => {
        targetCalls += 1;
        return { outputs: { result: 'should not run' }, metrics: { durationMs: 1 } };
      },
    }),
    /has no saved value for bound input field "Input"/u,
  );
  assert.equal(targetCalls, 0);
});

test('rejects thresholds that cannot be evaluated before executing the target', async (context) => {
  const cases: ReadonlyArray<{
    name: string;
    evaluationSuite: EvaluationSuite;
    expectedError: RegExp;
  }> = [
    {
      name: 'pass rate without a required per-trial check',
      evaluationSuite: suite({
        assertions: [],
        evaluators: [],
        thresholds: [{ id: 'pass-rate', metric: 'pass-rate', operator: 'at-least', value: 1 }],
      }),
      expectedError: /pass-rate threshold requires at least one required quality check or evaluator graph/u,
    },
    ...(['mean-score', 'custom:groundedness', 'evaluator-error-rate'] as const).map((metric) => ({
      name: `${metric} without an evaluator graph`,
      evaluationSuite: suite({
        evaluators: [],
        thresholds: [
          metric === 'evaluator-error-rate'
            ? { id: metric, metric, operator: 'at-most' as const, value: 0 }
            : { id: metric, metric, operator: 'at-least' as const, value: 0.5 },
        ],
      }),
      expectedError: new RegExp(
        `The "${metric.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}" threshold requires at least one evaluator graph`,
        'u',
      ),
    })),
    {
      name: 'unsupported metric',
      evaluationSuite: suite({
        thresholds: [{ id: 'unsupported', metric: 'made-up-metric', operator: 'max-regression', value: 0.1 }],
      }),
      expectedError: /threshold metric "made-up-metric" is not supported/u,
    },
  ];

  for (const testCase of cases) {
    await context.test(testCase.name, async () => {
      let targetCalls = 0;
      await assert.rejects(
        runEvaluationSuite({
          project,
          evaluationData: data(testCase.evaluationSuite),
          dataset: dataset(),
          suiteId: 'suite',
          runGraph: async () => {
            targetCalls += 1;
            return { outputs: { result: 'should not run' }, metrics: { durationMs: 1 } };
          },
        }),
        testCase.expectedError,
      );
      assert.equal(targetCalls, 0);
    });
  }
});

test('rejects duplicate definition ids and invalid threshold values before graph execution', async (context) => {
  const cases: Array<{ name: string; value: EvaluationSuite; expected: RegExp }> = [
    {
      name: 'duplicate ids across definition kinds',
      value: suite({
        evaluators: [{ id: 'output-object', name: 'Judge', graphId: 'evaluator', required: true }],
      }),
      expected: /duplicates a quality check id/u,
    },
    {
      name: 'out-of-range rate',
      value: suite({
        thresholds: [{ id: 'rate', metric: 'pass-rate', operator: 'at-least', value: 1.1 }],
      }),
      expected: /value from 0 to 1/u,
    },
    {
      name: 'incompatible threshold operator',
      value: suite({
        thresholds: [{ id: 'latency', metric: 'average-latency-ms', operator: 'at-least', value: 100 }],
      }),
      expected: /incompatible operator/u,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      let graphCalls = 0;
      await assert.rejects(
        runEvaluationSuite({
          project,
          evaluationData: data(item.value),
          dataset: dataset(),
          suiteId: 'suite',
          runGraph: async () => {
            graphCalls += 1;
            return { outputs: { result: 'should not run' }, metrics: { durationMs: 1 } };
          },
        }),
        item.expected,
      );
      assert.equal(graphCalls, 0);
    });
  }
});

test('deep equality drives authoritative pass and fail quality results', async () => {
  const evaluationSuite = suite({
    assertions: [
      {
        id: 'answer',
        name: 'Expected answer',
        outputPath: '$.result',
        operator: 'equals',
        expected: { kind: 'literal', value: ['singer'] },
        required: true,
      },
    ],
  });
  const matching = await runEvaluationSuite({
    project,
    evaluationData: data(evaluationSuite),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: ['singer'] }, metrics: { durationMs: 1 } }),
  });
  const mismatching = await runEvaluationSuite({
    project,
    evaluationData: data(evaluationSuite),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: ['dancer'] }, metrics: { durationMs: 1 } }),
  });
  const wrongType = await runEvaluationSuite({
    project,
    evaluationData: data(evaluationSuite),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'singer' }, metrics: { durationMs: 1 } }),
  });

  assert.equal(matching.qualityStatus, 'passed');
  assert.equal(matching.trials[0]?.qualityStatus, 'passed');
  assert.equal(mismatching.qualityStatus, 'failed');
  assert.equal(mismatching.trials[0]?.qualityStatus, 'failed');
  assert.equal(wrongType.qualityStatus, 'failed');
});

test('runs trials with bounded concurrency and preserves case/trial order', async () => {
  let active = 0;
  let peak = 0;
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite({ configuration: { concurrency: 2, trialCount: 2 } })),
    dataset: dataset(['one', 'two', 'three']),
    suiteId: 'suite',
    runGraph: async ({ inputs }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return { outputs: { result: inputs.input as PortableJson }, metrics: { durationMs: 4 } };
    },
  });

  assert.equal(peak, 2);
  assert.equal(result.executionStatus, 'completed');
  assert.deepEqual(
    result.trials.map((trial) => [trial.caseId, trial.trialIndex]),
    [
      ['case-0', 0],
      ['case-0', 1],
      ['case-1', 0],
      ['case-1', 1],
      ['case-2', 0],
      ['case-2', 1],
    ],
  );
});

test('rejects a bound field that has no saved case value before executing the target', async () => {
  let targetCalls = 0;
  const missingValueDataset = dataset([]);
  missingValueDataset.cases = [{ id: 'missing', name: 'Visible draft', values: {} }];

  await assert.rejects(
    runEvaluationSuite({
      project,
      evaluationData: data(suite()),
      dataset: missingValueDataset,
      suiteId: 'suite',
      runGraph: async () => {
        targetCalls += 1;
        return { outputs: {} };
      },
    }),
    /has no saved value for bound input field "Input"/u,
  );
  assert.equal(targetCalls, 0);
});

test('the shared work pool preserves work order while bounding concurrency', async () => {
  let active = 0;
  let peak = 0;
  const results = await runEvaluationWorkPool({
    work: ['first', 'second', 'third'],
    concurrency: 2,
    execute: async (value, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 6 : 1));
      active -= 1;
      return value.toUpperCase();
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(results, ['FIRST', 'SECOND', 'THIRD']);
});

test('rejects invalid persisted execution settings instead of silently changing them', async () => {
  await assert.rejects(
    runEvaluationSuite({
      project,
      evaluationData: data(suite({ configuration: { concurrency: 33, trialCount: 1 } })),
      dataset: dataset(),
      suiteId: 'suite',
      runGraph: async () => ({ outputs: {}, metrics: { durationMs: 0 } }),
    }),
    /concurrency must be a whole number from 1 to 32/,
  );
});

test('does not execute a dataset that belongs to another project', async () => {
  await assert.rejects(
    runEvaluationSuite({
      project,
      evaluationData: data(suite()),
      dataset: { ...dataset(), projectId: 'other-project' as ProjectId },
      suiteId: 'suite',
      runGraph: async () => ({ outputs: {}, metrics: { durationMs: 0 } }),
    }),
    /belongs to a different project/,
  );
});

test('marks a baseline stale when a statically configured tool handler graph changes', async () => {
  const toolProject = structuredClone(project);
  toolProject.graphs.handler = {
    metadata: { id: 'handler', name: 'Lookup' },
    nodes: [],
    connections: [],
  };
  toolProject.graphs.target!.nodes.push({
    id: 'delegate',
    type: 'delegateFunctionCall',
    data: {
      autoDelegate: false,
      handlers: [{ key: 'lookup', value: 'handler' }],
    },
  });
  const firstRun = await runEvaluationSuite({
    project: toolProject,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });
  const baseline = createEvaluationBaselineSnapshot(firstRun);
  toolProject.graphs.handler!.nodes.push({ id: 'changed-handler', type: 'text', data: { text: 'changed' } });
  const secondRun = await runEvaluationSuite({
    project: toolProject,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    baseline,
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });

  assert.equal(secondRun.qualityStatus, 'passed');
  assert.match(secondRun.warnings.join('\n'), /baseline is stale/);
});

test('marks a baseline stale when project-level knowledge configuration changes', async () => {
  const knowledgeProject = structuredClone(project);
  knowledgeProject.metadata.knowledgeStores = {
    books: {
      displayName: 'Books',
      provider: 'pinecone',
      config: { indexHost: 'first.example.test' },
    },
  };
  const firstRun = await runEvaluationSuite({
    project: knowledgeProject,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });
  const baseline = createEvaluationBaselineSnapshot(firstRun);
  knowledgeProject.metadata.knowledgeStores.books!.config = { indexHost: 'second.example.test' };
  const secondRun = await runEvaluationSuite({
    project: knowledgeProject,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    baseline,
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });

  assert.match(secondRun.warnings.join('\n'), /baseline is stale/);
});

test('provenance ignores cosmetic and retention edits but tracks material quality changes', async () => {
  const baseSuite = suite({
    description: 'Initial description',
    tags: ['initial'],
    configuration: { concurrency: 2, trialCount: 1, recordingRetention: 'failures-and-baselines' },
  });
  const renamedSuite = structuredClone(baseSuite);
  renamedSuite.name = 'Renamed suite';
  renamedSuite.description = 'Updated documentation';
  renamedSuite.tags = ['renamed'];
  renamedSuite.configuration = { ...renamedSuite.configuration, recordingRetention: 'all' };
  const changedQualitySuite = structuredClone(renamedSuite);
  changedQualitySuite.assertions[0] = {
    ...changedQualitySuite.assertions[0]!,
    operator: 'equals',
    expected: { kind: 'literal', value: { changed: true } },
  };
  const execute = (value: EvaluationSuite, purpose: 'evaluation' | 'execution-benchmark' = 'evaluation') =>
    runEvaluationSuite({
      project,
      evaluationData: data(value),
      dataset: dataset(),
      suiteId: 'suite',
      purpose,
      runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
    });

  const base = await execute(baseSuite);
  const renamed = await execute(renamedSuite);
  const changedQuality = await execute(changedQualitySuite);
  assert.equal(renamed.provenance.suiteFingerprint, base.provenance.suiteFingerprint);
  assert.notEqual(changedQuality.provenance.suiteFingerprint, base.provenance.suiteFingerprint);

  const benchmarkBase = await execute(baseSuite, 'execution-benchmark');
  const benchmarkChangedQuality = await execute(changedQualitySuite, 'execution-benchmark');
  assert.equal(benchmarkChangedQuality.provenance.suiteFingerprint, benchmarkBase.provenance.suiteFingerprint);
  assert.deepEqual(benchmarkChangedQuality.provenance.evaluatorFingerprints, {});
});

test('a target execution error fails quality, while a required evaluator error is unable to evaluate', async () => {
  const failedTarget = await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => {
      throw new Error('target unavailable');
    },
  });
  assert.equal(failedTarget.trials[0]?.executionStatus, 'error');
  assert.equal(failedTarget.trials[0]?.qualityStatus, 'failed');
  assert.equal(failedTarget.qualityStatus, 'failed');
  assert.equal(failedTarget.aggregate?.targetErrorRate, 1);

  const evaluatorError = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async ({ graphId }) => {
      if (graphId === 'evaluator') throw new Error('judge unavailable');
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });
  assert.equal(evaluatorError.trials[0]?.executionStatus, 'completed');
  assert.equal(evaluatorError.trials[0]?.qualityStatus, 'unable-to-evaluate');
  assert.equal(evaluatorError.qualityStatus, 'unable-to-evaluate');
  assert.equal(evaluatorError.aggregate?.evaluatorErrorRate, 1);
});

test('an explicit pass-rate requirement governs tolerated per-trial quality failures', async () => {
  const qualitySuite = suite({
    assertions: [
      {
        id: 'answer',
        name: 'Expected answer',
        outputPath: '$.result',
        operator: 'equals',
        expected: { kind: 'literal', value: 'ok' },
        required: true,
      },
    ],
    thresholds: [{ id: 'pass-rate', metric: 'pass-rate', operator: 'at-least', value: 0.8 }],
  });
  const options = {
    project,
    evaluationData: data(qualitySuite),
    dataset: dataset(['one', 'two', 'three', 'four', 'five']),
    suiteId: 'suite',
    runGraph: async ({ inputs }) => ({
      outputs: { result: inputs.input === 'five' ? 'wrong' : 'ok' },
      metrics: { durationMs: 1 },
    }),
  };

  const tolerated = await runEvaluationSuite(options);
  assert.equal(tolerated.aggregate?.passRate, 0.8);
  assert.equal(tolerated.aggregate?.failedTrialCount, 1);
  assert.equal(tolerated.thresholdResults[0]?.status, 'passed');
  assert.equal(tolerated.qualityStatus, 'passed');

  qualitySuite.thresholds = [{ id: 'pass-rate', metric: 'pass-rate', operator: 'at-least', value: 1 }];
  const rejected = await runEvaluationSuite(options);
  assert.equal(rejected.thresholdResults[0]?.status, 'failed');
  assert.equal(rejected.qualityStatus, 'failed');
});

test('an explicit target-error-rate requirement governs tolerated target failures', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        thresholds: [{ id: 'target-errors', metric: 'target-error-rate', operator: 'at-most', value: 0.2 }],
      }),
    ),
    dataset: dataset(['one', 'two', 'three', 'four', 'five']),
    suiteId: 'suite',
    runGraph: async ({ inputs }) => {
      if (inputs.input === 'five') throw new Error('target unavailable');
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });

  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.aggregate?.erroredTrialCount, 1);
  assert.equal(result.aggregate?.targetErrorRate, 0.2);
  assert.equal(result.thresholdResults[0]?.status, 'passed');
  assert.equal(result.qualityStatus, 'passed');
});

test('a tolerated check failure does not hide unavailable required cost evidence', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        assertions: [
          {
            id: 'answer',
            name: 'Expected answer',
            outputPath: '$.result',
            operator: 'equals',
            expected: { kind: 'literal', value: 'ok' },
            required: true,
          },
        ],
        thresholds: [
          { id: 'pass-rate', metric: 'pass-rate', operator: 'at-least', value: 0 },
          { id: 'budget', metric: 'total-cost', operator: 'at-most', value: 1 },
        ],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({
      outputs: { result: 'wrong' },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
  });

  assert.equal(result.thresholdResults[0]?.status, 'passed');
  assert.equal(result.thresholdResults[1]?.status, 'unavailable');
  assert.equal(result.qualityStatus, 'unable-to-evaluate');
});

test('weights evaluator scores in run and case aggregates, and preserves the applied weight', async () => {
  let calls = 0;
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        evaluators: [
          { id: 'strong', name: 'Strong signal', graphId: 'evaluator', scoreWeight: 3 },
          { id: 'weak', name: 'Weak signal', graphId: 'evaluator', scoreWeight: 1 },
        ],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async ({ graphId }) => {
      if (graphId === 'evaluator') {
        // The runner invokes the same evaluator graph twice; distinguish the
        // configured judges through their deterministic call sequence.
        const score = calls++ === 0 ? 0.2 : 0.8;
        return { outputs: { result: { passed: true, score } }, metrics: { durationMs: 1 } };
      }
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });

  assert.ok(Math.abs((result.aggregate?.meanScore ?? 0) - 0.35) < 1e-12);
  assert.ok(Math.abs((summarizeEvaluationRun(result)?.cases[0]?.meanScore ?? 0) - 0.35) < 1e-12);
  assert.equal(result.trials[0]?.observations.find((observation) => observation.id === 'strong')?.scoreWeight, 3);
  assert.equal(result.trials[0]?.observations.find((observation) => observation.id === 'weak')?.scoreWeight, 1);
});

test('rejects non-positive evaluator score weights', async () => {
  await assert.rejects(
    runEvaluationSuite({
      project,
      evaluationData: data(
        suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', scoreWeight: 0 }] }),
      ),
      dataset: dataset(),
      suiteId: 'suite',
      runGraph: async () => ({ outputs: {}, metrics: { durationMs: 0 } }),
    }),
    /score weight must be a positive finite number/,
  );
});

test('a target error keeps its replay artifact and physical metrics for the failed trial', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => {
      throw new EvaluationGraphExecutionError('provider unavailable', {
        metrics: { durationMs: 42, modelCallCount: 1 },
        recording: { id: 'failed-target', retention: 'temporary' },
        providerAttempts: [{ provider: 'test', outcome: 'failure' }],
      });
    },
  });

  assert.equal(result.trials[0]?.executionStatus, 'error');
  assert.equal(result.trials[0]?.qualityStatus, 'failed');
  assert.equal(result.trials[0]?.recording?.id, 'failed-target');
  assert.equal(result.trials[0]?.targetMetrics.durationMs, 42);
  assert.deepEqual(result.trials[0]?.targetProviderAttempts, [{ provider: 'test', outcome: 'failure' }]);
});

test('finalizes recording retention per trial instead of pinning every artifact after one failure', () => {
  const input: EvaluationRun = {
    version: 2,
    id: 'run',
    projectId: project.metadata.id,
    suiteId: 'suite',
    suiteName: 'Suite',
    startedAt: '2026-08-15T00:00:00.000Z',
    purpose: 'evaluation',
    executionStatus: 'completed' as const,
    qualityStatus: 'failed',
    qualityReason: { code: 'checks-failed', message: 'One quality check failed.' },
    accountingStatus: 'complete',
    provenance: {
      projectFingerprint: 'project',
      suiteFingerprint: 'suite',
      datasetFingerprint: 'dataset',
      targetFingerprint: 'target',
      evaluatorFingerprints: {},
      executionMode: 'test',
      accountingComplete: true,
    },
    aggregate: {
      trialCount: 2,
      evaluatedTrialCount: 2,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 0,
      passedTrialCount: 1,
      failedTrialCount: 1,
      erroredTrialCount: 0,
      canceledTrialCount: 0,
      passRate: 0.5,
      averageLatencyMs: 1,
      p95LatencyMs: 1,
      targetErrorRate: 0.5,
      evaluatorErrorRate: 0,
      toolFailureRate: 0,
      metrics: {},
    },
    thresholdResults: [],
    warnings: [],
    trials: [
      {
        id: 'passing',
        caseId: 'one',
        caseName: 'One',
        caseIndex: 0,
        trialIndex: 0,
        executionStatus: 'completed',
        qualityStatus: 'passed',
        qualityReason: { code: 'checks-passed', message: 'The quality check passed.' },
        inputs: {},
        expected: {},
        outputs: {},
        observations: [],
        targetMetrics: { durationMs: 1 },
        evaluatorMetrics: { durationMs: 0 },
        totalMetrics: { durationMs: 1 },
        recording: { id: 'passing-recording', retention: 'temporary' as const },
      },
      {
        id: 'failing',
        caseId: 'two',
        caseName: 'Two',
        caseIndex: 1,
        trialIndex: 0,
        executionStatus: 'completed',
        qualityStatus: 'failed',
        qualityReason: { code: 'checks-failed', message: 'The quality check failed.' },
        inputs: {},
        expected: {},
        outputs: {},
        observations: [
          {
            id: 'failed-assertion',
            kind: 'assertion',
            name: 'Expected output',
            status: 'failed',
            required: true,
          },
        ],
        targetMetrics: { durationMs: 1 },
        evaluatorMetrics: { durationMs: 0 },
        totalMetrics: { durationMs: 1 },
        recording: { id: 'failing-recording', retention: 'temporary' as const },
      },
    ],
  };

  const finalized = finalizeEvaluationRecordingRetention(
    input,
    'failures-and-baselines',
    Date.parse('2026-08-15T00:00:00.000Z'),
  );
  assert.deepEqual(
    finalized.trials.map((trial) => trial.recording?.retention),
    ['temporary', 'failure'],
  );
  assert.equal(finalized.trials[0]?.recording?.expiresAt, '2026-08-16T00:00:00.000Z');
  assert.equal(finalized.trials[1]?.recording?.expiresAt, undefined);
});

test('does not permit an interrupted run to become an evaluation baseline', () => {
  assert.throws(
    () =>
      createEvaluationBaselineSnapshot({
        version: 2,
        id: 'canceled-run',
        projectId: project.metadata.id,
        suiteId: 'suite',
        suiteName: 'Suite',
        startedAt: '2026-08-15T00:00:00.000Z',
        purpose: 'evaluation',
        executionStatus: 'canceled',
        qualityStatus: 'not-evaluated',
        qualityReason: { code: 'canceled', message: 'The run was canceled.' },
        accountingStatus: 'complete',
        provenance: {
          projectFingerprint: 'project',
          suiteFingerprint: 'suite',
          datasetFingerprint: 'dataset',
          targetFingerprint: 'target',
          evaluatorFingerprints: {},
          executionMode: 'test',
          accountingComplete: true,
        },
        aggregate: {
          trialCount: 0,
          evaluatedTrialCount: 0,
          notEvaluatedTrialCount: 0,
          unableToEvaluateTrialCount: 0,
          passedTrialCount: 0,
          failedTrialCount: 0,
          erroredTrialCount: 0,
          canceledTrialCount: 0,
          passRate: 0,
          averageLatencyMs: 0,
          p95LatencyMs: 0,
          targetErrorRate: 0,
          evaluatorErrorRate: 0,
          toolFailureRate: 0,
          metrics: {},
        },
        thresholdResults: [],
        trials: [],
        warnings: [],
      }),
    /Only a completed evaluation run/,
  );
});

test('a failed evaluator still contributes its physical accounting to the trial', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }] })),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async ({ graphId }) => {
      if (graphId === 'evaluator') {
        throw new EvaluationGraphExecutionError('judge provider failed', {
          metrics: { durationMs: 17, modelCallCount: 1, costUsd: 0.004 },
        });
      }
      return { outputs: { result: 'ok' }, metrics: { durationMs: 3 } };
    },
  });

  assert.equal(result.trials[0]?.qualityStatus, 'unable-to-evaluate');
  assert.equal(result.trials[0]?.evaluatorMetrics.costUsd, 0.004);
  assert.equal(result.trials[0]?.totalMetrics.durationMs, 20);
});

test('an invalid evaluator result retains its own diagnostics and replay without pinning the target', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }] })),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async ({ graphId }) =>
      graphId === 'evaluator'
        ? {
            outputs: { result: { passed: true, message: 7 } },
            metrics: { durationMs: 9, costUsd: 0.003 },
            recording: { id: 'evaluator-recording', retention: 'temporary' },
            providerAttempts: [{ provider: 'judge', outcome: 'success' }],
          }
        : {
            outputs: { result: 'ok' },
            metrics: { durationMs: 2 },
            recording: { id: 'target-recording', retention: 'temporary' },
          },
  });

  const observation = result.trials[0]?.observations.find((item) => item.id === 'judge');
  assert.equal(result.trials[0]?.qualityStatus, 'unable-to-evaluate');
  assert.equal(observation?.status, 'error');
  assert.match(observation?.message ?? '', /result\.message.*string/u);
  assert.equal(observation?.costUsd, 0.003);
  assert.equal(observation?.recording?.id, 'evaluator-recording');
  assert.deepEqual(observation?.providerAttempts, [{ provider: 'judge', outcome: 'success' }]);

  const finalized = finalizeEvaluationRecordingRetention(result);
  assert.equal(finalized.trials[0]?.recording?.retention, 'temporary');
  assert.equal(finalized.trials[0]?.observations.find((item) => item.id === 'judge')?.recording?.retention, 'failure');
});

test('an evaluator timeout contributes elapsed latency even without adapter metrics', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }],
        configuration: { concurrency: 1, trialCount: 1, timeoutMs: 15 },
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async ({ graphId }) => {
      if (graphId === 'target') return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
      return new Promise<never>(() => undefined);
    },
  });

  assert.equal(result.trials[0]?.qualityStatus, 'unable-to-evaluate');
  assert.ok((result.trials[0]?.evaluatorMetrics.durationMs ?? 0) >= 10);
  assert.ok((result.trials[0]?.totalMetrics.durationMs ?? 0) >= 11);
});

test('a required assertion error is unable to evaluate rather than a false pass', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        assertions: [
          {
            id: 'invalid-regex',
            name: 'Invalid regex',
            outputPath: '$.result',
            operator: 'matches-regex',
            expected: { kind: 'literal', value: '[' },
            required: true,
          },
        ],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });
  assert.equal(result.trials[0]?.executionStatus, 'completed');
  assert.equal(result.trials[0]?.qualityStatus, 'unable-to-evaluate');
  assert.equal(result.qualityStatus, 'unable-to-evaluate');
});

test('a relative baseline threshold is unable to evaluate when no compatible baseline exists', async () => {
  const currentSuite = suite({
    thresholds: [{ id: 'regression', metric: 'average-latency-ms', operator: 'max-regression', value: 0.1 }],
  });
  const baselineData = data(currentSuite);
  baselineData.baselines = [
    {
      id: 'old',
      suiteId: 'suite',
      createdAt: new Date().toISOString(),
      provenance: {
        projectFingerprint: 'old',
        suiteFingerprint: 'old',
        datasetFingerprint: 'old',
        targetFingerprint: 'old',
        evaluatorFingerprints: {},
        executionMode: 'browser',
        accountingComplete: true,
      },
      aggregate: {
        trialCount: 1,
        passedTrialCount: 1,
        failedTrialCount: 0,
        erroredTrialCount: 0,
        canceledTrialCount: 0,
        passRate: 1,
        averageLatencyMs: 1,
        p95LatencyMs: 1,
        targetErrorRate: 0,
        evaluatorErrorRate: 0,
        toolFailureRate: 0,
        metrics: {},
      },
      cases: [],
    },
  ];
  const result = await runEvaluationSuite({
    project,
    evaluationData: baselineData,
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });
  assert.equal(result.qualityStatus, 'unable-to-evaluate');
  assert.match(result.warnings.join('\n'), /baseline is stale/);
});

test('a cost regression threshold rejects a compatible baseline with partial accounting', async () => {
  const costSuite = suite({
    thresholds: [{ id: 'cost-regression', metric: 'total-cost', operator: 'max-regression', value: 0.1 }],
  });
  const execute = (baseline?: ReturnType<typeof createEvaluationBaselineSnapshot>) =>
    runEvaluationSuite({
      project,
      evaluationData: data(costSuite),
      dataset: dataset(),
      suiteId: 'suite',
      ...(baseline === undefined ? {} : { baseline }),
      runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1, costUsd: 0.01 } }),
    });
  const initial = await execute();
  const baseline = createEvaluationBaselineSnapshot(initial);
  baseline.accountingStatus = 'partial';
  baseline.provenance.accountingComplete = false;
  baseline.aggregate.totalCostUsd = 0.01;
  baseline.aggregate.averageCostUsd = 0.01;

  const result = await execute(baseline);
  assert.equal(result.qualityStatus, 'unable-to-evaluate');
  assert.equal(result.thresholdResults[0]?.status, 'unavailable');
  assert.match(result.thresholdResults[0]?.message ?? '', /baseline.*partial accounting.*pricing/iu);
});

test('unknown provider cost keeps a passing quality result while marking accounting partial', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({
      outputs: { result: 'ok' },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
  });

  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.qualityStatus, 'passed');
  assert.equal(result.accountingStatus, 'partial');
  assert.equal(result.provenance.accountingComplete, false);
  assert.equal(result.aggregate?.totalCostUsd, undefined);
  assert.equal(result.aggregate?.averageCostUsd, undefined);
  assert.match(result.warnings.join('\n'), /provider pricing was unavailable/);
});

test('a failing assertion remains failed when provider pricing is unknown', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        assertions: [
          {
            id: 'expected-result',
            name: 'Expected result',
            outputPath: '$.result',
            operator: 'equals',
            expected: { kind: 'literal', value: 'expected' },
            required: true,
          },
        ],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({
      outputs: { result: 'different' },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
  });

  assert.equal(result.qualityStatus, 'failed');
  assert.equal(result.accountingStatus, 'partial');
});

test('unknown provider cost makes a configured cost requirement unable to evaluate', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({ thresholds: [{ id: 'budget', metric: 'total-cost', operator: 'at-most', value: 0.01 }] }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({
      outputs: { result: 'ok' },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
  });

  assert.equal(result.qualityStatus, 'unable-to-evaluate');
  assert.equal(result.accountingStatus, 'partial');
  assert.equal(result.thresholdResults[0]?.status, 'unavailable');
  assert.match(result.thresholdResults[0]?.message ?? '', /provider pricing was unavailable/);
});

test('unknown provider cost does not block a non-cost latency requirement', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({ thresholds: [{ id: 'latency', metric: 'average-latency-ms', operator: 'at-most', value: 5 }] }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({
      outputs: { result: 'ok' },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
  });

  assert.equal(result.qualityStatus, 'passed');
  assert.equal(result.accountingStatus, 'partial');
  assert.equal(result.thresholdResults[0]?.status, 'passed');
});

test('a quality failure dominates an unavailable cost requirement', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        assertions: [
          {
            id: 'expected-result',
            name: 'Expected result',
            outputPath: '$.result',
            operator: 'equals',
            expected: { kind: 'literal', value: 'expected' },
            required: true,
          },
        ],
        thresholds: [{ id: 'budget', metric: 'total-cost', operator: 'at-most', value: 0.01 }],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({
      outputs: { result: 'different' },
      metrics: { durationMs: 1, hasUnknownCost: true },
    }),
  });

  assert.equal(result.qualityStatus, 'failed');
  assert.equal(result.thresholdResults[0]?.status, 'unavailable');
});

test('cancellation stops a trial even when a target adapter does not honour its AbortSignal', async () => {
  const controller = new AbortController();
  const pending = runEvaluationSuite({
    project,
    evaluationData: data(suite({ configuration: { concurrency: 1, trialCount: 1 } })),
    dataset: dataset(),
    suiteId: 'suite',
    signal: controller.signal,
    // Deliberately ignore the signal: the runner itself must still settle the
    // evaluation so cancellation cannot leave the worker pool stuck forever.
    runGraph: async () => new Promise(() => undefined),
  });
  setTimeout(() => controller.abort(new DOMException('Canceled by test.', 'AbortError')), 5);
  const result = await pending;
  assert.equal(result.executionStatus, 'canceled');
  assert.equal(result.trials[0]?.qualityStatus, 'not-evaluated');
});

test('cancellation leaves queued cases unstarted while preserving the active trial result', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = runEvaluationSuite({
    project,
    evaluationData: data(suite({ configuration: { concurrency: 1, trialCount: 1 } })),
    dataset: dataset(['one', 'two', 'three']),
    suiteId: 'suite',
    signal: controller.signal,
    runGraph: async ({ signal }) => {
      calls += 1;
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw signal?.reason ?? new DOMException('Canceled', 'AbortError');
    },
  });
  setTimeout(() => controller.abort(new DOMException('Canceled by test.', 'AbortError')), 5);
  const result = await pending;

  assert.equal(result.executionStatus, 'canceled');
  assert.equal(calls, 1);
  assert.equal(result.trials.length, 1);
  assert.equal(result.trials[0]?.qualityStatus, 'not-evaluated');
});

test('cancellation during an evaluator preserves incurred target cost while marking accounting partial', async () => {
  const controller = new AbortController();
  let notifyEvaluatorStarted: (() => void) | undefined;
  const evaluatorStarted = new Promise<void>((resolve) => {
    notifyEvaluatorStarted = resolve;
  });
  const pending = runEvaluationSuite({
    project,
    evaluationData: data(suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }] })),
    dataset: dataset(),
    suiteId: 'suite',
    signal: controller.signal,
    runGraph: async ({ graphId, signal }) => {
      if (graphId === 'target') {
        return { outputs: { result: 'ok' }, metrics: { durationMs: 4, costUsd: 0.01, modelCallCount: 1 } };
      }
      notifyEvaluatorStarted?.();
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      throw new Error('unreachable');
    },
  });
  await evaluatorStarted;
  controller.abort(new DOMException('Canceled by test.', 'AbortError'));
  const result = await pending;

  assert.equal(result.executionStatus, 'canceled');
  assert.equal(result.accountingStatus, 'partial');
  assert.equal(result.trials[0]?.targetMetrics.costUsd, 0.01);
  assert.equal(result.trials[0]?.totalMetrics.costUsd, 0.01);
  assert.equal(result.trials[0]?.totalMetrics.hasUnknownCost, true);
  assert.equal(result.aggregate?.totalCostUsd, undefined);
  assert.equal(result.aggregate?.averageCostUsd, undefined);
});

test('a seed input cannot silently replace a case-bound target input', async () => {
  const seededProject = structuredClone(project);
  (seededProject.graphs.target!.nodes[0] as { data: { dataType: string } }).data.dataType = 'number';
  const seededDataset = dataset();
  seededDataset.fields[0]!.dataType = 'number';
  seededDataset.cases[0]!.values.input = 1;
  await assert.rejects(
    runEvaluationSuite({
      project: seededProject,
      evaluationData: data(suite({ configuration: { seed: 7, seedGraphInputId: 'input' } })),
      dataset: seededDataset,
      suiteId: 'suite',
      runGraph: async () => ({ outputs: {}, metrics: { durationMs: 1 } }),
    }),
    /cannot also be bound to a dataset field/,
  );
});

test('derives trial seeds from stable case ids rather than case order or subset position', async () => {
  const seededProject = structuredClone(project);
  seededProject.graphs.target!.nodes.push({
    id: 'seed-node',
    type: 'graphInput',
    data: { id: 'seed', dataType: 'number', defaultValue: 0 },
  } as never);
  const seededSuite = suite({
    configuration: { seed: 314159, seedGraphInputId: 'seed', trialCount: 2, concurrency: 1 },
  });
  const seededDataset = dataset(['one', 'two']);

  const collect = async (cases: EvaluationDataset['cases'], selectedCaseIds?: readonly string[]) => {
    const seen = new Map<string, number[]>();
    const options = {
      project: seededProject,
      evaluationData: data(seededSuite),
      dataset: { ...seededDataset, cases },
      suiteId: 'suite',
      runGraph: async ({ inputs, metadata }: Parameters<EvaluationGraphRunner>[0]) => {
        const values = seen.get(metadata.caseId) ?? [];
        values[metadata.trialIndex] = inputs.seed as number;
        seen.set(metadata.caseId, values);
        return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
      },
    };
    if (selectedCaseIds) await runEvaluationCases({ ...options, caseIds: selectedCaseIds });
    else await runEvaluationSuite(options);
    return seen;
  };

  const ordered = await collect(seededDataset.cases);
  const reordered = await collect([...seededDataset.cases].reverse());
  const subset = await collect(seededDataset.cases, ['case-1']);
  assert.deepEqual(reordered.get('case-0'), ordered.get('case-0'));
  assert.deepEqual(reordered.get('case-1'), ordered.get('case-1'));
  assert.deepEqual(subset.get('case-1'), ordered.get('case-1'));
});

test('publishes the running shell before the first target graph starts', async () => {
  let published = false;
  const updates: EvaluationRun[] = [];
  await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: dataset(),
    suiteId: 'suite',
    onUpdate: (run) => {
      published = true;
      updates.push(run);
    },
    runGraph: async () => {
      assert.equal(published, true);
      assert.equal(updates[0]?.executionStatus, 'running');
      assert.deepEqual(updates[0]?.trials, []);
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });
});

test('labels target and evaluator invocations with stable evaluation metadata', async () => {
  const calls: Array<{
    graphId: string;
    phase: string;
    evaluationRunId: string;
    suiteId: string;
    caseId: string;
    trialIndex: number;
  }> = [];
  await runEvaluationSuite({
    project,
    evaluationData: data(suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }] })),
    dataset: dataset(),
    suiteId: 'suite',
    runId: 'run-42',
    runGraph: async ({ graphId, metadata }) => {
      calls.push({ graphId, ...metadata });
      return graphId === 'evaluator'
        ? { outputs: { result: { passed: true } }, metrics: { durationMs: 1 } }
        : { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });
  assert.deepEqual(calls, [
    {
      graphId: 'target',
      evaluationRunId: 'run-42',
      suiteId: 'suite',
      caseId: 'case-0',
      trialIndex: 0,
      phase: 'target',
    },
    {
      graphId: 'evaluator',
      evaluationRunId: 'run-42',
      suiteId: 'suite',
      caseId: 'case-0',
      trialIndex: 0,
      phase: 'evaluator',
    },
  ]);
});

test('gives evaluator graphs a portable case snapshot, including identity and metadata', async () => {
  const evaluatedDataset = dataset();
  evaluatedDataset.cases[0] = {
    ...evaluatedDataset.cases[0]!,
    tags: ['regression'],
    note: 'Keep this behavior stable.',
  };
  let evaluatorCase: PortableJson | undefined;
  await runEvaluationSuite({
    project,
    evaluationData: data(suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator' }] })),
    dataset: evaluatedDataset,
    suiteId: 'suite',
    runGraph: async ({ graphId, inputs }) => {
      if (graphId === 'evaluator') {
        evaluatorCase = inputs.case;
        return { outputs: { result: { passed: true } }, metrics: { durationMs: 1 } };
      }
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });
  assert.deepEqual(evaluatorCase, {
    id: 'case-0',
    name: 'Case 0',
    enabled: true,
    tags: ['regression'],
    note: 'Keep this behavior stable.',
    values: { input: 'one' },
  });
});

test('isolates concurrent graph adapters from mutable dataset and evaluator values', async () => {
  const evaluatedDataset = dataset(['one']);
  let targetInput: Record<string, PortableJson> | undefined;
  let evaluatorInput: Record<string, PortableJson> | undefined;
  await runEvaluationSuite({
    project,
    evaluationData: data(suite({ evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator' }] })),
    dataset: evaluatedDataset,
    suiteId: 'suite',
    runGraph: async ({ graphId, inputs }) => {
      if (graphId === 'evaluator') {
        evaluatorInput = inputs;
        const caseValue = inputs.case as { values: Record<string, PortableJson> };
        caseValue.values.input = 'mutated by evaluator';
        return { outputs: { result: { passed: true } }, metrics: { durationMs: 1 } };
      }
      targetInput = inputs;
      inputs.input = 'mutated by target';
      return { outputs: { result: 'ok' }, metrics: { durationMs: 1 } };
    },
  });

  assert.equal(evaluatedDataset.cases[0]?.values.input, 'one');
  assert.equal(targetInput?.input, 'mutated by target');
  assert.equal((evaluatorInput?.case as { values: Record<string, PortableJson> }).values.input, 'mutated by evaluator');
});

test('averages custom evaluator metrics before applying a custom threshold', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        evaluators: [{ id: 'judge', name: 'Judge', graphId: 'evaluator', required: true }],
        thresholds: [{ id: 'groundedness', metric: 'custom:groundedness', operator: 'at-least', value: 0.8 }],
      }),
    ),
    dataset: dataset(['one', 'two']),
    suiteId: 'suite',
    runGraph: async ({ graphId, inputs }) =>
      graphId === 'evaluator'
        ? {
            outputs: {
              result: {
                passed: true,
                metrics: {
                  groundedness:
                    inputs.case &&
                    typeof inputs.case === 'object' &&
                    !Array.isArray(inputs.case) &&
                    inputs.case.id === 'case-0'
                      ? 1
                      : 0.6,
                },
              },
            },
            metrics: { durationMs: 1 },
          }
        : { outputs: { result: 'ok' }, metrics: { durationMs: 1 } },
  });

  assert.equal(result.aggregate?.metrics.groundedness, 0.8);
  assert.deepEqual(
    summarizeEvaluationRun(result)?.cases.map(({ caseId, metrics }) => ({ caseId, metrics })),
    [
      { caseId: 'case-0', metrics: { groundedness: 1 } },
      { caseId: 'case-1', metrics: { groundedness: 0.6 } },
    ],
  );
  assert.equal(result.qualityStatus, 'passed');
});

test('counts known zero-cost trials in cost aggregates and thresholds', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        thresholds: [{ id: 'free', metric: 'average-cost', operator: 'at-most', value: 0 }],
      }),
    ),
    dataset: dataset(['one', 'two']),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });

  assert.equal(result.aggregate?.totalCostUsd, 0);
  assert.equal(result.aggregate?.averageCostUsd, 0);
  assert.equal(result.qualityStatus, 'passed');
});

test('a threshold-only suite passes overall while its trial quality stays not evaluated', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(
      suite({
        assertions: [],
        evaluators: [],
        thresholds: [{ id: 'latency', metric: 'average-latency-ms', operator: 'at-most', value: 5 }],
      }),
    ),
    dataset: dataset(),
    suiteId: 'suite',
    runGraph: async () => ({ outputs: { result: 'ok' }, metrics: { durationMs: 1 } }),
  });

  assert.equal(result.trials[0]?.executionStatus, 'completed');
  assert.equal(result.trials[0]?.qualityStatus, 'not-evaluated');
  assert.equal(result.qualityStatus, 'passed');
  assert.equal(result.thresholdResults[0]?.status, 'passed');
});

test('averages known trial cost across priced and zero-cost trials', async () => {
  const result = await runEvaluationSuite({
    project,
    evaluationData: data(suite()),
    dataset: dataset(['paid', 'free']),
    suiteId: 'suite',
    runGraph: async ({ inputs }) => ({
      outputs: { result: 'ok' },
      metrics: { durationMs: 1, ...(inputs.input === 'paid' ? { costUsd: 0.01 } : {}) },
    }),
  });

  assert.equal(result.aggregate?.totalCostUsd, 0.01);
  assert.equal(result.aggregate?.averageCostUsd, 0.005);
});

test('pass rate excludes execution errors, not-evaluated, unable, and canceled trials', () => {
  const trials = [
    trial('passed', 'completed', 'passed'),
    trial('failed', 'completed', 'failed'),
    trial('target-error', 'error', 'failed'),
    trial('not-evaluated', 'completed', 'not-evaluated'),
    trial('unable', 'completed', 'unable-to-evaluate'),
    trial('canceled', 'canceled', 'not-evaluated'),
  ];
  const run: EvaluationRun = {
    version: 2,
    id: 'mixed-run',
    projectId: project.metadata.id,
    suiteId: 'suite',
    suiteName: 'Suite',
    startedAt: '2026-08-15T00:00:00.000Z',
    purpose: 'evaluation',
    executionStatus: 'completed',
    qualityStatus: 'failed',
    qualityReason: { code: 'checks-failed', message: 'Mixed run.' },
    accountingStatus: 'complete',
    provenance: {
      projectFingerprint: 'project',
      suiteFingerprint: 'suite',
      datasetFingerprint: 'dataset',
      targetFingerprint: 'target',
      evaluatorFingerprints: {},
      executionMode: 'test',
      accountingComplete: true,
    },
    aggregate: {
      trialCount: 0,
      evaluatedTrialCount: 0,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 0,
      passedTrialCount: 0,
      failedTrialCount: 0,
      erroredTrialCount: 0,
      canceledTrialCount: 0,
      passRate: 0,
      averageLatencyMs: 0,
      p95LatencyMs: 0,
      targetErrorRate: 0,
      evaluatorErrorRate: 0,
      toolFailureRate: 0,
      metrics: {},
    },
    thresholdResults: [],
    trials,
    warnings: [],
  };

  const summary = summarizeEvaluationRun(run);
  assert.equal(summary?.aggregate.evaluatedTrialCount, 2);
  assert.equal(summary?.aggregate.passedTrialCount, 1);
  assert.equal(summary?.aggregate.failedTrialCount, 1);
  assert.equal(summary?.aggregate.erroredTrialCount, 1);
  assert.equal(summary?.aggregate.notEvaluatedTrialCount, 1);
  assert.equal(summary?.aggregate.unableToEvaluateTrialCount, 1);
  assert.equal(summary?.aggregate.canceledTrialCount, 1);
  assert.equal(summary?.aggregate.passRate, 0.5);
  const notEvaluatedCase = summary?.cases.find((item) => item.caseId === 'not-evaluated');
  assert.equal(notEvaluatedCase?.passRate, undefined);
  assert.equal(notEvaluatedCase?.evaluatedTrialCount, 0);
  assert.equal(notEvaluatedCase?.notEvaluatedTrialCount, 1);
  const passedCase = summary?.cases.find((item) => item.caseId === 'passed');
  assert.equal(passedCase?.passRate, 1);
  assert.equal(passedCase?.passedTrialCount, 1);
});
