import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { GraphProcessor } from '@valerypopoff/rivet2-core';
import { parseLatestEndpointSegment, parseLatestDebuggerPath, isLatestDebuggerScope } from '@valerypopoff/rivet2-core';
import type { RivetDebuggerServer } from '@valerypopoff/rivet2-node';
import { LatestDebuggerPolicy } from '../latest-debugger-policy.js';

void test('latest suffix parsing preserves labels without weakening endpoint names or decoding twice', () => {
  assert.deepEqual(parseLatestEndpointSegment('endpoint@00123'), { endpointName: 'endpoint', channel: '00123' });
  assert.equal(parseLatestEndpointSegment('endpoint').channel, null);
  assert.equal(parseLatestDebuggerPath('/ws/latest-debugger%40Case_1'), 'Case_1');
  assert.equal(parseLatestDebuggerPath('/ws/latest-debugger'), null);
  const scope = { channel: null, rootRunId: 'root', projectId: 'project', owner: 'owner', incarnation: 'process' };
  assert.equal(isLatestDebuggerScope({ ...scope, promptLifecycle: 1 }), true);
  assert.equal(isLatestDebuggerScope({ ...scope, promptLifecycle: 2 }), false);
  for (const value of ['endpoint@', 'endpoint@@a', 'endpoint@a/b', 'endpoint@a%40b', 'endpoint@' + 'a'.repeat(33)])
    assert.throws(() => parseLatestEndpointSegment(value));
  for (const value of [
    '/ws/latest-debugger@',
    '/ws/latest-debugger@a%2fb',
    '/ws/latest-debugger@a%2540b',
    '/ws/latest-debugger-other',
    '/ws/latest-debugger@%',
  ])
    assert.throws(() => parseLatestDebuggerPath(value));
});

void test('controls require channel, root and incarnation; exact prompt callback wins once; finish releases ownership', () => {
  const policy = new LatestDebuggerPolicy('owner', 'incarnation');
  const calls: string[] = [];
  const closures: Array<{ message: string; data: unknown }> = [];
  let failBroadcast = false;
  const make = (id: string) => {
    const events = new EventEmitter();
    const processor = {
      id,
      on(name: string, listener: (...args: unknown[]) => void) {
        events.on(name, listener);
        return () => events.off(name, listener);
      },
      pause() {
        calls.push(`${id}:pause`);
      },
      resume() {
        calls.push(`${id}:resume`);
      },
      async abort() {
        calls.push(`${id}:abort`);
      },
    } as unknown as GraphProcessor;
    const debuggerServer = {
      attach() {},
      detach() {},
      broadcast(_processor: unknown, message: string, data: unknown) {
        if (failBroadcast) throw new Error('observer transport failed');
        closures.push({ message, data });
      },
    } as unknown as RivetDebuggerServer;
    policy.forChannel(debuggerServer, id).attach(processor);
    const execution = { rootRunId: id, projectId: 'same-project', graphRunId: id };
    const scope = JSON.parse(
      policy.decorate('{"message":"start","data":{}}', processor, 'start', { execution }),
    ).rivetScope;
    return { events, processor, execution, scope };
  };
  const a = make('A'),
    b = make('B');
  assert.equal(policy.control({ target: b.scope, action: 'pause' }, 'A').status, 'rejected');
  assert.equal(
    policy.control({ target: { ...a.scope, incarnation: 'stale' }, action: 'abort' }, 'A').status,
    'rejected',
  );
  assert.equal(policy.control({ target: a.scope, action: 'pause' }, 'A').status, 'accepted');
  assert.equal(policy.control({ target: a.scope, action: 'pause' }, 'A').status, 'rejected');
  assert.deepEqual(calls, ['A:pause']);
  const prompt = JSON.parse(
    policy.decorate('{"message":"userInput","data":{}}', a.processor, 'userInput', {
      execution: a.execution,
      processId: 'same-node-process',
      callback: () => calls.push('A:answer'),
    }),
  ).rivetScope;
  const reply = {
    target: a.scope,
    action: 'user-input',
    promptId: prompt.promptId,
    answers: { type: 'string[]', value: ['answer'] },
  };
  assert.equal(policy.control(reply, 'A').status, 'accepted');
  assert.equal(policy.control(reply, 'A').status, 'rejected');
  assert.equal(a.scope.promptLifecycle, 1);
  assert.deepEqual(closures, [{ message: 'latest-prompt-closed', data: { promptId: prompt.promptId } }]);
  assert.deepEqual(calls, ['A:pause', 'A:answer']);
  const failing = make('failing-observer');
  const failingPrompt = JSON.parse(
    policy.decorate('{"message":"userInput","data":{}}', failing.processor, 'userInput', {
      execution: failing.execution,
      processId: 'pending',
      callback: () => calls.push('accepted-answer'),
    }),
  ).rivetScope;
  failBroadcast = true;
  assert.deepEqual(
    policy.control({ ...reply, target: failing.scope, promptId: failingPrompt.promptId }, 'failing-observer'),
    { status: 'accepted' },
    'observer delivery cannot block an accepted answer',
  );
  assert.equal(calls.at(-1), 'accepted-answer');
  assert.equal(
    policy.control({ ...reply, target: failing.scope, promptId: failingPrompt.promptId }, 'failing-observer').status,
    'rejected',
    'delivery failure cannot re-enable a consumed callback',
  );
  assert.doesNotThrow(() => failing.events.emit('finish'), 'observer failure must not escape into execution');
  assert.equal(policy.control({ target: failing.scope, action: 'pause' }, 'failing-observer').status, 'rejected');
  assert.ok(policy.getDiagnostics().some((entry) => entry.reason === 'broadcast-failed'));
  failBroadcast = false;
  a.events.emit('finish');
  assert.equal(policy.control({ target: a.scope, action: 'pause' }, 'A').status, 'rejected');
  assert.equal(policy.control({ target: b.scope, action: 'resume' }, 'B').status, 'rejected');
  assert.equal(policy.control({ target: b.scope, action: 'pause' }, 'B').status, 'accepted');
  assert.equal(policy.control({ target: b.scope, action: 'resume' }, 'B').status, 'accepted');
  for (let i = 0; i < 50; i++)
    assert.equal(policy.decorate('{}', a.processor, 'trace', { secret: 'not retained' }), '');
  assert.equal(policy.getDiagnostics().length, 32);
  assert.ok(policy.getDiagnostics().every((entry) => Object.keys(entry).sort().join(',') === 'message,reason'));
});
