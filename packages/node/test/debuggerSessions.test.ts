import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { DebuggerSessions } from '../src/debuggerSessions.js';

class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(payload: string) {
    this.sent.push(payload);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  get socket() {
    return this as unknown as WebSocket;
  }
}
const request = (capability?: string, sequence = 0) =>
  ({
    headers: {
      'sec-websocket-protocol': [
        'rivet-session-v1',
        ...(capability ? [`rivet-cap.${capability}`, `rivet-seq.${sequence}`] : []),
      ].join(', '),
    },
  }) as IncomingMessage;
const capability = (client: Client): string => JSON.parse(client.sent[0]!).data.capability;

test('retirement advertises only settled idle owners, while accepted sessions retain their original controls', () => {
  const sessions = new DebuggerSessions(), idle = new Client(), active = new Client();
  sessions.bind(idle.socket, request()); sessions.bind(active.socket, request());
  const release = sessions.retain(active.socket);
  sessions.beginRetirement();
  assert.equal(sessions.canAccept(request(), true), false);
  assert.ok(idle.sent.some(frame => JSON.parse(frame).message === 'executor-owner-retiring'));
  assert.ok(!active.sent.some(frame => JSON.parse(frame).message === 'executor-owner-retiring'));
  assert.equal(sessions.canAccept(request(capability(active), 0), false), true);
  assert.equal(active.readyState, 1);
  release(); assert.ok(active.sent.some(frame => JSON.parse(frame).message === 'executor-owner-retiring'));
});

test('resumes the same logical owner during retirement and replays diagnostics, never executions', () => {
  const sessions = new DebuggerSessions();
  const first = new Client();
  assert.equal(sessions.canAccept(request(), true), true);
  assert.equal(sessions.bind(first.socket, request()), first.socket);
  const release = sessions.retain(first.socket);
  assert.equal(sessions.acceptRun(first.socket, 'run-1'), true);
  sessions.send(first.socket, JSON.stringify({ message: 'start', data: { value: 1 } }));
  first.close();
  sessions.send(first.socket, JSON.stringify({ message: 'done', data: { value: 2 } }));
  const resume = request(capability(first), 1);
  assert.equal(sessions.canAccept(request(), false), false);
  assert.equal(sessions.canAccept(resume, false), true);
  const second = new Client();
  assert.equal(sessions.bind(second.socket, resume), first.socket);
  assert.equal(sessions.isCurrent(first.socket), false);
  assert.equal(sessions.isCurrent(second.socket), true);
  assert.equal(sessions.acceptRun(first.socket, 'run-1'), false);
  assert.equal(JSON.parse(second.sent[1]!).message, 'done');
  assert.equal(JSON.parse(second.sent[1]!).rivetSequence, 2);
  sessions.send(first.socket, JSON.stringify({ message: 'cleanup', data: {} }));
  assert.equal(JSON.parse(second.sent.at(-1)!).rivetSequence, 3);
  release();
  release();
});

test('rejects foreign, expired, malformed and unavailable cursors instead of creating a new owner', () => {
  let now = 0;
  const sessions = new DebuggerSessions({ sessions: 1, bytes: 256, events: 1, idleMs: 10 }, () => now);
  const first = new Client();
  sessions.bind(first.socket, request());
  const cap = capability(first);
  assert.equal(sessions.canAccept(request('x'.repeat(43)), true), false);
  assert.equal(sessions.canAccept(request(cap, 1), true), false);
  assert.equal(sessions.canAccept(request(), true), false);
  sessions.send(first.socket, '{"message":"start","data":{}}');
  sessions.send(first.socket, '{"message":"done","data":{}}');
  assert.equal(sessions.canAccept(request(cap, 0), true), false);
  assert.equal(sessions.canAccept(request(cap, 1), false), true);
  const release = sessions.retain(first.socket);
  first.close();
  now = 20;
  assert.equal(sessions.canAccept(request(cap, 1), false), true);
  release();
  now += 11;
  assert.equal(sessions.canAccept(request(cap, 1), true), false);
  assert.equal(sessions.canAccept(request(), true), true);
  assert.equal(sessions.canAccept({ headers: {} } as IncomingMessage, true), false);
});

test('a replacement socket fences stale controls and a slow observer cannot grow the send queue', () => {
  const sessions = new DebuggerSessions({ sessions: 1, bytes: 256, events: 2, idleMs: 10 });
  const first = new Client();
  sessions.bind(first.socket, request());
  const second = new Client();
  sessions.bind(second.socket, request(capability(first)));
  assert.equal(first.readyState, 3);
  assert.equal(sessions.isCurrent(first.socket), false);
  second.bufferedAmount = 257;
  sessions.send(first.socket, '{"message":"start","data":{}}');
  assert.equal(second.readyState, 3);
});

test('the aggregate replay budget is bounded independently of per-session limits', () => {
  const sessions = new DebuggerSessions({ sessions: 2, bytes: 4096, events: 20, idleMs: 10 }, Date.now, 120);
  const first = new Client(),
    second = new Client();
  sessions.bind(first.socket, request());
  sessions.bind(second.socket, request());
  for (const client of [first, second])
    sessions.send(client.socket, JSON.stringify({ message: 'start', data: 'x'.repeat(60) }));
  assert.equal(sessions.canAccept(request(capability(first), 0), false), false);
  assert.equal(sessions.canAccept(request(capability(second), 0), false), true);
});

test('invalid mutable resource budgets cannot disable bounded session ownership', () => {
  for (const value of [0, -1, Infinity, NaN, 1.5])
    assert.throws(() => new DebuggerSessions({ sessions: value, bytes: 10, events: 10, idleMs: 10 }));
  const limits = { sessions: 1, bytes: 4096, events: 20, idleMs: 10 };
  const sessions = new DebuggerSessions(limits);
  limits.sessions = 10;
  const first = new Client();
  sessions.bind(first.socket, request());
  assert.equal(sessions.canAccept(request(), true), false);
});
