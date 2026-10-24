import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphExecutionMetadata, ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { createProjectBindingRegistry, type ProjectBindingSpec } from './projectBindingRegistry.js';

import { getExecutionBundleKey } from './bundleMembership.js';
import {
  bindExecutionTerminal,
  normalizeExecutionEvent,
  type ExecutionSourceKind,
} from './executionEventNormalization.js';
import { createExecutionObservationCoordinator } from './executionObservationCoordinator.js';
import { createLocalExecutionObservationRouter } from './localExecutionObservation.js';

test('closing prototype-named IDs removes their binding and reopening cannot inherit its token', () => {
  for (const id of ['constructor', '__proto__', 'toString']) {
    const registry = createProjectBindingRegistry();
    registry.reconcile({ [id]: { path: 'project.rivet-project' } });
    const old = registry.get(id)!;
    registry.reconcile({});
    assert.equal(registry.get(id), undefined);
    assert.equal(registry.isCurrent(id, old.token), false);
    registry.reconcile({ [id]: { path: 'project.rivet-project' } });
    assert.notEqual(registry.get(id)!.token, old.token);
  }
});

test('binding lifetimes change only at close, rebind, membership or explicit replacement boundaries', () => {
  const registry = createProjectBindingRegistry();
  const original = { a: { path: '/a', bundleKey: 'bundle' } };
  registry.reconcile(original);
  const first = registry.get('a')!;
  registry.reconcile(structuredClone(original));
  assert.equal(registry.get('a'), first, 'ordinary save/title/tab selection must not renew a lifetime');
  const changes: Record<string, ProjectBindingSpec>[] = [
    { a: { path: '/b', bundleKey: 'bundle' } },
    { a: { path: '/a', bundleKey: 'other' } },
    {},
  ];
  for (const change of changes) {
    registry.reconcile(change);
    registry.reconcile(original);
    assert.notEqual(registry.get('a')!.token, first.token);
  }
  const beforeReload = registry.get('a')!.token;
  registry.renew('a');
  assert.equal(registry.isCurrent('a', beforeReload), false);
  const beforeDisposal = registry.get('a')!.token;
  const workspace = registry.getWorkspaceToken();
  registry.invalidateWorkspace();
  assert.equal(registry.isCurrent('a', beforeDisposal), false);
  assert.equal(registry.get('a')!.path, '/a');
  assert.ok(registry.getWorkspaceToken() > workspace);
  registry.dispose();
  assert.equal(registry.capture().size, 0);
  registry.reconcile(original);
  assert.ok(registry.get('a')!.token > beforeReload);
  assert.equal(getExecutionBundleKey({ bundleManifestPath: '/old', hostedBundleKey: null }), undefined);
});

test('every adapter distinguishes outputs/abort/display terminal from actual settlement without changing payloads', () => {
  const kinds: ExecutionSourceKind[] = ['browser', 'desktop-node', 'hosted-node', 'remote-debugger', 'recording'];
  for (const kind of kinds)
    for (const [message, lifecycle] of [
      ['graphOutputsReady', 'outputs-ready'],
      ['graphAbort', 'abort-requested'],
      ['done', 'display-terminal'],
      ['error', 'display-terminal'],
      ['graphFinish', 'display-terminal'],
      ['nodeFinish', 'event'],
    ] as const) {
      const data = { execution: { projectId: 'a', rootRunId: 'r', graphRunId: 'g' }, outputs: {} } as never;
      const envelope = normalizeExecutionEvent({ source: {}, kind, sourceProjectId: 'a', message, data });
      assert.equal(envelope.lifecycle, lifecycle);
      assert.equal(envelope.settlement, 'unknown');
      assert.equal(envelope.data, data);
      assert.equal(envelope.origin, kind === 'recording' ? 'recording' : 'live');
    }
  assert.equal(
    normalizeExecutionEvent({
      source: {},
      kind: 'remote-debugger',
      sourceProjectId: 'a',
      message: 'trace',
      data: 'test',
      origin: 'reconnect',
    }).origin,
    'reconnect',
  );
});

test('identity-free browser terminals use only the captured processor root, never the selected tab or another root', () => {
  const root = { projectId: 'a', rootRunId: 'root-a', graphRunId: 'graph-a' } as GraphExecutionMetadata;
  const raw = { results: {} };
  const scoped = bindExecutionTerminal(raw, root) as typeof raw & { execution: GraphExecutionMetadata };
  assert.equal(scoped.execution, root);
  assert.equal(scoped.results, raw.results);
  assert.equal(Object.hasOwn(raw, 'execution'), false, 'recorded payload remains untouched');
  assert.equal(bindExecutionTerminal(raw, undefined), raw, 'no identity is fabricated without a captured root');
  const identified = { ...raw, execution: { ...root, rootRunId: 'different-root' } };
  assert.equal(bindExecutionTerminal(identified, root), identified, 'existing identity is authoritative');
});

for (const kind of ['browser', 'desktop-node', 'hosted-node'] as const)
  test(`${kind} uses the same root-captured policy, original activity ancestry, and explicit cleanup`, () => {
    const coordinator = createExecutionObservationCoordinator();
    const router = createLocalExecutionObservationRouter(coordinator);
    const registry = createProjectBindingRegistry();
    registry.reconcile({ a: { bundleKey: 'bundle' }, b: { bundleKey: 'bundle' }, c: { bundleKey: 'other' } });
    const conflicts = new Set<string>();
    const projected: Array<{
      data: { execution: GraphExecutionMetadata };
      activityData: { execution: GraphExecutionMetadata };
    }> = [];
    const settled: string[] = [];
    const source = {};
    const options = {
      bindings: registry.capture,
      conflict: (id: ProjectId) => conflicts.has(id),
      project: (_id: ProjectId, _message: keyof ProcessEventMessageMap, data: unknown, activityData: unknown) => {
        projected.push({
          data: data as { execution: GraphExecutionMetadata },
          activityData: activityData as { execution: GraphExecutionMetadata },
        });
      },
      settle: (id: ProjectId, root: string, status: string) => {
        settled.push(`${id}:${root}:${status}`);
      },
    };
    const emit = (message: keyof ProcessEventMessageMap, owner = 'a', root = 'root') =>
      router.receive(
        'a' as ProjectId,
        message,
        {
          execution: {
            projectId: owner,
            rootRunId: root,
            graphRunId: `${owner}-${root}`,
            graphId: owner,
            ...(owner !== 'a'
              ? { projectScope: owner, parentGraphRunId: `a-${root}`, executor: { nodeId: 'caller' } }
              : {}),
          },
        } as never,
        options,
        source,
        kind,
      );
    emit('start');
    conflicts.add('b');
    router.reconcile(options);
    conflicts.delete('b');
    emit('graphStart', 'b');
    assert.equal(projected.length, 0, 'transient pre-child conflict is sticky');
    emit('graphOutputsReady');
    emit('graphAbort');
    assert.equal(coordinator.inspect().roots, 1, 'early results and cancellation do not release fences');
    emit('graphFinish');
    emit('nodeFinish', 'b');
    assert.equal(projected.length, 0);
    emit('start', 'a', 'next');
    emit('graphStart', 'b', 'next');
    assert.equal(projected.length, 1, 'next root can observe the released tab');
    assert.equal(projected[0]!.data.execution.parentGraphRunId, undefined);
    assert.equal(projected[0]!.activityData.execution.parentGraphRunId, 'a-next');
    emit('nodeFinish', 'c', 'next');
    assert.equal(projected.length, 1, 'foreign bundles never receive display');
    registry.renew('b');
    emit('nodeFinish', 'b', 'next');
    assert.equal(projected.length, 1, 'same-path reload rejects old events');
    // Source closure interrupts only the still-current receivers; a rebound B
    // must not have its new history changed by old-source cleanup.
    registry.reconcile({ b: registry.get('b')!, c: registry.get('c')! });
    router.settle(source, options);
    assert.deepEqual(settled, []);
    assert.equal(coordinator.inspect().roots, 0);
    assert.deepEqual(router.inspect(), { sources: 0, roots: 0 });
  });

test('source disposal interrupts current receiver evidence without requiring the source tab to remain open', () => {
  const router = createLocalExecutionObservationRouter();
  const registry = createProjectBindingRegistry();
  registry.reconcile({ a: { bundleKey: 'bundle' }, b: { bundleKey: 'bundle' } });
  const source = {};
  const settled: string[] = [];
  const options = {
    bindings: registry.capture,
    conflict: () => false,
    project: () => {},
    settle: (id: ProjectId, root: string, status: string) => {
      settled.push(`${id}:${root}:${status}`);
    },
  };
  for (const owner of ['a', 'b'])
    router.receive(
      'a' as ProjectId,
      owner === 'a' ? 'start' : 'graphStart',
      {
        execution: {
          projectId: owner,
          rootRunId: 'root',
          graphRunId: owner,
          ...(owner === 'b' ? { parentGraphRunId: 'a' } : {}),
        },
      } as never,
      options,
      source,
    );
  registry.reconcile({ b: { bundleKey: 'bundle' } });
  router.settle(source, options);
  assert.deepEqual(settled, ['b:root:aborted']);
  assert.deepEqual(router.inspect(), { sources: 0, roots: 0 });
});

test('thousands of concurrent lifecycle sequences retain live fences and release all metadata on disposal', () => {
  const coordinator = createExecutionObservationCoordinator();
  const registry = createProjectBindingRegistry();
  registry.reconcile({ a: {}, b: {} });
  const source = {};
  const held = coordinator.capture(source, 'held', 'a', registry.capture(), (id) => id === 'b');
  for (let i = 0; i < 5000; i++) {
    const admission = coordinator.capture(source, `root-${i}`, 'a', registry.capture(), () => false);
    assert.equal(
      coordinator.check(admission, `root-${i}`, 'b', registry.get, () => false),
      undefined,
    );
    coordinator.settle(source, `root-${i}`);
    assert.equal(
      coordinator.check(held, 'held', 'b', registry.get, () => false),
      'ownership-conflict',
    );
  }
  assert.equal(coordinator.inspect().roots, 1);
  assert.equal(coordinator.inspect().diagnostics.length, 64);
  assert.ok(
    coordinator
      .inspect()
      .diagnostics.every(
        (entry) =>
          Object.keys(entry).sort().join() ===
          'bindingToken,currentBindingToken,projectId,reason,root,sourceKind,sourceProjectId',
      ),
  );
  coordinator.disconnect(source);
  assert.equal(coordinator.inspect().roots, 0);
  coordinator.dispose();
  assert.deepEqual(coordinator.inspect(), { sources: 0, roots: 0, diagnostics: [] });
});

test('seeded lifetime sequences preserve sticky conflicts and never revive a retired receiver', () => {
  for (let seed = 1; seed <= 16; seed++) {
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const registry = createProjectBindingRegistry();
    registry.reconcile({ a: {}, b: {} });
    const coordinator = createExecutionObservationCoordinator();
    const source = {};
    let conflict = false;
    const roots = new Map<string, { admission: ReturnType<typeof coordinator.capture>; eligible: boolean }>();
    for (let step = 0; step < 128; step++) {
      const command = next() % 6;
      if (command === 0 || roots.size === 0) {
        const root = `${seed}:${step}`;
        roots.set(root, {
          admission: coordinator.capture(source, root, 'a', registry.capture(), () => conflict),
          eligible: !conflict,
        });
      } else if (command === 1) {
        conflict = !conflict;
        if (conflict) for (const run of roots.values()) run.eligible = false;
      } else if (command === 2 || command === 3) {
        if (command === 2) registry.renew('b');
        else registry.invalidateWorkspace();
        for (const run of roots.values()) run.eligible = false;
      } else if (command === 4) {
        const root = roots.keys().next().value!;
        coordinator.settle(source, root);
        roots.delete(root);
      }
      // Ownership transitions are reconciled between frames, including a
      // conflict that vanishes before the next actual child event.
      for (const [root, run] of roots) {
        const reason = coordinator.check(run.admission, root, 'b', registry.get, () => conflict);
        assert.equal(!reason, run.eligible, `seed ${seed}, step ${step}, root ${root}`);
      }
      assert.equal(coordinator.inspect().roots, roots.size);
    }
    coordinator.disconnect(source);
    assert.equal(coordinator.inspect().roots, 0);
  }
});
