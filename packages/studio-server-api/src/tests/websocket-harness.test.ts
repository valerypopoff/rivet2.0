import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { closeWebSocket, waitForWebSocketMessages } from './helpers/websocket-harness.js';

function socketFixture() {
  const events = new EventEmitter();
  const observer = () => {};
  events.on('message', observer);
  return {
    events,
    socket: events as unknown as WebSocket,
    assertClean() {
      assert.deepEqual(events.listeners('message'), [observer], 'Preserve unrelated subscribers.');
      assert.equal(events.listenerCount('close'), 0);
      assert.equal(events.listenerCount('error'), 0);
    },
  };
}

test('WebSocket waiter settles every outcome and removes only its own listeners', async () => {
  for (const outcome of ['success', 'malformed', 'parser-error', 'close', 'error', 'empty']) {
    const fixture = socketFixture();
    const failure = new Error('Fixture parser failure');
    const waiting = waitForWebSocketMessages(fixture.socket, outcome === 'empty' ? [] : ['accepted', 'completed'], {
      parser:
        outcome === 'parser-error'
          ? () => {
              throw failure;
            }
          : undefined,
    });
    // Attach rejection assertions before emitting: expected failures must never
    // become unhandled rejections, even when the emitter runs synchronously.
    const settled =
      outcome === 'success' || outcome === 'empty'
        ? waiting
        : assert.rejects(
            waiting,
            outcome === 'parser-error' || outcome === 'error'
              ? (error) => error === failure
              : outcome === 'close'
                ? /Socket closed/
                : SyntaxError,
          );
    if (outcome === 'success') {
      fixture.events.emit('message', Buffer.from('{"message":"accepted","data":1}'));
      fixture.events.emit('message', Buffer.from('{"type":"completed","data":2}'));
      assert.deepEqual(await waiting, [
        { message: 'accepted', data: 1 },
        { message: 'completed', data: 2 },
      ]);
    } else if (outcome === 'close') fixture.events.emit('close');
    else if (outcome === 'error') fixture.events.emit('error', failure);
    else if (outcome !== 'empty') fixture.events.emit('message', Buffer.from('{broken'));
    await settled;
    fixture.assertClean();
  }
});

test('WebSocket waiter observes the exact deadline without wall-clock sleeping', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = socketFixture();
  const waiting = waitForWebSocketMessages(fixture.socket, ['completed'], { timeoutMs: 5000 });
  const rejected = assert.rejects(waiting, /Timed out waiting for websocket messages: completed/);
  t.mock.timers.tick(4999);
  assert.equal(fixture.events.listenerCount('message'), 2, 'Still listening before the deadline.');
  t.mock.timers.tick(1);
  await rejected;
  fixture.assertClean();
});

test('WebSocket teardown preserves observers and settles pending waiters without unhandled handshake errors', async () => {
  for (const state of [WebSocket.CONNECTING, WebSocket.OPEN]) {
    const fixture = socketFixture();
    const failure = new Error('Handshake terminated by fixture cleanup');
    let observedErrors = 0;
    const observer = () => {
      observedErrors += 1;
    };
    fixture.events.on('error', observer);
    const socket = Object.assign(fixture.events, {
      readyState: state,
      terminate() {
        queueMicrotask(() => {
          fixture.events.emit('error', failure);
          fixture.events.emit('close');
        });
      },
    }) as unknown as WebSocket;
    const rejected = assert.rejects(waitForWebSocketMessages(socket, ['completed']), (error) => error === failure);
    closeWebSocket(socket);
    await rejected;
    assert.equal(observedErrors, 1);
    assert.deepEqual(fixture.events.listeners('error'), [observer], 'Remove only the teardown listener.');
    fixture.events.off('error', observer);
    fixture.assertClean();
  }
  const fixture = socketFixture();
  const socket = Object.assign(fixture.events, {
    readyState: WebSocket.CONNECTING,
    terminate() {
      // No waiter or caller error listener remains, as during a timeout cleanup.
      fixture.events.emit('error', new Error('Expected teardown error'));
      fixture.events.emit('close');
    },
  }) as unknown as WebSocket;
  closeWebSocket(socket);
  fixture.assertClean();
});
