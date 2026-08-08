import { omit } from 'lodash-es';
import type { DataValue, ParsedAssistantChatMessageFunctionCall, ChatMessage } from '../DataValue.js';
import type { GraphId } from '../NodeGraph.js';
import type { InternalProcessContext, ProcessId, ToolCallFinishedEvent } from '../ProcessContext.js';
import type { NodeId, PortId } from '../NodeBase.js';
import type { Outputs } from '../GraphProcessor.js';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getError } from '../../utils/errors.js';
import {
  createDelegatedToolCallRecord,
  createToolResultMessage,
  normalizeToolCall,
  stringifyToolResult,
} from '../chat-v2/toolCallCodec.js';
import { findAutoDelegateGraphCandidate, resolveToolHandler } from '../chat-v2/toolHandlerResolver.js';

export type ToolCallDelegationConfig = {
  handlers: { key: string | undefined; value: GraphId }[];
  unknownHandler: GraphId | undefined;
  autoDelegate: boolean;
  fallBackToExternalCall?: boolean;
  passthroughErrors?: boolean;
};

export type ToolCallDelegationResult = {
  outputString: string;
  message: ChatMessage;
  record: DelegatedToolCallRecord;
  /** Cost from this live delegation. Kept out of the replay record so replay cannot charge it again. */
  cost?: number;
  /** Internal trace disposition; never exposed through node ports. */
  traceOutcome?: 'success' | 'passthrough-error';
};

export type DelegatedToolCallRecord = {
  delegatedToolCall: true;
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
  output: string;
  /** Milliseconds spent running the handler graph or external function. Absent on legacy records. */
  executionTimeMs?: number;
  message: ChatMessage;
};

/**
 * Reserved inputs belong to Rivet's tool invocation envelope. Model-produced
 * arguments must never replace them, otherwise a handler can observe a tool
 * name or argument object that does not match the invocation being delegated.
 */
const RIVET_TOOL_CALL_INPUT_IDS = new Set(['_function_name', '_arguments', '_rivet_tool_call']);

/**
 * Finds an Auto Delegate handler from an ordered set of graph-like candidates.
 *
 * Candidate identity belongs to the caller. Runtime execution passes graph
 * objects and uses their metadata IDs; editor analysis passes project-map
 * entries and uses their map keys. Keeping that distinction here preserves the
 * existing behavior for malformed projects where those identities disagree.
 */
export { findAutoDelegateGraphCandidate };

export function isDelegatedToolCallRecord(input: unknown): input is DelegatedToolCallRecord {
  const maybeRecord = input as Partial<DelegatedToolCallRecord> | undefined;
  const maybeMessage = maybeRecord?.message as Partial<ChatMessage> | undefined;

  return (
    typeof input === 'object' &&
    input != null &&
    maybeRecord?.delegatedToolCall === true &&
    typeof maybeRecord.name === 'string' &&
    typeof maybeRecord.output === 'string' &&
    typeof maybeRecord.arguments === 'object' &&
    maybeRecord.arguments != null &&
    !Array.isArray(maybeRecord.arguments) &&
    typeof maybeMessage === 'object' &&
    maybeMessage != null &&
    maybeMessage.type === 'function' &&
    typeof maybeMessage.message === 'string' &&
    typeof maybeMessage.name === 'string' &&
    (maybeMessage.toolName == null || typeof maybeMessage.toolName === 'string')
  );
}

export function buildDelegatedToolCallOutputs(
  records: DelegatedToolCallRecord[],
  preToolMessage?: string,
  cost?: number,
): Outputs {
  const preToolMessageOutput =
    preToolMessage == null
      ? {
          type: 'control-flow-excluded' as const,
          value: undefined,
        }
      : {
          type: 'string' as const,
          value: preToolMessage,
        };

  const executionTimesSeconds = records.map((record) => {
    const executionTimeMs = getExecutionTimeMs(record);
    return executionTimeMs == null ? undefined : executionTimeMs / 1_000;
  });
  const executionTimeOutput = executionTimesSeconds.every((executionTimeSeconds) => executionTimeSeconds != null)
    ? records.length === 1
      ? {
          type: 'number' as const,
          value: executionTimesSeconds[0]!,
        }
      : {
          type: 'number[]' as const,
          value: executionTimesSeconds,
        }
    : {
        type: 'control-flow-excluded' as const,
        value: undefined,
      };

  const outputs: Outputs =
    records.length === 1
      ? {
          ['tool-name' as PortId]: {
            type: 'string',
            value: records[0]!.name,
          },
          ['tool-arguments' as PortId]: {
            type: 'object',
            value: records[0]!.arguments,
          },
          ['assistant-message' as PortId]: preToolMessageOutput,
          ['output' as PortId]: {
            type: 'string',
            value: records[0]!.output,
          },
          ['execution-time' as PortId]: executionTimeOutput,
          ['message' as PortId]: {
            type: 'chat-message',
            value: records[0]!.message,
          },
        }
      : {
          ['tool-name' as PortId]: {
            type: 'string[]',
            value: records.map((record) => record.name),
          },
          ['tool-arguments' as PortId]: {
            type: 'object[]',
            value: records.map((record) => record.arguments),
          },
          ['assistant-message' as PortId]: preToolMessageOutput,
          ['output' as PortId]: {
            type: 'string[]',
            value: records.map((record) => record.output),
          },
          ['execution-time' as PortId]: executionTimeOutput,
          ['message' as PortId]: {
            type: 'chat-message[]',
            value: records.map((record) => record.message),
          },
        };

  if (cost != null) {
    outputs['cost' as PortId] = { type: 'number', value: cost };
  }

  return outputs;
}

/** @deprecated Use normalizeToolCall from the canonical chat-v2 codec. */
export const normalizeFunctionCallInput = normalizeToolCall;

export async function delegateToolCall(
  rawFunctionCall: unknown,
  context: InternalProcessContext,
  config: ToolCallDelegationConfig,
): Promise<ToolCallDelegationResult> {
  const functionCall = normalizeToolCall(rawFunctionCall);
  const source = context.toolCallTraceSource ?? {
    nodeId: context.node?.id ?? ('unknown' as NodeId),
    processId: context.processId ?? ('unknown' as ProcessId),
  };
  // A connected continuation changes the trace *source* to the LLM Chat, but
  // the Delegate invocation still owns the persisted result. Carry that exact
  // pointer so observers can navigate to the result without matching tool
  // names or scanning potentially evicted input values.
  const resultOwner = getToolCallResultOwner(context);
  const startedAt = Date.now();
  const timingStart = getCurrentTimeMs();
  const trace: ToolCallTraceHandler = { handlerKind: 'unknown' };

  try {
    const result = await delegateResolvedToolCall(functionCall, context, config, trace);
    notifyToolCallFinished(context, {
      ...(functionCall.id == null ? {} : { toolCallId: functionCall.id }),
      toolName: functionCall.name,
      sourceNodeId: source.nodeId,
      sourceProcessId: source.processId,
      ...(resultOwner == null ? {} : { resultOwner }),
      ...trace,
      outcome: result.traceOutcome ?? 'success',
      startedAt,
      durationMs: Math.max(0, getCurrentTimeMs() - timingStart),
    });
    return result;
  } catch (error) {
    notifyToolCallFinished(context, {
      ...(functionCall.id == null ? {} : { toolCallId: functionCall.id }),
      toolName: functionCall.name,
      sourceNodeId: source.nodeId,
      sourceProcessId: source.processId,
      ...trace,
      outcome: context.signal.aborted ? 'aborted' : 'failure',
      startedAt,
      durationMs: Math.max(0, getCurrentTimeMs() - timingStart),
    });
    throw error;
  }
}

function getToolCallResultOwner(context: InternalProcessContext): ToolCallFinishedEvent['resultOwner'] | undefined {
  const node = context.node;
  if (node?.type !== 'delegateFunctionCall' || typeof node.id !== 'string' || typeof context.processId !== 'string') {
    return undefined;
  }

  return {
    nodeId: node.id,
    processId: context.processId,
    outputPortId: 'output' as PortId,
  };
}

type ToolCallTraceHandler = {
  handlerKind: 'graph' | 'external' | 'unknown';
  handlerGraphId?: GraphId;
  handlerName?: string;
};

async function delegateResolvedToolCall(
  functionCall: ParsedAssistantChatMessageFunctionCall,
  context: InternalProcessContext,
  config: ToolCallDelegationConfig,
  trace: ToolCallTraceHandler,
): Promise<ToolCallDelegationResult> {
  const resolvedHandler = resolveToolHandler({
    project: context.project,
    toolName: functionCall.name,
    config,
    hasExternalFunction: context.externalFunctions[functionCall.name] != null,
  });
  let handler: { value: GraphId } | undefined;

  if (resolvedHandler?.kind === 'external') {
    const externalFunction = context.externalFunctions[functionCall.name];
    if (externalFunction) {
      trace.handlerKind = 'external';
      trace.handlerName = functionCall.name;
      const executionStart = getCurrentTimeMs();
      try {
        const externalContext = omit(context, ['setGlobal']);
        const result = await externalFunction(externalContext, functionCall.arguments ?? {});
        const outputString = stringifyToolResult(result);
        const executionTimeMs = getCurrentTimeMs() - executionStart;

        return {
          outputString,
          message: createToolResultMessage(functionCall, outputString),
          record: createDelegatedToolCallRecord(functionCall, outputString, executionTimeMs),
          cost: result.cost,
        };
      } catch (error) {
        if (config.passthroughErrors) {
          const outputString = `Error: ${getError(error).message}`;
          const executionTimeMs = getCurrentTimeMs() - executionStart;

          return {
            outputString,
            message: createToolResultMessage(functionCall, outputString),
            record: createDelegatedToolCallRecord(functionCall, outputString, executionTimeMs),
            traceOutcome: 'passthrough-error',
          };
        }

        throw new Error(`External function call failed for ${functionCall.name}: ${getError(error).message}`);
      }
    }
  }

  if (resolvedHandler?.kind === 'graph' || resolvedHandler?.kind === 'unknown') {
    handler = { value: resolvedHandler.graphId };
  }

  if (!handler) {
    if (config.autoDelegate) {
      const errorMessage = config.fallBackToExternalCall
        ? `No handler found for tool call: ${functionCall.name}, no graph containing the name "${functionCall.name}" was found, and no external function with that name was registered.`
        : `No handler found for tool call: ${functionCall.name}, no graph containing the name "${functionCall.name}" was found.`;
      throw new Error(errorMessage);
    } else {
      throw new Error(`No handler found for tool call: ${functionCall.name}`);
    }
  }

  // A null-prototype map prevents model arguments such as `__proto__` from
  // changing the input map's prototype. Retain the legacy top-level argument
  // inputs for existing handler graphs, while also providing one namespaced
  // invocation envelope for new graphs.
  const subgraphInputs = Object.create(null) as Record<string, DataValue>;
  subgraphInputs._function_name = {
    type: 'string',
    value: functionCall.name,
  };
  subgraphInputs._arguments = {
    type: 'object',
    value: functionCall.arguments,
  };
  subgraphInputs._rivet_tool_call = {
    type: 'object',
    value: {
      id: functionCall.id,
      name: functionCall.name,
      arguments: functionCall.arguments,
    },
  };

  trace.handlerKind = 'graph';
  trace.handlerGraphId = handler.value;
  const handlerName = context.project.graphs[handler.value]?.metadata?.name;
  if (handlerName != null) {
    trace.handlerName = handlerName;
  }

  for (const [argName, argument] of Object.entries(functionCall.arguments ?? {})) {
    if (RIVET_TOOL_CALL_INPUT_IDS.has(argName)) {
      continue;
    }
    subgraphInputs[argName] = {
      type: 'any',
      value: argument,
    };
  }

  const subprocessor = context.createSubProcessor(handler.value, { signal: context.signal });
  const executionStart = getCurrentTimeMs();
  const outputs = await subprocessor.processGraph(context, subgraphInputs, context.contextValues);
  const executionTimeMs = getCurrentTimeMs() - executionStart;
  const outputValue = outputs['output' as PortId];
  if (outputValue == null) {
    throw new Error(
      `Tool handler graph "${handlerName ?? handler.value}" must return a string Graph Output named "output".`,
    );
  }
  const outputString = coerceTypeOptional(outputValue, 'string');
  if (outputString == null) {
    throw new Error(
      `Tool handler graph "${handlerName ?? handler.value}" returned an invalid Graph Output named "output". It must resolve to a string.`,
    );
  }
  const cost = coerceTypeOptional(outputs['cost' as PortId], 'number');

  return {
    outputString,
    message: createToolResultMessage(functionCall, outputString),
    record: createDelegatedToolCallRecord(functionCall, outputString, executionTimeMs),
    cost,
  };
}

function notifyToolCallFinished(
  context: InternalProcessContext,
  event: Parameters<NonNullable<InternalProcessContext['onToolCallFinished']>>[0],
): void {
  try {
    context.onToolCallFinished?.(event);
  } catch {
    // Trace observers must never change tool execution behavior.
  }
}

function getCurrentTimeMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function getExecutionTimeMs(record: DelegatedToolCallRecord): number | undefined {
  const { executionTimeMs } = record;
  return typeof executionTimeMs === 'number' && Number.isFinite(executionTimeMs) && executionTimeMs >= 0
    ? executionTimeMs
    : undefined;
}
