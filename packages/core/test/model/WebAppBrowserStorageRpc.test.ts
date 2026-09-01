import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  decodeRivetWebAppStorageBinaryFrame,
  encodeRivetWebAppStorageBinaryFrame,
  parseRivetWebAppBrowserStorageClientMessage,
  parseRivetWebAppBrowserStorageServerMessage,
} from '../../src/model/WebAppBrowserStorageRpc.js';

void describe('web app browser-storage RPC framing', () => {
  void it('round-trips the action session, transfer id, chunk index, and bytes', () => {
    const storageSessionId = '11111111-1111-4111-8111-111111111111';
    const transferId = '22222222-2222-4222-8222-222222222222';
    const decoded = decodeRivetWebAppStorageBinaryFrame(
      encodeRivetWebAppStorageBinaryFrame(storageSessionId, transferId, 7, new Uint8Array([1, 2, 3])),
    );

    assert.equal(decoded?.storageSessionId, storageSessionId);
    assert.equal(decoded?.transferId, transferId);
    assert.equal(decoded?.chunkIndex, 7);
    assert.deepEqual(decoded?.bytes, new Uint8Array([1, 2, 3]));
  });

  void it('rejects malformed frames and controls without a valid action session', () => {
    assert.equal(decodeRivetWebAppStorageBinaryFrame(new Uint8Array([1, 2, 3])), undefined);
    assert.equal(
      parseRivetWebAppBrowserStorageServerMessage({
        type: 'storage.get',
        requestId: 'request',
        runId: 'run',
        storageSessionId: 'not-a-uuid',
        storageRequestId: 'read',
        key: 'value',
      }),
      undefined,
    );
    assert.equal(
      parseRivetWebAppBrowserStorageClientMessage({
        type: 'storage.commit.ack',
        requestId: 'request',
        runId: 'run',
        storageSessionId: '11111111-1111-4111-8111-111111111111',
        transferId: 'not-a-uuid',
      }),
      undefined,
    );
  });
});
