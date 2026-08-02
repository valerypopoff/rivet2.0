import { omit } from 'lodash-es';
import type { DataValue, ParsedAssistantChatMessageFunctionCall, ChatMessage } from '../DataValue.js';
import type { GraphId } from '../NodeGraph.js';
import type { InternalProcessContext, ProcessId } from '../ProcessContext.js';
import type { NodeId, PortId } from '../NodeBase.js';
import type { Outputs } from '../GraphProcessor.js';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getError } from '../../utils/errors.js';

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
 * Finds an Auto Delegate handler from an ordered set of graph-like candidates.
 *
 * Candidate identity belongs to the caller. Runtime execution passes graph
 * objects and uses their metadata IDs; editor analysis passes project-map
 * entries and uses their map keys. Keeping that distinction here preserves the
 * existing behavior for malformed projects where those identities disagree.
 */
export function findAutoDelegateGraphCandidate<T>(
  candidates: readonly T[],
  toolName: string,
  getGraphName: (candidate: T) => string | undefined,
): T | undefined {
  return (
    candidates.find((candidate) => getGraphName(candidate) === toolName) ??
    candidates.find((candidate) => getGraphName(candidate)?.includes(toolName))
  );
}

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

export function normalizeFunctionCallInput(input: unknown): ParsedAssistantChatMessageFunctionCall {
  if (Array.isArray(input)) {
    if (input.length !== 1) {
      throw new Error(
        `Delegate Tool Call expected a single tool call, but received ${input.length}. Use Run per item or select one tool call before delegating.`,
      );
    }

    return normalizeFunctionCallInput(input[0]);
  }

  if (typeof input !== 'object' || input == null) {
    throw new Error('Delegate Tool Call expected a tool call object.');
  }

  const rawFunctionCall = input as Record<string, unknown>;
  const name = rawFunctionCall.name;

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Delegate Tool Call expected the tool call to include a name.');
  }

  const id = typeof rawFunctionCall.id === 'string' ? rawFunctionCall.id : undefined;
  const rawArguments = rawFunctionCall.arguments;

  if (rawArguments == null) {
    return { id, name, arguments: {} };
  }

  if (typeof rawArguments === 'string') {
    try {
      const parsedArguments = JSON.parse(rawArguments);

      if (typeof parsedArguments === 'object' && parsedArguments != null && !Array.isArray(parsedArguments)) {
        return { id, name, arguments: parsedArguments as Record<string, unknown> };
      }
    } catch {
      // Fall through to the explicit error below.
    }

    throw new Error(`Delegate Tool Call expected "${name}" arguments to be a JSON object.`);
  }

  if (typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return { id, name, arguments: rawArguments as Record<string, unknown> };
  }

  throw new Error(`Delegate Tool Call expected "${name}" arguments to be an object.`);
}

function buildToolResultMessage(
  functionCall: ParsedAssistantChatMessageFunctionCall,
  outputString: string,
): ChatMessage {
  return {
    type: 'function',
    message: outputString,
    name: functionCall.id ?? '',
    toolName: functionCall.name,
  };
}

function buildDelegatedToolCallRecord(
  functionCall: ParsedAssistantChatMessageFunctionCall,
  outputString: string,
  executionTimeMs?: number,
): DelegatedToolCallRecord {
  return {
    delegatedToolCall: true,
    name: functionCall.name,
    arguments: functionCall.arguments,
    id: functionCall.id,
    output: outputString,
    ...(executionTimeMs == null ? {} : { executionTimeMs }),
    message: buildToolResultMessage(functionCall, outputString),
  };
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  return JSON.stringify(output) ?? String(output);
}

export async function delegateToolCall(
  rawFunctionCall: unknown,
  context: InternalProcessContext,
  config: ToolCallDelegationConfig,
): Promise<ToolCallDelegationResult> {
  const functionCall = normalizeFunctionCallInput(rawFunctionCall);
  const source = context.toolCallTraceSource ?? {
    nodeId: context.node?.id ?? ('unknown' as NodeId),
    processId: context.processId ?? ('unknown' as ProcessId),
  };
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
  let handler: { key: string | undefined; value: GraphId } | undefined;

  if (config.autoDelegate) {
    const graphs = Object.values(context.project.graphs);
    const matchingGraph = findAutoDelegateGraphCandidate(graphs, functionCall.name, (graph) => graph.metadata?.name);
    if (matchingGraph) {
      handler = { key: undefined, value: matchingGraph.metadata!.id! };
    }
  } else {
    handler = config.handlers.find((handler) => handler.key === functionCall.name);
  }

  if (!handler) {
    if (config.autoDelegate && config.fallBackToExternalCall) {
      const externalFunction = context.externalFunctions[functionCall.name];
      if (externalFunction) {
        trace.handlerKind = 'external';
        trace.handlerName = functionCall.name;
        const executionStart = getCurrentTimeMs();
        try {
          const externalContext = omit(context, ['setGlobal']);
          const result = await externalFunction(externalContext, functionCall.arguments ?? {});
          const outputString = stringifyToolOutput(result);
          const executionTimeMs = getCurrentTimeMs() - executionStart;

          return {
            outputString,
            message: buildToolResultMessage(functionCall, outputString),
            record: buildDelegatedToolCallRecord(functionCall, outputString, executionTimeMs),
            cost: result.cost,
          };
        } catch (error) {
          if (config.passthroughErrors) {
            const outputString = `Error: ${getError(error).message}`;
            const executionTimeMs = getCurrentTimeMs() - executionStart;

            return {
              outputString,
              message: buildToolResultMessage(functionCall, outputString),
              record: buildDelegatedToolCallRecord(functionCall, outputString, executionTimeMs),
              traceOutcome: 'passthrough-error',
            };
          }

          throw new Error(`External function call failed for ${functionCall.name}: ${getError(error).message}`);
        }
      }
    }

    if (config.unknownHandler) {
      handler = { key: undefined, value: config.unknownHandler };
    } else if (config.autoDelegate) {
      const errorMessage = config.fallBackToExternalCall
        ? `No handler found for tool call: ${functionCall.name}, no graph containing the name "${functionCall.name}" was found, and no external function with that name was registered.`
        : `No handler found for tool call: ${functionCall.name}, no graph containing the name "${functionCall.name}" was found.`;
      throw new Error(errorMessage);
    } else {
      throw new Error(`No handler found for tool call: ${functionCall.name}`);
    }
  }

  const subgraphInputs: Record<string, DataValue> = {
    _function_name: {
      type: 'string',
      value: functionCall.name,
    },
    _arguments: {
      type: 'object',
      value: functionCall.arguments,
    },
  };

  trace.handlerKind = 'graph';
  trace.handlerGraphId = handler.value;
  const handlerName = context.project.graphs[handler.value]?.metadata?.name;
  if (handlerName != null) {
    trace.handlerName = handlerName;
  }

  for (const [argName, argument] of Object.entries(functionCall.arguments ?? {})) {
    subgraphInputs[argName] = {
      type: 'any',
      value: argument,
    };
  }

  const subprocessor = context.createSubProcessor(handler.value, { signal: context.signal });
  const executionStart = getCurrentTimeMs();
  const outputs = await subprocessor.processGraph(context, subgraphInputs, context.contextValues);
  const executionTimeMs = getCurrentTimeMs() - executionStart;
  const outputString = coerceTypeOptional(outputs['output' as PortId], 'string') ?? '';
  const cost = coerceTypeOptional(outputs['cost' as PortId], 'number');

  return {
    outputString,
    message: buildToolResultMessage(functionCall, outputString),
    record: buildDelegatedToolCallRecord(functionCall, outputString, executionTimeMs),
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
