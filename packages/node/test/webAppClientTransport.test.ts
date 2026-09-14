import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { createHostedActionRunner, HostedActionError } from '../src/webAppClientTransport.js';
import type { HostedBrowserStorageBridge } from '../src/webAppClientStorageRpc.js';
import type { WebAppClientConfig } from '../src/webAppClientTypes.js';

const originalFetch = globalThis.fetch;
const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobalProperty('WebSocket', originalWebSocketDescriptor);
  restoreGlobalProperty('window', originalWindowDescriptor);
});

void describe('hosted web-app action WebSocket transport', () => {
  void it('does not reconnect after an authorization-revocation close', async () => {
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: class extends TestWebSocket {
        constructor(url: URL) {
          super(url, sockets);
        }
      },
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'https://app.example.test/' } },
      writable: true,
    });

    const runner = createHostedActionRunner({
      ...httpConfig(),
      actionTransport: { socketPath: '/actions/ws', type: 'websocket' },
    });
    const result = runner.run({
      componentId: 'button',
      onProgress: () => undefined,
      signal: new AbortController().signal,
      state: {},
    });
    const socket = sockets[0];
    assert.ok(socket);
    socket.open();
    socket.receiveJson({ capabilities: [], protocolVersion: 1, type: 'server.ready' });
    assert.equal(socket.sent.some((message) => message.includes('action.start')), true);

    socket.close(1008, 'Web app access was revoked');
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof HostedActionError);
      assert.equal(error.code, 'websocket_closed');
      assert.match(error.message, /access was revoked/i);
      return true;
    });

    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(sockets.length, 1);
  });
});

void describe('hosted web-app action storage fallback', () => {
  void it('fails before HTTP execution when browser storage exceeds the safe legacy snapshot size', async () => {
    let fetchCalled = false;
    let warning: string | undefined;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('{}');
    };
    const runner = createHostedActionRunner(httpConfig());

    await assert.rejects(
      runner.run({
        browserStorage: bridge({ large: 'x'.repeat(4 * 1024 * 1024) }, (message) => {
          warning = message;
        }),
        componentId: 'button',
        onProgress: () => undefined,
        signal: new AbortController().signal,
        state: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof HostedActionError);
        assert.equal(error.code, 'browser_storage_rpc_required');
        return true;
      },
    );

    assert.equal(fetchCalled, false);
    assert.match(warning ?? '', /too large for HTTP action transport/i);
  });

  void it('keeps the legacy HTTP snapshot path for compatible storage sizes', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let cleared = 0;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ statePatch: { result: 'ok' }, storagePatch: { saved: true } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    };
    const runner = createHostedActionRunner(httpConfig());
    const storage = { small: { value: 1 } };

    const result = await runner.run({
      browserStorage: {
        ...bridge(storage),
        clearTransportIncompatibility: () => {
          cleared += 1;
        },
      },
      componentId: 'button',
      onProgress: () => undefined,
      signal: new AbortController().signal,
      state: { input: 'hello' },
    });

    assert.deepEqual(requestBody?.storage, storage);
    assert.deepEqual(result.storagePatch, { saved: true });
    assert.equal(cleared, 1);
  });
});

function httpConfig(): WebAppClientConfig {
  return {
    actionTransport: { actionPath: '/actions', type: 'http' },
    initialState: {},
    markdownSanitizerPolicy: {} as WebAppClientConfig['markdownSanitizerPolicy'],
    uiGraph: {} as WebAppClientConfig['uiGraph'],
  };
}

function bridge(
  snapshot: Record<string, unknown>,
  reportTransportIncompatibility?: (message: string) => void,
): HostedBrowserStorageBridge {
  return {
    commit: async () => undefined,
    get: async (key) => snapshot[key],
    loadSnapshot: async () => structuredClone(snapshot),
    reportTransportIncompatibility,
  };
}

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: BinaryType = 'blob';
  readonly sent: string[] = [];
  readyState = TestWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(
    readonly url: URL,
    sockets: TestWebSocket[],
  ) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.emit('open', {});
  }

  receiveJson(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(typeof data === 'string' ? data : '[binary]');
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
