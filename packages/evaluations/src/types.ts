import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';

/** Values saved in evaluation datasets, assertions, evidence, and run artifacts. */
export type PortableJson = null | boolean | number | string | PortableJson[] | { [key: string]: PortableJson };

export type EvaluationDatasetFieldRole = 'input' | 'expected' | 'metadata';

export type EvaluationDatasetField = {
  id: string;
  name: string;
  description?: string;
  /** Rivet data type identifier. The runner validates bindings against the target graph. */
  dataType: string;
  role: EvaluationDatasetFieldRole;
  required?: boolean;
};

export type EvaluationDatasetCase = {
  id: string;
  name: string;
  enabled?: boolean;
  tags?: string[];
  note?: string;
  values: Record<string, PortableJson>;
};

export type EvaluationDataset = {
  id: string;
  /**
   * Legacy project ownership retained only while importing older project
   * files. Locally persisted evaluation datasets intentionally omit it so
   * they can be reused with any currently open project.
  */
  projectId?: ProjectId;
  name: string;
  fields: EvaluationDatasetField[];
  cases: EvaluationDatasetCase[];
  /** Derived from fields and cases; stored to make snapshot reuse inspectable. */
  contentFingerprint?: string;
};

export type EvaluationInputBinding = {
  graphInputId: string;
  datasetFieldId: string;
};

export type EvaluationExpectedSource =
  | { kind: 'literal'; value: PortableJson }
  | { kind: 'dataset-field'; fieldId: string };

export type EvaluationAssertionOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'matches-regex'
  | 'type-is'
  | 'json-schema'
  | 'number-at-least'
  | 'number-at-most'
  | 'number-between'
  | 'array-includes'
  | 'set-overlaps'
  | 'contains-any'
  | 'contains-all';

export type EvaluationAssertion = {
  id: string;
  name: string;
  required?: boolean;
  outputPath: string;
  operator: EvaluationAssertionOperator;
  expected: EvaluationExpectedSource;
};

export type EvaluationEvaluatorContextInput = 'case' | 'inputs' | 'expected' | 'outputs' | 'run';

export type EvaluationEvaluatorInputSource =
  | { kind: 'dataset-field'; fieldId: string }
  | { kind: 'target-output'; outputId: string }
  | { kind: 'context'; context: EvaluationEvaluatorContextInput };

export type EvaluationEvaluatorInputBinding = {
  graphInputId: string;
  source: EvaluationEvaluatorInputSource;
};

export type EvaluationGraphEvaluator = {
  id: string;
  name: string;
  graphId: GraphId;
  /**
   * Explicit evaluator Graph Input mappings. Missing means an older evaluator
   * may use the five reserved context inputs; an empty array explicitly opts
   * into direct mapping for a graph with no required inputs.
   */
  inputBindings?: EvaluationEvaluatorInputBinding[];
  required?: boolean;
  scoreWeight?: number;
  runOnTargetError?: boolean;
};

/**
 * Pass/fail suites evaluate required assertions and evaluator verdicts.
 * Scoring evaluator graphs return scores on the user-facing 0..100 scale.
 * Runs store normalized scores internally for aggregation and compatibility.
 */
export type EvaluationSuiteMode = 'pass-fail' | 'scoring';

export type EvaluationThreshold =
  | { id: string; metric: 'pass-rate' | 'mean-score'; operator: 'at-least'; value: number }
  | {
      id: string;
      metric:
        | 'target-error-rate'
        | 'evaluator-error-rate'
        | 'tool-failure-rate'
        | 'average-cost'
        | 'total-cost'
        | 'average-latency-ms'
        | 'p95-latency-ms';
      operator: 'at-most';
      value: number;
    }
  | { id: string; metric: `custom:${string}`; operator: 'at-least' | 'at-most'; value: number }
  | { id: string; metric: string; operator: 'max-regression'; value: number };

export type EvaluationRunConfiguration = {
  trialCount?: number;
  concurrency?: number;
  timeoutMs?: number;
  seed?: number;
  seedGraphInputId?: string;
  recordingRetention?: 'failures-and-baselines' | 'all';
};

export type EvaluationSuite = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  targetGraphId: GraphId;
  datasetId: string;
  inputBindings: EvaluationInputBinding[];
  assertions: EvaluationAssertion[];
  evaluators: EvaluationGraphEvaluator[];
  /** Missing values are legacy pass/fail suites. */
  evaluationMode?: EvaluationSuiteMode;
  configuration?: EvaluationRunConfiguration;
  thresholds?: EvaluationThreshold[];
};

export type EvaluationBaselineSnapshot = {
  id: string;
  suiteId: string;
  sourceRunId?: string;
  createdAt: string;
  provenance: EvaluationRunProvenance;
  aggregate: EvaluationAggregate;
  /** Optional for project baselines created before EvaluationRun v2. */
  purpose?: EvaluationRunPurpose;
  /** Optional for project baselines created before EvaluationRun v2. */
  qualityStatus?: EvaluationQualityStatus;
  /** Optional for project baselines created before EvaluationRun v2. */
  qualityReason?: EvaluationQualityReason;
  /** Optional for project baselines created before EvaluationRun v2. */
  accountingStatus?: EvaluationAccountingStatus;
  /** Optional for baselines created before score-capable suites existed. */
  evaluationMode?: EvaluationSuiteMode;
  cases: Array<
    Pick<
      EvaluationCaseAggregate,
      | 'caseId'
      | 'caseName'
      | 'passRate'
      | 'meanScore'
      | 'metrics'
      | 'evaluatedTrialCount'
      | 'passedTrialCount'
      | 'failedTrialCount'
      | 'notEvaluatedTrialCount'
      | 'unableToEvaluateTrialCount'
      | 'erroredTrialCount'
      | 'canceledTrialCount'
      | 'scoredTrialCount'
      | 'missingScoreTrialCount'
    >
  >;
};

export type EvaluationProjectData = {
  version: 1;
  suites: EvaluationSuite[];
  baselines: EvaluationBaselineSnapshot[];
};

export type EvaluationObservationStatus = 'passed' | 'failed' | 'scored' | 'error' | 'skipped';

export type EvaluationObservation = {
  id: string;
  kind: 'assertion' | 'graph';
  name: string;
  status: EvaluationObservationStatus;
  required: boolean;
  /**
   * Normalized internal score in the closed 0..1 range. Evaluator graphs
   * return their `result.score` on the user-facing 0..100 scale.
   */
  score?: number;
  /**
   * The configured importance of a graph evaluator's score. It is copied into
   * the observation so a stored run remains interpretable after its suite is
   * edited.
   */
  scoreWeight?: number;
  message?: string;
  evidence?: PortableJson;
  metrics?: Record<string, number>;
  durationMs?: number;
  costUsd?: number;
  /** Privacy-bounded physical provider and profile decisions from this evaluator graph. */
  providerAttempts?: PortableJson;
  /**
   * Replay artifact for this evaluator execution. The serialized recording
   * itself stays in the evaluation run store, never in the project or run
   * summary document.
   */
  recording?: EvaluationRecordingReference;
};

export type EvaluationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  modelCallCount?: number;
  toolCallCount?: number;
  toolFailureCount?: number;
  costUsd?: number;
  hasUnknownCost?: boolean;
};

export type EvaluationExecutionMetrics = EvaluationUsage & {
  durationMs: number;
};

export type EvaluationRunPurpose = 'evaluation' | 'execution-benchmark';

export type EvaluationTrialExecutionStatus = 'completed' | 'error' | 'canceled';

export type EvaluationQualityStatus = 'passed' | 'failed' | 'scored' | 'not-evaluated' | 'unable-to-evaluate';

export type EvaluationAccountingStatus = 'complete' | 'partial';

export type EvaluationQualityReasonCode =
  | 'in-progress'
  | 'checks-passed'
  | 'checks-failed'
  | 'scores-complete'
  | 'scores-incomplete'
  | 'benchmark'
  | 'no-trial-quality-checks'
  | 'target-error'
  | 'required-check-error'
  | 'required-metric-unavailable'
  | 'thresholds-passed'
  | 'thresholds-failed'
  | 'canceled'
  | 'no-completed-trials';

export type EvaluationQualityReason = {
  code: EvaluationQualityReasonCode;
  message: string;
};

export type EvaluationThresholdResult = {
  id: string;
  metric: string;
  operator: EvaluationThreshold['operator'];
  status: 'passed' | 'failed' | 'unavailable';
  expectedValue: number;
  actualValue?: number;
  baselineValue?: number;
  regression?: number;
  message: string;
};

export type EvaluationTrial = {
  id: string;
  caseId: string;
  caseName: string;
  caseIndex: number;
  trialIndex: number;
  executionStatus: EvaluationTrialExecutionStatus;
  qualityStatus: EvaluationQualityStatus;
  qualityReason: EvaluationQualityReason;
  inputs: Record<string, PortableJson>;
  expected: Record<string, PortableJson>;
  outputs: Record<string, PortableJson>;
  observations: EvaluationObservation[];
  targetMetrics: EvaluationExecutionMetrics;
  evaluatorMetrics: EvaluationExecutionMetrics;
  totalMetrics: EvaluationExecutionMetrics;
  error?: string;
  seed?: number;
  recording?: EvaluationRecordingReference;
  /** Privacy-bounded physical provider and profile decisions from the target graph. */
  targetProviderAttempts?: PortableJson;
};

export type EvaluationCaseAggregate = {
  caseId: string;
  caseName: string;
  /** Undefined when no trial for this case produced an authoritative quality result. */
  passRate?: number;
  /** Optional so compact baselines written before EvaluationRun v2 remain readable. */
  evaluatedTrialCount?: number;
  passedTrialCount?: number;
  failedTrialCount?: number;
  notEvaluatedTrialCount?: number;
  unableToEvaluateTrialCount?: number;
  erroredTrialCount?: number;
  canceledTrialCount?: number;
  /** Completed trials that produced a usable score in a scoring suite. */
  scoredTrialCount?: number;
  /** Requested trials that could not contribute a score. */
  missingScoreTrialCount?: number;
  /** Normalized internal score in the closed 0..1 range. */
  meanScore?: number;
  metrics: Record<string, number>;
};

export type EvaluationAggregate = {
  trialCount: number;
  evaluatedTrialCount: number;
  notEvaluatedTrialCount: number;
  unableToEvaluateTrialCount: number;
  passedTrialCount: number;
  failedTrialCount: number;
  erroredTrialCount: number;
  canceledTrialCount: number;
  /** Completed trials that produced a usable score in a scoring suite. */
  scoredTrialCount?: number;
  /** Requested trials that could not contribute a score. */
  missingScoreTrialCount?: number;
  passRate: number;
  /** Normalized internal score in the closed 0..1 range. */
  meanScore?: number;
  averageLatencyMs: number;
  /** Optional so historical persisted runs without this newer factoid remain readable. */
  medianLatencyMs?: number;
  p95LatencyMs: number;
  /** Score distribution statistics use equal-weight per-case mean scores. */
  medianScore?: number;
  /** Score distribution statistics use equal-weight per-case mean scores. */
  p95Score?: number;
  totalCostUsd?: number;
  averageCostUsd?: number;
  targetErrorRate: number;
  evaluatorErrorRate: number;
  toolFailureRate: number;
  metrics: Record<string, number>;
};

export type EvaluationRunProvenance = {
  projectFingerprint: string;
  suiteFingerprint: string;
  datasetFingerprint: string;
  targetFingerprint: string;
  evaluatorFingerprints: Record<string, string>;
  executionMode: string;
  accountingComplete: boolean;
};

export type EvaluationRun = {
  version: 2;
  id: string;
  projectId: ProjectId;
  suiteId: string;
  suiteName: string;
  /** Optional user-assigned label for distinguishing retained runs. */
  name?: string;
  /**
   * Monotonically increases while a run is persisted. Stores use it to reject
   * a delayed live-progress write after a newer completed snapshot.
   * Missing means zero for recordings created before this field existed.
   */
  revision?: number;
  startedAt: string;
  completedAt?: string;
  purpose: EvaluationRunPurpose;
  /** Captures the suite semantics that produced this run. */
  evaluationMode?: EvaluationSuiteMode;
  /** Planned target executions, retained so live progress does not depend on a later suite edit. */
  requestedTrialCount?: number;
  executionStatus: 'queued' | 'running' | 'completed' | 'canceled' | 'error';
  qualityStatus: EvaluationQualityStatus;
  qualityReason: EvaluationQualityReason;
  accountingStatus: EvaluationAccountingStatus;
  provenance: EvaluationRunProvenance;
  aggregate?: EvaluationAggregate;
  /** Structured aggregate-threshold evidence for UI, reporters, and retained runs. */
  thresholdResults: EvaluationThresholdResult[];
  trials: EvaluationTrial[];
  warnings: string[];
};

export type EvaluationRecordingReference = {
  id: string;
  retention: 'temporary' | 'failure' | 'baseline' | 'retained';
  expiresAt?: string;
};

/** A replayable execution artifact owned by an EvaluationRunStore. */
export type EvaluationRecordingArtifact = {
  projectId: ProjectId;
  runId: string;
  trialId: string;
  reference: EvaluationRecordingReference;
  /** ExecutionRecorder's compact serialized representation. */
  serialized: string;
  createdAt: string;
};

/**
 * Immutable, content-addressed copy of the cases used by an evaluation run.
 * It lives with the run history rather than in a compact project baseline, so
 * a later edit to a .rivet-data file cannot rewrite historical evidence.
 */
export type EvaluationDatasetSnapshot = {
  projectId: ProjectId;
  fingerprint: string;
  dataset: EvaluationDataset;
  createdAt: string;
};

export type EvaluationGraphExecution = {
  outputs: Record<string, PortableJson>;
  metrics: EvaluationExecutionMetrics;
  recording?: EvaluationRecordingReference;
  providerAttempts?: PortableJson;
};

/**
 * Lets a target adapter preserve its metrics and replay reference when a
 * graph itself fails. The runner still classifies that as a target failure.
 */
export class EvaluationGraphExecutionError extends Error {
  readonly metrics?: EvaluationExecutionMetrics;
  readonly recording?: EvaluationRecordingReference;
  readonly providerAttempts?: PortableJson;

  constructor(
    message: string,
    details: Partial<Pick<EvaluationGraphExecution, 'metrics' | 'recording' | 'providerAttempts'>> = {},
  ) {
    super(message);
    this.name = 'EvaluationGraphExecutionError';
    this.metrics = details.metrics;
    this.recording = details.recording;
    this.providerAttempts = details.providerAttempts;
  }
}

export type EvaluationGraphRunner = (input: {
  project: Project;
  graphId: GraphId;
  inputs: Record<string, PortableJson>;
  signal?: AbortSignal;
  metadata: {
    evaluationRunId: string;
    suiteId: string;
    caseId: string;
    trialIndex: number;
    phase: 'target' | 'evaluator';
  };
}) => Promise<EvaluationGraphExecution>;

export type EvaluationRunStore = {
  put(run: EvaluationRun): Promise<void>;
  /** Sets a user-assigned run name; omit the name to restore the Unnamed label. */
  updateRunName(input: { projectId: ProjectId; runId: string; name?: string }): Promise<EvaluationRun | undefined>;
  get(input: { projectId: ProjectId; runId: string }): Promise<EvaluationRun | undefined>;
  list(input: { projectId: ProjectId; suiteId?: string }): Promise<readonly EvaluationRun[]>;
  delete(input: { projectId: ProjectId; runId: string }): Promise<void>;
  /**
   * Persists the first project-scoped snapshot for a dataset fingerprint.
   * Implementations must not rewrite an existing snapshot.
   */
  putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void>;
  getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined>;
  putRecording(artifact: EvaluationRecordingArtifact): Promise<void>;
  getRecording(input: { projectId: ProjectId; recordingId: string }): Promise<EvaluationRecordingArtifact | undefined>;
  updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingReference['retention'];
    expiresAt?: string;
  }): Promise<void>;
  /** Pins all artifacts belonging to the run before its compact baseline is saved in the project. */
  promoteBaseline(input: { projectId: ProjectId; runId: string }): Promise<void>;
};

export type EvaluationReporter = {
  report(run: EvaluationRun): Promise<void> | void;
};
