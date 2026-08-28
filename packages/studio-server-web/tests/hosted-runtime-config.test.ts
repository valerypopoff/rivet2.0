import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeHostedRuntimeConfig,
  normalizeRuntimeWebSocketUrl,
} from '../../studio-server-shared/hosted-env';
import { normalizeHostedProjectExecutorMode } from '../overrides/utils/hostedExecutorMode';

type TestWindow = {
  location: {
    host: string;
    protocol: string;
  };
};

function withWindowLocation(location: TestWindow['location'], run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location },
  });

  try {
    run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'window', descriptor);
    } else {
      delete (globalThis as typeof globalThis & { window?: TestWindow }).window;
    }
  }
}

test('hosted runtime config upgrades same-host websocket URLs on HTTPS pages', () => {
  withWindowLocation({ protocol: 'https:', host: 'storyteller-rivet.litnet.com' }, () => {
    assert.equal(
      normalizeRuntimeWebSocketUrl('ws://storyteller-rivet.litnet.com/ws/executor/internal'),
      'wss://storyteller-rivet.litnet.com/ws/executor/internal',
    );
    assert.equal(
      normalizeRuntimeWebSocketUrl('ws://storyteller-rivet.litnet.com/ws/latest-debugger'),
      'wss://storyteller-rivet.litnet.com/ws/latest-debugger',
    );
  });
});

test('hosted runtime config normalizes websocket URL fields for dashboard state', () => {
  withWindowLocation({ protocol: 'https:', host: 'storyteller-rivet.litnet.com' }, () => {
    assert.deepEqual(
      normalizeHostedRuntimeConfig({
        executorWsUrl: 'ws://storyteller-rivet.litnet.com/ws/executor/internal',
        remoteDebuggerDefaultWs: 'ws://storyteller-rivet.litnet.com/ws/latest-debugger',
        publishedAppsBasePath: '/apps',
      }),
      {
        executorWsUrl: 'wss://storyteller-rivet.litnet.com/ws/executor/internal',
        remoteDebuggerDefaultWs: 'wss://storyteller-rivet.litnet.com/ws/latest-debugger',
        publishedAppsBasePath: '/apps',
      },
    );
  });
});

test('hosted project executor mode normalizes stale same-host Remote Debugger URLs', () => {
  withWindowLocation({ protocol: 'https:', host: 'storyteller-rivet.litnet.com' }, () => {
    assert.deepEqual(
      normalizeHostedProjectExecutorMode({
        type: 'remote-debugger',
        url: 'ws://storyteller-rivet.litnet.com/ws/latest-debugger',
      }),
      {
        type: 'remote-debugger',
        url: 'wss://storyteller-rivet.litnet.com/ws/latest-debugger',
      },
    );
    assert.deepEqual(
      normalizeHostedProjectExecutorMode({
        type: 'local',
        executor: 'nodejs',
      }),
      {
        type: 'local',
        executor: 'nodejs',
      },
    );
  });
});

test('hosted runtime config leaves explicit cross-host and secure websocket URLs unchanged', () => {
  withWindowLocation({ protocol: 'https:', host: 'storyteller-rivet.litnet.com' }, () => {
    assert.equal(
      normalizeRuntimeWebSocketUrl('ws://debugger.example.test/ws/latest-debugger'),
      'ws://debugger.example.test/ws/latest-debugger',
    );
    assert.equal(
      normalizeRuntimeWebSocketUrl('wss://storyteller-rivet.litnet.com/ws/executor/internal'),
      'wss://storyteller-rivet.litnet.com/ws/executor/internal',
    );
  });
});

test('hosted runtime config leaves websocket URLs unchanged on HTTP pages', () => {
  withWindowLocation({ protocol: 'http:', host: 'localhost:8081' }, () => {
    assert.equal(
      normalizeRuntimeWebSocketUrl('ws://localhost:8081/ws/executor/internal'),
      'ws://localhost:8081/ws/executor/internal',
    );
  });
});
