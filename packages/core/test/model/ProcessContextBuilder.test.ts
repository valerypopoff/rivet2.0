import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildNodeProcessContext, type NodeProcessContextBase } from '../../src/model/ProcessContextBuilder.js';
import type { NodeId } from '../../src/model/NodeBase.js';
import type { GraphId } from '../../src/model/NodeGraph.js';
import type { GraphRunId, ProcessId, RootRunId } from '../../src/model/ProcessContext.js';
import type { ScalarOrArrayDataValue } from '../../src/model/DataValue.js';

void it('binds global and stored-value waits to the node signal by default and forwards an explicit signal', async () => {
  const nodeAbortController = new AbortController();
  const explicitController = new AbortController();
  const calls: Array<{ id: string; signal?: AbortSignal }> = [];
  const value: ScalarOrArrayDataValue = { type: 'string', value: 'ready' };
  const context = buildNodeProcessContext({
    activeOutputPortIds: new Set(),
    attachedData: {},
    base: {
      waitForGlobal: async (id, signal) => {
        calls.push({ id, signal });
        return value;
      },
      waitForStoredValue: async (id, signal) => {
        calls.push({ id, signal });
        return 'stored';
      },
    } as NodeProcessContextBase,
    createSubProcessor: () => undefined,
    execution: {
      graphId: 'graph' as GraphId,
      graphRunId: 'graph-run' as GraphRunId,
      rootRunId: 'root-run' as RootRunId,
    },
    externalFunctions: {},
    getPluginConfig: () => undefined,
    isDirectRunTarget: false,
    node: { id: 'node' as NodeId, type: 'text', title: 'Node', data: {}, visualData: { x: 0, y: 0 } },
    nodeAbortController,
    onPartialOutputs: () => {},
    processId: 'process' as ProcessId,
    requestUserInput: async () => ({ type: 'string[]', value: [] }),
    reportProgress: () => {},
    setGlobal: () => {},
    splitIndex: 0,
    waitEvent: async () => undefined,
  });

  assert.equal(await context.waitForGlobal('default'), value);
  assert.equal(await context.waitForGlobal('explicit', explicitController.signal), value);
  assert.equal(await context.waitForStoredValue('stored-default'), 'stored');
  assert.equal(await context.waitForStoredValue('stored-explicit', explicitController.signal), 'stored');
  assert.deepEqual(calls, [
    { id: 'default', signal: nodeAbortController.signal },
    { id: 'explicit', signal: explicitController.signal },
    { id: 'stored-default', signal: nodeAbortController.signal },
    { id: 'stored-explicit', signal: explicitController.signal },
  ]);
});
