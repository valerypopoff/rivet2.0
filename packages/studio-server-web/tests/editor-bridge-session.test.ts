import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorBridgeSession } from '../dashboard/editorBridgeSession';
import type { DashboardToEditorCommand } from '../../studio-server-shared/editor-bridge';

function fixture(maxEntries = 128) {
  const timers = new Map<number, () => void>();
  let sequence = 0;
  let now = 0;
  let reconciliations = 0;
  const session = new EditorBridgeSession({
    maxEntries,
    now: () => now,
    onReconciliationRequired: () => reconciliations++,
    setTimer: ((callback: () => void) => {
      timers.set(++sequence, callback);
      return sequence;
    }) as typeof setTimeout,
    clearTimer: ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout,
  });
  const sent: DashboardToEditorCommand[] = [];
  return {
    session,
    sent,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    get reconciliations() {
      return reconciliations;
    },
    expire: () => {
      for (const callback of [...timers.values()]) callback();
    },
    ready: (instance = 'editor-1') => session.ready(instance, (command) => sent.push(command)),
  };
}
const recording = (requestId: string): DashboardToEditorCommand & { requestId: string } => ({
  type: 'open-recording',
  recordingId: 'run-1',
  replaceCurrent: false,
  requestId,
});

test('dispatch checks deadlines even when timeout callbacks are throttled', async () => {
  const f = fixture();
  const pending = f.session.request(recording('delayed'), 'opened', 10);
  f.session.post({ type: 'save-project' });
  f.advance(120_001);
  f.ready();
  assert.deepEqual(await pending, { status: 'expired' });
  assert.deepEqual(f.sent, []);
  assert.equal(f.session.pendingCount, 0);
  assert.equal(f.session.pendingBytes, 0);
  assert.equal(f.timers.size, 0);
});

test('late replies cannot defeat a throttled deadline or settle a newer request', async () => {
  const f = fixture();
  f.ready();
  const pending = f.session.request(recording('late'), 'opened', 10);
  f.advance(10);
  assert.equal(f.session.acknowledge('late', 'opened', true), false);
  assert.deepEqual(await pending, { status: 'unknown' });
  const next = f.session.request(recording('new'), 'opened', 10);
  assert.equal(f.session.acknowledge('late', 'opened', true), false);
  assert.equal(f.session.acknowledge('new', 'opened', true), true);
  assert.equal((await next).status, 'completed');
  assert.equal(f.timers.size, 0);
});

test('throttled durable expiry settles its caller but still delivers the committed notification', async () => {
  const f = fixture();
  const pending = f.session.request({ type: 'workflow-paths-moved', moves: [], requestId: 'move' }, 'moved', 10);
  f.advance(11);
  f.ready();
  assert.deepEqual(await pending, { status: 'expired' });
  assert.equal(f.sent[0]?.type, 'workflow-paths-moved');
  assert.equal(f.session.pendingCount, 0);
  assert.equal(f.timers.size, 0);
});

test('rejected committed changes trigger reconciliation without retaining an overflow queue', async () => {
  const f = fixture(1);
  const pending = f.session.request(recording('occupier'), 'opened', 10);
  const moved = await f.session.request({ type: 'workflow-paths-moved', moves: [], requestId: 'move' }, 'moved', 10);
  assert.deepEqual(moved, { status: 'overloaded' });
  assert.equal(f.session.post({ type: 'delete-workflow-project', path: '/workflows/deleted.rivet-project' }), false);
  assert.equal(f.reconciliations, 2);
  assert.equal(f.session.pendingCount, 1);
  f.expire();
  await pending;
  // The existing tree reconciler can acquire a fresh request once capacity is
  // available. Neither the move nor the expired interactive request is replayed.
  f.ready();
  const reconciliation = f.session.request(
    { type: 'capture-workflow-project-reconciliation', requestId: 'capture' },
    'captured',
    10,
  );
  assert.deepEqual(
    f.sent.map((command) => command.type),
    ['capture-workflow-project-reconciliation'],
  );
  f.session.acknowledge('capture', 'captured', null);
  await reconciliation;
  assert.equal(f.session.pendingCount, 0);
  let byteReconciliations = 0;
  const bounded = new EditorBridgeSession({ maxBytes: 1, onReconciliationRequired: () => byteReconciliations++ });
  assert.equal(
    bounded.post({ type: 'refresh-open-project-from-disk', path: '/workflows/project.rivet-project' }),
    false,
  );
  assert.equal(byteReconciliations, 1);
  assert.equal(bounded.pendingBytes, 0);
});

test('unconfirmed dispatched mutations reconcile on timeout and replacement, never replay', async () => {
  const f = fixture();
  f.ready();
  const timeout = f.session.request({ type: 'workflow-paths-moved', moves: [], requestId: 'move-1' }, 'moved', 10);
  f.expire();
  assert.deepEqual(await timeout, { status: 'unknown' });
  assert.equal(f.reconciliations, 1);
  const replaced = f.session.request({ type: 'workflow-paths-moved', moves: [], requestId: 'move-2' }, 'moved', 10);
  f.ready('replacement');
  assert.deepEqual(await replaced, { status: 'replaced' });
  assert.equal(f.reconciliations, 2);
  assert.equal(f.sent.length, 2);
  assert.equal(f.session.acknowledge('move-2', 'moved', undefined), false);
  f.session.dispose();
  assert.equal(f.reconciliations, 2, 'terminal disposal must not schedule updates on an unmounted dashboard');
});

test('expired and cancelled queued requests are never delivered at readiness', async () => {
  const f = fixture();
  const expired = f.session.request(recording('expired'), 'opened', 10);
  const cancelled = f.session.request(recording('cancelled'), 'opened', 10);
  assert.equal(f.session.cancelQueued('cancelled'), true);
  f.expire();
  assert.deepEqual(await expired, { status: 'expired' });
  assert.deepEqual(await cancelled, { status: 'expired' });
  f.ready();
  assert.equal(f.sent.length, 0);
  assert.equal(f.session.pendingBytes, 0);
  assert.equal(f.timers.size, 0);
});

test('transport failure recovers committed changes through reconciliation without replay', async () => {
  const f = fixture();
  f.session.ready('editor-1', () => {
    throw new Error('transport unavailable');
  });
  assert.deepEqual(
    await f.session.request({ type: 'workflow-paths-moved', moves: [], requestId: 'move' }, 'moved', 10),
    { status: 'unknown' },
  );
  assert.equal(f.reconciliations, 1);
  assert.equal(f.session.pendingBytes, 0);
  assert.equal(f.timers.size, 0);
  f.ready('editor-2');
  assert.deepEqual(f.sent, []);
});

test('dispatched timeout is unknown; wrong and late replies cannot settle another request', async () => {
  const f = fixture();
  f.ready();
  const first = f.session.request(recording('first'), 'opened', 10);
  assert.equal(f.session.cancelQueued('first'), false);
  assert.equal(f.session.acknowledge('first', 'wrong-event', true), false);
  f.expire();
  assert.deepEqual(await first, { status: 'unknown' });
  const second = f.session.request<boolean>(recording('second'), 'opened', 10);
  assert.equal(f.session.acknowledge('first', 'opened', true), false);
  assert.equal(f.session.acknowledge('second', 'opened', true), true);
  assert.deepEqual(await second, { status: 'completed', value: true });
});

test('durable notifications survive expiry and editor replacement without replaying dispatched requests', async () => {
  const f = fixture();
  f.ready();
  f.session.detach();
  const applied = f.session.request({ type: 'workflow-paths-moved', moves: [], requestId: 'move' }, 'moved', 10);
  f.expire();
  assert.deepEqual(await applied, { status: 'expired' });
  f.ready('editor-2');
  assert.equal(f.sent[0]?.type, 'workflow-paths-moved');
  const old = f.session.request(recording('old'), 'opened', 10);
  f.ready('editor-3');
  assert.deepEqual(await old, { status: 'replaced' });
  assert.equal(f.sent.filter((command) => command.type === 'open-recording').length, 1);
  assert.equal(f.session.pendingCount, 0);
});

test('count and byte bounds reject overload; disposal settles callers and clears resources', async () => {
  const f = fixture(1);
  const first = f.session.request(recording('first'), 'opened', 10);
  assert.deepEqual(await f.session.request(recording('overflow'), 'opened', 10), { status: 'overloaded' });
  f.session.dispose();
  assert.deepEqual(await first, { status: 'closed' });
  assert.equal(f.timers.size, 0);
  assert.equal(f.session.pendingBytes, 0);
  const small = new EditorBridgeSession({ maxBytes: 1 });
  assert.equal(small.post(recording('too-large')), false);
  assert.equal(small.pendingCount, 0);
});

test('reentrant replies and a development remount cannot leak timers or reuse requests', async () => {
  const f = fixture();
  f.session.ready('first', (command) => {
    if ('requestId' in command) f.session.acknowledge(command.requestId, 'opened', true);
  });
  assert.deepEqual(await f.session.request(recording('instant'), 'opened', 10), { status: 'completed', value: true });
  assert.equal(f.timers.size, 0);
  f.session.dispose();
  assert.deepEqual(await f.session.request(recording('closed'), 'opened', 10), { status: 'closed' });
  f.session.activate();
  const next = f.session.request(recording('next'), 'opened', 10);
  f.ready('second');
  f.session.acknowledge('next', 'opened', true);
  assert.deepEqual(await next, { status: 'completed', value: true });
});
