import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectedToolContinuationHost } from '../../src/model/ConnectedToolContinuationHost.js';

describe('ConnectedToolContinuationHost', () => {
  it('commits exactly the invocation it owns and suppresses released continuations', async () => {
    const host = new ConnectedToolContinuationHost();
    const invoked: string[] = [];
    const continuation = host.begin({
      key: 'p:0',
      delegateNode: { id: 'delegate', type: 'delegateFunctionCall' } as any,
      llmNodeId: 'chat' as any,
      llmProcessId: 'process' as any,
      run: async (_invocation, calls) => {
        invoked.push(calls[0]?.name ?? '');
        return [];
      },
    });
    await continuation.run([{ id: 'call', name: 'time', arguments: '{}' }], '');
    assert.deepEqual(invoked, ['time']);

    let committed = 0;
    continuation.release();
    host.finalize({
      key: 'p:0',
      nodeOutputs: {},
      replay: () => assert.fail('released invocation must not replay'),
      commit: () => committed++,
    });
    assert.equal(committed, 0);
  });
});
