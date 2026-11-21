import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import { createDeferred } from './helpers/managed-backend-harness.js';
import { withAsyncDeadline } from './helpers/workflow-async-process.js';
import { getPublishedExecutionAdmission } from '../published-execution-admission.js';
import { abortActiveHttpExecutions, getActiveHttpExecutionCount } from '../active-http-executions.js';
import { writeWorkflowEndpointAuthSettings } from '../workflow-endpoint-auth-settings.js';
import type { WorkflowPublishedExecutionTarget } from '../routes/workflows/data-backend.js';

process.env.RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE = 'enforce';
process.env.RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS = '32';
process.env.RIVET_KEY = 'local-admission-test';
const suite = await createFilesystemWorkflowSuiteHarness();
const admission = getPublishedExecutionAdmission();
const headers = { Authorization: 'Bearer local-admission-test' };

test.beforeEach(async () => {
  await suite.resetAndEnsureWorkflowsRoot();
  admission.setMaxActiveRuns(32);
});
test.afterEach(() => {
  assert.equal(admission.getSnapshot().activeRuns, 0, 'No request may leak its execution slot.');
  assert.equal(getActiveHttpExecutionCount(), 0);
});
test.after(suite.cleanupWorkflowSuite);

async function publish(name = 'admission') {
  const project = await suite.workflowMutations.createWorkflowProjectItem('', name);
  await suite.workflowStorageBackend.publishWorkflowProjectItemWithBackend(project.relativePath, { endpointName: name });
  return project;
}

test('saturation preserves authentication and 404s while skipping all rejected materializations', async (t) => {
  await publish();
  const privateProject = await publish('private');
  await suite.workflowStorageBackend.updateWorkflowEndpointAccessWithBackend(privateProject.relativePath, 'internal');
  await writeWorkflowEndpointAuthSettings({ requireBearerAuth: true });
  await suite.withWorkflowExecutionServer(async ({ publishedBaseUrl }) => {
    const cache = suite.filesystemExecutionCache.getFilesystemExecutionCache();
    const resolve = cache.resolvePublishedExecutionTarget.bind(cache);
    let lookups = 0;
    let loads = 0;
    t.mock.method(cache, 'resolvePublishedExecutionTarget', async (...args: Parameters<typeof resolve>) => {
      lookups++;
      const target = await resolve(...args);
      return target && { ...target, load: () => { loads++; return target.load(); } };
    });
    const held = Array.from({ length: 32 }, () => admission.acquire('workflow-endpoint'));
    try {
      assert.ok(held.every((entry) => entry.kind === 'accepted'));
      const responses = await Promise.all(Array.from({ length: 64 }, () =>
        fetch(`${publishedBaseUrl}/admission`, { method: 'POST', headers })));
      for (const response of responses) {
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '1');
        assert.equal((await response.json()).error.code, 'execution_capacity_exceeded');
      }
      assert.equal(lookups, 64);
      assert.equal(loads, 0);
      const unauthorized = await fetch(`${publishedBaseUrl}/admission`, { method: 'POST' });
      assert.equal(unauthorized.status, 401);
      await unauthorized.arrayBuffer();
      assert.equal(lookups, 64, 'Authentication precedes storage and execution admission.');
      for (const endpoint of ['missing', 'private']) {
        const response = await fetch(`${publishedBaseUrl}/${endpoint}`, { method: 'POST', headers });
        assert.equal(response.status, 404);
        await response.arrayBuffer();
      }
      assert.equal(loads, 0, 'Private endpoints do not materialize even at full capacity.');
    } finally {
      for (const entry of held) if (entry.kind === 'accepted') entry.permit.release();
    }
    const accepted = await fetch(`${publishedBaseUrl}/admission`, { method: 'POST', headers });
    assert.equal(accepted.status, 200);
    await accepted.arrayBuffer();
    assert.equal(loads, 1);
  });
});

test('preparation counts against the live limit and shutdown registry', async (t) => {
  await publish();
  admission.setMaxActiveRuns(1);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let loads = 0;
  await suite.withWorkflowExecutionServer(async ({ publishedBaseUrl }) => {
    t.mock.method(suite.filesystemExecutionCache.getFilesystemExecutionCache(), 'resolvePublishedExecutionTarget', async () => ({
      endpointAccess: 'public',
      load: async () => {
        if (++loads === 1) {
          entered.resolve();
          await release.promise;
        }
        return null;
      },
    } satisfies WorkflowPublishedExecutionTarget));
    const first = fetch(`${publishedBaseUrl}/admission`, { method: 'POST' });
    try {
      await withAsyncDeadline(entered.promise, 'published project preparation');
      assert.equal(admission.getSnapshot().activeRuns, 1);
      assert.equal(getActiveHttpExecutionCount(), 1);
      const rejected = await fetch(`${publishedBaseUrl}/admission`, { method: 'POST' });
      assert.equal(rejected.status, 429);
      await rejected.arrayBuffer();
      assert.equal(loads, 1);
      admission.setMaxActiveRuns(2);
      const admitted = await fetch(`${publishedBaseUrl}/admission`, { method: 'POST' });
      assert.equal(admitted.status, 404);
      await admitted.arrayBuffer();
      assert.equal(loads, 2);
      assert.equal(admission.getSnapshot().activeRuns, 1);
    } finally {
      release.resolve();
      const response = await first;
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    }
  });
});

test('missing, newly private and failed preparation release the permit before the next request', async (t) => {
  await publish();
  admission.setMaxActiveRuns(1);
  await suite.withWorkflowExecutionServer(async ({ publishedBaseUrl, internalPublishedBaseUrl }) => {
    const cache = suite.filesystemExecutionCache.getFilesystemExecutionCache();
    const actual = await cache.loadPublishedExecutionProject(suite.workflowsRoot, 'admission');
    assert.ok(actual);
    let result: 'missing' | 'private' | 'error' | 'invalid' | 'aborted' = 'missing';
    t.mock.method(cache, 'resolvePublishedExecutionTarget', async () => ({
      endpointAccess: 'public',
      load: async () => {
        assert.equal(admission.getSnapshot().activeRuns, 1);
        if (result === 'error') throw new Error('Storage unavailable');
        if (result === 'missing') return null;
        if (result === 'aborted') {
          assert.equal(abortActiveHttpExecutions(), 1);
          return actual;
        }
        return result === 'invalid'
          ? { ...actual, project: { ...actual.project, metadata: { ...actual.project.metadata, mainGraphId: undefined } } }
          : { ...actual, endpointAccess: 'internal' };
      },
    } satisfies WorkflowPublishedExecutionTarget));
    for (result of ['missing', 'private', 'error', 'invalid', 'aborted'] as const) {
      const response = await fetch(`${publishedBaseUrl}/admission`, { method: 'POST' });
      assert.equal(response.status, result === 'missing' || result === 'private' ? 404 : 500);
      await response.arrayBuffer();
      assert.equal(admission.getSnapshot().activeRuns, 0);
      assert.equal(getActiveHttpExecutionCount(), 0);
    }
    result = 'private';
    const internal = await fetch(`${internalPublishedBaseUrl}/admission`, { method: 'POST' });
    assert.equal(internal.status, 200, 'Internal routing retains access to private endpoints.');
    await internal.arrayBuffer();
  });
});

test('draining rejects before materialization and keeps its existing retry response', async (t) => {
  await publish();
  await suite.withWorkflowExecutionServer(async ({ publishedBaseUrl }) => {
    t.mock.method(suite.filesystemExecutionCache.getFilesystemExecutionCache(), 'resolvePublishedExecutionTarget', async () => ({
      endpointAccess: 'public',
      load: async () => assert.fail('Draining must not start project preparation.'),
    } satisfies WorkflowPublishedExecutionTarget));
    admission.beginDrain();
    const response = await fetch(`${publishedBaseUrl}/admission`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal((await response.json()).error.code, 'execution_draining');
  });
});
