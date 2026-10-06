import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { ScheduledRunStore } from '../scheduled-runs/store.js';
import { projectBundleFixture } from './helpers/project-bundle-fixture.js';
import { getActiveScheduledRunCount } from '../scheduled-runs/activity.js';
import { withAsyncDeadline } from './helpers/workflow-async-process.js';

test('scheduled root uses real cross-project execution and root/child recording wiring', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-scheduled-execution-'));
  const keys = [
    'RIVET_WORKSPACE_ROOT',
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_APP_DATA_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
    'RIVET_RECORDINGS_ENABLED',
    'RIVET_STORAGE_MODE',
    'RIVET_LOCAL_METADATA_CONTROL_ROOT',
    'RIVET_KEY',
  ];
  const previous = keys.map((k) => process.env[k]);
  delete process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
  process.env.RIVET_KEY = 'scheduled-http-fixture-only';
  process.env.RIVET_WORKSPACE_ROOT = root;
  process.env.RIVET_WORKFLOWS_ROOT = path.join(root, 'workflows');
  process.env.RIVET_APP_DATA_ROOT = path.join(root, 'app-data');
  process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = path.join(root, 'recordings');
  process.env.RIVET_RUNTIME_LIBRARIES_ROOT = path.join(root, 'libraries');
  process.env.RIVET_STORAGE_MODE = 'filesystem';
  process.env.RIVET_RECORDINGS_ENABLED = 'true';
  for (const dir of ['workflows', 'app-data', 'recordings', 'libraries']) await fs.mkdir(path.join(root, dir));
  const fixture = projectBundleFixture();
  await fs.writeFile(path.join(root, 'workflows', 'root.rivet-project'), fixture.root.projectContents);
  await fs.writeFile(path.join(root, 'workflows', 'child.rivet-project'), fixture.child.projectContents);
  const storage = await import('../routes/workflows/storage-backend.js');
  const recordings = await import('../routes/workflows/recordings.js');
  const { runScheduledGraph } = await import('../scheduled-runs/runner.js');
  const runtime = await import('../scheduled-runs/runtime.js');
  const store = ScheduledRunStore.sqlite(path.join(root, 'schedules.sqlite'));
  try {
    await storage.initializeWorkflowStorage();
    const schedule = await store.save({
      name: 'Root plus child',
      description: '',
      enabled: false,
      projectId: fixture.root.project.metadata.id,
      version: 'latest',
      timeZone: 'UTC',
      schedule: { kind: 'daily', time: '12:00' },
      record: true,
      timeoutMinutes: 1,
      missed: 'skip',
    });
    await store.runNow(schedule.id, schedule.revision);
    const job = (await store.tick('worker'))!;
    const result = await runScheduledGraph(job, store, 'worker', new AbortController().signal);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.recordingStatus, 'saved');
    assert.ok(result.recordingId);
    await store.finish(job.occurrence.id, 'worker', result);
    await recordings.flushWorkflowExecutionRecordingPersistence();
    const page = await storage.listWorkflowRecordingRunsPageWithBackend('', 1, 20, 'all');
    assert.equal(page.runs.length, 2);
    const primary = page.runs.find((r) => r.executionIdentity?.surface === 'scheduled')!;
    assert.equal(primary.executionIdentity?.scheduleName, schedule.name);
    assert.equal(primary.executionIdentity?.occurrenceId, job.occurrence.id);
    assert.ok(
      page.runs.some(
        (r) =>
          r.executionIdentity?.surface === 'subgraph_project' &&
          r.executionIdentity.correlationId === job.occurrence.id,
      ),
    );
    const disabled = await store.save({ ...schedule, record: false }, schedule.id, schedule.revision);
    await store.runNow(disabled.id, disabled.revision);
    const second = (await store.tick('worker'))!;
    const outcome = await runScheduledGraph(second, store, 'worker', new AbortController().signal);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.recordingStatus, 'off');
    await store.finish(second.occurrence.id, 'worker', outcome);
    await recordings.flushWorkflowExecutionRecordingPersistence();
    assert.equal((await storage.listWorkflowRecordingRunsPageWithBackend('', 1, 20, 'all')).runs.length, 2);
    const marker = path.join(root, 'app-data', 'vm-migration-maintenance.json');
    await fs.writeFile(marker, JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }));
    await runtime.initializeScheduledRuns();
    assert.throws(() => runtime.getScheduledRunService(), /unavailable/);
    await assert.rejects(() => fs.stat(path.join(root, 'app-data', 'scheduled-runs.sqlite')), { code: 'ENOENT' });
    await fs.unlink(marker);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        runtime.getScheduledRunService();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(50);
      }
    }
    const { scheduledRunsRouter } = await import('../scheduled-runs/router.js');
    const { getExpectedProxyAuthToken } = await import('../auth.js');
    const app = express();
    app.use('/schedules', scheduledRunsRouter);
    app.use(((error, _req, res, _next) =>
      res.status(error.status ?? 500).json({ error: error.message })) as ErrorRequestHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/schedules`;
    try {
      assert.equal((await fetch(base)).status, 403);
      const headers = { 'X-Rivet-Proxy-Auth': getExpectedProxyAuthToken(), 'Content-Type': 'application/json' };
      assert.equal((await fetch(base, { headers })).status, 200);
      const createBody = { requestId: randomUUID(), draft: { ...disabled, name: 'API schedule', enabled: true } };
      const response = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify(createBody),
      });
      assert.equal(response.status, 201);
      const saved = await response.json();
      const repeated = await fetch(base, { method: 'POST', headers, body: JSON.stringify(createBody) });
      assert.equal(repeated.status, 201);
      assert.equal((await repeated.json()).id, saved.id);
      assert.equal(
        (
          await fetch(base, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...createBody, draft: { ...createBody.draft, name: 'Conflict' } }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${base}/${saved.id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ draft: disabled, revision: 0 }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${base}/${saved.id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ draft: disabled, revision: 99 }),
          })
        ).status,
        409,
      );
      assert.equal(
        (await fetch(base + '/preview', { method: 'POST', headers, body: JSON.stringify({ ...disabled, input: [] }) }))
          .status,
        400,
      );
      assert.equal(
        (
          await fetch(base + '/preview', {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...disabled, input: { large: 'x'.repeat(2 * 1024 * 1024) } }),
          })
        ).status,
        413,
      );
      assert.equal(
        (
          await fetch(`${base}/${saved.id}`, {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ revision: saved.revision }),
          })
        ).status,
        204,
      );
      // A disconnected browser must not release the migration drain while its
      // accepted mutation is still committing. No real IO delays are needed.
      const runtimeStore = runtime.getScheduledRunService().store;
      const originalSave = runtimeStore.save.bind(runtimeStore);
      let releaseCommit!: () => void;
      let enteredCommit!: () => void;
      const entered = new Promise<void>((resolve) => (enteredCommit = resolve));
      const held = new Promise<void>((resolve) => (releaseCommit = resolve));
      runtimeStore.save = async (...args) => {
        enteredCommit();
        await held;
        return originalSave(...args);
      };
      const controller = new AbortController();
      const disconnected = fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId: randomUUID(), draft: { ...disabled, name: 'Disconnected commit' } }),
        signal: controller.signal,
      });
      // Attach rejection handling before aborting, including assertion failures.
      const responseSettled = disconnected.catch(() => undefined);
      try {
        await withAsyncDeadline(entered, 'schedule mutation entering commit');
        controller.abort();
        await responseSettled;
        await fs.writeFile(marker, JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }));
        assert.ok(getActiveScheduledRunCount() >= 1);
        const { localStorageDrainSnapshot } = await import('../vm-migration-service.js');
        const drain = await localStorageDrainSnapshot();
        assert.equal(drain.ready, false);
        assert.ok(drain.blockers.includes('Scheduled runs'));
        assert.equal(
          (
            await fetch(`${base}/${saved.id}/run`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ revision: saved.revision, requestId: randomUUID() }),
            })
          ).status,
          409,
        );
        assert.ok(getActiveScheduledRunCount() >= 1);
        releaseCommit();
        await withAsyncDeadline(
          (async () => {
            while (getActiveScheduledRunCount()) await delay(1);
          })(),
          'disconnected mutation releasing drain',
        );
        assert.ok((await runtimeStore.list()).schedules.some((s) => s.name === 'Disconnected commit'));
      } finally {
        controller.abort();
        releaseCommit();
        runtimeStore.save = originalSave;
        await fs.unlink(marker);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    await runtime.stopScheduledRuns(0);
    await store.close();
    await storage.disposeWorkflowStorage();
    await recordings.resetWorkflowRecordingStorageForTests();
    for (let i = 0; i < keys.length; i++) {
      if (previous[i] === undefined) delete process.env[keys[i]!];
      else process.env[keys[i]!] = previous[i];
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
