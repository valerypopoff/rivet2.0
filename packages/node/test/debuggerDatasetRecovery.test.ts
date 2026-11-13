import assert from 'node:assert/strict';
import test from 'node:test';
import { DebuggerDatasetProvider } from '../src/native/DebuggerDatasetProvider.js';

test('failed or expired dataset responses release their waiters instead of hanging execution', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new DebuggerDatasetProvider();
  let requestId = '';
  provider.onrequest = (_type, data) => {
    requestId = data.requestId;
  };
  const failed = provider.getDatasetData('fixture' as never);
  provider.handleResponse('datasets:response', { requestId, error: 'write failed' });
  await assert.rejects(failed, /write failed/);
  const expired = provider.getDatasetData('fixture' as never);
  const rejection = assert.rejects(expired, /expired.*not retried/);
  t.mock.timers.tick(120_000);
  await rejection;
  assert.equal(Object.keys(provider.listeners).length, 0);
  provider.dispose();
});
