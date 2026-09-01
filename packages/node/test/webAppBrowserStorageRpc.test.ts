import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  RivetStoredValueRecord,
  RivetWebAppBrowserStorageClientMessage,
  RivetWebAppBrowserStorageServerMessage,
} from '@valerypopoff/rivet2-core';
import {
  createRivetWebAppBrowserStorageRpcAdmission,
  RivetWebAppBrowserStorageRpcHost,
} from '../src/webAppBrowserStorageRpcHost.js';
import { encodeRivetWebAppStorageBinaryFrame } from '@valerypopoff/rivet2-core/web-app-runtime';
import { WebAppClientStorageRpc } from '../src/webAppClientStorageRpc.js';

void describe('web app browser-storage RPC v2', () => {
  void it('fetches only requested keys, preserves read-after-write, and atomically commits the final patch', async () => {
    const values: RivetStoredValueRecord = { existing: { count: 1 }, untouched: 'not fetched' };
    const fetched: string[] = [];
    let committed: RivetStoredValueRecord | undefined;
    let host!: RivetWebAppBrowserStorageRpcHost;
    let client!: WebAppClientStorageRpc;
    const requestId = 'request-1';
    const runId = 'run-1';
    const controller = new AbortController();

    host = new RivetWebAppBrowserStorageRpcHost({
      admission: createRivetWebAppBrowserStorageRpcAdmission(),
      requestId,
      runId,
      signal: controller.signal,
      sendBinary(frame) {
        queueMicrotask(() => void client.handleBinary(frame));
        return true;
      },
      sendJson(message) {
        queueMicrotask(() => void client.handleMessage(message));
        return true;
      },
    });
    client = new WebAppClientStorageRpc({
      bridge: {
        async commit(patch) {
          committed = structuredClone(patch);
          Object.assign(values, patch);
        },
        async get(key) {
          fetched.push(key);
          return values[key];
        },
        async loadSnapshot() {
          return structuredClone(values);
        },
      },
      onFatal(error) {
        assert.fail(error.message);
      },
      requestId,
      runId: () => runId,
      sendBinary(frame) {
        queueMicrotask(() => host.handleBinary(frame));
        return true;
      },
      sendJson(message) {
        queueMicrotask(() => host.handleMessage(message));
        return true;
      },
    });

    assert.deepEqual(await host.store.get('existing'), { count: 1 });
    await host.store.set('existing', { count: 2 });
    await host.store.set('created', ['large', 'value']);
    assert.deepEqual(await host.store.get('existing'), { count: 2 });
    await host.commit();

    assert.deepEqual(fetched, ['existing']);
    assert.deepEqual(committed, { existing: { count: 2 }, created: ['large', 'value'] });
    assert.deepEqual(values.untouched, 'not fetched');
    host.dispose();
    client.dispose();
  });

  void it('releases aggregate admission after read and commit timeouts', async () => {
    const keepEventLoopAlive = setTimeout(() => undefined, 1_000);
    const admission = createRivetWebAppBrowserStorageRpcAdmission(1024);
    const controller = new AbortController();
    const messages: RivetWebAppBrowserStorageServerMessage[] = [];
    const host = new RivetWebAppBrowserStorageRpcHost({
      admission,
      limits: { maxActionBytes: 1024, maxActiveBytes: 1024, maxValueBytes: 1024, transferTimeoutMs: 5 },
      requestId: 'request-timeout',
      runId: 'run-timeout',
      signal: controller.signal,
      sendBinary: () => true,
      sendJson(message) {
        messages.push(message);
        return true;
      },
    });

    const read = host.store.get('key');
    await waitFor(() => messages.some((message) => message.type === 'storage.get'));
    const get = messages.find((message) => message.type === 'storage.get')!;
    host.handleMessage({
      type: 'storage.transfer.start',
      requestId: get.requestId,
      runId: get.runId,
      storageSessionId: get.storageSessionId,
      storageRequestId: get.storageRequestId,
      transferId: 'read-transfer',
      byteLength: 4,
      chunkCount: 1,
      found: true,
    });
    assert.equal(admission.getActiveBytes(), 4);
    await assert.rejects(read, /timed out/i);
    assert.equal(admission.getActiveBytes(), 0);

    await host.store.set('key', 'value');
    const commit = host.commit();
    await waitFor(() => admission.getActiveBytes() > 0);
    await assert.rejects(commit, /timed out/i);
    assert.equal(admission.getActiveBytes(), 0);
    host.dispose();
    clearTimeout(keepEventLoopAlive);
  });

  void it('lets storage-free actions complete after their browser RPC host is disposed', async () => {
    const host = new RivetWebAppBrowserStorageRpcHost({
      admission: createRivetWebAppBrowserStorageRpcAdmission(),
      requestId: 'request-disposed-noop',
      runId: 'run-disposed-noop',
      signal: new AbortController().signal,
      sendBinary: () => true,
      sendJson: () => true,
    });

    host.dispose(new Error('Browser storage connection closed.'));
    await host.commit();
  });

  void it('discards a pending patch and rejects later writes after the browser disconnects', async () => {
    const host = new RivetWebAppBrowserStorageRpcHost({
      admission: createRivetWebAppBrowserStorageRpcAdmission(),
      requestId: 'request-disposed-write',
      runId: 'run-disposed-write',
      signal: new AbortController().signal,
      sendBinary: () => true,
      sendJson: () => true,
    });

    host.store.set('before-disconnect', 'value');
    host.dispose(new Error('Browser storage connection closed.'));
    await host.commit();
    assert.throws(() => host.store.set('after-disconnect', 'value'), /connection is unavailable/i);
  });

  void it('rejects transfer capacity separately from invalid payloads', async () => {
    const admission = createRivetWebAppBrowserStorageRpcAdmission(3);
    const controller = new AbortController();
    let getMessage: Extract<RivetWebAppBrowserStorageServerMessage, { type: 'storage.get' }> | undefined;
    const host = new RivetWebAppBrowserStorageRpcHost({
      admission,
      limits: { maxActionBytes: 16, maxActiveBytes: 3, maxValueBytes: 16, transferTimeoutMs: 1_000 },
      requestId: 'request-capacity',
      runId: 'run-capacity',
      signal: controller.signal,
      sendBinary: () => true,
      sendJson(message) {
        if (message.type === 'storage.get') getMessage = message;
        return true;
      },
    });

    const read = host.store.get('key');
    await waitFor(() => getMessage != null);
    host.handleMessage({
      type: 'storage.transfer.start',
      requestId: getMessage!.requestId,
      runId: getMessage!.runId,
      storageSessionId: getMessage!.storageSessionId,
      storageRequestId: getMessage!.storageRequestId,
      transferId: 'capacity-transfer',
      byteLength: 4,
      chunkCount: 1,
      found: true,
    } satisfies RivetWebAppBrowserStorageClientMessage);

    await assert.rejects(read, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'storage_capacity');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    });
    assert.equal(admission.getActiveBytes(), 0);
    host.dispose();
  });

  void it('does not accept binary chunks owned by another action session', async () => {
    const messages: RivetWebAppBrowserStorageServerMessage[] = [];
    const host = new RivetWebAppBrowserStorageRpcHost({
      admission: createRivetWebAppBrowserStorageRpcAdmission(),
      requestId: 'request-isolation',
      runId: 'run-isolation',
      signal: new AbortController().signal,
      sendBinary: () => true,
      sendJson(message) {
        messages.push(message);
        return true;
      },
    });

    const read = host.store.get('key');
    await waitFor(() => messages.some((message) => message.type === 'storage.get'));
    const get = messages.find((message) => message.type === 'storage.get')!;
    const transferId = '22222222-2222-4222-8222-222222222222';
    const valueBytes = new TextEncoder().encode(JSON.stringify('value'));
    host.handleMessage({
      type: 'storage.transfer.start',
      requestId: get.requestId,
      runId: get.runId,
      storageSessionId: get.storageSessionId,
      storageRequestId: get.storageRequestId,
      transferId,
      byteLength: valueBytes.byteLength,
      chunkCount: 1,
      found: true,
    });

    assert.equal(
      host.handleBinary(
        encodeRivetWebAppStorageBinaryFrame('11111111-1111-4111-8111-111111111111', transferId, 0, valueBytes),
      ),
      false,
    );
    assert.equal(
      host.handleBinary(encodeRivetWebAppStorageBinaryFrame(get.storageSessionId, transferId, 0, valueBytes)),
      true,
    );
    assert.equal(await read, 'value');
    host.dispose();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for browser-storage RPC state.');
}
