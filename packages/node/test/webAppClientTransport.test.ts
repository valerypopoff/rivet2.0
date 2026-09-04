import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { createHostedActionRunner, HostedActionError } from '../src/webAppClientTransport.js';
import type { HostedBrowserStorageBridge } from '../src/webAppClientStorageRpc.js';
import type { WebAppClientConfig } from '../src/webAppClientTypes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
