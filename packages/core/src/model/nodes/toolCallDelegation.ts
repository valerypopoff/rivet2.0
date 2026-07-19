import { omit } from 'lodash-es';
import type { DataValue, ParsedAssistantChatMessageFunctionCall, ChatMessage } from '../DataValue.js';
import type { GraphId } from '../NodeGraph.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { PortId } from '../NodeBase.js';
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
};

export type DelegatedToolCallRecord = {
  delegatedToolCall: true;
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
  output: string;
  message: ChatMessage;
};

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

  const outputs: Outputs =
    records.length === 1
      ? {
          ['output' as PortId]: {
            type: 'string',
            value: records[0]!.output,
          },
          ['message' as PortId]: {
            type: 'chat-message',
            value: records[0]!.message,
          },
          ['assistant-message' as PortId]: preToolMessageOutput,
        }
      : {
          ['output' as PortId]: {
            type: 'string[]',
            value: records.map((record) => record.output),
          },
          ['message' as PortId]: {
            type: 'chat-message[]',
            value: records.map((record) => record.message),
          },
          ['assistant-message' as PortId]: preToolMessageOutput,
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
): DelegatedToolCallRecord {
  return {
    delegatedToolCall: true,
    name: functionCall.name,
    arguments: functionCall.arguments,
    id: functionCall.id,
    output: outputString,
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
  let handler: { key: string | undefined; value: GraphId } | undefined;

  if (config.autoDelegate) {
    const graphs = Object.values(context.project.graphs);
    const matchingGraph =
      graphs.find((graph) => graph.metadata?.name === functionCall.name) ??
      graphs.find((graph) => graph.metadata?.name?.includes(functionCall.name));
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
        try {
          const externalContext = omit(context, ['setGlobal']);
          const result = await externalFunction(externalContext, functionCall.arguments ?? {});
          const outputString = stringifyToolOutput(result);

          return {
            outputString,
            message: buildToolResultMessage(functionCall, outputString),
            record: buildDelegatedToolCallRecord(functionCall, outputString),
            cost: result.cost,
          };
        } catch (error) {
          if (config.passthroughErrors) {
            const outputString = `Error: ${getError(error).message}`;

            return {
              outputString,
              message: buildToolResultMessage(functionCall, outputString),
              record: buildDelegatedToolCallRecord(functionCall, outputString),
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

  for (const [argName, argument] of Object.entries(functionCall.arguments ?? {})) {
    subgraphInputs[argName] = {
      type: 'any',
      value: argument,
    };
  }

  const subprocessor = context.createSubProcessor(handler.value, { signal: context.signal });
  const outputs = await subprocessor.processGraph(context, subgraphInputs, context.contextValues);
  const outputString = coerceTypeOptional(outputs['output' as PortId], 'string') ?? '';
  const cost = coerceTypeOptional(outputs['cost' as PortId], 'number');

  return {
    outputString,
    message: buildToolResultMessage(functionCall, outputString),
    record: buildDelegatedToolCallRecord(functionCall, outputString),
    cost,
  };
}
