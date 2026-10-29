import assert from 'node:assert/strict';
import test from 'node:test';
import { LatestDebuggerRuns, type LatestFrame } from './latestDebuggerRuns.js';
import { createExecutorSessionRuntime } from './executorSession.js';
import { FakeWebSocket } from './executorSessionTestUtils.js';
import { ManagedLatestSession } from './managedLatestSession.js';

test('managed adapter owns acknowledgement timers and disposal without replaying commands', () => {
  const sent: string[] = [];
  const adapter = new ManagedLatestSession({
    eligible: () => true,
    deliver() {},
    notify() {},
    warn() {},
    canSend: () => true,
    send: (raw) => {
      sent.push(raw);
      return true;
    },
  });
  adapter.ready = true;
  const target = { channel: null, rootRunId: 'root', projectId: 'project', owner: 'owner', incarnation: 'process' };
  assert.equal(adapter.sendControl('run', target), false);
  assert.equal(adapter.sendControl('pause', target), true);
  const command = JSON.parse(sent[0]!);
  adapter.acceptEnvelope(
    { message: 'latest-control-result', data: { commandId: command.data.commandId, status: 'invented' } },
    { message: 'latest-control-result', data: { commandId: command.data.commandId, status: 'invented' } },
    { external: true, named: false, fail() {}, onReady() {} },
  );
  assert.equal(adapter.pendingCount, 1, 'malformed acknowledgements cannot settle pending commands');
  adapter.reset();
  assert.equal(adapter.pendingCount, 0);
  assert.equal(adapter.ready, false);
  assert.equal(sent.length, 1, 'reset disposes timers without execution or control replay');
});

test('typed managed lifecycle delivery is separate from executor events and shares subscription disposal', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const runtime = createExecutorSessionRuntime({ projectId: 'project' as never, onStateChange() {} });
  const process: string[] = [],
    lifecycle: string[] = [];
  const unsubscribe = runtime.subscribeMessages(
    (message) => {
      process.push(message);
    },
    (frame) => {
      lifecycle.push(frame.message);
    },
  );
  try {
    await runtime.connectExternalDebugger('ws://test/ws/latest-debugger@00123');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.emitMessage({
      message: 'latest-session',
      data: { protocol: 2, channel: '00123', channelIsolation: true, runScopedControls: true },
    });
    socket.emitMessage(frame('root'));
    socket.emitMessage({ ...frame('root', 'latest-prompt-closed'), data: { promptId: 'prompt' } });
    socket.emitMessage(frame('root', 'latest-settled'));
    assert.ok(process.length > 0 && process.every((name) => name === 'start'));
    assert.deepEqual(lifecycle, ['latest-prompt-closed', 'latest-settled']);
    unsubscribe();
    socket.emitMessage(frame('other'));
    socket.emitMessage(frame('other', 'latest-settled'));
    assert.equal(lifecycle.length, 2, 'one unsubscribe retires both typed callback roles');
  } finally {
    unsubscribe();
    runtime.disconnect();
    globalThis.WebSocket = original;
  }
});

const frame = (root: string, message = 'start', projectId = 'project'): LatestFrame => ({
  message,
  rivetScope: { channel: '00123', rootRunId: root, projectId: 'project', owner: 'backend-0', incarnation: 'process' },
  data: {
    execution: { projectId, rootRunId: root, graphRunId: root },
    project: { metadata: { id: projectId, title: projectId } },
  },
});

test('session retirement fences replay and diagnostics without suppressing replacement notices', () => {
  for (const action of ['replay', 'history-gap', 'owner-unavailable']) {
    let deliveries = 0,
      warnings = 0,
      retire = true;
    const adapter = new ManagedLatestSession({
      eligible: () => true,
      notify() {
        if (retire && action === 'owner-unavailable') adapter.reset();
      },
      warn() {
        warnings++;
      },
      canSend: () => true,
      send: () => true,
      deliver() {
        deliveries++;
        if (retire) adapter.reset();
      },
    });
    const seed = () => {
      adapter.ready = true;
      adapter.observation = true;
      adapter.channel = '00123';
      adapter.runs = new LatestDebuggerRuns(() => true);
      for (const message of ['start', 'trace']) {
        const event = frame('root', message);
        adapter.runs.receive(event, JSON.stringify(event));
      }
    };
    const diagnostic = {
      message: 'latest-diagnostic',
      data: { protocol: 1, code: action === 'replay' ? 'history-gap' : action },
    };
    const report = () =>
      adapter.acceptEnvelope(diagnostic, diagnostic, { external: true, named: true, fail() {}, onReady() {} });
    seed();
    assert.doesNotThrow(() => (action === 'replay' ? adapter.rebuild() : report()));
    assert.equal(deliveries, action === 'owner-unavailable' ? 0 : 1, 'retired replay cannot publish its tail');
    assert.equal(warnings, 0, 'retired diagnostics cannot warn or populate replacement deduplication state');
    retire = false;
    seed();
    report();
    assert.equal(warnings, 1, 'the replacement session must report its own first diagnostic');
  }
});

test('synchronous acknowledgement, retirement and failed sends cannot leave orphaned timers', () => {
  const target = { channel: null, rootRunId: 'root', projectId: 'project', owner: 'owner', incarnation: 'process' };
  for (const action of ['ack', 'reset', 'false', 'throw']) {
    const adapter = new ManagedLatestSession({
      eligible: () => true,
      deliver() {},
      notify() {},
      warn() {},
      canSend: () => true,
      send(raw) {
        if (action === 'throw') throw new Error('Transport failed');
        if (action === 'false') return false;
        const command = JSON.parse(raw);
        if (action === 'reset') adapter.reset();
        else {
          const ack = {
            message: 'latest-control-result',
            data: { commandId: command.data.commandId, status: 'accepted' },
          };
          adapter.acceptEnvelope(ack, ack, { external: true, named: false, fail() {}, onReady() {} });
        }
        return true;
      },
    });
    adapter.ready = true;
    try {
      if (action === 'throw') assert.throws(() => adapter.sendControl('pause', target), /Transport failed/);
      else assert.equal(adapter.sendControl('pause', target), action !== 'false');
      assert.equal(adapter.pendingCount, 0, `${action} must settle/dispose the timer before send returns`);
    } finally {
      adapter.reset();
    }
  }
});

test('unsupported managed events invalidate only their admitted root view, with bounded warning', () => {
  let warnings = 0;
  const adapter = new ManagedLatestSession({
    eligible: () => true,
    deliver() {},
    notify() {},
    warn() {
      warnings++;
    },
    canSend: () => true,
    send: () => true,
  });
  adapter.ready = true;
  adapter.channel = '00123';
  adapter.runs = new LatestDebuggerRuns(() => true);
  const start = frame('root');
  adapter.receive(start.message, start.data, start.rivetScope, JSON.stringify(start));
  const selected = adapter.runs.runs.get(adapter.runs.selected!)!;
  adapter.receive('future-event', {}, { ...start.rivetScope, channel: 'foreign' }, '{}');
  assert.equal(selected.incomplete, false, 'foreign events have no history authority');
  for (let i = 0; i < 2; i++) adapter.receive('future-event', {}, start.rivetScope, '{}');
  assert.equal(selected.incomplete, true, 'unrecognized discarded data is not complete history');
  assert.equal(warnings, 1);
  assert.equal(selected.phase, 'running', 'unsupported observation never settles execution');
});

test('nested selection replaces the replay turn instead of interleaving two views', () => {
  const delivered: string[] = [];
  let replacement = '';
  const adapter = new ManagedLatestSession({
    eligible: () => true,
    notify() {},
    warn() {},
    canSend: () => true,
    send: () => true,
    deliver(event) {
      delivered.push(event.rivetScope.rootRunId);
      if (event.rivetScope.rootRunId === 'a') adapter.select(replacement);
    },
  });
  adapter.runs = new LatestDebuggerRuns(() => true);
  for (const root of ['a', 'b'])
    for (const message of ['start', 'trace']) {
      const event = frame(root, message);
      adapter.runs.receive(event, JSON.stringify(event));
    }
  const [a, b] = adapter.runs.runs.values();
  replacement = b!.key;
  adapter.runs.select(a!.key);
  adapter.rebuild();
  assert.deepEqual(delivered, ['a', 'b', 'b']);
  assert.equal(adapter.runs.selected, replacement);
});

test('unsupported events in another retained root do not invalidate the selected prompt', () => {
  const adapter = new ManagedLatestSession({
    eligible: () => true,
    deliver() {},
    notify() {},
    warn() {},
    canSend: () => true,
    send: () => true,
  });
  adapter.runs = new LatestDebuggerRuns(() => true);
  adapter.channel = '00123';
  adapter.ready = true;
  for (const root of ['a', 'b']) {
    const start = frame(root);
    start.rivetScope.promptLifecycle = 1;
    adapter.receive('start', start.data, start.rivetScope, JSON.stringify(start));
    const input = {
      ...frame(root, 'userInput'),
      rivetScope: { ...start.rivetScope, promptId: root },
      data: { execution: { rootRunId: root, graphRunId: root }, processId: root },
    };
    adapter.receive(input.message, input.data, input.rivetScope, JSON.stringify(input));
  }
  adapter.receive('future-event', {}, { ...frame('a').rivetScope, promptLifecycle: 1 }, '{}');
  const run = adapter.runs.runs.get(adapter.runs.selected!)!;
  assert.equal(run.scope.rootRunId, 'b');
  assert.equal(run.incomplete, false);
  assert.equal(
    (adapter.runs.replay().find((event) => event.message === 'userInput')!.data as { isReplay?: boolean }).isReplay,
    undefined,
  );
});

test('newest follows admission, not late child arrival; pin/replay is bounded and never changes another root status', () => {
  const runs = new LatestDebuggerRuns((id) => id === 'project', { runs: 2, events: 4, bytes: 4096 });
  const receive = (event: LatestFrame) => runs.receive(event, JSON.stringify(event));
  const a = receive(frame('a'))!,
    b = receive(frame('b'))!;
  assert.equal(runs.selected, b.key);
  receive(frame('a', 'done'));
  assert.equal(b.status, 'running');
  assert.equal(runs.selected, b.key);
  runs.select(a.key);
  const c = receive(frame('c'))!;
  assert.equal(runs.selected, a.key);
  assert.equal(runs.runs.size, 2);
  assert.equal(runs.runs.has(b.key), false);
  assert.ok(runs.replay().every((event) => event.rivetScope.rootRunId === 'a'));
  runs.follow();
  assert.equal(runs.selected, c.key);
  receive(frame('c', 'nodeStart'));
  receive(frame('c', 'nodeFinish'));
  receive(frame('c', 'done'));
  assert.equal(c.incomplete, false);
  assert.equal(a.incomplete, true);
});

test('out-of-order peer replay follows admission time for selection, following and eviction', () => {
  const runs = new LatestDebuggerRuns(() => true, { runs: 2, events: 32, bytes: 32_768 });
  const receive = (root: string, admittedAt: number) => {
    const event = frame(root);
    event.rivetScope.admittedAt = admittedAt;
    return runs.receive(event, JSON.stringify(event))!;
  };
  const newest = receive('newest', 200),
    older = receive('older-replayed-late', 100);
  assert.equal(runs.selected, newest.key, 'an older start replayed later must not steal selection');
  runs.select(older.key);
  runs.follow();
  assert.equal(runs.selected, newest.key, 'Follow newest uses the same admission ordering');
  const middle = receive('middle-replayed-later', 150);
  assert.equal(runs.runs.has(older.key), false, 'history evicts the oldest admission, not the earliest delivery');
  assert.ok(runs.runs.has(newest.key) && runs.runs.has(middle.key));
});

test('event/byte eviction and oversized frames retain identity but never claim complete history', () => {
  const start = frame('root');
  for (const limits of [
    { runs: 32, events: 2, bytes: 1_000_000 },
    { runs: 32, events: 16, bytes: Buffer.byteLength(JSON.stringify(start)) + 10 },
  ]) {
    const runs = new LatestDebuggerRuns(() => true, limits);
    const receive = (event: LatestFrame) => runs.receive(event, JSON.stringify(event));
    const run = receive(start)!;
    receive(frame('root', 'nodeStart'));
    receive(frame('root', 'partialOutput'));
    assert.equal(run.incomplete, true);
    assert.equal(runs.selected, run.key);
    assert.equal(run.status, 'running', 'eviction is not execution cancellation');
    assert.ok(runs.replay().length > 0);
    assert.ok(runs.replay().every((event) => event.message !== 'start' && event.rivetScope.rootRunId === 'root'));
    const before = runs.replay();
    receive({ ...frame('root', 'trace'), data: 'x'.repeat(limits.bytes + 1) });
    assert.deepEqual(runs.replay(), before, 'an oversized diagnostic cannot displace the retained view');
  }
});

test('relevance does not let an older outsider caller replace a newer run, and contradictory provenance is rejected', () => {
  const runs = new LatestDebuggerRuns((id) => id === 'member');
  const outside = frame('outside', 'start', 'outsider');
  outside.rivetScope.projectId = 'outsider';
  runs.receive(outside, JSON.stringify(outside));
  const own = frame('new', 'start', 'member');
  own.rivetScope.projectId = 'member';
  const newest = runs.receive(own, JSON.stringify(own))!;
  const oldChild = {
    ...outside,
    message: 'graphStart',
    data: { execution: { projectId: 'member', rootRunId: 'outside', graphRunId: 'child' } },
  };
  runs.receive(oldChild, JSON.stringify(oldChild));
  assert.equal(runs.selected, newest.key);
  assert.equal(runs.receive({ ...own, data: { execution: { rootRunId: 'wrong' } } }, '{}'), undefined);
  assert.equal(
    runs.receive({ ...own, rivetScope: { ...own.rivetScope, projectId: 'contradiction' } }, '{}'),
    undefined,
  );
  runs.receive({ ...own, message: 'done' }, JSON.stringify({ ...own, message: 'done' }));
  runs.receive({ ...own, message: 'latest-settled' }, JSON.stringify({ ...own, message: 'latest-settled' }));
  assert.equal(newest.status, 'completed');
  assert.equal(runs.receive({ ...own, message: 'pause' }, '{}'), undefined);
  assert.equal(newest.status, 'completed');
});

test('outputs-ready and abort request do not claim physical settlement', () => {
  const runs = new LatestDebuggerRuns(() => true);
  const receive = (message: string) => {
    const event = frame('root', message);
    return runs.receive(event, JSON.stringify(event));
  };
  const run = receive('start')!;
  const child = frame('root', 'graphOutputsReady');
  child.data = {
    execution: { rootRunId: 'root', projectId: 'project', graphRunId: 'child', parentGraphRunId: 'root' },
  };
  runs.receive(child, JSON.stringify(child));
  assert.equal(run.status, 'running', 'child outputs are not the root outputs-ready boundary');
  receive('graphOutputsReady');
  assert.equal(run.status, 'outputs-ready');
  receive('abort');
  receive('error');
  assert.equal(run.status, 'abort-requested');
  receive('latest-settled');
  assert.equal(run.status, 'aborted');
  assert.equal(receive('pause'), undefined);
  const unknown = frame('unknown');
  runs.receive(unknown, JSON.stringify(unknown));
  const settled = { ...unknown, message: 'latest-settled' };
  const missingOutcome = runs.receive(settled, JSON.stringify(settled))!;
  assert.equal(missingOutcome.status, 'settled', 'physical settlement is not proof of success');
  assert.equal(missingOutcome.incomplete, true);
});

test('pause, output readiness and cancellation retain independent lifecycle meaning', () => {
  const runs = new LatestDebuggerRuns(() => true);
  const receive = (message: string) => {
    const event = frame('root', message);
    return runs.receive(event, JSON.stringify(event))!;
  };
  const run = receive('start');
  receive('pause');
  receive('graphOutputsReady');
  assert.equal(run.status, 'paused', 'an in-flight output event cannot hide Resume');
  receive('resume');
  assert.equal(run.status, 'outputs-ready', 'resuming does not forget early outputs');
  receive('pause');
  receive('done');
  assert.equal(run.status, 'paused', 'logical completion cannot unpause unsettled background work');
  receive('resume');
  assert.equal(run.status, 'finishing');
  receive('abort');
  receive('pause');
  receive('resume');
  assert.equal(run.status, 'abort-requested', 'late pause/resume cannot reopen cancellation controls');
  receive('latest-settled');
  assert.equal(run.status, 'aborted');
});

test('retained prompt history never reopens answered or unsupported-owner prompts', () => {
  for (const supportsLifecycle of [true, false]) {
    const runs = new LatestDebuggerRuns(() => true);
    const start = frame('root');
    Object.assign(start.rivetScope, supportsLifecycle ? { promptLifecycle: 1 } : {});
    const receive = (message: string, data: object, promptId?: string) => {
      const event = { ...start, message, data, rivetScope: { ...start.rivetScope, ...(promptId ? { promptId } : {}) } };
      return runs.receive(event, JSON.stringify(event));
    };
    runs.receive(start, JSON.stringify(start));
    receive('userInput', { execution: { rootRunId: 'root', graphRunId: 'graph' }, processId: 'process' }, 'prompt');
    if (supportsLifecycle) receive('latest-prompt-closed', { promptId: 'prompt' });
    const prompt = runs.replay().find((entry) => entry.message === 'userInput')!;
    assert.equal(
      (prompt.data as { isReplay?: boolean }).isReplay,
      true,
      'answered/uncertifiable prompt events remain activity, not a new interactive question',
    );
  }
});

test('pending prompt proof is exact and invalidated by gaps and terminals', () => {
  const runs = new LatestDebuggerRuns(() => true, { runs: 2, events: 4, bytes: 32_000 });
  const start = frame('root');
  start.rivetScope.promptLifecycle = 1;
  const receive = (message: string, data: object, promptId?: string) => {
    const event = { ...start, message, data, rivetScope: { ...start.rivetScope, ...(promptId ? { promptId } : {}) } };
    runs.receive(event, JSON.stringify(event));
  };
  runs.receive(start, JSON.stringify(start));
  const ask = (promptId = 'prompt') =>
    receive('userInput', { execution: { rootRunId: 'root', graphRunId: 'graph' }, processId: 'process' }, promptId);
  const interactive = () =>
    !(
      runs
        .replay()
        .filter((entry) => entry.message === 'userInput')
        .at(-1)?.data as { isReplay?: boolean }
    )?.isReplay;
  ask();
  assert.equal(interactive(), true, 'pending prompts remain usable when returning to a run');
  receive('latest-prompt-closed', { promptId: 'other' });
  assert.equal(interactive(), true, 'another prompt cannot settle this callback');
  runs.markIncomplete();
  assert.equal(interactive(), false, 'a missing closure cannot be guessed through a stream gap');
  ask('next');
  receive('nodeFinish', { execution: { rootRunId: 'root', graphRunId: 'graph' }, processId: 'process' });
  assert.equal(interactive(), false, 'exact invocation settlement removes pending proof');
});

test('an unsuffixed generic debugger keeps its legacy adapter, but a managed v1 hello disables unsafe controls', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const runtime = createExecutorSessionRuntime({ onStateChange() {} });
  try {
    await runtime.connectExternalDebugger('ws://test/ws/latest-debugger');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    assert.equal(runtime.getRuntimeState().status, 'ready');
    assert.deepEqual(runtime.getRuntimeState().connection, { kind: 'generic-debugger' });
    assert.equal(runtime.getLatestDebuggerState(), undefined);
    assert.equal(runtime.sendMessage('pause', undefined), true);
    assert.equal(JSON.parse(socket.sent.at(-1)!).type, 'pause');
    socket.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
    assert.deepEqual(runtime.getRuntimeState().connection, { kind: 'managed-latest', protocol: 1, channel: null });
    assert.equal(runtime.getRuntimeState().capabilities.canSendPause, false);
    assert.equal(runtime.sendMessage('pause', undefined), false);
    assert.equal(socket.sent.length, 1);
  } finally {
    runtime.disconnect();
    globalThis.WebSocket = original;
  }
});

test('named latest connections admit no events or dataset requests before their v2 handshake', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  let delivered = 0;
  const runtime = createExecutorSessionRuntime({ projectId: 'project' as never, onStateChange() {} });
  runtime.subscribeMessages(() => {
    delivered++;
  });
  try {
    await runtime.connectExternalDebugger('ws://test/ws/latest-debugger@00123');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.emitMessage(frame('before-hello'));
    assert.equal(delivered, 0, 'a named connection must not fall through to legacy dispatch before verification');
    socket.emitMessage({ message: 'graph-upload-allowed', data: true });
    assert.equal(runtime.getRuntimeState().remoteUploadAllowed, false);
    socket.emitMessage({
      message: 'latest-session',
      data: { protocol: 2, channel: '00123', channelIsolation: true, runScopedControls: true },
    });
    socket.emitMessage(frame('verified'));
    assert.ok(delivered > 0);
    assert.deepEqual(
      runtime.getLatestDebuggerState()!.runs.map((run) => run.scope.rootRunId),
      ['verified'],
    );
  } finally {
    runtime.disconnect();
    globalThis.WebSocket = original;
  }
});

test('managed observation cannot enable uploads or read/write the observer dataset provider', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    for (const protocol of [1, 2])
      await t.test(`protocol ${protocol}`, async () => {
        let writes = 0,
          reads = 0;
        const runtime = createExecutorSessionRuntime({
          onStateChange() {},
          datasetProvider: {
            deleteDataset: async () => {
              writes++;
            },
            getDatasetData: async () => {
              reads++;
              return { rows: [] };
            },
          } as never,
        });
        try {
          await runtime.connectExternalDebugger('ws://test/ws/latest-debugger');
          const socket = FakeWebSocket.instances.at(-1)!;
          socket.open();
          assert.equal(
            runtime.getRuntimeState().capabilities.canBridgeDatasets,
            true,
            'generic adapter remains usable before a managed handshake',
          );
          socket.emitMessage({ message: 'graph-upload-allowed' });
          assert.equal(runtime.getRuntimeState().remoteUploadAllowed, true);
          socket.emitMessage({
            message: 'latest-session',
            data: { protocol, channel: null, channelIsolation: true, runScopedControls: true },
          });
          socket.emitMessage({ message: 'graph-upload-allowed' });
          socket.emitMessage({
            message: 'datasets:delete',
            data: { requestId: 'unexpected', payload: { id: 'local-data' } },
          });
          socket.emitMessage({
            message: 'datasets:get-data',
            data: { requestId: 'unexpected-read', payload: { id: 'local-data' } },
          });
          assert.equal(writes, 0, 'observation never owns the viewer dataset provider');
          assert.equal(reads, 0, 'observation cannot read viewer data either');
          assert.equal(runtime.getRuntimeState().capabilities.canBridgeDatasets, false);
          assert.equal(runtime.getRuntimeState().capabilities.canUploadProject, false);
          assert.equal(runtime.getRuntimeState().remoteUploadAllowed, false);
          assert.equal(socket.sent.length, 0);
        } finally {
          runtime.disconnect();
        }
      });
  } finally {
    globalThis.WebSocket = original;
  }
});

test('a managed v2 logical session rejects downgrade or unsupported handshakes on reconnect', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    for (const channel of [null, '00123'])
      for (const invalid of [
        { label: 'protocol 1', data: { protocol: 1 } },
        { label: 'protocol 3', data: { protocol: 3 } },
        { label: 'string isolation flag', data: { protocol: 2, channelIsolation: 'true', runScopedControls: true } },
        { label: 'numeric controls flag', data: { protocol: 2, channelIsolation: true, runScopedControls: 1 } },
      ])
        await t.test(`${channel ?? 'default'} rejects ${invalid.label}`, async () => {
          const runtime = createExecutorSessionRuntime({ projectId: 'project' as never, onStateChange() {} });
          try {
            await runtime.connectExternalDebugger(`ws://test/ws/latest-debugger${channel ? '@' + channel : ''}`);
            const socket = FakeWebSocket.instances.at(-1)!;
            socket.open();
            socket.emitMessage({
              message: 'latest-session',
              data: { protocol: 2, channel, channelIsolation: true, runScopedControls: true },
            });
            socket.emitMessage({ ...frame('root'), rivetScope: { ...frame('root').rivetScope, channel } });
            const count = FakeWebSocket.instances.length;
            socket.emitClose();
            const deadline = Date.now() + 2000;
            while (FakeWebSocket.instances.length === count) {
              assert.ok(Date.now() < deadline, 'managed reconnect was not attempted');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const next = FakeWebSocket.instances.at(-1)!;
            next.open();
            next.emitMessage({ message: 'latest-session', data: { channel, ...invalid.data } });
            assert.equal(runtime.getRuntimeState().status, 'idle', 'incompatible identity must fail closed');
            assert.equal(runtime.getLatestDebuggerState(), undefined);
            assert.equal(next.sent.length, 0, 'rejection must not replay controls or execution');
          } finally {
            runtime.disconnect();
          }
        });
  } finally {
    globalThis.WebSocket = original;
  }
});

test('v2 connection validates channel, targets captured runs, pins on pause and never replays controls on reconnect', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.instances = [];
  let revisions = 0;
  const runtime = createExecutorSessionRuntime({
    projectId: 'project' as never,
    onStateChange() {
      revisions++;
    },
  });
  let connected = 0;
  runtime.subscribeLifecycle('connect', () => {
    connected++;
  });
  try {
    await runtime.connectExternalDebugger('ws://test/ws/latest-debugger@00123');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    assert.equal(runtime.getRuntimeState().capabilities.canSendPause, false);
    socket.emitMessage({
      message: 'latest-session',
      data: { protocol: 2, channel: '00123', channelIsolation: true, runScopedControls: true },
    });
    assert.equal(connected, 1);
    const emitted: Array<{ root: string; selected: boolean; reset: boolean }> = [];
    runtime.subscribeMessages((_message, _data, _requestId, admission) => {
      if (admission?.managedLatest)
        emitted.push({
          root: admission.managedLatest.scope.rootRunId,
          selected: admission.managedLatest.selected,
          reset: admission.managedLatest.reset,
        });
    });
    socket.emitMessage(frame('a'));
    socket.emitMessage(frame('b'));
    const beforeOutputs = revisions;
    socket.emitMessage(frame('b', 'graphOutputsReady'));
    assert.ok(revisions > beforeOutputs, 'output readiness must notify catalogue/UI subscribers');
    assert.equal(runtime.sendMessage('pause', undefined), true);
    const command = JSON.parse(socket.sent.at(-1)!);
    assert.equal(command.type, 'latest-control');
    assert.equal(command.data.target.rootRunId, 'b');
    socket.emitMessage({
      message: 'latest-control-result',
      data: { commandId: command.data.commandId, status: 'accepted' },
    });
    socket.emitMessage(frame('c'));
    assert.equal(
      runtime.getLatestDebuggerState()!.runs.find((run) => run.key === runtime.getLatestDebuggerState()!.selected)!
        .scope.rootRunId,
      'b',
    );
    const count = emitted.length;
    socket.emitMessage({ ...frame('foreign'), rivetScope: { ...frame('foreign').rivetScope, channel: 'B' } });
    assert.equal(emitted.length, count);
    runtime.selectLatestDebuggerRun();
    assert.ok(emitted.some((event) => event.root === 'c' && event.reset));
    assert.equal(socket.sent.length, 1, 'selection and rebuild issue no runtime commands');
    socket.emitClose();
    assert.equal(runtime.sendMessage('abort', undefined), false);
    assert.equal(socket.sent.length, 1);
    const selected = runtime.getLatestDebuggerState()!.selected;
    const deadline = Date.now() + 2000;
    while (FakeWebSocket.instances.length < 2) {
      assert.ok(Date.now() < deadline, 'Managed transport did not reconnect');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reconnected = FakeWebSocket.instances.at(-1)!;
    reconnected.open();
    assert.equal(runtime.getRuntimeState().status, 'connecting');
    reconnected.emitMessage({
      message: 'latest-session',
      data: { protocol: 2, channel: '00123', channelIsolation: true, runScopedControls: true },
    });
    assert.equal(runtime.getLatestDebuggerState()!.selected, selected);
    assert.equal(reconnected.sent.length, 0);
    assert.equal(connected, 1, 'reconnect is the same logical session');
    reconnected.emitMessage({
      message: 'latest-session',
      data: { protocol: 2, channel: 'wrong', channelIsolation: true, runScopedControls: true },
    });
    assert.equal(runtime.getLatestDebuggerState(), undefined, 'contradictory handshake fails closed');
  } finally {
    runtime.disconnect();
    globalThis.WebSocket = original;
  }
});
