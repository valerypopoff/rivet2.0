import { performance } from 'node:perf_hooks';

import { getApiRuntimeProfile, type ApiRuntimeProfile } from './runtime-profile.js';
import type { RuntimeHealthSnapshot } from './runtime-health.js';

export const METRICS_ENABLED_ENV = 'RIVET_METRICS_ENABLED';

export type MetricsConfig = Readonly<{
  enabled: boolean;
  profile: ApiRuntimeProfile;
}>;

type Labels = Readonly<Record<string, string | number>>;

type MetricSample = Readonly<{
  labels: Labels;
  value: number;
}>;

type HistogramSample = Readonly<{
  buckets: number[];
  count: number;
  labels: Labels;
  sum: number;
}>;

const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export type MetricsHttpRoute =
  | 'api'
  | 'internal_workflow'
  | 'latest_web_app'
  | 'latest_workflow'
  | 'other'
  | 'published_web_app'
  | 'published_workflow';

export type MetricsPublishedExecutionSurface = 'web_app_action' | 'workflow_endpoint';
export type MetricsHostedEvaluationSubmissionResult =
  | 'accepted'
  | 'outstanding_capacity_exceeded'
  | 'per_run_capacity_exceeded';
export type MetricsPublishedAdmissionResult = 'accepted' | 'capacity_exceeded' | 'draining';
export type MetricsObjectStorageDomain = 'runtime_libraries' | 'workflows';
export type MetricsObjectStorageOperation = 'delete' | 'delete_many' | 'get' | 'head' | 'health' | 'list' | 'put';
export type MetricsManagedReconciliationDomain = 'evaluations' | 'runtime_libraries' | 'workflows';
export type MetricsManagedReconciliationPhase = 'metadata' | 'objects';
export type MetricsManagedEvaluationRetentionMode = 'audit' | 'enforce';

export function getMetricsConfig(
  env: NodeJS.ProcessEnv = process.env,
  profile = getApiRuntimeProfile(),
): MetricsConfig {
  const raw = env[METRICS_ENABLED_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'false') return { enabled: false, profile };
  if (raw === 'true') return { enabled: true, profile };
  throw new Error(`${METRICS_ENABLED_ENV} must be true or false when set.`);
}

/**
 * A deliberately small Prometheus text registry. It has no network exporter,
 * keeps label sets finite at every call site, and never throws while recording
 * application work. The scrape route is the only rendering path.
 */
export class StudioMetrics {
  readonly #enabled: boolean;
  readonly #profile: ApiRuntimeProfile;
  readonly #counters = new Map<string, Map<string, MetricSample>>();
  readonly #gauges = new Map<string, Map<string, MetricSample>>();
  readonly #histograms = new Map<string, Map<string, HistogramSample>>();

  constructor(config: MetricsConfig) {
    this.#enabled = config.enabled;
    this.#profile = config.profile;
    this.setGauge('rivet_metrics_enabled', {}, config.enabled ? 1 : 0);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  observeHttpRequest(input: { durationMs: number; method: string; route: MetricsHttpRoute; status: number }): void {
    const labels = {
      method: normalizeHttpMethod(input.method),
      route: input.route,
      status_class: statusClass(input.status),
    };
    this.incrementCounter('rivet_http_requests_total', labels);
    this.observeHistogram('rivet_http_request_duration_seconds', labels, Math.max(0, input.durationMs) / 1_000);
  }

  setRuntimeHealth(liveness: RuntimeHealthSnapshot, readiness: RuntimeHealthSnapshot): void {
    this.setGauge('rivet_runtime_liveness', {}, liveness.ok ? 1 : 0);
    this.setGauge('rivet_runtime_readiness', {}, readiness.ok ? 1 : 0);
    for (const check of readiness.checks) {
      this.setGauge('rivet_runtime_health_check', { check: normalizeHealthCheckName(check.name) }, check.ok ? 1 : 0);
    }
  }

  setPublishedExecutionAdmission(input: {
    activeRuns: number;
    activeRunsBySurface?: Readonly<Record<'web-app-action' | 'workflow-endpoint', number>>;
    draining: boolean;
    maxActiveRuns: number;
    mode: 'disabled' | 'enforce' | 'observe';
  }): void {
    this.setGauge('rivet_published_execution_active_runs', {}, input.activeRuns);
    this.setGauge('rivet_published_execution_admission_limit', { mode: input.mode }, input.maxActiveRuns);
    this.setGauge('rivet_published_execution_draining', {}, input.draining ? 1 : 0);
    if (input.activeRunsBySurface) {
      this.setGauge(
        'rivet_published_execution_active_runs_by_surface',
        { surface: 'workflow_endpoint' },
        input.activeRunsBySurface['workflow-endpoint'],
      );
      this.setGauge(
        'rivet_published_execution_active_runs_by_surface',
        { surface: 'web_app_action' },
        input.activeRunsBySurface['web-app-action'],
      );
    }
  }

  recordPublishedExecutionAdmission(
    result: MetricsPublishedAdmissionResult,
    surface: MetricsPublishedExecutionSurface,
  ): void {
    this.incrementCounter('rivet_published_execution_admission_total', { result, surface });
  }

  recordPublishedExecutionInterruptions(surface: MetricsPublishedExecutionSurface, count = 1): void {
    this.incrementCounter('rivet_published_execution_interruptions_total', { surface }, count);
  }

  recordHostedEvaluationSubmission(result: MetricsHostedEvaluationSubmissionResult): void {
    this.incrementCounter('rivet_hosted_evaluation_submissions_total', { result });
  }

  setHostedEvaluationQueue(input: {
    accepted: number;
    claimed: number;
    maxOutstandingJobs: number;
    queued: number;
  }): void {
    this.setGauge('rivet_hosted_evaluation_jobs_outstanding', { state: 'queued' }, input.queued);
    this.setGauge('rivet_hosted_evaluation_jobs_outstanding', { state: 'claimed' }, input.claimed);
    this.setGauge('rivet_hosted_evaluation_jobs_outstanding', { state: 'accepted' }, input.accepted);
    this.setGauge('rivet_hosted_evaluation_jobs_outstanding_limit', {}, input.maxOutstandingJobs);
  }

  setHostedEvaluationWorkers(input: { activeTrials: number; workerConcurrency: number }): void {
    this.setGauge('rivet_hosted_evaluation_workers_active_trials', {}, input.activeTrials);
    this.setGauge('rivet_hosted_evaluation_workers_concurrency_limit', {}, input.workerConcurrency);
  }
  setWorkflowRecordingPersistence(input: {
    activeWrites: number;
    maxPendingWrites: number;
    pendingWrites: number;
  }): void {
    this.setGauge('rivet_workflow_recording_persistence_queue_depth', {}, input.pendingWrites);
    this.setGauge('rivet_workflow_recording_persistence_active_writes', {}, input.activeWrites);
    this.setGauge('rivet_workflow_recording_persistence_queue_limit', {}, input.maxPendingWrites);
  }

  recordWorkflowRecordingPersistenceDrop(): void {
    this.incrementCounter('rivet_workflow_recording_persistence_dropped_total', {});
  }

  recordWorkflowRecordingPersistenceFailure(): void {
    this.incrementCounter('rivet_workflow_recording_persistence_failures_total', {});
  }

  setPostgresPool(input: { idle: number; pools: number; total: number; waiting: number }): void {
    this.setGauge('rivet_postgres_pool_connections', { state: 'idle' }, input.idle);
    this.setGauge('rivet_postgres_pool_connections', { state: 'total' }, input.total);
    this.setGauge('rivet_postgres_pool_connections', { state: 'waiting' }, input.waiting);
    this.setGauge('rivet_postgres_pool_instances', {}, input.pools);
  }

  observeObjectStorageOperation(input: {
    domain: MetricsObjectStorageDomain;
    durationMs: number;
    operation: MetricsObjectStorageOperation;
    outcome: 'error' | 'success';
  }): void {
    const labels = { domain: input.domain, operation: input.operation, outcome: input.outcome };
    this.incrementCounter('rivet_object_storage_operations_total', labels);
    this.observeHistogram(
      'rivet_object_storage_operation_duration_seconds',
      labels,
      Math.max(0, input.durationMs) / 1_000,
    );
  }

  setRuntimeLibraryJobActive(active: number): void {
    this.setGauge('rivet_runtime_library_jobs_active', {}, active);
  }

  recordRuntimeLibraryJob(outcome: 'failed' | 'succeeded'): void {
    this.incrementCounter('rivet_runtime_library_jobs_total', { outcome });
  }

  recordManagedReconciliationPage(input: {
    domain: MetricsManagedReconciliationDomain;
    outcome: 'error' | 'skipped' | 'success';
    phase: MetricsManagedReconciliationPhase;
  }): void {
    this.incrementCounter('rivet_managed_reconciliation_pages_total', input);
  }

  setManagedReconciliationState(input: {
    completedGeneration: number;
    domain: MetricsManagedReconciliationDomain;
    openFindings: number;
  }): void {
    this.setGauge(
      'rivet_managed_reconciliation_completed_generation',
      { domain: input.domain },
      input.completedGeneration,
    );
    this.setGauge('rivet_managed_reconciliation_open_findings', { domain: input.domain }, input.openFindings);
  }

  /**
   * Evaluation replay artifacts are PostgreSQL-owned today. These bounded
   * lifecycle metrics deliberately carry no project, suite, or recording ids.
   */
  setManagedEvaluationRetention(input: {
    mode: MetricsManagedEvaluationRetentionMode;
    expiredRecordingCandidates: number;
    orphanedSnapshotCandidates: number;
  }): void {
    this.setGauge(
      'rivet_managed_evaluation_retention_candidates',
      { kind: 'expired_recording', mode: input.mode },
      input.expiredRecordingCandidates,
    );
    this.setGauge(
      'rivet_managed_evaluation_retention_candidates',
      { kind: 'orphaned_snapshot', mode: input.mode },
      input.orphanedSnapshotCandidates,
    );
  }

  recordManagedEvaluationRetention(input: {
    mode: MetricsManagedEvaluationRetentionMode;
    expiredRecordings: number;
    orphanedSnapshots: number;
  }): void {
    this.incrementCounter(
      'rivet_managed_evaluation_retention_deleted_total',
      { kind: 'expired_recording', mode: input.mode },
      input.expiredRecordings,
    );
    this.incrementCounter(
      'rivet_managed_evaluation_retention_deleted_total',
      { kind: 'orphaned_snapshot', mode: input.mode },
      input.orphanedSnapshots,
    );
  }
  render(): string {
    if (!this.#enabled) return '';
    try {
      return [
        ...renderMetricFamilies(this.#counters, 'counter'),
        ...renderMetricFamilies(this.#gauges, 'gauge'),
        ...renderHistogramFamilies(this.#histograms),
      ].join('\n');
    } catch {
      // Scraping must not destabilize an otherwise healthy API process.
      return '';
    }
  }

  private incrementCounter(name: string, labels: Labels, amount = 1): void {
    if (!this.#enabled || !Number.isFinite(amount) || amount <= 0) return;
    this.setMetricValue(this.#counters, name, labels, (current) => current + amount);
  }

  private setGauge(name: string, labels: Labels, value: number): void {
    if (!this.#enabled || !Number.isFinite(value)) return;
    this.setMetricValue(this.#gauges, name, labels, () => value);
  }

  private setMetricValue(
    store: Map<string, Map<string, MetricSample>>,
    name: string,
    labels: Labels,
    update: (current: number) => number,
  ): void {
    try {
      const normalizedLabels = this.withProfile(labels);
      const key = labelKey(normalizedLabels);
      const family = store.get(name) ?? new Map<string, MetricSample>();
      const current = family.get(key)?.value ?? 0;
      family.set(key, { labels: normalizedLabels, value: update(current) });
      store.set(name, family);
    } catch {
      // Instrumentation cannot affect the operation it observes.
    }
  }

  private observeHistogram(name: string, labels: Labels, value: number): void {
    if (!this.#enabled || !Number.isFinite(value)) return;
    try {
      const normalizedLabels = this.withProfile(labels);
      const key = labelKey(normalizedLabels);
      const family = this.#histograms.get(name) ?? new Map<string, HistogramSample>();
      const current = family.get(key) ?? {
        buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
        count: 0,
        labels: normalizedLabels,
        sum: 0,
      };
      const buckets = current.buckets.map(
        (count, index) => count + (value <= DURATION_BUCKETS_SECONDS[index]! ? 1 : 0),
      );
      family.set(key, {
        buckets,
        count: current.count + 1,
        labels: current.labels,
        sum: current.sum + value,
      });
      this.#histograms.set(name, family);
    } catch {
      // Instrumentation cannot affect the operation it observes.
    }
  }

  private withProfile(labels: Labels): Labels {
    return { profile: this.#profile, ...labels };
  }
}

let defaultMetrics: StudioMetrics | undefined;

export function getStudioMetrics(): StudioMetrics {
  defaultMetrics ??= new StudioMetrics(getMetricsConfig());
  return defaultMetrics;
}

export function configureStudioMetrics(
  profile: ApiRuntimeProfile,
  env: NodeJS.ProcessEnv = process.env,
): StudioMetrics {
  const metrics = new StudioMetrics(getMetricsConfig(env, profile));
  defaultMetrics = metrics;
  return metrics;
}

export function resetStudioMetricsForTests(): void {
  defaultMetrics = undefined;
}

/**
 * Records an observation without allowing a telemetry configuration or
 * rendering failure to affect the operation that produced it.
 */
export function recordStudioMetrics(record: (metrics: StudioMetrics) => void): void {
  try {
    record(getStudioMetrics());
  } catch {
    // Metrics must remain strictly observational.
  }
}

export async function observeObjectStorageOperation<T>(
  domain: MetricsObjectStorageDomain,
  operation: MetricsObjectStorageOperation,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    recordStudioMetrics((metrics) =>
      metrics.observeObjectStorageOperation({
        domain,
        durationMs: performance.now() - startedAt,
        operation,
        outcome: 'success',
      }),
    );
    return result;
  } catch (error) {
    recordStudioMetrics((metrics) =>
      metrics.observeObjectStorageOperation({
        domain,
        durationMs: performance.now() - startedAt,
        operation,
        outcome: 'error',
      }),
    );
    throw error;
  }
}

function normalizeHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].includes(normalized) ? normalized : 'OTHER';
}

function normalizeHealthCheckName(name: string): string {
  return ['app-settings', 'runtime-libraries', 'web-app-actions', 'workflow-storage'].includes(name) ? name : 'other';
}

function statusClass(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other';
}

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\u0000');
}

function renderMetricFamilies(families: Map<string, Map<string, MetricSample>>, type: 'counter' | 'gauge'): string[] {
  const lines: string[] = [];
  for (const [name, samples] of families) {
    lines.push(`# TYPE ${name} ${type}`);
    for (const sample of samples.values()) {
      lines.push(`${name}${renderLabels(sample.labels)} ${formatMetricNumber(sample.value)}`);
    }
  }
  return lines;
}

function renderHistogramFamilies(families: Map<string, Map<string, HistogramSample>>): string[] {
  const lines: string[] = [];
  for (const [name, samples] of families) {
    lines.push(`# TYPE ${name} histogram`);
    for (const sample of samples.values()) {
      for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
        lines.push(
          `${name}_bucket${renderLabels({ ...sample.labels, le: DURATION_BUCKETS_SECONDS[index]! })} ${sample.buckets[index]!}`,
        );
      }
      lines.push(`${name}_bucket${renderLabels({ ...sample.labels, le: '+Inf' })} ${sample.count}`);
      lines.push(`${name}_sum${renderLabels(sample.labels)} ${formatMetricNumber(sample.sum)}`);
      lines.push(`${name}_count${renderLabels(sample.labels)} ${sample.count}`);
    }
  }
  return lines;
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatMetricNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(9)));
}
