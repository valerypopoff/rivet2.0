import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LatestDebuggerRelay } from '../ha-latest-relay.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readLatestDebuggerControl,
  readLatestDebuggerEventId,
  isLatestDebuggerExecutionMessage,
  encodeLatestDebuggerEnvelope,
  createLatestDebuggerSession,
  isLatestDebuggerSession,
  readLatestDebuggerExecution,
  createLatestDebuggerDiagnostic,
  isLatestDebuggerDiagnostic,
  createLatestDebuggerControlResult,
  type LatestDebuggerMessage,
} from '@valerypopoff/rivet2-core';
import { createLatestDebuggerReporter } from '../latest-debugger-diagnostics.js';

// Diagnostic only: production relay, deterministic socket stand-in, no listener.
class Observer extends EventEmitter {
  readyState = 1;
  hold = false;
  pending: (() => void) | undefined;
  lastSequence = 0;
  notices: string[] = [];
  send(raw: string, callback?: () => void) {
    const frame = JSON.parse(raw);
    if (frame.message === 'latest-diagnostic') this.notices.push(frame.data.code);
    if (frame.rivetEventId) this.lastSequence = Number(frame.rivetEventId.split(':').at(-1));
    if (this.hold) this.pending = callback;
    else callback?.();
  }
  terminate() {
    this.readyState = 3;
    this.emit('close');
  }
}
void test('each independent ring overrun emits a fresh invalidation on one connection', async () => {
  const server = new EventEmitter() as EventEmitter & { clients: Set<Observer> };
  const observer = new Observer();
  server.clients = new Set([observer]);
  const incarnation = randomUUID();
  const relay = new LatestDebuggerRelay(
    {
      pod: 'backend-0',
      backendName: 'backend',
      headless: 'local',
      apiPort: 1,
      executorPort: 1,
      installation: 'fixture',
      key: 'k'.repeat(32),
      incarnation,
    },
    server as never,
    0,
    undefined,
    () => ({ status: 'rejected' }),
  );
  const scope = {
    channel: 'A',
    rootRunId: 'root',
    projectId: 'project',
    owner: 'backend-0',
    incarnation,
    promptLifecycle: 1,
  };
  let sequence = 0;
  const publish = () => {
    const raw = relay.transformBroadcast(
      JSON.stringify({ message: 'trace', rivetScope: scope, data: 'local fixture' }),
    );
    sequence++;
    relay.sendBroadcast(observer as never, raw);
  };
  try {
    server.emit('connection', observer, { url: '/ws/latest-debugger@A', headers: {} });
    for (let round = 1; round <= 2; round++) {
      observer.hold = true;
      publish();
      for (let i = 0; i < 8194; i++) publish();
      observer.hold = false;
      const resume = observer.pending!;
      observer.pending = undefined;
      resume();
      const deadline = Date.now() + 10000;
      while (observer.lastSequence < sequence) {
        if (Date.now() > deadline) throw Error('Local relay drain timed out');
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(observer.notices.filter((code) => code === 'history-gap').length, round);
    }
  } finally {
    relay.dispose();
  }
});
void test('managed control codec validates actions and event IDs independent of JSON ordering', () => {
  assert.equal(isLatestDebuggerExecutionMessage('run'), false);
  assert.equal(isLatestDebuggerExecutionMessage('latest-prompt-closed'), true);
  assert.equal(encodeLatestDebuggerEnvelope('{"message":"trace"}'), '{"message":"trace"}');
  assert.ok(
    encodeLatestDebuggerEnvelope('{"message":"trace"}', undefined, 'owner:process:1').startsWith('{"rivetEventId":'),
  );
  const scope = { channel: null, rootRunId: 'root', projectId: 'project', owner: 'owner', incarnation: 'process' };
  for (const action of ['pause', 'resume', 'abort'])
    assert.ok(
      readLatestDebuggerControl({ type: 'latest-control', data: { commandId: 'command', target: scope, action } }),
    );
  for (const action of ['run', 'upload', 'user-input'])
    assert.equal(
      readLatestDebuggerControl({ type: 'latest-control', data: { commandId: 'command', target: scope, action } }),
      undefined,
    );
  assert.equal(
    readLatestDebuggerEventId(JSON.parse('{ "message": "trace", "rivetEventId": "backend-0:abc:1" }')),
    'backend-0:abc:1',
  );
  assert.equal(readLatestDebuggerEventId({ rivetEventId: 'bad/id' }), undefined);
});

void test('shared managed messages preserve payload identity and validate lifecycle and diagnostic boundaries', () => {
  const scope = { channel: 'A', rootRunId: 'root', projectId: 'project', owner: 'owner', incarnation: 'process' };
  const data = { unknownAuthoredField: { bytes: new Uint8Array([1, 2]), optional: undefined } };
  const execution = { message: 'trace', data, rivetScope: scope };
  assert.equal(readLatestDebuggerExecution(execution), execution, 'routing admission must not clone authored data');
  assert.equal(data.unknownAuthoredField.optional, undefined);
  for (const value of [
    { ...execution, message: 'future-event' },
    { ...execution, rivetScope: { ...scope, channel: 'bad/channel' } },
    { ...execution, data: { execution: { rootRunId: 'other' } } },
    { message: 'latest-prompt-closed', rivetScope: scope, data: { promptId: '' } },
  ])
    assert.equal(readLatestDebuggerExecution(value), undefined);
  const messages: LatestDebuggerMessage[] = [
    createLatestDebuggerSession('A'),
    createLatestDebuggerDiagnostic('history-gap'),
    createLatestDebuggerControlResult('command', { status: 'accepted' }),
    { message: 'latest-prompt-closed', rivetScope: scope, data: { promptId: 'prompt' } },
    { message: 'latest-settled', rivetScope: scope, data: {} },
  ];
  assert.ok(isLatestDebuggerSession(messages[0]));
  assert.ok(isLatestDebuggerDiagnostic(messages[1]));
  assert.ok(readLatestDebuggerExecution(messages[3]));
  assert.ok(readLatestDebuggerExecution(messages[4]));
  assert.equal(
    isLatestDebuggerSession({ ...createLatestDebuggerSession('A'), data: { protocol: 2, channel: 'A' } }),
    false,
  );
  assert.equal(
    isLatestDebuggerDiagnostic({ message: 'latest-diagnostic', data: { protocol: 1, code: 'invented' } }),
    false,
  );
  assert.deepEqual(
    createLatestDebuggerControlResult('command', { status: 'accepted', forwardId: 'private-hop' } as never),
    { message: 'latest-control-result', data: { commandId: 'command', status: 'accepted' } },
    'browser results must not inherit private peer fields',
  );
});
void test('production diagnostics contain only finite metadata and tolerate failing sinks', () => {
  const entries: unknown[] = [];
  let now = 0;
  const report = createLatestDebuggerReporter(
    (entry) => entries.push(entry),
    () => now,
  );
  report('broadcast');
  report('broadcast');
  report('history');
  assert.deepEqual(entries, [
    { event: 'latest-debugger-diagnostic', reason: 'broadcast', count: 1 },
    { event: 'latest-debugger-diagnostic', reason: 'history', count: 1 },
  ]);
  now = 60_000;
  report('broadcast');
  assert.deepEqual(entries.at(-1), { event: 'latest-debugger-diagnostic', reason: 'broadcast', count: 3 });
  const throwing = createLatestDebuggerReporter(() => {
    throw Error('sink failed');
  });
  assert.doesNotThrow(() => throwing('ownership'));
});
