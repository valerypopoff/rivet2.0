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
  projectId: ProjectId;
  name: string;
  description?: string;
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

export type EvaluationGraphEvaluator = {
  id: string;
  name: string;
  graphId: GraphId;
  required?: boolean;
  scoreWeight?: number;
  runOnTargetError?: boolean;
};

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
    >
  >;
};

export type EvaluationProjectData = {
  version: 1;
  suites: EvaluationSuite[];
  baselines: EvaluationBaselineSnapshot[];
  /** Editor-only selection state. It never affects execution or baselines. */
  selectedSuiteId?: string;
  /** Lets Data Studio open an evaluation dataset even before it has a suite. */
  selectedDatasetId?: string;
};

export type EvaluationObservationStatus = 'passed' | 'failed' | 'error' | 'skipped';

export type EvaluationObservation = {
  id: string;
  kind: 'assertion' | 'graph';
  name: string;
  status: EvaluationObservationStatus;
  required: boolean;
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

export type EvaluationQualityStatus = 'passed' | 'failed' | 'not-evaluated' | 'unable-to-evaluate';

export type EvaluationAccountingStatus = 'complete' | 'partial';

export type EvaluationQualityReasonCode =
  | 'in-progress'
  | 'checks-passed'
  | 'checks-failed'
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
  passRate: number;
  meanScore?: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
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
  /**
   * Monotonically increases while a run is persisted. Stores use it to reject
   * a delayed live-progress write after a newer completed snapshot.
   * Missing means zero for recordings created before this field existed.
   */
  revision?: number;
  startedAt: string;
  completedAt?: string;
  purpose: EvaluationRunPurpose;
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
