import { nanoid } from 'nanoid/non-secure';
import { createGraphAbortErrorFromSignal, getAbortSignalReason } from './GraphAbortReasons.js';
import type { DataValue } from './DataValue.js';
import type { NodeInputs, NodeOutputs } from './NodeIO.js';
import type { ChartNode, NodeId, PortId } from './NodeBase.js';
import type { InternalProcessContext, ProcessId } from './ProcessContext.js';
import type { StreamedFunctionCall } from './chat/streamChatResponse.js';
import { DELEGATE_TOOL_CALL_INPUT_ID } from './chat-v2/toolContinuationConnection.js';
import type { DelegateFunctionCallNode } from './nodes/DelegateFunctionCallNode.js';
import { buildDelegatedToolCallOutputs, delegateToolCall } from './nodes/toolCallDelegation.js';
import type { ToolCallContinuationResult } from './ToolCallContinuation.js';

export type ToolCallContinuationBranchRunResult = {
  graphOutputWrites: Record<string, DataValue>;
  nodeOutputs: ReadonlyMap<NodeId, NodeOutputs>;
};

export type ToolCallContinuationInvocationResult = {
  finalBranch: ToolCallContinuationBranchRunResult;
  outputs: NodeOutputs;
  preToolBranch: ToolCallContinuationBranchRunResult;
  toolResult: Awaited<ReturnType<typeof delegateToolCall>>;
};

export type ToolCallContinuationRoundResult = {
  invocations: readonly ToolCallContinuationInvocationResult[];
  results: readonly ToolCallContinuationResult[];
};

export type ToolCallContinuationBranchAdapter = {
  canRunContinuationBranches(llmNode: ChartNode, delegateNode: DelegateFunctionCallNode): boolean;
  runOutputBranch(request: {
    activeOutputPortIds: ReadonlySet<PortId>;
    availableNodeOutputs: ReadonlyMap<NodeId, NodeOutputs>;
    deferGraphOutputCommit: boolean;
    excludedNodeIds: ReadonlySet<NodeId>;
    failOnUnsafeReadyNode: boolean;
    signal: AbortSignal;
    sourceNode: ChartNode;
    sourceOutputs: NodeOutputs;
  }): Promise<ToolCallContinuationBranchRunResult>;
  validatePreToolBranch(request: {
    activeOutputPortIds: ReadonlySet<PortId>;
    excludedNodeIds: ReadonlySet<NodeId>;
    sourceNode: DelegateFunctionCallNode;
    sourceOutputs: NodeOutputs;
  }): void;
};

export type ToolCallContinuationCoordinatorAdapter = {
  accumulateCost(outputs: NodeOutputs): void;
  createBranchAdapter(): ToolCallContinuationBranchAdapter;
  createDelegateProcessContext(
    node: DelegateFunctionCallNode,
    inputs: NodeInputs,
    processId: ProcessId,
    nodeAbortController: AbortController,
  ): InternalProcessContext;
  createNodeAbortController(): AbortController;
  emitDelegateError(
    node: DelegateFunctionCallNode,
    error: unknown,
    processId: ProcessId,
    timingStart: number | undefined,
  ): Promise<void>;
  emitDelegateFinish(
    node: DelegateFunctionCallNode,
    outputs: NodeOutputs,
    processId: ProcessId,
    timingStart: number | undefined,
  ): Promise<void>;
  emitDelegatePartialOutput(node: DelegateFunctionCallNode, outputs: NodeOutputs, processId: ProcessId): void;
  emitDelegateStart(node: DelegateFunctionCallNode, inputs: NodeInputs, processId: ProcessId): Promise<void>;
  getActiveOutputPortIds(node: ChartNode): ReadonlySet<PortId>;
  getContinuationBranchBoundaryNodeIds(llmNode: ChartNode): ReadonlySet<NodeId>;
  hasPreloadedOrFrozenDelegateOutput(node: DelegateFunctionCallNode, inputs: NodeInputs, processId: ProcessId): boolean;
  registerNodeAbortController(nodeId: NodeId, controller: AbortController): void;
  rootAbortSignal: AbortSignal;
  unregisterNodeAbortController(nodeId: NodeId, controller: AbortController): void;
  startNodeTiming(): number | undefined;
  waitUntilUnpaused(): Promise<void>;
};

export class ToolCallContinuationCoordinator {
  readonly #adapter: ToolCallContinuationCoordinatorAdapter;

  constructor(adapter: ToolCallContinuationCoordinatorAdapter) {
    this.#adapter = adapter;
  }

  async run(options: {
    assistantMessage: string;
    delegateNode: DelegateFunctionCallNode;
    llmNode: ChartNode;
    llmSignal: AbortSignal;
    toolCalls: readonly StreamedFunctionCall[];
  }): Promise<ToolCallContinuationRoundResult> {
    const { assistantMessage, delegateNode, llmNode, llmSignal, toolCalls } = options;
    if (toolCalls.length === 0) {
      return { invocations: [], results: [] };
    }

    if (this.#adapter.rootAbortSignal.aborted) {
      throw createGraphAbortErrorFromSignal(this.#adapter.rootAbortSignal);
    }

    const processIds = toolCalls.map(() => nanoid() as ProcessId);
    const inputsByCall = toolCalls.map(
      (toolCall): NodeInputs => ({
        [DELEGATE_TOOL_CALL_INPUT_ID]: {
          type: 'object',
          value: toolCall,
        },
      }),
    );
    const nodeAbortControllers = toolCalls.map(() => this.#adapter.createNodeAbortController());
    nodeAbortControllers.forEach((controller) =>
      this.#adapter.registerNodeAbortController(delegateNode.id, controller),
    );
    const abortAllCalls = (reason: unknown) => {
      for (const controller of nodeAbortControllers) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      }
    };
    const abortFromLLM = () => {
      abortAllCalls(getAbortSignalReason(llmSignal));
    };
    llmSignal.addEventListener('abort', abortFromLLM, { once: true });
    if (this.#adapter.rootAbortSignal.aborted) {
      abortAllCalls(getAbortSignalReason(this.#adapter.rootAbortSignal));
    } else if (llmSignal.aborted) {
      abortFromLLM();
    }

    try {
      await this.#adapter.waitUntilUnpaused();
      const abortedController = nodeAbortControllers.find((controller) => controller.signal.aborted);
      if (abortedController) {
        throw createGraphAbortErrorFromSignal(abortedController.signal, 'Delegate Tool Call aborted');
      }

      // Snapshot topology only after the parent is runnable. A paused parent
      // may still receive graph-state updates before this continuation round.
      const branchAdapter = this.#adapter.createBranchAdapter();
      const hasAssistantMessage = assistantMessage.trim().length > 0;
      const canRunContinuationBranches = branchAdapter.canRunContinuationBranches(llmNode, delegateNode);
      const assistantOutputs: NodeOutputs = {
        ['assistant-message' as PortId]: {
          type: 'string',
          value: assistantMessage,
        },
      };
      const preToolOutputPortIds = new Set<PortId>(['assistant-message' as PortId]);
      const hasActivePreToolBranch =
        hasAssistantMessage && this.#adapter.getActiveOutputPortIds(delegateNode).has('assistant-message' as PortId);
      const continuationBranchBoundaries = new Set(this.#adapter.getContinuationBranchBoundaryNodeIds(llmNode));

      // Validate the complete round before parallel calls can cause side effects.
      // The first invocation still produces a real Delegate error run for diagnostics.
      try {
        if (this.#adapter.hasPreloadedOrFrozenDelegateOutput(delegateNode, inputsByCall[0]!, processIds[0]!)) {
          throw new Error(
            `Delegate Tool Call "${delegateNode.title}" is the active auto-continuation handler and cannot use preloaded or frozen outputs. Clear its preload or unfreeze it before running this graph.`,
          );
        }
        if (hasActivePreToolBranch) {
          if (!canRunContinuationBranches) {
            throw new Error(
              `Delegate Tool Call "${delegateNode.title}" cannot fire its pre-tool Message branch because the LLM/Delegate continuation is inside an unsupported cycle, race, or loop.`,
            );
          }
          branchAdapter.validatePreToolBranch({
            activeOutputPortIds: preToolOutputPortIds,
            excludedNodeIds: continuationBranchBoundaries,
            sourceNode: delegateNode,
            sourceOutputs: assistantOutputs,
          });
        }
      } catch (error) {
        const processId = processIds[0]!;
        const inputs = inputsByCall[0]!;
        await this.#adapter.emitDelegateStart(delegateNode, inputs, processId);
        await this.#adapter.emitDelegateError(delegateNode, error, processId, this.#adapter.startNodeTiming());
        throw error;
      }

      let firstFailure: unknown;
      let hasFailure = false;
      const abortSiblingOnFailure = async <T>(work: Promise<T>): Promise<T> => {
        try {
          return await work;
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
          }
          abortAllCalls(error);
          throw error;
        }
      };

      const runInvocation = async (toolCall: StreamedFunctionCall, toolCallIndex: number) => {
        const processId = processIds[toolCallIndex]!;
        const inputs = inputsByCall[toolCallIndex]!;
        const nodeAbortController = nodeAbortControllers[toolCallIndex]!;
        let timingStart: number | undefined;
        let delegateStarted = false;
        let delegateFinished = false;

        try {
          await this.#adapter.waitUntilUnpaused();
          if (nodeAbortController.signal.aborted) {
            throw createGraphAbortErrorFromSignal(nodeAbortController.signal, 'Delegate Tool Call aborted');
          }

          await this.#adapter.emitDelegateStart(delegateNode, inputs, processId);
          delegateStarted = true;
          timingStart = this.#adapter.startNodeTiming();
          const delegateContext = this.#adapter.createDelegateProcessContext(
            delegateNode,
            inputs,
            processId,
            nodeAbortController,
          );

          if (hasAssistantMessage) {
            this.#adapter.emitDelegatePartialOutput(delegateNode, assistantOutputs, processId);
          }

          const preToolBranchPromise = hasActivePreToolBranch
            ? branchAdapter.runOutputBranch({
                activeOutputPortIds: preToolOutputPortIds,
                availableNodeOutputs: new Map(),
                deferGraphOutputCommit: true,
                excludedNodeIds: continuationBranchBoundaries,
                failOnUnsafeReadyNode: true,
                signal: nodeAbortController.signal,
                sourceNode: delegateNode,
                sourceOutputs: assistantOutputs,
              })
            : Promise.resolve(createEmptyBranchResult());

          // Do not await the early Message branch before tool work: it is an
          // independent side-effect branch and must overlap every scalar call.
          const [toolOutcome, preToolBranchOutcome] = await Promise.allSettled([
            abortSiblingOnFailure(delegateToolCall(toolCall, delegateContext, delegateNode.data)),
            abortSiblingOnFailure(preToolBranchPromise),
          ]);
          if (toolOutcome.status === 'rejected') throw toolOutcome.reason;
          if (preToolBranchOutcome.status === 'rejected') throw preToolBranchOutcome.reason;
          const toolResult = toolOutcome.value;
          const preToolBranch = preToolBranchOutcome.value;

          if (nodeAbortController.signal.aborted) {
            throw createGraphAbortErrorFromSignal(nodeAbortController.signal, 'Delegate Tool Call aborted');
          }

          const outputs = buildDelegatedToolCallOutputs(
            [toolResult.record],
            hasAssistantMessage ? assistantMessage : undefined,
            toolResult.cost,
          );
          this.#adapter.accumulateCost(outputs);
          await this.#adapter.emitDelegateFinish(delegateNode, outputs, processId, timingStart);
          delegateFinished = true;

          const finalBranch = canRunContinuationBranches
            ? await branchAdapter.runOutputBranch({
                activeOutputPortIds: new Set<PortId>(['output' as PortId, 'message' as PortId]),
                availableNodeOutputs: preToolBranch.nodeOutputs,
                deferGraphOutputCommit: true,
                excludedNodeIds: continuationBranchBoundaries,
                failOnUnsafeReadyNode: false,
                signal: nodeAbortController.signal,
                sourceNode: delegateNode,
                sourceOutputs: outputs,
              })
            : createEmptyBranchResult();

          return { finalBranch, outputs, preToolBranch, toolResult };
        } catch (error) {
          if (delegateStarted && !delegateFinished) {
            await this.#adapter.emitDelegateError(delegateNode, error, processId, timingStart);
          }
          throw error;
        }
      };

      const outcomes = await Promise.allSettled(
        toolCalls.map((toolCall, toolCallIndex) => abortSiblingOnFailure(runInvocation(toolCall, toolCallIndex))),
      );
      if (hasFailure) {
        throw firstFailure;
      }
      const invocations = outcomes.map((outcome) => {
        if (outcome.status === 'rejected') {
          throw outcome.reason;
        }
        return outcome.value;
      });

      return {
        invocations,
        results: invocations.map(({ toolResult }) => ({
          message: toolResult.message,
          record: toolResult.record,
        })),
      };
    } finally {
      llmSignal.removeEventListener('abort', abortFromLLM);
      nodeAbortControllers.forEach((controller) =>
        this.#adapter.unregisterNodeAbortController(delegateNode.id, controller),
      );
    }
  }
}

function createEmptyBranchResult(): ToolCallContinuationBranchRunResult {
  return { graphOutputWrites: {}, nodeOutputs: new Map() };
}
