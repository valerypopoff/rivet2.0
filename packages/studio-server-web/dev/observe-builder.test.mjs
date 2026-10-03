import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeBuilder } from './observe-builder.mjs';
import { createCompilerOwner } from './compiler-owner.mjs';

function fixture() {
  const calls = { sent: [], killed: [], status: [], failures: [] };
  const timers = [];
  const cleared = [];
  const builder = new EventEmitter();
  builder.send = (message) => calls.sent.push(message);
  builder.kill = (signal) => calls.killed.push(['builder', signal]);
  let current = builder;
  const compiler = createCompilerOwner((pid, signal) => calls.killed.push([pid, signal]));
  observeBuilder(builder, {
    setTimer(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) cleared.push(timer);
    },
    isCurrent: (value) => current === value,
    compiler,
    onStatus: (message) => calls.status.push(message),
    onFailure(error) {
      current = null;
      compiler.stop();
      calls.failures.push(error);
    },
  });
  return {
    builder,
    calls,
    timers,
    cleared,
    retire: () => {
      current = null;
    },
  };
}

test('retired watcher messages cannot publish, acknowledge or forget replacement ownership', () => {
  const { builder, calls, retire } = fixture();
  retire();
  builder.emit('message', { type: 'compiler-started', pid: 42 });
  builder.emit('message', { type: 'compiler-stopped', pid: 42 });
  builder.emit('message', { phase: 'ready', generation: '11111111-1111-4111-8111-111111111111' });
  builder.emit('error', new Error('late error'));
  builder.emit('exit', 1);
  assert.deepEqual(calls, { sent: [], killed: [], status: [], failures: [] });
});

test('current watcher owns compiler before acknowledgement and retires once on failure', () => {
  const { builder, calls } = fixture();
  builder.emit('message', { type: 'compiler-started', pid: 1 });
  assert.deepEqual(calls.sent, []);
  builder.emit('message', { type: 'compiler-started', pid: 42 });
  assert.deepEqual(calls.sent, [{ type: 'compiler-tracked', pid: 42 }]);
  builder.emit('message', { phase: 'ready', generation: 'invalid' });
  assert.deepEqual(calls.status, []);
  builder.emit('message', { phase: 'building' });
  assert.deepEqual(calls.status, [{ phase: 'building' }]);
  const error = new Error('watcher broke');
  builder.emit('error', error);
  builder.emit('message', { type: 'compiler-started', pid: 43 });
  builder.emit('exit', 1);
  assert.deepEqual(calls.killed, [
    ['builder', 'SIGTERM'],
    [42, 'SIGKILL'],
  ]);
  assert.deepEqual(calls.failures, [error]);
  assert.equal(calls.sent.length, 1);
});

test('completed compilers are forgotten and an ordinary watcher exit is retired', () => {
  const { builder, calls } = fixture();
  builder.emit('message', { type: 'compiler-started', pid: 42 });
  builder.emit('message', { type: 'compiler-stopped', pid: 42 });
  builder.emit('message', { phase: 'ready', generation: '11111111-1111-4111-8111-111111111111' });
  builder.emit('exit', 0);
  assert.deepEqual(calls.killed, []);
  assert.equal(calls.status.length, 1);
  assert.equal(calls.failures.length, 1);
});

test('hung compilation is bounded; a retired deadline cannot kill a newer compiler', () => {
  const { builder, calls, timers, cleared } = fixture();
  builder.emit('message', { type: 'compiler-started', pid: 42 });
  builder.emit('message', { type: 'compiler-stopped', pid: 42 });
  builder.emit('message', { type: 'compiler-started', pid: 43 });
  assert.equal(timers[0].milliseconds, 15 * 60_000);
  assert.ok(cleared.includes(timers[0]));
  timers[0].callback();
  assert.equal(calls.failures.length, 0);
  timers[1].callback();
  assert.deepEqual(calls.killed, [
    ['builder', 'SIGTERM'],
    [43, 'SIGKILL'],
  ]);
  assert.equal(calls.failures[0].code, 'RIVET_DEV_BUILD_TIMEOUT');
  builder.emit('exit', 1);
  timers[1].callback();
  assert.equal(calls.failures.length, 1);
});
