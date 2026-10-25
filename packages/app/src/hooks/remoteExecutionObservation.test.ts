import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphExecutionMetadata, ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { getSubgraphProjectKey } from '@valerypopoff/rivet2-core';
import { createExecutionObservationCoordinator } from '../domain/execution/executionObservationCoordinator.js';
import { createRemoteExecutionObservationRouter, type RemoteObservation } from './remoteExecutionObservation.js';

const id = (value: string) => value as ProjectId;
function fixture(eligible?: (projectId: ProjectId, source: object) => boolean, afterEffect?: () => void) {
  const source = {};
  const opened = new Map<ProjectId, { token: number; path?: string | null; bundleKey?: string }>(
    ['a', 'b', 'c', 'd'].map((name) => [id(name), { token: 1 }]),
  );
  const conflicts = new Map<ProjectId, string>();
  const records = new Map<string, { project: ProjectId; observation: RemoteObservation }>();
  const projected: Array<{
    project: ProjectId;
    message: string;
    data: { execution: GraphExecutionMetadata };
    activityData: unknown;
  }> = [];
  const settled: Array<{ project: ProjectId; root: string; status: 'completed' | 'error' | 'aborted' }> = [];
  const notices: Array<string | undefined> = [];
  const coordinator = createExecutionObservationCoordinator();
  const router = createRemoteExecutionObservationRouter({
    coordinator,
    eligible,
    receivers: () => new Map(opened),
    conflict: (project) => conflicts.get(project),
    publish: (project, observation) => {
      records.set(observation.id, { project, observation });
      afterEffect?.();
    },
    remove: (_project, key) => {
      records.delete(key);
      afterEffect?.();
    },
    notice: (_source, message) => {
      notices.push(message);
    },
    project: (project, message, data, activityData) => {
      projected.push({ project, message, data: data as { execution: GraphExecutionMetadata }, activityData });
    },
    settle: (project, root, status) => {
      settled.push({ project, root, status });
      afterEffect?.();
    },
  });
  const emit = (
    message: keyof ProcessEventMessageMap,
    owner = 'a',
    root = 'root',
    extra: Record<string, unknown> = {},
    accepted = true,
  ) => {
    const execution = {
      projectId: id(owner),
      rootRunId: root,
      graphRunId: `${owner}-${root}`,
      graphId: 'shared',
      ...(owner !== 'a'
        ? {
            projectScope: getSubgraphProjectKey({ projectId: id(owner), version: 'latest' }),
            parentGraphRunId: owner === 'c' ? `b-${root}` : `a-${root}`,
            executor: { nodeId: 'shared', parentGraphId: 'shared', processId: 'shared', splitIndex: 0 },
          }
        : {}),
    };
    router.receive(
      source,
      id('a'),
      'Project A',
      message,
      {
        execution,
        project: { metadata: { id: id('a') } },
        node: { id: 'shared' },
        processId: `${owner}-process-${root}`,
        ...extra,
      } as unknown as ProcessEventMessageMap[typeof message],
      accepted,
    );
  };
  const begin = (root = 'root') => {
    emit('start', 'a', root);
    emit('graphStart', 'a', root);
  };
  return { router, coordinator, source, opened, conflicts, records, projected, settled, notices, emit, begin };
}

test('explicit eligibility prevents outsider projection without losing nested eligible children', () => {
  const eligible = new Set(['a', 'c']);
  const f = fixture((id) => eligible.has(id));
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('nodeStart', 'b');
  f.emit('graphStart', 'c');
  f.emit('nodeStart', 'c');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['c', 'c'],
  );
  assert.ok([...f.records.values()].every((item) => item.project === 'c'));
  eligible.delete('c');
  f.router.reconcileOwnership();
  assert.equal(f.settled.at(-1)?.project, 'c');
  const count = f.projected.length;
  f.emit('nodeFinish', 'c');
  assert.equal(f.projected.length, count, 'departed members cannot receive late values');
});

test('one admitted stream projects A → B → C into actual owners and retains same-project nesting', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('nodeStart', 'b');
  f.emit('graphStart', 'c');
  f.emit('nodeFinish', 'c');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['b', 'b', 'c', 'c'],
  );
  for (const [index, owner, parent] of [
    [0, 'b', 'a-root'],
    [2, 'c', 'b-root'],
  ] as const) {
    const original = f.projected[index]!.activityData as { execution: GraphExecutionMetadata };
    const expected = {
      projectId: id(owner),
      rootRunId: 'root',
      graphRunId: `${owner}-root`,
      graphId: 'shared',
      parentGraphRunId: parent,
      projectScope: getSubgraphProjectKey({ projectId: id(owner), version: 'latest' }),
      executor: { nodeId: 'shared', parentGraphId: 'shared', processId: 'shared', splitIndex: 0 },
    };
    assert.deepEqual(
      original.execution,
      expected,
      'Run Activity retains original ancestry while the canvas is rebased',
    );
    assert.deepEqual(
      f.projected[index]!.data.execution,
      {
        ...expected,
        projectScope: undefined,
        parentGraphRunId: undefined,
        executor: undefined,
      },
      'canvas rebasing changes only cross-project view identity',
    );
  }
  const nested = {
    ...(f.projected[0]!.activityData as { execution: GraphExecutionMetadata }).execution,
    graphRunId: 'b-nested',
    parentGraphRunId: 'b-root',
    projectScope: getSubgraphProjectKey({ projectId: id('b'), version: 'latest' }),
  };
  f.emit('graphStart', 'b', 'root', { execution: nested });
  assert.equal(f.projected.at(-1)!.data.execution.parentGraphRunId, 'b-root');
  assert.equal(
    [...f.records.values()].some((record) => record.project === 'd'),
    false,
  );
});

test('rejected roots, missing starts, replay and unscoped diagnostics cannot create dependency observations', () => {
  const f = fixture();
  f.emit('start', 'a', 'rejected', {}, false);
  f.emit('graphStart', 'b', 'rejected');
  f.emit('graphStart', 'c', 'unknown');
  f.emit('start', 'a', 'replay', { replayRecordedAt: 100 });
  f.emit('graphStart', 'b', 'replay');
  f.emit('start', 'a', 'legacy', { execution: undefined });
  f.emit('error', 'a', 'legacy', { execution: undefined });
  assert.equal(f.records.size, 0);
  assert.equal(f.settled.length, 0);
  assert.match(f.notices.at(-1)!, /does not provide project ownership/);
  f.router.disconnect(f.source);
  assert.equal(f.notices.at(-1), undefined, 'legacy-source warnings must not outlive their connection');
});

test('overlapping roots settle separately, ignore late starts and do not end at early outputs or abort', () => {
  const f = fixture();
  f.begin('one');
  f.begin('two');
  f.emit('graphStart', 'b', 'one');
  f.emit('graphStart', 'b', 'two');
  f.emit('graphOutputsReady', 'a', 'one');
  f.emit('abort', 'a', 'one');
  assert.equal(f.settled.length, 0);
  f.emit('done', 'a', 'one');
  assert.deepEqual(
    f.settled.map((entry) => entry.root),
    ['one'],
  );
  const count = f.projected.length;
  f.emit('nodeStart', 'b', 'one');
  f.emit('start', 'a', 'one');
  assert.equal(f.projected.length, count);
  f.emit('nodeFinish', 'b', 'two');
  f.emit('error', 'a', 'two');
  assert.deepEqual(
    f.settled.map((entry) => entry.status),
    ['completed', 'error'],
  );
});

test('a dependency becoming the next actual root releases its old passive lock and cannot be repainted by the prior root', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  const count = f.projected.length;
  f.router.receive(
    f.source,
    id('b'),
    'Project B',
    'start',
    {
      execution: { projectId: id('b'), rootRunId: 'b-root', graphRunId: 'b-own', graphId: 'shared' },
      project: { metadata: { id: id('b') } },
    } as never,
    true,
  );
  assert.equal(f.records.size, 0);
  assert.deepEqual(
    f.settled.map((entry) => entry.status),
    ['aborted'],
  );
  f.emit('nodeFinish', 'b');
  assert.equal(f.projected.length, count);
  f.emit('graphStart', 'c');
  assert.equal(f.projected.at(-1)!.project, 'c', 'other observers of the earlier root continue');
});

test('a blocked project never joins midway through a run while its descendants remain observable', () => {
  const f = fixture();
  f.conflicts.set(id('b'), 'Local run');
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('graphStart', 'c');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['c'],
  );
  f.conflicts.clear();
  f.emit('nodeFinish', 'b');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['c'],
  );
  f.begin('next');
  f.emit('graphStart', 'b', 'next');
  assert.equal(f.projected.at(-1)!.project, 'b');
});

test('an already-active source wins over a later root calling back into it on the shared connection', () => {
  const f = fixture();
  f.begin('a-live');
  const fromB = (message: keyof ProcessEventMessageMap, owner: string, root = 'b-live') => {
    const execution = {
      projectId: id(owner),
      rootRunId: root,
      graphRunId: `${owner}-${root}`,
      graphId: 'shared',
      ...(owner === 'b'
        ? {}
        : {
            parentGraphRunId: owner === 'c' ? `a-${root}` : `b-${root}`,
            projectScope: getSubgraphProjectKey({ projectId: id(owner), version: 'latest' }),
          }),
    };
    f.router.receive(
      f.source,
      id('b'),
      'Project B',
      message,
      {
        execution,
        project: { metadata: { id: id('b') } },
        node: { id: 'shared' },
        processId: 'child',
      } as never,
      true,
    );
  };
  fromB('start', 'b');
  fromB('graphStart', 'a');
  fromB('nodeFinish', 'a');
  fromB('graphStart', 'c');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['c'],
  );
  assert.equal(
    [...f.records.values()].some((record) => record.project === 'a'),
    false,
  );
  f.emit('done', 'a', 'a-live');
  fromB('nodeFinish', 'a');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['c'],
    'do not join the older passive run midway',
  );
  fromB('start', 'b', 'next');
  fromB('graphStart', 'a', 'next');
  assert.equal(f.projected.at(-1)!.project, 'a', 'a future run can observe the completed source normally');
});

test('close/reopen fences old events and closed intermediate projects do not hide open descendants', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.opened.delete(id('b'));
  f.router.sweep();
  f.opened.set(id('b'), { token: 2 });
  f.emit('nodeFinish', 'b');
  f.emit('graphStart', 'c');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['b', 'c'],
  );
  assert.equal(
    [...f.records.values()].some((record) => record.project === 'b'),
    false,
  );
  f.begin('next');
  f.emit('graphStart', 'b', 'next');
  assert.equal(f.projected.at(-1)!.project, 'b');
});

test('an old source in a replaced tab lifetime cannot block a new root observing the reopened project', () => {
  const f = fixture();
  f.begin();
  f.opened.set(id('a'), { token: 2 });
  f.router.sweep();
  const execution = { projectId: id('b'), rootRunId: 'new-root', graphRunId: 'new-b', graphId: 'shared' };
  f.router.receive(f.source, id('b'), 'Project B', 'start', { execution } as never, true);
  f.router.receive(
    f.source,
    id('b'),
    'Project B',
    'graphStart',
    {
      execution: {
        ...execution,
        projectId: id('a'),
        graphRunId: 'new-a',
        parentGraphRunId: 'new-b',
        projectScope: getSubgraphProjectKey({ projectId: id('a'), version: 'latest' }),
      },
    } as never,
    true,
  );
  assert.equal(f.projected.at(-1)!.project, 'a');
});

test('projects opened after admission wait for the next root rather than claiming complete history', () => {
  const f = fixture();
  f.opened.delete(id('c'));
  f.begin();
  f.opened.set(id('c'), { token: 2 });
  f.emit('graphStart', 'b');
  f.emit('graphStart', 'c');
  assert.deepEqual(
    f.projected.map((event) => event.project),
    ['b'],
  );
});

test('stopping the shared connection removes all observations without sending an execution command', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('graphStart', 'c');
  const count = f.projected.length;
  f.router.disconnect(f.source);
  assert.equal(f.records.size, 0);
  f.emit('nodeFinish', 'b');
  f.emit('nodeFinish', 'c');
  assert.equal(f.projected.length, count);
  f.begin('fresh');
  f.emit('graphStart', 'b', 'fresh');
  assert.equal(f.projected.at(-1)!.project, 'b');
});

test('disconnect interrupts only unfinished members of its source and leaves completed results alone', () => {
  const f = fixture();
  f.begin('done');
  f.emit('graphStart', 'b', 'done');
  f.emit('done', 'a', 'done');
  f.opened.delete(id('b'));
  f.begin('active');
  f.emit('graphStart', 'b', 'active');
  f.emit('graphStart', 'c', 'active');
  f.router.disconnect(f.source);
  assert.deepEqual(
    f.settled.map((entry) => [entry.project, entry.root, entry.status]),
    [
      ['b', 'done', 'completed'],
      ['c', 'active', 'aborted'],
    ],
  );
  assert.equal(f.records.size, 0);
});

test('receiver conflicts that start after admission interrupt that observation without redirecting ownership', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.conflicts.set(id('b'), 'Playback');
  f.emit('nodeStart', 'b');
  assert.equal(f.projected.length, 1);
  assert.equal(f.settled[0]!.status, 'aborted');
  assert.equal([...f.records.values()][0]!.observation.status, 'blocked');
});

test('transient conflicts before a first child remain excluded, but a fresh root is admitted', () => {
  const f = fixture();
  f.conflicts.set(id('b'), 'Playback');
  f.begin('initial');
  f.conflicts.clear();
  f.emit('graphStart', 'b', 'initial');
  assert.equal(f.projected.length, 0, 'admission captures existing conflicts');
  f.begin('between');
  f.conflicts.set(id('b'), 'Local execution');
  f.router.reconcileOwnership();
  f.conflicts.clear();
  f.emit('graphStart', 'b', 'between');
  assert.equal(f.projected.length, 0, 'pre-child conflicts cannot disappear unnoticed');
  f.begin('fresh');
  f.emit('graphStart', 'b', 'fresh');
  assert.equal(f.projected.length, 1);
});

test('membership removal after a verified rename keeps its explanation without transferring old event admission', () => {
  for (const replacementPath of ['/renamed-b', '/different-file']) {
    const eligible = new Set(['a', 'b', 'c']);
    const f = fixture((id) => eligible.has(id));
    f.opened.set(id('b'), { token: 1, path: '/b', bundleKey: 'bundle' });
    f.begin();
    f.emit('graphStart', 'b');
    f.opened.set(id('b'), { token: 1, path: '/renamed-b', bundleKey: 'bundle' });
    f.router.reconcileOwnership();
    assert.equal([...f.records.values()].find((entry) => entry.project === 'b')!.observation.status, 'observing');
    eligible.delete('b');
    f.opened.set(id('b'), { token: 2, path: '/renamed-b' });
    f.router.reconcileOwnership();
    const record = [...f.records.values()].find((entry) => entry.project === 'b')!;
    assert.equal(record.observation.status, 'blocked');
    assert.equal(record.observation.message, 'This project no longer belongs to this Remote Debugger session.');
    assert.equal(f.settled.at(-1)?.status, 'aborted');
    const count = f.projected.length;
    f.emit('nodeFinish', 'b');
    assert.equal(f.projected.length, count);
    f.opened.set(id('b'), { token: 3, path: replacementPath });
    f.router.reconcileOwnership();
    assert.equal(
      [...f.records.values()].some((entry) => entry.project === 'b'),
      false,
      'actual file replacement removes old provenance, including a same-path reload',
    );
  }
});

test('synchronous store notifications cannot reenter unfinished observation retirement', () => {
  for (const transition of ['conflict', 'membership', 'disconnect'] as const) {
    const eligible = new Set(['a', 'b', 'c']);
    let notify = false;
    let notifications = 0;
    const f = fixture(
      (id) => eligible.has(id),
      () => {
        if (!notify) return;
        assert.ok(++notifications < 20, `${transition} recursively retires the same observation`);
        f.router.reconcileOwnership();
      },
    );
    f.opened.set(id('b'), { token: 1, path: '/b', bundleKey: 'bundle' });
    f.begin();
    f.emit('graphStart', 'b');
    notify = true;
    if (transition === 'conflict') f.conflicts.set(id('b'), 'Playback');
    else {
      eligible.delete('b');
      if (transition === 'membership') f.opened.set(id('b'), { token: 2, path: '/b' });
    }
    if (transition === 'disconnect') f.router.disconnect(f.source);
    else f.router.reconcileOwnership();
    assert.equal(f.settled.length, 1, `${transition} settles display once`);
    if (transition === 'disconnect') assert.equal(f.records.size, 0);
    else assert.equal([...f.records.values()][0]!.observation.status, 'blocked');
  }
});

test('disconnect during publication or terminal settlement cannot resurrect observation state', () => {
  for (const boundary of ['completion', 'completion-settle', 'publication', 'version'] as const) {
    let disconnect = false;
    const f = fixture(undefined, () => {
      if (!disconnect) return;
      if (boundary === 'completion-settle' && !f.settled.length) return;
      disconnect = false;
      f.router.disconnect(f.source);
    });
    f.begin();
    if (boundary !== 'publication') f.emit('graphStart', 'b');
    const projected = f.projected.length;
    disconnect = true;
    if (boundary === 'version') {
      const original = f.projected[0]!.activityData as { execution: GraphExecutionMetadata };
      f.emit('nodeFinish', 'b', 'root', {
        execution: {
          ...original.execution,
          projectScope: getSubgraphProjectKey({ projectId: id('b'), version: 'published' }),
        },
      });
    } else f.emit(boundary === 'publication' ? 'graphStart' : 'done', boundary === 'publication' ? 'b' : 'a');
    assert.equal(f.records.size, 0, `${boundary} cannot republish a disconnected observation`);
    assert.equal(f.projected.length, projected, `${boundary} cannot project after ownership is released`);
    assert.equal(f.settled.length, 1, `${boundary} settles the member only once`);
    assert.equal(f.settled[0]!.status, boundary.startsWith('completion') ? 'completed' : 'aborted');
  }
});

test('terminal callbacks preserve an ownership handoff in another dependency tab', () => {
  let handover = false;
  const f = fixture(undefined, () => {
    if (!handover || !f.settled.some((item) => item.project === 'b')) return;
    handover = false;
    f.conflicts.set(id('c'), 'A local execution owns this tab.');
    f.router.reconcileOwnership();
  });
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('graphStart', 'c');
  handover = true;
  f.emit('done', 'a');
  assert.deepEqual(f.settled, [
    { project: 'b', root: 'root', status: 'completed' },
    { project: 'c', root: 'root', status: 'aborted' },
  ]);
  const c = [...f.records.values()].find((item) => item.project === 'c')!.observation;
  assert.equal(c.status, 'blocked');
  assert.match(c.message!, /local execution/);
});

test('blocked publication cannot settle a replacement binding created by its callback', () => {
  for (const boundary of ['conflict', 'membership'] as const) {
    let replace = false;
    const f = fixture(undefined, () => {
      if (!replace) return;
      replace = false;
      f.opened.set(id('b'), { token: 3, path: '/b', ...(boundary === 'conflict' ? { bundleKey: 'bundle' } : {}) });
      f.router.reconcileOwnership();
    });
    f.opened.set(id('b'), { token: 1, path: '/b', bundleKey: 'bundle' });
    f.begin();
    f.emit('graphStart', 'b');
    if (boundary === 'membership') f.opened.set(id('b'), { token: 2, path: '/b' });
    else f.conflicts.set(id('b'), 'A local execution owns this tab.');
    replace = true;
    f.router.reconcileOwnership();
    assert.equal(f.settled.length, 0, `${boundary} cannot settle the replacement's display`);
    assert.equal(f.records.size, 0, `${boundary} cannot retain stale provenance after replacement`);
  }
});

test('disconnect during source takeover cannot admit an orphan root or retain its metadata', () => {
  for (const boundary of ['settle', 'remove', 'reconnect'] as const) {
    let disconnect = false;
    const f = fixture(undefined, () => {
      if (!disconnect || (boundary === 'remove' && f.records.size)) return;
      disconnect = false;
      f.router.disconnect(f.source);
      if (boundary === 'reconnect') f.begin('replacement');
    });
    f.begin();
    f.emit('graphStart', 'b');
    disconnect = true;
    const execution = { projectId: id('b'), rootRunId: 'takeover', graphRunId: 'new-b', graphId: 'shared' };
    f.router.receive(f.source, id('b'), 'Project B', 'start', { execution } as never, true);
    assert.equal(f.records.size, 0);
    assert.equal(
      f.coordinator.inspect().roots,
      boundary === 'reconnect' ? 1 : 0,
      `${boundary} cannot retain a disconnected admission`,
    );
    const count = f.projected.length;
    f.emit('graphStart', 'c', 'takeover');
    assert.equal(f.projected.length, count, `${boundary} cannot enroll a child after disconnect`);
    f.begin('fresh');
    f.emit('graphStart', 'b', 'fresh');
    assert.equal(f.projected.length, count + 1, `${boundary} permits a genuinely new source lifetime`);
    f.router.dispose();
    assert.equal(f.coordinator.inspect().roots, 0);
  }
});

test('user input is indicated and journaled without providing a control transport', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('graphStart', 'c');
  f.emit('userInput', 'c');
  assert.equal(f.projected.filter((event) => event.message === 'userInput').length, 1);
  assert.equal(
    [...f.records.values()].every((record) => record.observation.needsInput),
    true,
  );
  f.emit('nodeFinish', 'c');
  assert.equal(
    [...f.records.values()].some((record) => record.observation.needsInput),
    false,
  );
});

test('pause and resume update passive provenance without sending controls or graph events', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  const count = f.projected.length;
  f.emit('pause');
  assert.equal([...f.records.values()][0]!.observation.paused, true);
  f.emit('resume');
  assert.equal([...f.records.values()][0]!.observation.paused, false);
  assert.equal(f.projected.length, count);
});

test('a dependency first observed after pause inherits the root pause state', () => {
  const f = fixture();
  f.begin();
  f.emit('pause');
  f.emit('graphStart', 'b');
  assert.equal([...f.records.values()][0]!.observation.paused, true);
  f.emit('resume');
  assert.equal([...f.records.values()][0]!.observation.paused, false);
});

test('runtime version provenance reports both saved and published calls in the same root', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  const execution = {
    ...f.projected[0]!.data.execution,
    graphRunId: 'published-call',
    parentGraphRunId: 'a-root',
    projectScope: getSubgraphProjectKey({ projectId: id('b'), version: 'published' }),
  };
  f.emit('graphStart', 'b', 'root', { execution });
  assert.equal([...f.records.values()][0]!.observation.version, 'mixed');
  f.emit('nodeFinish', 'b');
  assert.equal(
    [...f.records.values()][0]!.observation.version,
    'mixed',
    'later saved events cannot hide a published call',
  );
});

test('capacity warns instead of evicting active roots; completed metadata is bounded', () => {
  const f = fixture();
  for (let index = 0; index < 33; index++) {
    f.begin(String(index));
    f.emit('graphStart', 'b', String(index));
  }
  assert.equal(f.records.size, 32);
  assert.match(f.notices.at(-1)!, /capacity reached/);
  f.emit('nodeFinish', 'b', '0');
  assert.equal(f.projected.at(-1)!.data.execution.rootRunId, '0');
  for (let index = 0; index < 32; index++) f.emit('done', 'a', String(index));
  for (let index = 33; index < 68; index++) {
    f.begin(String(index));
    f.emit('graphStart', 'b', String(index));
    f.emit('done', 'a', String(index));
  }
  assert.equal(f.records.size, 32);
});

test('older runtimes settle observers at the exact root completion without identified done frames', () => {
  for (const terminal of ['graphFinish', 'graphError'] as const) {
    const f = fixture();
    f.begin();
    f.emit('graphStart', 'b');
    f.emit('graphFinish', 'b');
    assert.equal(f.settled.length, 0);
    f.emit(terminal, 'a');
    assert.deepEqual(f.settled, [
      { project: 'b', root: 'root', status: terminal === 'graphFinish' ? 'completed' : 'error' },
    ]);
    f.emit('done', 'a', 'root', { execution: undefined });
    f.emit('done', 'a');
    assert.equal(f.settled.length, 1);
  }
});

test('root graphAbort is a cancellation request, not the end of late dependency diagnostics', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('graphAbort', 'a');
  f.emit('abort', 'a');
  assert.equal(f.settled.length, 0);
  f.emit('nodeError', 'b');
  assert.equal(f.projected.at(-1)!.message, 'nodeError');
  f.emit('graphError', 'a');
  assert.deepEqual(
    f.settled.map((entry) => entry.status),
    ['aborted'],
  );
  f.emit('error', 'a');
  assert.equal(f.settled.length, 1);
});

test('a new owner wins even when the next received frame is the source terminal', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.conflicts.set(id('b'), 'Independent debugger');
  f.emit('done', 'a');
  assert.equal([...f.records.values()][0]!.observation.status, 'blocked');
  assert.deepEqual(
    f.settled.map((entry) => entry.status),
    ['aborted'],
  );
});

test('ownership changes release all old view-only locks without waiting for another remote event', () => {
  const f = fixture();
  f.begin('complete');
  f.emit('graphStart', 'b', 'complete');
  f.emit('done', 'a', 'complete');
  f.begin('active');
  f.emit('graphStart', 'b', 'active');
  f.conflicts.set(id('b'), 'Independent debugger');
  f.router.reconcileOwnership();
  assert.equal(
    [...f.records.values()].every((entry) => entry.observation.status === 'blocked'),
    true,
  );
  assert.deepEqual(
    f.settled.map((entry) => entry.status),
    ['completed', 'aborted'],
  );
  f.conflicts.clear();
  f.router.reconcileOwnership();
  f.emit('done', 'a', 'active');
  assert.deepEqual(
    f.settled.map((entry) => entry.status),
    ['completed', 'aborted'],
  );
  f.begin('next');
  f.emit('graphStart', 'b', 'next');
  assert.equal([...f.records.values()].at(-1)!.observation.status, 'observing');
});

test('input waits are root-owned and clear even when the receiving child tab has closed', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.emit('graphStart', 'c');
  f.emit('userInput', 'c');
  f.opened.delete(id('c'));
  f.router.sweep();
  f.emit('nodeFinish', 'c');
  assert.equal([...f.records.values()][0]!.observation.needsInput, false);
  f.emit('userInput', 'a');
  assert.equal([...f.records.values()][0]!.observation.needsInput, true);
  f.emit('nodeExcluded', 'a');
  assert.equal([...f.records.values()][0]!.observation.needsInput, false);
});

test('pause notifications cannot publish provenance into a replacement tab lifetime', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  const previous = [...f.records.values()][0]!.observation;
  f.opened.set(id('b'), { token: 2 });
  f.emit('pause', 'a');
  assert.equal([...f.records.values()][0]!.observation, previous);
});

test('terminal events cannot recreate a closed receiver without an intervening sweep', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.opened.set(id('b'), { token: 2 });
  f.emit('done', 'a');
  assert.equal(f.settled.length, 0);
});

test('provider disposal removes observations and interrupts only its unfinished roots', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  f.router.dispose();
  assert.equal(f.records.size, 0);
  assert.deepEqual(
    f.settled,
    [{ project: 'b', root: 'root', status: 'aborted' }],
    'disposal aborts observation; it does not fabricate a runtime error',
  );
});

test('a reused root ID without caller ancestry cannot enroll an unrelated project', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b', 'root', {
    execution: {
      projectId: id('b'),
      rootRunId: 'root',
      graphRunId: 'orphan',
      graphId: 'shared',
      parentGraphRunId: 'missing',
    },
  });
  assert.equal(f.records.size, 0);
  assert.match(f.notices.at(-1)!, /no known caller/);
  f.emit('graphStart', 'b');
  assert.equal(f.records.size, 1);
});

test('A → B → A return calls paint the source canvas but never duplicate or prematurely settle its journal', () => {
  const f = fixture();
  f.begin();
  f.emit('graphStart', 'b');
  const execution = {
    projectId: id('a'),
    graphId: 'helper',
    graphRunId: 'a-helper',
    rootRunId: 'root',
    parentGraphRunId: 'b-root',
    projectScope: getSubgraphProjectKey({ projectId: id('a'), version: 'latest' }),
  };
  f.emit('graphStart', 'a', 'root', { execution });
  f.emit('nodeFinish', 'a', 'root', { execution });
  assert.equal(f.projected.at(-1)!.project, 'a');
  assert.equal(f.projected.at(-1)!.activityData, false);
  f.emit('graphFinish', 'a');
  assert.deepEqual(f.settled, [{ project: 'b', root: 'root', status: 'completed' }]);
  f.router.disconnect(f.source);
  assert.equal(f.settled.length, 1);
});
