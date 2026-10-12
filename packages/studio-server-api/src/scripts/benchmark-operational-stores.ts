import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import type { ProjectId, RivetLLMProfileHealthIdentity } from '@valerypopoff/rivet2-node';
import type { EvaluationRun } from '@valerypopoff/rivet2-evaluations';
import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import { FilesystemRivetLLMProfileHealthStore } from '../llm-profile-health/filesystem-store.js';
import { FilesystemRivetEvaluationStore } from '../evaluation-runs/filesystem-store.js';
import { ScheduledRunStore } from '../scheduled-runs/store.js';

// A disposable, repeatable operational workload; never points at a serving DB.
const rounds = Number(process.argv[2] ?? 100);
const servingMode = process.argv[3];
if (
  !Number.isSafeInteger(rounds) ||
  rounds < 20 ||
  rounds > 500 ||
  process.argv.length > 4 ||
  (servingMode !== undefined && !['direct', 'worker'].includes(servingMode))
)
  throw new Error('Usage: benchmark-operational-stores [20..500 rounds] [direct|worker]');
for (const key of Object.keys(process.env)) if (key.startsWith('RIVET_')) delete process.env[key];
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-operational-workload-'));
Object.assign(process.env, {
  RIVET_APP_DATA_ROOT: root,
  RIVET_WORKFLOWS_ROOT: path.join(root, 'virtual'),
  RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
  RIVET_RECORDINGS_ENABLED: 'true',
  RIVET_METRICS_ENABLED: 'true',
  DOTENV_CONFIG_PATH: path.join(root, 'absent.env'),
});
const initializationAt = performance.now();
const settings = new SqliteAppSettingsBackend({ databasePath: path.join(root, 'settings.sqlite') });
const health = new FilesystemRivetLLMProfileHealthStore(path.join(root, 'health.sqlite'));
const evaluations = new FilesystemRivetEvaluationStore(path.join(root, 'evaluations.sqlite'));
const schedules = ScheduledRunStore.sqlite(path.join(root, 'schedules.sqlite'));
const projectId = 'operational-fixture' as ProjectId;
const policy = { failureThreshold: 3, failureWindowMs: 300_000, openDurationMs: 300_000, halfOpenLeaseMs: 60_000 };
const identity = (index: number): RivetLLMProfileHealthIdentity => ({
  key: 'profile-' + index,
  projectId,
  profileNodeId: ('node-' + index) as never,
  profileName: 'Profile',
  provider: 'custom',
  model: 'fixture',
  configurationFingerprint: 'sha256:fixture',
});
const results: Record<string, unknown> = {};
let workflowBackend: import('../local-metadata/sqlite-workflow-backend.js').SqliteWorkflowBackend | undefined;
let claimSchedule: Awaited<ReturnType<ScheduledRunStore['save']>> | undefined;
async function measure(name: string, operation: () => Promise<unknown>) {
  const samples: number[] = [];
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < rounds; i++) {
    const at = performance.now();
    await operation();
    samples.push(performance.now() - at);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const usage = process.cpuUsage(cpu);
  delay.disable();
  samples.sort((a, b) => a - b);
  results[name] = {
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    maxMs: samples.at(-1),
    elapsedMs: performance.now() - start,
    cpuMs: (usage.user + usage.system) / 1000,
    eventLoopMaxMs: delay.max / 1e6,
    rssBytes: process.memoryUsage().rss,
  };
}
try {
  await settings.initialize();
  for (let i = 0; i < 24; i++)
    await settings.write({
      key: 'settings-' + i,
      expectedRevision: null,
      schemaVersion: 1,
      value: { text: 's'.repeat(4096) },
    });
  for (let i = 0; i < 100; i++) {
    const source = identity(i);
    const attempt = await health.begin({ identity: source, policy });
    await health.finish({ identity: source, policy, permitId: attempt.permitId!, outcome: 'healthy' });
    const value = run(projectId, 'run-' + i);
    value.trials[0]!.outputs = { output: { type: 'string', value: 'x'.repeat(100_000) } };
    await evaluations.put(value);
    const schedule = await schedules.save({
      name: 'Schedule ' + i,
      description: '',
      projectId,
      version: 'latest',
      enabled: false,
      timeZone: 'UTC',
      schedule: { kind: 'interval', minutes: 1, anchor: '2026-01-01T00:00:00Z' },
      record: true,
      timeoutMinutes: 5,
      missed: 'skip',
    });
    claimSchedule ??= schedule;
  }
  results.operationalSetupMs = performance.now() - initializationAt;
  await measure('settings.readiness', () => settings.checkHealth());
  await measure('settings.integrity', async () => settings.verifyIntegrity());
  await measure('health.begin-finish', async () => {
    const source = identity(1),
      attempt = await health.begin({ identity: source, policy });
    await health.finish({ identity: source, policy, permitId: attempt.permitId!, outcome: 'healthy' });
  });
  await measure('health.project-list', () => health.list({ projectId }));
  await measure('evaluations.compact-page', () => evaluations.listPage({ projectId, limit: 20 }));
  await measure('evaluations.detail', () => evaluations.get({ projectId, runId: 'run-1' }));
  await measure('schedules.list', () => schedules.list());
  await measure('schedules.tick', () => schedules.tick('benchmark'));
  if (servingMode) {
    const progress = run(projectId, 'progress-fixture');
    progress.executionStatus = 'running';
    progress.revision = 0;
    progress.trials[0]!.outputs = { output: { type: 'string', value: 'x'.repeat(100_000) } };
    await evaluations.applyRunEvent({ type: 'run-started', revision: 0, run: progress });
    const { LocalWorkflowCatalog } = await import('../local-metadata/workflow-catalog.js');
    const { SqliteWorkflowBackend } = await import('../local-metadata/sqlite-workflow-backend.js');
    const { measureServingWorkload } = await import('./serving-workload.js');
    const { getStudioMetrics } = await import('../metrics.js');
    const options = {
      databasePath: path.join(root, 'workflow.sqlite'),
      artifactRoot: path.join(root, 'objects'),
      virtualRoot: path.join(root, 'virtual'),
    };
    const candidate = new LocalWorkflowCatalog(options);
    try {
      candidate.initialize();
    } finally {
      candidate.close();
    }
    workflowBackend = new SqliteWorkflowBackend({
      ...options,
      worker: servingMode === 'worker',
      withWrite: (operation) => operation(),
      getRecordingRetentionHolds: async () => new Set(),
    });
    const start = performance.now();
    await workflowBackend.initialize();
    results.workflowStartupMs = performance.now() - start;
    results.concurrentServing = await measureServingWorkload(
      workflowBackend,
      () => workflowBackend!.checkHealth(),
      rounds,
      {
        operations: [
          {
            name: 'operational.settings-refresh',
            async run() {
              assert.ok(await settings.read('settings-1'));
              await settings.checkHealth();
            },
          },
          {
            name: 'operational.profile-health',
            async run() {
              const source = identity(1),
                attempt = await health.begin({ identity: source, policy });
              assert.ok(attempt.permitId);
              await health.finish({ identity: source, policy, permitId: attempt.permitId, outcome: 'healthy' });
            },
          },
          {
            name: 'operational.evaluation-progress',
            async run(round) {
              await evaluations.applyRunEvent({
                type: 'trial-settled',
                revision: round + 1,
                projectId,
                runId: progress.id,
                suiteId: progress.suiteId,
                requestedTrialCount: 1,
                settledTrialCount: 1,
                trial: progress.trials[0]!,
              });
              assert.equal((await evaluations.get({ projectId, runId: progress.id }))?.revision, round + 1);
            },
          },
          {
            name: 'operational.schedule-claim',
            async run() {
              const schedule = claimSchedule!;
              const queued = await schedules.runNow(schedule.id, schedule.revision);
              const claimed = await schedules.tick('benchmark');
              assert.equal(claimed?.occurrence.id, queued.id);
              await schedules.finish(queued.id, 'benchmark', { status: 'succeeded' });
            },
          },
        ],
        sampleResources() {
          const metrics = getStudioMetrics().render();
          return Object.fromEntries(
            ['pending_operations', 'active_operations', 'reserved_bytes'].map((name) => [
              name,
              Number(metrics.match(new RegExp(`^rivet_catalog_worker_${name}(?:\\{[^}]*\\})? (\\d+)`, 'm'))?.[1] ?? 0),
            ]),
          );
        },
      },
    );
    results.catalogMetricsBeforeDrain = getStudioMetrics().render();
  }
} finally {
  const closingAt = performance.now();
  await workflowBackend?.dispose();
  await health.dispose();
  await evaluations.dispose();
  await settings.dispose();
  await schedules.close();
  results.shutdownMs = performance.now() - closingAt;
  await fs.rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      nodeVersion: process.version,
      servingMode,
      workload: { rounds, settings: 24, profiles: 100, initialRuns: 100, payloadBytesPerRun: 100_000, schedules: 100 },
      results,
    },
    null,
    2,
  ),
);

function run(projectId: ProjectId, id: string): EvaluationRun {
  return {
    version: 2,
    id,
    projectId,
    suiteId: 'suite',
    suiteName: 'Suite',
    startedAt: '2026-08-15T00:00:00.000Z',
    purpose: 'evaluation',
    executionStatus: 'completed',
    qualityStatus: 'passed',
    qualityReason: {
      code: 'checks-passed',
      message: 'All required quality criteria passed.',
    },
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
    thresholdResults: [],
    trials: [
      {
        id: 'trial',
        caseId: 'case',
        caseName: 'Case',
        caseIndex: 0,
        trialIndex: 0,
        executionStatus: 'completed',
        qualityStatus: 'passed',
        qualityReason: {
          code: 'checks-passed',
          message: 'All required quality criteria passed.',
        },
        inputs: {},
        expected: {},
        outputs: {},
        observations: [],
        targetMetrics: { durationMs: 1 },
        evaluatorMetrics: { durationMs: 0 },
        totalMetrics: { durationMs: 1 },
      },
    ],
    warnings: [],
  };
}
