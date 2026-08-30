import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createApiApp } from '../app.js';
import {
  getMetricsConfig,
  observeObjectStorageOperation,
  resetStudioMetricsForTests,
  StudioMetrics,
} from '../metrics.js';

async function startMetricsServer(metrics: StudioMetrics) {
  const app = createApiApp('execution', {
    health: {
      getLiveness: () => ({ ok: true, profile: 'execution', state: 'ready', checkedAt: null, checks: [] }),
      getReadiness: () => ({
        ok: true,
        profile: 'execution',
        state: 'ready',
        checkedAt: null,
        checks: [{ checkedAt: '2026-08-29T00:00:00.000Z', durationMs: 1, name: 'workflow-storage', ok: true }],
      }),
    },
    metrics,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('metrics registry renders only finite, fixed-label metric families', () => {
  const metrics = new StudioMetrics({ enabled: true, profile: 'execution' });
  metrics.observeHttpRequest({ durationMs: 125, method: 'POST', route: 'published_workflow', status: 429 });
  metrics.observeHttpRequest({ durationMs: 250, method: 'TRACE', route: 'other', status: 799 });
  metrics.setPublishedExecutionAdmission({
    activeRuns: 2,
    activeRunsBySurface: { 'web-app-action': 1, 'workflow-endpoint': 1 },
    draining: false,
    maxActiveRuns: 4,
    mode: 'enforce',
  });
  metrics.recordPublishedExecutionAdmission('capacity_exceeded', 'workflow_endpoint');
  metrics.recordHostedEvaluationSubmission('accepted');
  metrics.recordHostedEvaluationSubmission('outstanding_capacity_exceeded');
  metrics.setHostedEvaluationQueue({ accepted: 1, claimed: 2, maxOutstandingJobs: 24, queued: 3 });
  metrics.setHostedEvaluationWorkers({ activeTrials: 2, workerConcurrency: 4 });
  metrics.setManagedMaintenance({ lastAttemptAtMs: 1_000, lastSuccessAtMs: 900 });
  metrics.recordManagedMaintenancePass('completed');
  metrics.setManagedObjectDeletionOutbox({
    entries: { blocked: 1, claimed: 2, pending: 3 },
    oldestAgeSeconds: { blocked: 12, claimed: 8, pending: 4 },
  });
  metrics.recordManagedObjectDeletionOutbox('blocked');
  metrics.setManagedSettingsSynchronization({
    lastFailureAtMs: 800,
    lastSuccessAtMs: 1_000,
    listenerConnected: true,
    pollInFlight: false,
  });
  metrics.recordManagedSettingsSynchronization({ outcome: 'success', source: 'poll' });
  metrics.recordManagedReconciliationPage({
    domain: 'runtime_libraries',
    outcome: 'success',
    phase: 'objects',
    returnedItems: 4,
  });
  metrics.setManagedReconciliationState({
    completedGeneration: 2,
    domain: 'runtime_libraries',
    lastCompletedAtMs: 900,
    lastErrorAtMs: 800,
    openFindings: 3,
  });
  metrics.setManagedEvaluationRetention({
    expiredRecordingCandidates: 2,
    mode: 'audit',
    orphanedSnapshotCandidates: 1,
  });
  metrics.recordManagedEvaluationRetention({
    expiredRecordings: 2,
    mode: 'enforce',
    orphanedSnapshots: 1,
  });

  const rendered = metrics.render();
  assert.match(
    rendered,
    /rivet_http_requests_total\{method="POST",profile="execution",route="published_workflow",status_class="4xx"\} 1/,
  );
  assert.match(
    rendered,
    /rivet_http_requests_total\{method="OTHER",profile="execution",route="other",status_class="other"\} 1/,
  );
  assert.match(rendered, /rivet_published_execution_active_runs\{profile="execution"\} 2/);
  assert.match(
    rendered,
    /rivet_published_execution_admission_total\{profile="execution",result="capacity_exceeded",surface="workflow_endpoint"\} 1/,
  );
  assert.match(rendered, /rivet_hosted_evaluation_submissions_total\{profile="execution",result="accepted"\} 1/);
  assert.match(
    rendered,
    /rivet_hosted_evaluation_submissions_total\{profile="execution",result="outstanding_capacity_exceeded"\} 1/,
  );
  assert.match(rendered, /rivet_hosted_evaluation_jobs_outstanding\{profile="execution",state="queued"\} 3/);
  assert.match(rendered, /rivet_hosted_evaluation_jobs_outstanding_limit\{profile="execution"\} 24/);
  assert.match(rendered, /rivet_hosted_evaluation_workers_active_trials\{profile="execution"\} 2/);
  assert.match(rendered, /rivet_hosted_evaluation_workers_concurrency_limit\{profile="execution"\} 4/);
  assert.match(
    rendered,
    /rivet_managed_reconciliation_pages_total\{domain="runtime_libraries",outcome="success",phase="objects",profile="execution"\} 1/,
  );
  assert.match(
    rendered,
    /rivet_managed_reconciliation_open_findings\{domain="runtime_libraries",profile="execution"\} 3/,
  );
  assert.match(rendered, /rivet_managed_maintenance_passes_total\{outcome="completed",profile="execution"\} 1/);
  assert.match(rendered, /rivet_managed_maintenance_last_attempt_timestamp_seconds\{profile="execution"\} 1/);
  assert.match(rendered, /rivet_managed_maintenance_last_success_timestamp_seconds\{profile="execution"\} 0\.9/);
  assert.match(rendered, /rivet_managed_object_deletion_outbox_entries\{profile="execution",state="blocked"\} 1/);
  assert.match(
    rendered,
    /rivet_managed_object_deletion_outbox_oldest_entry_age_seconds\{profile="execution",state="pending"\} 4/,
  );
  assert.match(
    rendered,
    /rivet_managed_object_deletion_outbox_operations_total\{outcome="blocked",profile="execution"\} 1/,
  );
  assert.match(rendered, /rivet_managed_settings_listener_connected\{profile="execution"\} 1/);
  assert.match(
    rendered,
    /rivet_managed_settings_synchronization_total\{outcome="success",profile="execution",source="poll"\} 1/,
  );
  assert.match(
    rendered,
    /rivet_managed_reconciliation_returned_items_total\{domain="runtime_libraries",outcome="success",phase="objects",profile="execution"\} 4/,
  );
  assert.match(
    rendered,
    /rivet_managed_reconciliation_last_completed_timestamp_seconds\{domain="runtime_libraries",profile="execution"\} 0\.9/,
  );
  assert.match(
    rendered,
    /rivet_managed_evaluation_retention_candidates\{kind="expired_recording",mode="audit",profile="execution"\} 2/,
  );
  assert.match(
    rendered,
    /rivet_managed_evaluation_retention_deleted_total\{kind="orphaned_snapshot",mode="enforce",profile="execution"\} 1/,
  );
  assert.doesNotMatch(rendered, /workflow name|prompt|secret|http:\/\//i);
});

test('metrics config accepts only an explicit boolean switch', () => {
  assert.deepEqual(getMetricsConfig({ RIVET_METRICS_ENABLED: 'true' }, 'execution'), {
    enabled: true,
    profile: 'execution',
  });
  assert.deepEqual(getMetricsConfig({ RIVET_METRICS_ENABLED: 'false' }, 'control'), {
    enabled: false,
    profile: 'control',
  });
  assert.throws(
    () => getMetricsConfig({ RIVET_METRICS_ENABLED: 'yes' }, 'execution'),
    /RIVET_METRICS_ENABLED must be true or false/,
  );
});

test('enabled metrics endpoint is pull-only and does not instrument its own scrape', async () => {
  const metrics = new StudioMetrics({ enabled: true, profile: 'execution' });
  const server = await startMetricsServer(metrics);
  try {
    const unknown = await fetch(`${server.baseUrl}/unknown`);
    assert.equal(unknown.status, 404);

    const health = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(health.status, 200);

    const scrape = await fetch(`${server.baseUrl}/metrics`);
    assert.equal(scrape.status, 200);
    assert.equal(scrape.headers.get('cache-control'), 'no-store');
    assert.match(scrape.headers.get('content-type') ?? '', /^text\/plain;/);
    assert.match(scrape.headers.get('content-type') ?? '', /version=0\.0\.4/);
    const body = await scrape.text();
    assert.match(body, /rivet_runtime_liveness\{profile="execution"\} 1/);
    assert.match(body, /rivet_runtime_readiness\{profile="execution"\} 1/);
    assert.match(body, /rivet_runtime_health_check\{check="workflow-storage",profile="execution"\} 1/);
    assert.match(
      body,
      /rivet_http_requests_total\{method="GET",profile="execution",route="other",status_class="4xx"\} 1/,
    );
    assert.doesNotMatch(body, /route="metrics"|route="other",status_class="2xx"/);
  } finally {
    await server.close();
  }
});

test('one unavailable scrape source does not suppress other process-local gauges', async () => {
  const metrics = new StudioMetrics({ enabled: true, profile: 'execution' });
  const app = createApiApp('execution', {
    health: {
      getLiveness: () => {
        throw new Error('health is still starting');
      },
      getReadiness: () => {
        throw new Error('health is still starting');
      },
    },
    metrics,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /rivet_postgres_pool_instances\{profile="execution"\} 0/);
    assert.match(body, /rivet_workflow_recording_persistence_queue_depth\{profile="execution"\} 0/);
    assert.doesNotMatch(body, /health is still starting/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('disabled metrics do not add a scrape route', async () => {
  const metrics = new StudioMetrics({ enabled: false, profile: 'execution' });
  const server = await startMetricsServer(metrics);
  try {
    const response = await fetch(`${server.baseUrl}/metrics`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test('telemetry configuration failures cannot change the object-storage operation being observed', async () => {
  const previous = process.env.RIVET_METRICS_ENABLED;
  process.env.RIVET_METRICS_ENABLED = 'invalid';
  resetStudioMetricsForTests();
  try {
    assert.equal(await observeObjectStorageOperation('workflows', 'get', async () => 'stored value'), 'stored value');
    await assert.rejects(
      observeObjectStorageOperation('workflows', 'get', async () => {
        throw new Error('storage failure');
      }),
      /storage failure/,
    );
  } finally {
    if (previous == null) {
      delete process.env.RIVET_METRICS_ENABLED;
    } else {
      process.env.RIVET_METRICS_ENABLED = previous;
    }
    resetStudioMetricsForTests();
  }
});
