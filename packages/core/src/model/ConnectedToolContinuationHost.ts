import type { Outputs } from './GraphProcessor.js';
import type { NodeId } from './NodeBase.js';
import type { ProcessId } from './ProcessContext.js';
import type { ToolCallContinuation } from './ToolCallContinuation.js';
import type { DelegateFunctionCallNode } from './nodes/DelegateFunctionCallNode.js';

/**
 * Owns connected Delegate invocation lifetime. GraphProcessor supplies narrow
 * scheduling callbacks, while this host owns only continuation-local state.
 */
export type ConnectedToolContinuationInvocation = {
  delegateNode: DelegateFunctionCallNode;
  latestOutputs: Map<NodeId, Outputs>;
  llmNodeId: NodeId;
  llmProcessId: ProcessId;
  released: boolean;
};

export class ConnectedToolContinuationHost {
  #invocations = new Map<string, ConnectedToolContinuationInvocation>();

  begin(params: {
    key: string;
    delegateNode: DelegateFunctionCallNode;
    llmNodeId: NodeId;
    llmProcessId: ProcessId;
    run: (
      invocation: ConnectedToolContinuationInvocation,
      toolCalls: Parameters<ToolCallContinuation['run']>[0],
      assistantMessage: string,
    ) => ReturnType<ToolCallContinuation['run']>;
  }): ToolCallContinuation {
    const invocation: ConnectedToolContinuationInvocation = {
      delegateNode: params.delegateNode,
      latestOutputs: new Map(),
      llmNodeId: params.llmNodeId,
      llmProcessId: params.llmProcessId,
      released: false,
    };
    this.#invocations.set(params.key, invocation);
    return {
      run: (toolCalls, assistantMessage) => params.run(invocation, toolCalls, assistantMessage),
      release: () => {
        invocation.released = true;
      },
    };
  }

  finalize(params: {
    key: string;
    nodeOutputs: Outputs;
    replay: (invocation: ConnectedToolContinuationInvocation, nodeOutputs: Outputs) => void;
    commit: (invocation: ConnectedToolContinuationInvocation) => void;
  }): void {
    const invocation = this.#invocations.get(params.key);
    this.#invocations.delete(params.key);
    if (!invocation || invocation.released) return;
    params.replay(invocation, params.nodeOutputs);
    params.commit(invocation);
  }

  discard(key: string): void {
    this.#invocations.delete(key);
  }

  reset(): void {
    this.#invocations.clear();
  }
}
