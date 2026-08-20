import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type {
  EvaluationDatasetSnapshot,
  EvaluationProjectData,
  EvaluationRecordingArtifact,
  EvaluationRun,
} from '../src/index.js';
import {
  deserializeEvaluationProjectData,
  fingerprintEvaluationDataset,
  InMemoryEvaluationRunStore,
  normalizeEvaluationBaselineSnapshot,
  normalizeEvaluationRun,
  normalizeEvaluationTrial,
  serializeEvaluationProjectData,
} from '../src/index.js';

function run(revision: number, status: EvaluationRun['executionStatus']): EvaluationRun {
  return {
    version: 2,
    id: 'run',
    projectId: 'project' as ProjectId,
    suiteId: 'suite',
    suiteName: 'Suite',
    revision,
    startedAt: '2026-08-15T00:00:00.000Z',
    purpose: 'evaluation',
    executionStatus: status,
    qualityStatus: 'not-evaluated',
    qualityReason: { code: 'no-trial-quality-checks', message: 'No quality checks evaluated this run.' },
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
    thresholdResults: [],
    trials: [],
    warnings: [],
  };
}

test('in-memory run stores normalize an unchecked legacy pass as not evaluated', async () => {
  const store = new InMemoryEvaluationRunStore();
  const legacy = structuredClone(run(1, 'completed')) as unknown as Record<string, unknown>;
  delete legacy.version;
  delete legacy.purpose;
  delete legacy.qualityStatus;
  delete legacy.qualityReason;
  delete legacy.accountingStatus;
  delete legacy.thresholdResults;
  legacy.verdict = 'pass';
  legacy.trials = [
    {
      id: 'legacy-trial',
      caseId: 'case',
      caseName: 'Case',
      caseIndex: 0,
      trialIndex: 0,
      status: 'passed',
      inputs: {},
      expected: {},
      outputs: { result: 'completed without a quality check' },
      observations: [],
      targetMetrics: { durationMs: 1 },
      evaluatorMetrics: { durationMs: 0 },
      totalMetrics: { durationMs: 1 },
    },
  ];
  await store.put(legacy as unknown as EvaluationRun);

  const stored = await store.get({ projectId: 'project' as ProjectId, runId: 'run' });
  assert.equal(stored?.version, 2);
  assert.equal(stored?.purpose, 'evaluation');
  assert.equal(stored?.qualityStatus, 'not-evaluated');
  assert.equal(stored?.accountingStatus, 'complete');
  assert.deepEqual(stored?.thresholdResults, []);
  assert.equal('verdict' in (stored ?? {}), false);
  assert.equal(stored?.trials[0]?.executionStatus, 'completed');
  assert.equal(stored?.trials[0]?.qualityStatus, 'not-evaluated');
  assert.equal('status' in (stored?.trials[0] ?? {}), false);
});

test('normalization replaces quality reasons that contradict normalized purpose or status', () => {
  const benchmark = run(1, 'completed');
  benchmark.purpose = 'execution-benchmark';
  benchmark.qualityStatus = 'passed';
  benchmark.qualityReason = { code: 'checks-passed', message: 'Contradictory stored reason.' };
  const normalizedBenchmark = normalizeEvaluationRun(benchmark);
  assert.equal(normalizedBenchmark.qualityStatus, 'not-evaluated');
  assert.equal(normalizedBenchmark.qualityReason.code, 'benchmark');

  const canceled = run(1, 'canceled');
  canceled.qualityStatus = 'passed';
  canceled.qualityReason = { code: 'checks-passed', message: 'Contradictory stored reason.' };
  const normalizedCanceled = normalizeEvaluationRun(canceled);
  assert.equal(normalizedCanceled.qualityStatus, 'not-evaluated');
  assert.equal(normalizedCanceled.qualityReason.code, 'canceled');

  const trial = normalizeEvaluationTrial(
    {
      id: 'trial',
      caseId: 'case',
      caseName: 'Case',
      caseIndex: 0,
      trialIndex: 0,
      executionStatus: 'completed',
      qualityStatus: 'passed',
      qualityReason: { code: 'checks-passed', message: 'Contradictory stored reason.' },
      inputs: {},
      expected: {},
      outputs: {},
      observations: [],
      targetMetrics: { durationMs: 1 },
      evaluatorMetrics: { durationMs: 0 },
      totalMetrics: { durationMs: 1 },
    },
    'execution-benchmark',
  );
  assert.equal(trial.qualityStatus, 'not-evaluated');
  assert.equal(trial.qualityReason.code, 'benchmark');
});

test('scoring trial normalization never revives a pass/fail quality label', () => {
  const normalized = normalizeEvaluationTrial(
    {
      id: 'trial',
      caseId: 'case',
      caseName: 'Case',
      caseIndex: 0,
      trialIndex: 0,
      executionStatus: 'completed',
      qualityStatus: 'passed',
      qualityReason: { code: 'checks-passed', message: 'Legacy pass/fail result.' },
      inputs: {},
      expected: {},
      outputs: {},
      observations: [
        {
          id: 'judge',
          kind: 'graph',
          name: 'Judge',
          required: false,
          status: 'scored',
          score: 0.85,
        },
      ],
      targetMetrics: { durationMs: 1 },
      evaluatorMetrics: { durationMs: 1 },
      totalMetrics: { durationMs: 2 },
    },
    'evaluation',
    'scoring',
  );

  assert.equal(normalized.qualityStatus, 'scored');
  assert.equal(normalized.qualityReason.code, 'scores-complete');
});

test('scoring run normalization derives completion from trial evidence instead of a stored scored label', () => {
  const scoringRun = run(1, 'completed');
  scoringRun.evaluationMode = 'scoring';
  scoringRun.qualityStatus = 'scored';
  scoringRun.qualityReason = { code: 'scores-complete', message: 'Contradictory stored score.' };
  scoringRun.trials = [
    {
      id: 'trial',
      caseId: 'case',
      caseName: 'Case',
      caseIndex: 0,
      trialIndex: 0,
      executionStatus: 'completed',
      qualityStatus: 'scored',
      qualityReason: { code: 'scores-complete', message: 'Contradictory stored score.' },
      inputs: {},
      expected: {},
      outputs: {},
      observations: [
        {
          id: 'judge',
          kind: 'graph',
          name: 'Judge',
          required: true,
          status: 'error',
          message: 'Judge did not return a score.',
        },
      ],
      targetMetrics: { durationMs: 1 },
      evaluatorMetrics: { durationMs: 1 },
      totalMetrics: { durationMs: 2 },
    },
  ];

  const normalized = normalizeEvaluationRun(scoringRun);
  assert.equal(normalized.trials[0]?.qualityStatus, 'unable-to-evaluate');
  assert.equal(normalized.qualityStatus, 'unable-to-evaluate');
  assert.equal(normalized.qualityReason.code, 'scores-incomplete');
});

test('scoring run normalization drops a graph-facing score from stored aggregates', () => {
  const scoringRun = run(1, 'completed');
  scoringRun.evaluationMode = 'scoring';
  scoringRun.qualityStatus = 'scored';
  scoringRun.qualityReason = { code: 'scores-complete', message: 'Stored on the wrong score scale.' };
  scoringRun.trials = [
    {
      id: 'trial',
      caseId: 'case',
      caseName: 'Case',
      caseIndex: 0,
      trialIndex: 0,
      executionStatus: 'completed',
      qualityStatus: 'scored',
      qualityReason: { code: 'scores-complete', message: 'Stored on the wrong score scale.' },
      inputs: {},
      expected: {},
      outputs: {},
      observations: [
        {
          id: 'judge',
          kind: 'graph',
          name: 'Judge',
          required: true,
          status: 'scored',
          score: 85,
        },
      ],
      targetMetrics: { durationMs: 1 },
      evaluatorMetrics: { durationMs: 1 },
      totalMetrics: { durationMs: 2 },
    },
  ];
  scoringRun.aggregate = {
    trialCount: 1,
    evaluatedTrialCount: 0,
    notEvaluatedTrialCount: 0,
    unableToEvaluateTrialCount: 0,
    passedTrialCount: 0,
    failedTrialCount: 0,
    erroredTrialCount: 0,
    canceledTrialCount: 0,
    scoredTrialCount: 1,
    missingScoreTrialCount: 0,
    passRate: 0,
    meanScore: 85,
    averageLatencyMs: 2,
    p95LatencyMs: 2,
    targetErrorRate: 0,
    evaluatorErrorRate: 0,
    toolFailureRate: 0,
    metrics: {},
  };

  const normalized = normalizeEvaluationRun(scoringRun);
  assert.equal(normalized.qualityStatus, 'unable-to-evaluate');
  assert.equal(normalized.aggregate?.meanScore, undefined);
  assert.equal(normalized.aggregate?.scoredTrialCount, 0);
  assert.equal(normalized.aggregate?.missingScoreTrialCount, 1);
});

test('baseline normalization replaces contradictory benchmark quality metadata', () => {
  const completed = run(1, 'completed');
  const normalized = normalizeEvaluationBaselineSnapshot({
    id: 'baseline',
    suiteId: 'suite',
    createdAt: completed.startedAt,
    purpose: 'execution-benchmark',
    qualityStatus: 'passed',
    qualityReason: { code: 'checks-passed', message: 'Contradictory stored reason.' },
    accountingStatus: 'complete',
    provenance: completed.provenance,
    aggregate: {
      trialCount: 1,
      evaluatedTrialCount: 1,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 0,
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
  });
  assert.equal(normalized.qualityStatus, 'not-evaluated');
  assert.equal(normalized.qualityReason?.code, 'benchmark');
});

test('scoring baseline normalization requires complete score coverage', () => {
  const completed = run(1, 'completed');
  const normalized = normalizeEvaluationBaselineSnapshot({
    id: 'baseline',
    suiteId: 'suite',
    createdAt: completed.startedAt,
    purpose: 'evaluation',
    evaluationMode: 'scoring',
    qualityStatus: 'scored',
    qualityReason: { code: 'scores-complete', message: 'Contradictory stored score.' },
    accountingStatus: 'complete',
    provenance: completed.provenance,
    aggregate: {
      trialCount: 2,
      evaluatedTrialCount: 0,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 1,
      passedTrialCount: 0,
      failedTrialCount: 0,
      erroredTrialCount: 0,
      canceledTrialCount: 0,
      scoredTrialCount: 1,
      missingScoreTrialCount: 1,
      passRate: 0,
      meanScore: 0.8,
      averageLatencyMs: 1,
      p95LatencyMs: 1,
      targetErrorRate: 0,
      evaluatorErrorRate: 1,
      toolFailureRate: 0,
      metrics: {},
    },
    cases: [],
  });
  assert.equal(normalized.qualityStatus, 'unable-to-evaluate');
  assert.equal(normalized.qualityReason?.code, 'scores-incomplete');
});

test('project deserialization rejects malformed suite and baseline entries at the read boundary', () => {
  assert.throws(
    () => deserializeEvaluationProjectData({ version: 1, suites: [5], baselines: [] }),
    /evaluations\.suites\[0\] must be an object/,
  );
  assert.throws(
    () =>
      deserializeEvaluationProjectData({
        version: 1,
        suites: [{ id: 'suite', name: 'Suite', targetGraphId: 'graph', datasetId: 'dataset' }],
        baselines: [],
      }),
    /inputBindings must be an array/,
  );
  assert.throws(
    () => deserializeEvaluationProjectData({ version: 1, suites: [], baselines: [false] }),
    /evaluations\.baselines\[0\] must be an object/,
  );
  assert.throws(
    () =>
      deserializeEvaluationProjectData({
        version: 1,
        suites: [
          {
            id: 'suite',
            name: 'Suite',
            targetGraphId: 'graph',
            datasetId: 'dataset',
            inputBindings: [],
            assertions: [],
            evaluators: [],
            evaluationMode: 'numeric',
          },
        ],
        baselines: [],
      }),
    /evaluationMode must be "pass-fail" or "scoring"/,
  );
  assert.throws(
    () =>
      deserializeEvaluationProjectData({
        version: 1,
        suites: [
          {
            id: 'suite',
            name: 'Suite',
            targetGraphId: 'graph',
            datasetId: 'dataset',
            inputBindings: [],
            assertions: [],
            evaluators: [
              {
                id: 'judge',
                name: 'Judge',
                graphId: 'judge',
                inputBindings: [{ graphInputId: 'context', source: { kind: 'context', context: 'everything' } }],
              },
            ],
          },
        ],
        baselines: [],
      }),
    /source\.context is not supported/,
  );
});

test('project persistence strips obsolete workspace resource selections before portable JSON validation', () => {
  const dataWithLegacySelections: EvaluationProjectData & {
    selectedSuiteId?: unknown;
    selectedDatasetId?: unknown;
  } = {
    version: 1,
    suites: [],
    baselines: [],
    selectedSuiteId: undefined,
    selectedDatasetId: 'dataset',
  };

  assert.deepEqual(serializeEvaluationProjectData(dataWithLegacySelections), {
    version: 1,
    suites: [],
    baselines: [],
  });
  assert.deepEqual(
    deserializeEvaluationProjectData({
      version: 1,
      suites: [],
      baselines: [],
      selectedSuiteId: 1,
      selectedDatasetId: null,
    }),
    { version: 1, suites: [], baselines: [] },
  );
});

test('durable suite validation preserves temporarily empty authoring labels', () => {
  const result = deserializeEvaluationProjectData({
    version: 1,
    suites: [
      {
        id: 'suite',
        name: '',
        targetGraphId: 'graph',
        datasetId: 'dataset',
        inputBindings: [],
        assertions: [
          {
            id: 'assertion',
            name: '',
            outputPath: '$',
            operator: 'equals',
            expected: { kind: 'literal', value: null },
          },
        ],
        evaluators: [{ id: 'evaluator', name: '', graphId: 'judge', inputBindings: [] }],
      },
    ],
    baselines: [],
  });

  assert.equal(result.suites[0]?.name, '');
  assert.equal(result.suites[0]?.assertions[0]?.name, '');
  assert.equal(result.suites[0]?.evaluators[0]?.name, '');
});

function snapshot(projectId = 'project' as ProjectId): EvaluationDatasetSnapshot {
  const dataset = {
    id: 'dataset',
    projectId,
    name: 'Dataset',
    fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input' as const }],
    cases: [{ id: 'case', name: 'Case', values: { input: 'original' } }],
  };
  return {
    projectId,
    fingerprint: fingerprintEvaluationDataset(dataset),
    createdAt: '2026-08-15T00:00:00.000Z',
    dataset,
  };
}

test('run stores do not let a delayed progress snapshot replace a newer completed run', async () => {
  const store = new InMemoryEvaluationRunStore();
  await store.put(run(4, 'completed'));
  await store.put(run(3, 'running'));

  const stored = await store.get({ projectId: 'project' as ProjectId, runId: 'run' });
  assert.equal(stored?.revision, 4);
  assert.equal(stored?.executionStatus, 'completed');
});

test('run stores do not let an equal-revision progress snapshot demote a terminal run', async () => {
  const store = new InMemoryEvaluationRunStore();
  await store.put(run(4, 'completed'));
  await store.put(run(4, 'running'));

  const stored = await store.get({ projectId: 'project' as ProjectId, runId: 'run' });
  assert.equal(stored?.revision, 4);
  assert.equal(stored?.executionStatus, 'completed');
});

function recording(overrides: Partial<EvaluationRecordingArtifact> = {}): EvaluationRecordingArtifact {
  return {
    projectId: 'project' as ProjectId,
    runId: 'run',
    trialId: 'case:0',
    reference: { id: 'recording', retention: 'temporary', expiresAt: '2026-08-15T01:00:00.000Z' },
    serialized: '{"events":[]}',
    createdAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

test('temporary recordings expire without affecting durable run summaries', async () => {
  const store = new InMemoryEvaluationRunStore();
  await store.put(run(1, 'completed'));
  await store.putRecording(
    recording({ reference: { id: 'expired', retention: 'temporary', expiresAt: '2000-01-01T00:00:00.000Z' } }),
  );

  assert.equal(await store.getRecording({ projectId: 'project' as ProjectId, recordingId: 'expired' }), undefined);
  assert.equal((await store.get({ projectId: 'project' as ProjectId, runId: 'run' }))?.id, 'run');
});

test('dataset snapshots are content-addressed, project-scoped, and detached from caller mutation', async () => {
  const store = new InMemoryEvaluationRunStore();
  const original = snapshot();
  await store.putDatasetSnapshot(original);
  original.dataset.cases[0]!.values.input = 'changed by caller';

  const stored = await store.getDatasetSnapshot({
    projectId: 'project' as ProjectId,
    fingerprint: original.fingerprint,
  });
  assert.equal(stored?.dataset.cases[0]?.values.input, 'original');
  assert.equal(
    await store.getDatasetSnapshot({ projectId: 'other-project' as ProjectId, fingerprint: original.fingerprint }),
    undefined,
  );
});

test('dataset snapshots reject mismatched fingerprints and preserve the first historical value', async () => {
  const store = new InMemoryEvaluationRunStore();
  const original = snapshot();
  await assert.rejects(
    store.putDatasetSnapshot({ ...original, fingerprint: 'fnv1a64:not-the-dataset' }),
    /fingerprint must match/,
  );
  await store.putDatasetSnapshot(original);
  await store.putDatasetSnapshot({
    ...original,
    dataset: { ...original.dataset, name: 'Renamed live dataset' },
  });

  assert.equal(
    (await store.getDatasetSnapshot({ projectId: original.projectId, fingerprint: original.fingerprint }))?.dataset
      .name,
    'Dataset',
  );
});

test('dataset fingerprints keep distinct dataset resources separate', () => {
  const first = snapshot().dataset;
  const second = { ...first, id: 'another-dataset' };

  assert.notEqual(fingerprintEvaluationDataset(first), fingerprintEvaluationDataset(second));
});

test('project deserialization upgrades compact baseline aggregate counters', () => {
  const data = deserializeEvaluationProjectData({
    version: 1,
    suites: [],
    baselines: [
      {
        id: 'baseline',
        suiteId: 'suite',
        createdAt: '2026-08-15T00:00:00.000Z',
        provenance: run(1, 'completed').provenance,
        aggregate: {
          trialCount: 2,
          passedTrialCount: 1,
          failedTrialCount: 1,
          erroredTrialCount: 0,
          canceledTrialCount: 0,
          passRate: 0.5,
          averageLatencyMs: 1,
          p95LatencyMs: 1,
          targetErrorRate: 0,
          evaluatorErrorRate: 0,
          toolFailureRate: 0,
          metrics: {},
        },
        cases: [],
      },
    ],
  });

  assert.equal(data.baselines[0]?.aggregate.evaluatedTrialCount, 2);
  assert.equal(data.baselines[0]?.aggregate.notEvaluatedTrialCount, 0);
  assert.equal(data.baselines[0]?.aggregate.unableToEvaluateTrialCount, 0);
});

test('legacy partial accounting never preserves authoritative zero-cost aggregates', async () => {
  const store = new InMemoryEvaluationRunStore();
  const partialRun = run(1, 'completed');
  partialRun.accountingStatus = 'partial';
  partialRun.provenance.accountingComplete = false;
  partialRun.aggregate = {
    trialCount: 1,
    evaluatedTrialCount: 0,
    notEvaluatedTrialCount: 1,
    unableToEvaluateTrialCount: 0,
    passedTrialCount: 0,
    failedTrialCount: 0,
    erroredTrialCount: 0,
    canceledTrialCount: 0,
    passRate: 0,
    averageLatencyMs: 1,
    p95LatencyMs: 1,
    totalCostUsd: 0,
    averageCostUsd: 0,
    targetErrorRate: 0,
    evaluatorErrorRate: 0,
    toolFailureRate: 0,
    metrics: {},
  };
  await store.put(partialRun);
  const stored = await store.get({ projectId: 'project' as ProjectId, runId: 'run' });
  assert.equal(stored?.accountingStatus, 'partial');
  assert.equal(stored?.aggregate?.totalCostUsd, undefined);
  assert.equal(stored?.aggregate?.averageCostUsd, undefined);

  const baselineData = deserializeEvaluationProjectData({
    version: 1,
    suites: [],
    baselines: [
      {
        id: 'partial-baseline',
        suiteId: 'suite',
        createdAt: '2026-08-15T00:00:00.000Z',
        purpose: 'evaluation',
        qualityStatus: 'passed',
        accountingStatus: 'partial',
        provenance: { ...partialRun.provenance, accountingComplete: false },
        aggregate: partialRun.aggregate,
        cases: [],
      },
    ],
  });
  assert.equal(baselineData.baselines[0]?.aggregate.totalCostUsd, undefined);
  assert.equal(baselineData.baselines[0]?.aggregate.averageCostUsd, undefined);
});

test('baseline promotion pins all and only the selected run artifacts', async () => {
  const store = new InMemoryEvaluationRunStore();
  await store.putRecording(recording());
  await store.putRecording(recording({ runId: 'other-run', reference: { id: 'other', retention: 'temporary' } }));

  await store.promoteBaseline({ projectId: 'project' as ProjectId, runId: 'run' });

  assert.equal(
    (await store.getRecording({ projectId: 'project' as ProjectId, recordingId: 'recording' }))?.reference.retention,
    'baseline',
  );
  assert.equal(
    (await store.getRecording({ projectId: 'project' as ProjectId, recordingId: 'other' }))?.reference.retention,
    'temporary',
  );
});

test('delayed provisional recording writes cannot undo durable retention or reassign an artifact ID', async () => {
  const store = new InMemoryEvaluationRunStore();
  const provisional = recording();
  await store.putRecording(provisional);
  await store.updateRecordingRetention({
    projectId: provisional.projectId,
    recordingId: provisional.reference.id,
    retention: 'failure',
  });

  await store.putRecording(provisional);
  assert.deepEqual(
    (
      await store.getRecording({
        projectId: provisional.projectId,
        recordingId: provisional.reference.id,
      })
    )?.reference,
    { id: provisional.reference.id, retention: 'failure' },
  );

  await assert.rejects(store.putRecording({ ...provisional, runId: 'another-run' }), /cannot be reassigned/u);
});

test('expiry timestamps never evict explicitly retained recording artifacts', async () => {
  const store = new InMemoryEvaluationRunStore();
  const retained = recording({
    reference: { id: 'retained-expired-date', retention: 'retained', expiresAt: '2000-01-01T00:00:00.000Z' },
  });
  await store.putRecording(retained);

  assert.equal(
    (await store.getRecording({ projectId: retained.projectId, recordingId: retained.reference.id }))?.reference
      .retention,
    'retained',
  );
});
