import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVALUATION_LIBRARY_INVALIDATION_CHANNEL,
  evaluationLibrarySourceInstanceId,
} from '../evaluation-runs/library-invalidation.js';

import {
  ManagedWorkflowExecutionInvalidationController,
  MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL,
  MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_PRUNE_INTERVAL,
  MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_RETENTION_MS,
} from '../routes/workflows/managed/execution-invalidation.js';
import { DeferredConnectListener, FakeListener } from './helpers/managed-backend-harness.js';

function createController(options: {
  now?: () => number;
  createListener?: () => FakeListener;
  scheduleReconnect?: (task: () => void, delayMs: number) => { unref?(): void };
  invalidated?: string[];
  cleared?: { count: number };
  policyInvalidated?: string[];
  allPoliciesInvalidated?: { count: number };
  onExternalInvalidation?: () => void;
  onEvaluationLibraryChanged?: (revision: number | null) => void;
}) {
  const invalidated = options.invalidated ?? [];
  const cleared = options.cleared ?? { count: 0 };
  const policyInvalidated = options.policyInvalidated ?? [];
  const allPoliciesInvalidated = options.allPoliciesInvalidated ?? { count: 0 };
  const controller = new ManagedWorkflowExecutionInvalidationController({
    databaseConnectionConfig: {},
    withManagedDbRetry: async (_scope, run) => run(),
    invalidateWorkflowEndpointPointers: (workflowId) => {
      invalidated.push(workflowId);
    },
    clearEndpointPointers: () => {
      cleared.count += 1;
    },
    onWorkflowChanged: (workflowId) => {
      policyInvalidated.push(workflowId);
    },
    onAllChanged: () => {
      allPoliciesInvalidated.count += 1;
    },
    now: options.now,
    createListener: options.createListener,
    onExternalInvalidation: options.onExternalInvalidation,
    onEvaluationLibraryChanged: options.onEvaluationLibraryChanged,
    scheduleReconnect: options.scheduleReconnect,
  });

  return {
    controller,
    invalidated,
    cleared,
    policyInvalidated,
    allPoliciesInvalidated,
  };
}

test('workflow-level invalidation increments only the targeted workflow generation', () => {
  let now = 1_000;
  const { controller, invalidated, cleared } = createController({
    now: () => now,
  });

  const before = controller.captureResolveSnapshot();
  controller.markWorkflowChanged('workflow-a');
  const after = controller.captureResolveSnapshot();

  assert.equal(after.anyGeneration, before.anyGeneration + 1);
  assert.equal(controller.captureWorkflowSnapshot('workflow-a').generation, 1);
  assert.equal(controller.captureWorkflowSnapshot('workflow-b').generation, 0);
  assert.deepEqual(invalidated, ['workflow-a']);
  assert.equal(cleared.count, 0);
});

test('catalog notifications refresh remote trees without evicting published execution caches or echoing local writes', async () => {
  const listener = new FakeListener();
  let external = 0;
  const { controller, invalidated, cleared, policyInvalidated, allPoliciesInvalidated } = createController({
    // Resolve snapshots include their capture time; compare cache state under a controlled clock.
    now: () => 1_000,
    createListener: () => listener,
    onExternalInvalidation: () => {
      external++;
    },
  });
  await controller.initialize();
  const before = controller.captureResolveSnapshot();
  let notification: { eventType: string; sourceInstanceId: string } | undefined;
  await controller.queueCatalogInvalidation({
    query: async (_sql: string, params: unknown[]) => {
      notification = JSON.parse(String(params[1]));
    },
  } as never);
  assert.equal(notification?.eventType, 'catalog-changed');
  listener.emitNotification(notification);
  assert.equal(external, 1);
  listener.emitNotification({ ...notification, sourceInstanceId: 'other-owner' });
  assert.equal(external, 2);
  assert.deepEqual(controller.captureResolveSnapshot(), before);
  assert.deepEqual(invalidated, []);
  assert.equal(cleared.count, 0);
  assert.deepEqual(policyInvalidated, []);
  assert.equal(allPoliciesInvalidated.count, 0);
  await controller.dispose();
});

test('cross-owner and recovered notifications refresh HA observers without a second listener or local echo', async () => {
  const listener = new FakeListener();
  let external = 0;
  const { controller } = createController({
    createListener: () => listener,
    onExternalInvalidation: () => {
      external++;
    },
  });
  await controller.initialize();
  assert.equal(external, 1);
  controller.markWorkflowChanged('local');
  assert.equal(external, 1);
  listener.emitNotification({ eventType: 'workflow-changed', workflowId: 'remote', sourceInstanceId: 'other-owner' });
  assert.equal(external, 2);
  assert.equal(controller.captureWorkflowSnapshot('remote').generation, 1);
  await controller.dispose();
});

test('evaluation edits share the listener, suppress local echoes and reset observers across a notification gap', async () => {
  const listener = new FakeListener();
  const revisions: Array<number | null> = [];
  const { controller, invalidated } = createController({
    createListener: () => listener,
    onEvaluationLibraryChanged: (revision) => {
      revisions.push(revision);
    },
    scheduleReconnect: () => ({}),
  });
  await controller.initialize();
  assert.equal(listener.queries.filter((q) => q.text.startsWith('LISTEN ')).length, 2);
  assert.deepEqual(revisions, [null]);
  listener.emitNotification(
    { revision: 4, sourceInstanceId: 'another-editor' },
    EVALUATION_LIBRARY_INVALIDATION_CHANNEL,
  );
  listener.emitNotification(
    { revision: 5, sourceInstanceId: evaluationLibrarySourceInstanceId },
    EVALUATION_LIBRARY_INVALIDATION_CHANNEL,
  );
  listener.emitNotification(
    { revision: -1, sourceInstanceId: 'another-editor' },
    EVALUATION_LIBRARY_INVALIDATION_CHANNEL,
  );
  assert.deepEqual(revisions, [null, 4]);
  assert.deepEqual(invalidated, []);
  listener.emitError(new Error('notification connection lost'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(revisions, [null, 4, null]);
  await controller.dispose();
});

test('non-HA listeners do not allocate an evaluation subscription', async () => {
  const listener = new FakeListener();
  const { controller } = createController({ createListener: () => listener });
  await controller.initialize();
  assert.deepEqual(
    listener.queries.map((q) => q.text),
    [`LISTEN ${MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL}`],
  );
  await controller.dispose();
});

test('managed invalidation notifies targeted web-app policy listeners without forcing unrelated workflows', () => {
  const { controller, policyInvalidated, allPoliciesInvalidated } = createController({});

  controller.markWorkflowChanged('workflow-a');

  assert.deepEqual(policyInvalidated, ['workflow-a']);
  assert.equal(allPoliciesInvalidated.count, 0);

  controller.markAllChanged();

  assert.deepEqual(policyInvalidated, ['workflow-a']);
  assert.equal(allPoliciesInvalidated.count, 1);
});

test('clear-all invalidation forces retry through global generation change', () => {
  let now = 1_000;
  const { controller } = createController({
    now: () => now,
  });

  controller.markWorkflowChanged('workflow-a');
  const resolveSnapshot = controller.captureResolveSnapshot();
  const workflowSnapshot = controller.captureWorkflowSnapshot('workflow-a');

  now += 1;
  controller.markAllChanged();

  assert.equal(controller.shouldRetryAfterResolve(resolveSnapshot, 'workflow-a'), true);
  assert.equal(controller.shouldRetryAfterMaterialize(resolveSnapshot, 'workflow-a', workflowSnapshot), true);
});

test('active workflow loads protect generation pruning until the load completes', () => {
  let now = 1_000;
  const { controller } = createController({
    now: () => now,
  });

  controller.markWorkflowChanged('workflow-a');
  controller.beginWorkflowLoad('workflow-a');
  now += MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_RETENTION_MS + 1;

  for (let index = 0; index < MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_PRUNE_INTERVAL; index += 1) {
    controller.markWorkflowChanged(`workflow-${index}`);
  }

  assert.equal(controller.captureWorkflowSnapshot('workflow-a').generation, 1);

  controller.endWorkflowLoad('workflow-a');
  now += MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_RETENTION_MS + 1;
  for (let index = 0; index < MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_PRUNE_INTERVAL; index += 1) {
    controller.markWorkflowChanged(`workflow-next-${index}`);
  }

  assert.equal(controller.captureWorkflowSnapshot('workflow-a').generation, 0);
});

test('generation pruning removes sufficiently old inactive workflows only', () => {
  let now = 1_000;
  const { controller } = createController({
    now: () => now,
  });

  controller.markWorkflowChanged('old-workflow');
  controller.markWorkflowChanged('fresh-workflow');
  now += MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_RETENTION_MS + 1;
  controller.markWorkflowChanged('fresh-workflow');

  for (let index = 0; index < MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_PRUNE_INTERVAL - 3; index += 1) {
    controller.markWorkflowChanged(`workflow-${index}`);
  }

  assert.equal(controller.captureWorkflowSnapshot('old-workflow').generation, 0);
  assert.equal(controller.captureWorkflowSnapshot('fresh-workflow').generation, 2);
});

test('listener degradation disables pointer-cache health until a fresh listener session is established', async () => {
  const listenerOne = new FakeListener();
  const listenerTwo = new FakeListener();
  const listeners = [listenerOne, listenerTwo];
  let scheduledReconnect: (() => void) | null = null;
  const { controller, cleared } = createController({
    createListener: () => {
      const listener = listeners.shift();
      assert.ok(listener);
      return listener;
    },
    scheduleReconnect: (task) => {
      scheduledReconnect = task;
      return {};
    },
  });

  await controller.initialize();
  assert.equal(controller.isPointerCacheHealthy(), true);

  listenerOne.emitError(new Error('boom'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.isPointerCacheHealthy(), false);
  assert.equal(cleared.count >= 1, true);
  assert.ok(scheduledReconnect);

  const reconnectTask: () => void =
    scheduledReconnect ??
    (() => {
      throw new Error('expected reconnect task to be scheduled');
    });
  reconnectTask();
  assert.equal(controller.isPointerCacheHealthy(), false);
  await controller.initialize();

  assert.equal(controller.isPointerCacheHealthy(), true);
});

test('self notifications are ignored because same-process invalidation already ran on commit', async () => {
  const listener = new FakeListener();
  const invalidated: string[] = [];
  const { controller } = createController({
    createListener: () => listener,
    invalidated,
  });
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const commitTasks: Array<() => Promise<void>> = [];

  await controller.initialize();
  await controller.queueWorkflowInvalidation(
    {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
      },
    } as any,
    {
      onCommit(task) {
        commitTasks.push(task);
      },
    },
    'workflow-a',
  );

  const payload = JSON.parse(String(queries[0]?.values?.[1] ?? '{}')) as {
    eventType?: string;
    workflowId?: string;
    sourceInstanceId?: string;
  };

  await commitTasks[0]?.();
  assert.deepEqual(invalidated, ['workflow-a']);

  listener.emitNotification(payload);
  assert.deepEqual(invalidated, ['workflow-a']);
});

test('a notification from another managed instance notifies the affected web-app policy listeners', async () => {
  const listener = new FakeListener();
  const { controller, policyInvalidated } = createController({
    createListener: () => listener,
  });

  await controller.initialize();
  listener.emitNotification({
    eventType: 'workflow-changed',
    workflowId: 'workflow-on-another-instance',
    sourceInstanceId: 'other-instance',
  });

  assert.deepEqual(policyInvalidated, ['workflow-on-another-instance']);
});

test('dispose keeps an in-flight listener startup from becoming healthy afterward', async () => {
  const listener = new DeferredConnectListener();
  let reconnectScheduled = 0;
  const { controller } = createController({
    createListener: () => listener,
    scheduleReconnect: () => {
      reconnectScheduled += 1;
      return {};
    },
  });

  const initializePromise = controller.initialize();
  await Promise.resolve();

  await controller.dispose();
  listener.resolveConnect();
  await initializePromise;

  assert.equal(controller.isPointerCacheHealthy(), false);
  assert.equal(listener.ended, true);
  assert.equal(reconnectScheduled, 0);
});

test('queueWorkflowInvalidation emits pg_notify inside the transaction and invalidates locally on commit', async () => {
  const { controller, invalidated } = createController({});
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const commitTasks: Array<() => Promise<void>> = [];

  await controller.queueWorkflowInvalidation(
    {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
      },
    } as any,
    {
      onCommit(task) {
        commitTasks.push(task);
      },
    },
    'workflow-a',
  );

  assert.equal(queries.length, 1);
  assert.match(queries[0]?.text ?? '', /pg_notify/);
  assert.equal(typeof JSON.parse(String(queries[0]?.values?.[1] ?? '{}')).sourceInstanceId, 'string');
  assert.deepEqual(invalidated, []);

  await commitTasks[0]?.();
  assert.deepEqual(invalidated, ['workflow-a']);
});

test('queueGlobalInvalidation emits pg_notify inside the transaction and clears locally on commit', async () => {
  const { controller, cleared } = createController({});
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const commitTasks: Array<() => Promise<void>> = [];

  await controller.queueGlobalInvalidation(
    {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
      },
    } as any,
    {
      onCommit(task) {
        commitTasks.push(task);
      },
    },
  );

  assert.equal(queries.length, 1);
  assert.match(queries[0]?.text ?? '', /pg_notify/);
  assert.equal(typeof JSON.parse(String(queries[0]?.values?.[1] ?? '{}')).sourceInstanceId, 'string');
  assert.equal(cleared.count, 0);

  await commitTasks[0]?.();
  assert.equal(cleared.count, 1);
});
