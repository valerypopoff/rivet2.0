import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { InternalProcessContext } from '../../src/model/ProcessContext.js';
import {
  ToolCallContinuationCoordinator,
  type ToolCallContinuationCoordinatorAdapter,
} from '../../src/model/ToolCallContinuationCoordinator.js';
import type { ChartNode, NodeId, PortId } from '../../src/model/NodeBase.js';
import type { DelegateFunctionCallNode } from '../../src/model/nodes/DelegateFunctionCallNode.js';
import type { StreamedFunctionCall } from '../../src/model/chat/streamChatResponse.js';
import type { NodeOutputs } from '../../src/model/NodeIO.js';

describe('ToolCallContinuationCoordinator', () => {
  it('creates the branch adapter only after a paused round becomes runnable', async () => {
    const waitGate = deferred<void>();
    const initialWaitEntered = deferred<void>();
    let waitCalls = 0;
    let branchAdapterCreations = 0;
    const activatedOutputPortSets: string[][] = [];
    const rootAbortController = new AbortController();
    const coordinator = new ToolCallContinuationCoordinator({
      accumulateCost: () => undefined,
      createBranchAdapter: () => {
        branchAdapterCreations++;
        return {
          canRunContinuationBranches: () => true,
          runOutputBranch: async ({ activeOutputPortIds }) => {
            activatedOutputPortSets.push([...activeOutputPortIds]);
            return emptyBranchResult();
          },
          validatePreToolBranch: () => undefined,
        };
      },
      createDelegateProcessContext: () => makeExternalFunctionContext(),
      createNodeAbortController: () => new AbortController(),
      emitDelegateError: async () => undefined,
      emitDelegateFinish: async () => undefined,
      emitDelegatePartialOutput: () => undefined,
      emitDelegateStart: async () => undefined,
      getActiveOutputPortIds: () => new Set(),
      getContinuationBranchBoundaryNodeIds: () => new Set(),
      hasPreloadedOrFrozenDelegateOutput: () => false,
      registerNodeAbortController: () => undefined,
      rootAbortSignal: rootAbortController.signal,
      startNodeTiming: () => undefined,
      unregisterNodeAbortController: () => undefined,
      waitUntilUnpaused: async () => {
        waitCalls++;
        if (waitCalls === 1) {
          initialWaitEntered.resolve();
        }
        await waitGate.promise;
      },
    } satisfies ToolCallContinuationCoordinatorAdapter);

    const run = coordinator.run({
      assistantMessage: '',
      delegateNode: makeDelegateNode(),
      llmNode: makeNode('llm', 'llmChatV2', 'LLM Chat'),
      llmSignal: new AbortController().signal,
      toolCalls: [makeToolCall()],
    });

    await initialWaitEntered.promise;
    assert.equal(branchAdapterCreations, 0);

    waitGate.resolve();
    const result = await run;

    assert.equal(branchAdapterCreations, 1);
    assert.deepEqual(
      result.results.map((item) => item.record.name),
      ['lookup'],
    );
    assert.deepEqual(activatedOutputPortSets, [['tool-name', 'tool-arguments', 'output', 'execution-time', 'message']]);
  });
});

function makeDelegateNode(): DelegateFunctionCallNode {
  return {
    data: {
      autoDelegate: true,
      fallBackToExternalCall: true,
      handlers: [],
      passthroughErrors: false,
      unknownHandler: undefined,
    },
    id: 'delegate' as NodeId,
    title: 'Delegate Tool Call',
    type: 'delegateFunctionCall',
    visualData: { x: 0, y: 0, width: 200 },
  };
}

function makeNode(id: string, type: string, title: string): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title,
    type,
    visualData: { x: 0, y: 0, width: 200 },
  } as ChartNode;
}

function makeToolCall(): StreamedFunctionCall {
  return {
    arguments: '{}',
    id: 'tool-call',
    lastParsedArguments: {},
    name: 'lookup',
    type: 'function',
  };
}

function makeExternalFunctionContext(): InternalProcessContext {
  return {
    externalFunctions: {
      lookup: async () => ({ type: 'string', value: 'done' }),
    },
    project: { graphs: {} },
  } as unknown as InternalProcessContext;
}

function emptyBranchResult() {
  return {
    graphOutputWrites: {},
    nodeOutputs: new Map<NodeId, NodeOutputs>(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}
