import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { RivetWebAppBrowserStorageClientMessage } from '@valerypopoff/rivet2-core';
import {
  encodeRivetWebAppStorageBinaryFrame,
  serializeRivetWebAppStoredValuePatch,
} from '@valerypopoff/rivet2-core/web-app-runtime';
import { WebAppClientStorageRpc } from '../src/webAppClientStorageRpc.js';

void describe('WebAppClientStorageRpc limits', () => {
  void it('reports a cumulative transfer limit instead of leaking an unhandled rejection', async () => {
    const sent: RivetWebAppBrowserStorageClientMessage[] = [];
    let fatal: Error | undefined;
    const client = new WebAppClientStorageRpc({
      bridge: {
        commit: async () => undefined,
        get: async () => '123456',
        loadSnapshot: async () => ({}),
      },
      limits: { maxActionBytes: 12, maxValueBytes: 12, transferTimeoutMs: 1_000 },
      onFatal: (error) => {
        fatal = error;
      },
      requestId: 'request-client-limit',
      runId: () => 'run-client-limit',
      sendBinary: () => true,
      sendJson: (message) => {
        sent.push(message);
        return true;
      },
    });
    const storageSessionId = '11111111-1111-4111-8111-111111111111';

    await client.handleMessage({
      type: 'storage.get',
      requestId: 'request-client-limit',
      runId: 'run-client-limit',
      storageSessionId,
      storageRequestId: 'storage-read',
      key: 'hidden-key',
    });
    await client.handleMessage({
      type: 'storage.commit.start',
      requestId: 'request-client-limit',
      runId: 'run-client-limit',
      storageSessionId,
      transferId: '22222222-2222-4222-8222-222222222222',
      byteLength: 8,
      chunkCount: 1,
    });

    assert.match(fatal?.message ?? '', /per-action limit/i);
    assert.equal(sent.find((message) => message.type === 'storage.error')?.code, 'storage_too_large');
  });

  void it('rejects an incoming commit containing a value above the advertised per-value limit', async () => {
    const sent: RivetWebAppBrowserStorageClientMessage[] = [];
    let committed = false;
    let fatal: Error | undefined;
    const client = new WebAppClientStorageRpc({
      bridge: {
        commit: async () => {
          committed = true;
        },
        get: async () => undefined,
        loadSnapshot: async () => ({}),
      },
      limits: { maxActionBytes: 128, maxValueBytes: 8, transferTimeoutMs: 1_000 },
      onFatal: (error) => {
        fatal = error;
      },
      requestId: 'request-value-limit',
      runId: () => 'run-value-limit',
      sendBinary: () => true,
      sendJson: (message) => {
        sent.push(message);
        return true;
      },
    });
    const storageSessionId = '33333333-3333-4333-8333-333333333333';
    const transferId = '44444444-4444-4444-8444-444444444444';
    const bytes = serializeRivetWebAppStoredValuePatch({ value: 'too large' });

    await client.handleMessage({
      type: 'storage.commit.start',
      requestId: 'request-value-limit',
      runId: 'run-value-limit',
      storageSessionId,
      transferId,
      byteLength: bytes.byteLength,
      chunkCount: 1,
    });
    assert.equal(
      await client.handleBinary(encodeRivetWebAppStorageBinaryFrame(storageSessionId, transferId, 0, bytes)),
      true,
    );

    assert.equal(committed, false);
    assert.match(fatal?.message ?? '', /maximum size/i);
    assert.equal(sent.find((message) => message.type === 'storage.error')?.code, 'storage_too_large');
  });

  void it('fails a stalled incoming commit at the server-advertised timeout', async () => {
    const sent: RivetWebAppBrowserStorageClientMessage[] = [];
    let fatal: Error | undefined;
    const client = new WebAppClientStorageRpc({
      bridge: {
        commit: async () => undefined,
        get: async () => undefined,
        loadSnapshot: async () => ({}),
      },
      limits: { maxActionBytes: 128, maxValueBytes: 128, transferTimeoutMs: 5 },
      onFatal: (error) => {
        fatal = error;
      },
      requestId: 'request-stalled-commit',
      runId: () => 'run-stalled-commit',
      sendBinary: () => true,
      sendJson: (message) => {
        sent.push(message);
        return true;
      },
    });
    const storageSessionId = '55555555-5555-4555-8555-555555555555';
    const transferId = '66666666-6666-4666-8666-666666666666';

    await client.handleMessage({
      type: 'storage.commit.start',
      requestId: 'request-stalled-commit',
      runId: 'run-stalled-commit',
      storageSessionId,
      transferId,
      byteLength: 2,
      chunkCount: 1,
    });
    await waitFor(() => fatal !== undefined);

    assert.match(fatal?.message ?? '', /timed out/i);
    assert.equal(sent.find((message) => message.type === 'storage.error')?.code, 'storage_unavailable');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Timed out waiting for browser-storage RPC failure.');
}
