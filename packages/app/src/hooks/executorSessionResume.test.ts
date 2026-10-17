import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWebSocket, installExecutorSessionTestHooks, runtime } from './executorSessionTestUtils.js';
import { createExecutorSessionRuntime } from './executorSession.js';
import { ExecutionRecorder } from '@valerypopoff/rivet2-core';

installExecutorSessionTestHooks();

test('a new HA session enables commands and notifies connect only after its ready acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connects = 0;
  runtime.subscribeLifecycle('connect', () => { connects++; });
  const url = 'wss://rivet.example/ws/executor/owner/initial-owner';
  await runtime.connectInternalHostedExecutor(url);
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  assert.equal(runtime.isReady(), false);
  assert.equal(runtime.getRuntimeState().capabilities.canSendRun, false);
  assert.equal(runtime.recordSocketEvents(() => { assert.fail('handshake cannot start a recording'); }), undefined);
  assert.equal(connects, 0);
  socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'n'.repeat(43) } });
  await runtime.connectInternalHostedExecutor(url);
  assert.equal(runtime.isReady(), false, 'identity and socket reuse are not ready acknowledgements');
  socket.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  assert.equal(runtime.isReady(), true);
  assert.equal(runtime.getRuntimeState().capabilities.canSendRun, true);
  assert.equal(connects, 1);
  socket.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  socket.emitClose();
  t.mock.timers.tick(200);
  const resumed = FakeWebSocket.instances.at(-1)!;
  resumed.open();
  resumed.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'n'.repeat(43) } });
  resumed.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  assert.equal(runtime.isReady(), true);
  assert.equal(connects, 1, 'replay completion is not a second logical connection');
  t.mock.timers.tick(60_000);
  assert.equal(runtime.isReady(), true, 'successful negotiation clears its deadline');
  assert.deepEqual(FakeWebSocket.instances.flatMap(connection => connection.sent), []);
});

test('first HA ready notification survives losing the transport after identity acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connects = 0;
  runtime.subscribeLifecycle('connect', () => { connects++; });
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/initial-owner');
  const first = FakeWebSocket.instances.at(-1)!;
  first.open();
  first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'n'.repeat(43) } });
  first.emitClose();
  assert.equal(connects, 0);
  t.mock.timers.tick(200);
  const resumed = FakeWebSocket.instances.at(-1)!;
  resumed.open();
  resumed.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'n'.repeat(43) } });
  resumed.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  assert.equal(connects, 1);
  assert.equal(runtime.isReady(), true);
});

for (const stalledAt of ['identity', 'ready', 'reconnect'] as const) {
  test(`initial HA negotiation expires when stalled at ${stalledAt}, without replaying work`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let connects = 0;
    runtime.subscribeLifecycle('connect', () => { connects++; });
    await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/stalled-owner');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    if (stalledAt !== 'identity') socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 't'.repeat(43) } });
    const pending = runtime.createPendingGraphExecution();
    const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
    t.mock.timers.tick(30_000);
    if (stalledAt === 'reconnect') {
      socket.emitClose();
      t.mock.timers.tick(200);
      FakeWebSocket.instances.at(-1)!.open();
    }
    t.mock.timers.tick(stalledAt === 'reconnect' ? 29_799 : 29_999);
    assert.notEqual(runtime.getRuntimeState().status, 'idle');
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(runtime.getRuntimeState().status, 'idle');
    assert.equal(connects, 0);
    const count = FakeWebSocket.instances.length;
    t.mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, count, 'expired negotiation cannot keep reconnecting');
    assert.deepEqual(FakeWebSocket.instances.flatMap(connection => connection.sent), []);
  });
}

for (const ending of ['disconnect', 'replacement'] as const) {
  test(`initial HA deadline cannot affect the session after ${ending}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/stalled-owner');
    const stale = FakeWebSocket.instances.at(-1)!;
    stale.open();
    if (ending === 'disconnect') runtime.disconnect();
    else {
      await runtime.connectExternalDebugger('wss://custom.example/selected');
      FakeWebSocket.instances.at(-1)!.open();
    }
    const expected = runtime.getRuntimeState();
    stale.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 't'.repeat(43) } });
    stale.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
    t.mock.timers.tick(60_000);
    assert.equal(runtime.getRuntimeState().status, expected.status);
    assert.equal(runtime.getRuntimeState().socket, expected.socket);
    assert.equal(FakeWebSocket.instances.length, ending === 'disconnect' ? 1 : 2);
  });
}

for (const acknowledgement of ['different capability', 'malformed capability', 'array capability', 'wrong protocol', 'missing acknowledgement'] as const) {
  test(`resume rejects ${acknowledgement} before delivering retained dataset results`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    runtime.setDatasetProvider({ getDatasetData: async () => ({ private: 'original-session' }) } as never);
    await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/identity-owner');
    const original = FakeWebSocket.instances.at(-1)!;
    original.open();
    const capability = 'a'.repeat(43);
    original.emitMessage({ message: 'executor-session', data: { protocol: 1, capability } });
    const pending = runtime.createPendingGraphExecution();
    const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
    original.emitMessage({ message: 'datasets:get-data', data: { requestId: 'private-read', payload: { id: 'dataset' } }, rivetSequence: 1 });
    original.emitClose();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(200);
    const resumed = FakeWebSocket.instances.at(-1)!;
    resumed.open();
    if (acknowledgement !== 'missing acknowledgement') resumed.emitMessage({ message: 'executor-session', data: {
      protocol: acknowledgement === 'wrong protocol' ? 2 : 1,
      capability: acknowledgement === 'different capability' ? 'b'.repeat(43)
        : acknowledgement === 'array capability' ? [capability]
        : acknowledgement === 'malformed capability' ? 'invalid' : capability,
    } });
    resumed.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
    assert.deepEqual(resumed.sent, [], 'a mismatched session must never receive the original result');
    await rejected;
    assert.equal(runtime.getRuntimeState().status, 'idle');
    t.mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, 2);
  });
}

test('a resumed socket cannot dispatch dataset work before acknowledging the original session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  runtime.setDatasetProvider({ putDatasetRow: async () => { writes++; } } as never);
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/identity-owner');
  const original = FakeWebSocket.instances.at(-1)!;
  original.open();
  original.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'a'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  original.emitClose();
  t.mock.timers.tick(200);
  const resumed = FakeWebSocket.instances.at(-1)!;
  resumed.open();
  resumed.emitMessage({ message: 'datasets:put-row', rivetSequence: 1,
    data: { requestId: 'unacknowledged-write', payload: { id: 'dataset', row: { id: 'row', data: [] } } } });
  assert.equal(writes, 0);
  await rejected;
  assert.equal(runtime.getRuntimeState().status, 'idle');
});

test('repeated failed reconnects back off and a successful transport resets the delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await runtime.connectInternalHostedExecutor('wss://rivet.example/internal');
  const original = FakeWebSocket.instances.at(-1)!;
  original.open();
  original.emitClose();
  let delay = 150;
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = FakeWebSocket.instances.length;
    t.mock.timers.tick(Math.ceil(delay) - 1);
    assert.equal(FakeWebSocket.instances.length, count);
    t.mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, count + 1);
    FakeWebSocket.instances.at(-1)!.emitClose();
    delay = Math.min(2000, (delay + 100) * 1.5);
  }
  t.mock.timers.tick(2000);
  const recovered = FakeWebSocket.instances.at(-1)!;
  recovered.open();
  recovered.emitClose();
  const count = FakeWebSocket.instances.length;
  t.mock.timers.tick(149);
  assert.equal(FakeWebSocket.instances.length, count);
  t.mock.timers.tick(1);
  assert.equal(FakeWebSocket.instances.length, count + 1);
});

for (const completion of ['before resume', 'after resume'] as const) {
  test(`an accepted dataset write finishing ${completion} acknowledges the logical session once`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let completeWrite!: () => void;
    let writes = 0;
    runtime.setDatasetProvider({ putDatasetRow: async () => {
      writes++;
      await new Promise<void>(resolve => { completeWrite = resolve; });
    } } as never);
    const url = 'wss://rivet.example/ws/executor/owner/dataset-owner';
    await runtime.connectInternalHostedExecutor(url);
    const original = FakeWebSocket.instances.at(-1)!;
    original.open();
    const capability = 'd'.repeat(43);
    original.emitMessage({ message: 'executor-session', data: { protocol: 1, capability } });
    original.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
    const request = { message: 'datasets:put-row', rivetSequence: 1,
      data: { requestId: 'accepted-write', payload: { id: 'dataset', row: { id: 'row', data: ['value'] } } } };
    original.emitMessage(request);
    original.emitClose();
    if (completion === 'before resume') {
      completeWrite();
      await new Promise(resolve => setImmediate(resolve));
    }
    t.mock.timers.tick(200);
    const resumed = FakeWebSocket.instances.at(-1)!;
    resumed.open();
    resumed.emitMessage({ message: 'executor-session', data: { protocol: 1, capability, resumed: true } });
    resumed.emitMessage(request);
    resumed.emitMessage({ message: 'executor-session-ready', data: { protocol: 1, resumed: true } });
    if (completion === 'after resume') {
      completeWrite();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(writes, 1);
    assert.deepEqual(original.sent, []);
    assert.equal(resumed.sent.length, 1);
    const response = JSON.parse(resumed.sent[0]!);
    assert.deepEqual(response, { type: 'datasets:response', data: { requestId: 'accepted-write' } });
  });
}

for (const ending of ['disconnect', 'replacement', 'expiry'] as const) {
  test(`dataset completion after ${ending} cannot leak into another logical session`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let completeRead!: (data: unknown) => void;
    runtime.setDatasetProvider({ getDatasetData: () => new Promise(resolve => { completeRead = resolve; }) } as never);
    const url = 'wss://rivet.example/ws/executor/owner/dataset-owner';
    await runtime.connectInternalHostedExecutor(url);
    const old = FakeWebSocket.instances.at(-1)!;
    old.open();
    old.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'e'.repeat(43) } });
    old.emitMessage({ message: 'datasets:get-data', data: { requestId: 'old-request', payload: { id: 'dataset' } }, rivetSequence: 1 });
    if (ending === 'disconnect') runtime.disconnect();
    if (ending === 'replacement') await runtime.connectExternalDebugger('wss://custom.example/selected');
    if (ending === 'expiry') { old.emitClose(); t.mock.timers.tick(60_000); }
    await runtime.connectInternalHostedExecutor(url);
    const fresh = FakeWebSocket.instances.at(-1)!;
    fresh.open();
    fresh.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'f'.repeat(43) } });
    fresh.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
    completeRead({ rows: ['private-old-result'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fresh.sent, []);
    assert.equal(runtime.isReady(), true);
  });
}

for (const budget of ['count', 'bytes'] as const) {
  test(`disconnected dataset response ${budget} overflow stops recovery without repeating work`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    runtime.setDatasetProvider({ getDatasetData: async () => {
      reads++;
      return budget === 'bytes' ? 'x'.repeat(8 * 1024 * 1024) : {};
    } } as never);
    await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/bounded-owner');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'b'.repeat(43) } });
    const pending = runtime.createPendingGraphExecution();
    const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
    const count = budget === 'count' ? 65 : 1;
    for (let i = 0; i < count; i++) socket.emitMessage({
      message: 'datasets:get-data', data: { requestId: `dataset-${i}`, payload: { id: 'dataset' } }, rivetSequence: i + 1,
    });
    socket.emitClose();
    await rejected;
    assert.equal(reads, count);
    assert.equal(runtime.getRuntimeState().status, 'idle');
    assert.deepEqual(socket.sent, []);
  });
}

test('connected dataset responses preserve the existing large-payload behavior', async () => {
  const payload = 'x'.repeat(8 * 1024 * 1024);
  runtime.setDatasetProvider({ getDatasetData: async () => payload } as never);
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/large-owner');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'l'.repeat(43) } });
  socket.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  socket.emitMessage({ message: 'datasets:get-data', data: { requestId: 'large', payload: { id: 'dataset' } }, rivetSequence: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(socket.sent[0]!).data.payload.length, payload.length);
  assert.equal(runtime.isReady(), true);
});

const graphStart = { graph: { metadata: { id: 'recorded-graph' } }, inputs: {} };

test('a real recording survives socket replacement and captures replayed events exactly once', async () => {
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/recording-owner');
  const first = FakeWebSocket.instances.at(-1)!;
  first.open();
  first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'r'.repeat(43) } });
  first.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  const recorder = new ExecutionRecorder();
  let finalized = 0;
  const recording = runtime.recordSocketEvents(channel => recorder.recordSocket(channel, { requestId: 'owned-run' }))!
    .then(() => { finalized++; });
  first.emitMessage({ message: 'graphStart', data: graphStart, requestId: 'owned-run', rivetSequence: 1 });
  first.emitClose();
  await Promise.resolve();
  assert.equal(finalized, 0, 'physical disconnect is not logical recording completion');
  await new Promise(resolve => setTimeout(resolve, 200));
  const second = FakeWebSocket.instances.at(-1)!;
  second.open();
  second.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'r'.repeat(43), resumed: true } });
  second.emitMessage({ message: 'graphStart', data: graphStart, requestId: 'owned-run', rivetSequence: 1 });
  second.emitMessage({ message: 'executor-session-ready', data: { protocol: 1, resumed: true } });
  second.emitMessage({ message: 'done', data: { results: {} }, requestId: 'another-run', rivetSequence: 2 });
  assert.equal(finalized, 0);
  second.emitMessage({ message: 'done', data: { results: { result: { type: 'string', value: 'recorded' } } }, requestId: 'owned-run', rivetSequence: 3 });
  await recording;
  second.emitMessage({ message: 'done', data: { results: {} }, requestId: 'owned-run', rivetSequence: 3 });
  assert.equal(finalized, 1);
  assert.deepEqual(recorder.events.map(event => event.type), ['graphStart', 'done']);
  assert.deepEqual(second.sent, [], 'reconnect must not replay execution');
});

for (const ending of ['manual disconnect', 'session replacement', 'cursor gap', 'resume expiry'] as const) {
  test(`recording stops incompletely on ${ending} without accepting another session's events`, async (t) => {
    if (ending === 'resume expiry') t.mock.timers.enable({ apis: ['setTimeout'] });
    await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/recording-owner');
    const first = FakeWebSocket.instances.at(-1)!;
    first.open();
    first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 's'.repeat(43) } });
    first.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
    const recorder = new ExecutionRecorder();
    const recording = runtime.recordSocketEvents(channel => recorder.recordSocket(channel, { requestId: 'owned-run' }))!;
    first.emitMessage({ message: 'graphStart', data: graphStart, requestId: 'owned-run', rivetSequence: 1 });
    if (ending === 'manual disconnect') runtime.disconnect();
    else if (ending === 'session replacement') await runtime.connectExternalDebugger('wss://debugger.example/replacement');
    else if (ending === 'cursor gap') first.emitMessage({ message: 'done', data: { results: {} }, requestId: 'owned-run', rivetSequence: 3 });
    else {
      first.emitClose();
      t.mock.timers.tick(60_000);
    }
    await recording;
    first.emitMessage({ message: 'done', data: { results: {} }, requestId: 'owned-run', rivetSequence: 2 });
    assert.deepEqual(recorder.events.map(event => event.type), ['graphStart']);
    assert.equal(FakeWebSocket.instances.flatMap(socket => socket.sent).length, 0);
  });
}
test('only positively idle retired owners discover a new executor, without replaying run commands', async () => {
  let discoveries = 0;
  const session = createExecutorSessionRuntime({ onStateChange: () => {}, resolveInternalHostedExecutorUrl: async () => {
    discoveries++; return 'wss://rivet.example/ws/executor/owner/new-owner';
  } });
  await session.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/old-owner');
  const old = FakeWebSocket.instances.at(-1)!; old.open();
  old.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'i'.repeat(43) } });
  old.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  const pending = session.createPendingGraphExecution();
  old.emitMessage({ message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: 1 });
  await Promise.resolve(); assert.equal(discoveries, 0);
  session.resolvePendingGraphExecution(pending.requestId, {}); await pending.promise;
  old.emitMessage({ message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: 2 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(discoveries, 1);
  const fresh = FakeWebSocket.instances.at(-1)!;
  assert.equal(fresh.url, 'wss://rivet.example/ws/executor/owner/new-owner'); assert.deepEqual(fresh.protocols, ['rivet-session-v1']);
  assert.deepEqual(fresh.sent, []); fresh.open();
  fresh.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'j'.repeat(43) } });
  fresh.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  await session.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/old-owner');
  assert.equal(FakeWebSocket.instances.at(-1), fresh);
  session.disconnect();
});

for (const change of ['disconnect', 'replacement', 'pending run', 'active run', 'expired lookup'] as const) {
  test(`a delayed retired-owner lookup cannot override ${change}`, async (t) => {
    let completeLookup!: (url: string) => void;
    const session = createExecutorSessionRuntime({
      onStateChange: () => {},
      resolveInternalHostedExecutorUrl: () => new Promise(resolve => { completeLookup = resolve; }),
    });
    t.after(() => session.disconnect());
    const ownerUrl = 'wss://rivet.example/ws/executor/owner/old-owner';
    await session.connectInternalHostedExecutor(ownerUrl);
    const original = FakeWebSocket.instances.at(-1)!;
    original.open();
    original.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'h'.repeat(43) } });
    original.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
    original.emitMessage({ message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: 1 });
    assert.equal(typeof completeLookup, 'function');

    let pending: ReturnType<typeof session.createPendingGraphExecution> | undefined;
    if (change === 'disconnect') session.disconnect();
    if (change === 'replacement') {
      await session.connectExternalDebugger('wss://custom.example/selected-by-user');
      FakeWebSocket.instances.at(-1)!.open();
    }
    if (change === 'pending run') pending = session.createPendingGraphExecution();
    if (change === 'active run') session.setActiveGraphRunRequestId('accepted-run');
    if (change === 'expired lookup') t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
    const expected = session.getRuntimeState();
    completeLookup('wss://rivet.example/ws/executor/owner/discovered-owner');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(FakeWebSocket.instances.length, change === 'replacement' ? 2 : 1);
    assert.equal(session.getRuntimeState().target, expected.target);
    assert.equal(session.getRuntimeState().status, expected.status);
    assert.equal(session.getActiveGraphRunRequestId(), change === 'active run' ? 'accepted-run' : null);
    if (pending) {
      session.resolvePendingGraphExecution(pending.requestId, {});
      assert.deepEqual(await pending.promise, {});
    }
    assert.deepEqual(FakeWebSocket.instances.flatMap(socket => socket.sent), []);
  });
}
test('HA latest reconnect preserves observations and never duplicates lifecycle or replayed events', async () => {
  let connects = 0; const messages: string[] = [];
  runtime.subscribeLifecycle('connect', () => { connects++; });
  runtime.subscribeMessages(message => { messages.push(message); });
  await runtime.connectExternalDebugger('wss://rivet.example/ws/latest-debugger');
  const first = FakeWebSocket.instances.at(-1)!; first.open();
  first.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
  first.emitMessage({ message: 'start', data: {}, rivetEventId: 'backend-0:owner:1' });
  first.emitClose();
  await new Promise(resolve => setTimeout(resolve, 200));
  const resumed = FakeWebSocket.instances.at(-1)!; resumed.open();
  assert.equal(runtime.isReady(), false);
  resumed.emitMessage({ message: 'latest-session', data: { protocol: 1 } });
  resumed.emitMessage({ message: 'start', data: {}, rivetEventId: 'backend-0:owner:1' });
  resumed.emitMessage({ message: 'done', data: {}, rivetEventId: 'backend-0:owner:2' });
  assert.equal(connects, 1); assert.deepEqual(messages, ['start', 'done']); assert.deepEqual(resumed.sent, []);
});

for (const kind of ['hosted', 'latest'] as const) {
  test(`reusing an open ${kind} socket cannot declare replay complete`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const url = kind === 'hosted'
      ? 'wss://rivet.example/ws/executor/owner/replay-owner'
      : 'wss://rivet.example/ws/latest-debugger';
    const connect = () => kind === 'hosted' ? runtime.connectInternalHostedExecutor(url) : runtime.connectExternalDebugger(url);
    const ready = kind === 'hosted' ? 'executor-session-ready' : 'latest-session';
    await connect();
    const first = FakeWebSocket.instances.at(-1)!;
    first.open();
    if (kind === 'hosted') first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'p'.repeat(43) } });
    first.emitMessage({ message: ready, data: { protocol: 1 } });
    first.emitClose();
    t.mock.timers.tick(200);
    const resumed = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(resumed, first);
    resumed.open();
    assert.equal(runtime.isReady(), false);
    await connect();
    assert.equal(FakeWebSocket.instances.at(-1), resumed);
    assert.equal(runtime.isReady(), false, 'an open transport is not an acknowledged replay');
    assert.equal(runtime.getRuntimeState().capabilities.canSendRun, false);
    if (kind === 'hosted') resumed.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'p'.repeat(43) } });
    resumed.emitMessage({ message: ready, data: { protocol: 1 } });
    assert.equal(runtime.isReady(), true);
    assert.deepEqual(resumed.sent, []);
  });
}

for (const replacement of ['disconnect', 'direct replacement', 'transport reconnect'] as const) {
  test(`an abandoned discovery cannot block or clear the new session's handoff after ${replacement}`, async (t) => {
    if (replacement === 'transport reconnect') t.mock.timers.enable({ apis: ['setTimeout'] });
    const lookups: Array<(url: string) => void> = [];
    const session = createExecutorSessionRuntime({
      onStateChange: () => {},
      resolveInternalHostedExecutorUrl: () => new Promise(resolve => { lookups.push(resolve); }),
    });
    t.after(() => session.disconnect());
    const handshake = (socket: FakeWebSocket) => {
      socket.open();
      socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'o'.repeat(43) } });
      socket.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
      return socket;
    };
    const open = async (name: string) => {
      await session.connectInternalHostedExecutor(`wss://rivet.example/ws/executor/owner/${name}`);
      return handshake(FakeWebSocket.instances.at(-1)!);
    };
    const retire = (socket: FakeWebSocket, sequence: number) => socket.emitMessage({
      message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: sequence,
    });
    const old = await open('abandoned-owner');
    retire(old, 1);
    assert.equal(lookups.length, 1);
    let current: FakeWebSocket;
    if (replacement === 'transport reconnect') {
      old.emitClose();
      t.mock.timers.tick(200);
      current = handshake(FakeWebSocket.instances.at(-1)!);
      assert.notEqual(current, old);
    } else {
      if (replacement === 'disconnect') session.disconnect();
      else await session.connectExternalDebugger('wss://custom.example/replacement');
      current = await open('current-owner');
    }
    retire(current, replacement === 'transport reconnect' ? 2 : 1);
    assert.equal(lookups.length, 2, 'old discovery must not own a replacement session');
    lookups[0]!('wss://rivet.example/ws/executor/owner/stale-answer');
    await new Promise(resolve => setImmediate(resolve));
    retire(current, replacement === 'transport reconnect' ? 3 : 2);
    assert.equal(lookups.length, 2, 'old completion must not clear the replacement handoff');
    lookups[1]!('wss://rivet.example/ws/executor/owner/fresh-owner');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(FakeWebSocket.instances.at(-1)!.url, 'wss://rivet.example/ws/executor/owner/fresh-owner');
    assert.deepEqual(FakeWebSocket.instances.flatMap(socket => socket.sent), []);
  });
}
test('hosted resume keeps pending results, replays diagnostics once and never sends run again', async () => {
  const cap = 'a'.repeat(43);
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const first = FakeWebSocket.instances.at(-1)!;
  first.open();
  first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: cap } });
  first.emitMessage({ message: 'executor-session-ready', data: { protocol: 1 } });
  const messages: string[] = [];
  runtime.subscribeMessages((message) => {
    messages.push(message);
  });
  first.emitMessage({ message: 'start', data: {}, rivetSequence: 1 });
  const pending = runtime.createPendingGraphExecution();
  const result = pending.promise;
  first.emitClose();
  assert.equal(runtime.getRuntimeState().status, 'reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = FakeWebSocket.instances.at(-1)!;
  assert.notEqual(second, first);
  assert.deepEqual(second.protocols, ['rivet-session-v1', `rivet-cap.${cap}`, 'rivet-seq.1']);
  second.open();
  assert.equal(runtime.isReady(), false);
  assert.notEqual(runtime.getRuntimeState().status, 'ready');
  second.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: cap, resumed: true } });
  second.emitMessage({ message: 'start', data: {}, rivetSequence: 1 });
  second.emitMessage({ message: 'done', data: {}, rivetSequence: 2 });
  second.emitMessage({ message: 'executor-session-ready', data: { protocol: 1, resumed: true } });
  assert.deepEqual(messages, ['start', 'done']);
  assert.equal(runtime.isReady(), true);
  assert.deepEqual(second.sent, []);
  runtime.resolvePendingGraphExecution(pending.requestId, {});
  assert.deepEqual(await result, {});
});

test('a missing owner or diagnostic gap settles as unknown without replaying a run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const first = FakeWebSocket.instances.at(-1)!;
  first.open();
  first.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'b'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  first.emitClose();
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(runtime.getRuntimeState().status, 'idle');
  assert.equal(FakeWebSocket.instances.flatMap((socket) => socket.sent).length, 0);
});

test('a diagnostic cursor gap never reopens a terminal or pending execution', async () => {
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'c'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  socket.emitMessage({ message: 'done', data: {}, rivetSequence: 2 });
  await rejected;
  assert.equal(runtime.getRuntimeState().status, 'idle');
});

test('a fenced observer stops recovery instead of taking a new session from its replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await runtime.connectInternalHostedExecutor('wss://rivet.example/ws/executor/owner/test-owner');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.emitMessage({ message: 'executor-session', data: { protocol: 1, capability: 'd'.repeat(43) } });
  const pending = runtime.createPendingGraphExecution();
  const rejected = assert.rejects(pending.promise, /outcome is unknown.*not resubmitted/);
  socket.emitClose(4409);
  await rejected;
  t.mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(runtime.getRuntimeState().status, 'idle');
});

test('legacy hosted URLs and custom overrides keep their existing protocol-free handshake', async () => {
  await runtime.connectInternalHostedExecutor('wss://custom.example/internal');
  assert.equal(FakeWebSocket.instances.at(-1)!.protocols, undefined);
});
