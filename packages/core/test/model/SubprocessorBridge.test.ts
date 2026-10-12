import assert from 'node:assert/strict';
import test from 'node:test';
import Emittery from 'emittery';
import type { GraphProcessor, ProcessEvents } from '../../src/model/GraphProcessor.js';
import {
  cleanupSubprocessorBindings,
  wireSubprocessorEvents,
  wireSubprocessorLifecycle,
} from '../../src/model/SubprocessorBridge.js';

function fakeProcessor(failAt?: number, cleanupFailsAt?: number) {
  const listeners = new Map<string, Set<(data: unknown) => unknown>>();
  let subscriptions = 0;
  let disposals = 0;
  let aborts = 0;
  const on = (name: string, listener: (data: unknown) => unknown) => {
    const index = ++subscriptions;
    if (index === failAt) throw new Error('registration failed');
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set);
    set.add(listener);
    return () => {
      disposals++;
      set.delete(listener);
      if (index === cleanupFailsAt) throw new Error('disposal failed');
    };
  };
  const processor = {
    on,
    onAny: (listener: (event: string, data: unknown) => unknown) =>
      on('*', (value) => {
        const data = value as { event: string; data: unknown };
        return listener(data.event, data.data);
      }),
    isRunning: true,
    abort: async () => {
      aborts++;
    },
    pause: async () => {},
    resume: async () => {},
  } as unknown as GraphProcessor;
  return {
    processor,
    active: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    disposals: () => disposals,
    aborts: () => aborts,
    emit: async (name: string, data: unknown) => {
      for (const listener of [...(listeners.get(name) ?? [])]) await listener(data);
    },
  };
}

const parentState = { isPaused: () => false, pause: () => {}, resume: () => {} };
const parentEmitter = { emit: async () => {} } as unknown as Emittery<ProcessEvents>;

test('combined execution and cleanup failure preserves the primary identity and attempts both bindings', (t) => {
  t.mock.method(console, 'warn', () => {});
  const primary = new Error('execution failure');
  const cleaned: string[] = [];
  assert.throws(
    () => {
      try {
        throw primary;
      } finally {
        cleanupSubprocessorBindings(
          () => {
            cleaned.push('lifecycle');
            throw new Error('lifecycle cleanup');
          },
          () => {
            cleaned.push('events');
            throw new Error('event cleanup');
          },
          true,
        );
      }
    },
    (error) => error === primary,
  );
  assert.deepEqual(cleaned, ['lifecycle', 'events']);
});

test('cleanup failures after successful execution remain visible and include both bindings', () => {
  assert.throws(
    () =>
      cleanupSubprocessorBindings(
        () => {
          throw new Error('lifecycle cleanup');
        },
        () => {
          throw new Error('event cleanup');
        },
        false,
      ),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
});

test('a throwing host logger cannot replace the primary execution failure during cleanup', (t) => {
  t.mock.method(console, 'warn', () => {
    throw new Error('host logger failure');
  });
  const primary = new Error('execution failure');
  let eventBindingReleased = false;
  assert.throws(
    () => {
      try {
        throw primary;
      } finally {
        cleanupSubprocessorBindings(
          () => {
            throw new Error('cleanup failure');
          },
          () => {
            eventBindingReleased = true;
          },
          true,
        );
      }
    },
    (error) => error === primary,
  );
  assert.equal(eventBindingReleased, true);
});

test('event wiring rolls back subscriptions when registration fails partway through', () => {
  const child = fakeProcessor(3);
  assert.throws(() => wireSubprocessorEvents(child.processor, parentEmitter, parentState), /registration failed/);
  assert.equal(child.active(), 0);
});

test('lifecycle wiring rolls back parent and abort subscriptions when a later binding fails', () => {
  const child = fakeProcessor();
  const parent = new AbortController();
  const signal = new AbortController();
  let parentListeners = 0;
  assert.throws(
    () =>
      wireSubprocessorLifecycle(child.processor, {
        parentAbortSignal: parent.signal,
        signal: signal.signal,
        onParentPause: () => {
          parentListeners++;
          return () => {
            parentListeners--;
          };
        },
        onParentResume: () => {
          throw new Error('parent resume binding failed');
        },
      }),
    /parent resume binding failed/,
  );
  parent.abort();
  signal.abort();
  assert.equal(child.aborts(), 0);
  assert.equal(parentListeners, 0);
  assert.equal(child.active(), 0);
});

test('own-lifecycle registration failure releases both earlier child listeners and parent controls', () => {
  const child = fakeProcessor(4);
  const parent = new AbortController();
  let parentListeners = 0;
  const subscribe = () => {
    parentListeners++;
    return () => {
      parentListeners--;
    };
  };
  assert.throws(
    () =>
      wireSubprocessorLifecycle(child.processor, {
        parentAbortSignal: parent.signal,
        onParentPause: subscribe,
        onParentResume: subscribe,
      }),
    /registration failed/,
  );
  parent.abort();
  assert.equal(child.aborts(), 0);
  assert.equal(child.active(), 0);
  assert.equal(parentListeners, 0);
});

for (const [terminal, successful] of [
  ['graphError', false],
  ['graphAbort', false],
  ['graphAbort', true],
  ['graphFinish', true],
] as const) {
  test(`automatic ${terminal} cleanup (${successful ? 'successful' : 'failed'}) preserves failure policy`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const child = fakeProcessor();
    const parent = new AbortController();
    let controls = 0;
    const bind = () => {
      controls++;
      return () => {
        controls--;
        throw new Error('secondary control cleanup failure');
      };
    };
    const cleanup = wireSubprocessorLifecycle(child.processor, {
      parentAbortSignal: parent.signal,
      onParentPause: bind,
      onParentResume: bind,
    });
    await child.emit('graphStart', { execution: { graphRunId: 'own' } });
    const event = { execution: { graphRunId: 'own' }, error: new Error('primary failure'), successful };
    if (successful)
      await assert.rejects(
        child.emit(terminal, event),
        (error) => error instanceof AggregateError && error.errors.length === 2,
      );
    else await assert.doesNotReject(child.emit(terminal, event));
    assert.equal(controls, 0);
    assert.equal(child.active(), 0);
    cleanup();
  });
}

test('explicit event cleanup attempts every disposer once, even if one fails', () => {
  const child = fakeProcessor(undefined, 1);
  const cleanup = wireSubprocessorEvents(child.processor, parentEmitter, parentState);
  assert.throws(cleanup, AggregateError);
  assert.equal(child.active(), 0);
  const disposals = child.disposals();
  cleanup();
  assert.equal(child.disposals(), disposals);
});

test('ordinary graph completion removes controls but preserves late terminal forwarding until explicit cleanup', async () => {
  const child = fakeProcessor();
  const forwarded: string[] = [];
  let pauses = 0;
  const cleanup = wireSubprocessorEvents(
    child.processor,
    {
      emit: async (event: string) => {
        forwarded.push(event);
      },
    } as unknown as Emittery<ProcessEvents>,
    {
      ...parentState,
      pause: () => {
        pauses++;
      },
    },
  );
  await child.emit('graphStart', { execution: { graphRunId: 'own' } });
  await child.emit('graphFinish', { execution: { graphRunId: 'nested' } });
  await child.emit('pause', {});
  assert.equal(pauses, 1, 'a nested terminal must not clean up parent controls');
  await child.emit('graphFinish', { execution: { graphRunId: 'own' } });
  await child.emit('pause', {});
  assert.equal(pauses, 1);
  await child.emit('nodeFinish', {});
  assert.equal(forwarded.at(-1), 'nodeFinish');
  cleanup();
  cleanup();
  assert.equal(child.active(), 0);
});

test('disposing a pre-start cancellation removes its deferred abort listener', async () => {
  const child = fakeProcessor();
  Object.defineProperty(child.processor, 'isRunning', { value: false });
  const parent = new AbortController();
  parent.abort();
  const cleanup = wireSubprocessorLifecycle(child.processor, {
    parentAbortSignal: parent.signal,
    onParentPause: () => () => {},
    onParentResume: () => () => {},
  });
  cleanup();
  cleanup();
  await child.emit('graphStart', { execution: { graphRunId: 'late' } });
  assert.equal(child.aborts(), 0);
  assert.equal(child.active(), 0);
});

test('lifecycle disposal attempts all parent and child cleanup after a parent disposer fails', () => {
  const child = fakeProcessor();
  const parent = new AbortController();
  let resumedBindingRemoved = false;
  const cleanup = wireSubprocessorLifecycle(child.processor, {
    parentAbortSignal: parent.signal,
    onParentPause: () => () => {
      throw new Error('parent pause disposal failed');
    },
    onParentResume: () => () => {
      resumedBindingRemoved = true;
    },
  });
  assert.throws(cleanup, AggregateError);
  cleanup();
  parent.abort();
  assert.equal(child.aborts(), 0);
  assert.equal(child.active(), 0);
  assert.equal(resumedBindingRemoved, true);
});

test('lifecycle cleanup is reentrant while still attempting every disposer once', () => {
  const child = fakeProcessor();
  const parent = new AbortController();
  let pauseDisposals = 0;
  let resumeDisposals = 0;
  const cleanup = wireSubprocessorLifecycle(child.processor, {
    parentAbortSignal: parent.signal,
    onParentPause: () => () => {
      pauseDisposals++;
      cleanup();
    },
    onParentResume: () => () => {
      resumeDisposals++;
    },
  });
  cleanup();
  cleanup();
  parent.abort();
  assert.equal(pauseDisposals, 1);
  assert.equal(resumeDisposals, 1);
  assert.equal(child.disposals(), 4);
  assert.equal(child.active(), 0);
  assert.equal(child.aborts(), 0);
});

test('real emitter disposal suppresses queued controls and a deferred pre-start abort', async () => {
  const emitter = new Emittery<ProcessEvents>();
  const parent = new Emittery<ProcessEvents>();
  const controller = new AbortController();
  let aborts = 0;
  let pauses = 0;
  const processor = {
    on: emitter.on.bind(emitter),
    isRunning: false,
    abort: async () => {
      aborts++;
    },
    pause: () => {
      pauses++;
    },
    resume: () => {},
  } as unknown as GraphProcessor;
  const cleanup = wireSubprocessorLifecycle(processor, {
    parentAbortSignal: controller.signal,
    onParentPause: (listener) => parent.on('pause', listener),
    onParentResume: (listener) => parent.on('resume', listener),
  });
  controller.abort();
  const queuedPause = parent.emit('pause');
  const queuedStart = emitter.emit('graphStart', {
    execution: { graphRunId: 'disposed-child' },
  } as unknown as ProcessEvents['graphStart']);
  cleanup();
  await Promise.all([queuedPause, queuedStart]);
  assert.equal(aborts, 0);
  assert.equal(pauses, 0);
  assert.equal(emitter.listenerCount(), 0);
  assert.equal(parent.listenerCount(), 0);
});
