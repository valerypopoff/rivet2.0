import {
  type ChatMessage,
  type ChartNode,
  type EditorDefinition,
  type Inputs,
  type InternalProcessContext,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodeUIData,
  type Outputs,
  type PluginNodeImpl,
  type PortId,
} from '../../../index.js';
import {
  streamChatCompletions,
  streamGenerativeAi,
  type GenerativeAiGoogleModel,
  generativeAiGoogleModels,
  type StreamGenerativeAiOptions,
  type ChatCompletionChunk,
  type GoogleModelsDeprecated,
  generativeAiOptions,
} from '../google.js';
import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import retry from 'p-retry';
import { match } from 'ts-pattern';
import { coerceTypeOptional } from '../../../utils/coerceType.js';
import { getError } from '../../../utils/errors.js';
import { uint8ArrayToBase64 } from '../../../utils/base64.js';
import { pluginNodeDefinition } from '../../../model/NodeDefinition.js';
import type { TokenizerCallInfo } from '../../../integrations/Tokenizer.js';
import { getInputOrData, cleanHeaders } from '../../../utils/inputs.js';
import { type Content, type FunctionDeclaration, type Part, type Tool, type FunctionCall, Type } from '@google/genai';
import { mapValues } from 'lodash-es';
import { coercePromptToChatMessages } from '../../../model/chat/chatMessages.js';
import { clampMaxTokensToModelLimit, setRequestAndResponseTokenOutputs } from '../../../model/chat/tokenBudget.js';
import { createAssistantMessagesOutput } from '../../../model/chat/streamChatResponse.js';

type JsonSchemaProperty = {
  type?: string | string[];
  description?: string;
};

type JsonSchemaFunctionParameters = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

function toGoogleSchemaType(type: string | undefined): Type | undefined {
  switch (type) {
    case 'string':
      return Type.STRING;
    case 'number':
    case 'integer':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    default:
      return undefined;
  }
}

export type ChatGoogleNode = ChartNode<'chatGoogle', ChatGoogleNodeData>;

export type ChatGoogleNodeConfigData = {
  model: GenerativeAiGoogleModel;
  temperature: number;
  useTopP: boolean;
  top_p?: number;
  top_k?: number;
  maxTokens: number;
  thinkingBudget: number | undefined;
  headers?: { key: string; value: string }[];
};

export type ChatGoogleNodeData = ChatGoogleNodeConfigData & {
  useModelInput: boolean;
  useTemperatureInput: boolean;
  useTopPInput: boolean;
  useTopKInput: boolean;
  useUseTopPInput: boolean;
  useMaxTokensInput: boolean;
  useToolCalling: boolean;
  useThinkingBudgetInput: boolean;
  useHeadersInput?: boolean;

  /** Given the same set of inputs, return the same output without hitting GPT */
  cache: boolean;

  useAsGraphPartialOutput?: boolean;
};

// Temporary
const cache = new Map<string, Outputs>();

export const ChatGoogleNodeImpl: PluginNodeImpl<ChatGoogleNode> = {
  create(): ChatGoogleNode {
    const chartNode: ChatGoogleNode = {
      type: 'chatGoogle',
      title: 'Chat (Google, Legacy)',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 275,
      },
      data: {
        model: 'gemini-2.5-flash',
        useModelInput: false,

        temperature: 0.5,
        useTemperatureInput: false,

        top_p: 1,
        useTopPInput: false,

        top_k: undefined,
        useTopKInput: false,

        useTopP: false,
        useUseTopPInput: false,

        maxTokens: 1024,
        useMaxTokensInput: false,

        cache: false,
        useAsGraphPartialOutput: true,

        useToolCalling: false,

        thinkingBudget: undefined,
        useThinkingBudgetInput: false,
      },
    };

    return chartNode;
  },

  getInputDefinitions(data): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];

    inputs.push({
      id: 'systemPrompt' as PortId,
      title: 'System Prompt',
      dataType: 'string',
      required: false,
      description: 'An optional system prompt for the model to use.',
    });

    if (data.useModelInput) {
      inputs.push({
        id: 'model' as PortId,
        title: 'Model',
        dataType: 'string',
        required: false,
      });
    }

    if (data.useTemperatureInput) {
      inputs.push({
        dataType: 'number',
        id: 'temperature' as PortId,
        title: 'Temperature',
      });
    }

    if (data.useTopPInput) {
      inputs.push({
        dataType: 'number',
        id: 'top_p' as PortId,
        title: 'Top P',
      });
    }

    if (data.useUseTopPInput) {
      inputs.push({
        dataType: 'boolean',
        id: 'useTopP' as PortId,
        title: 'Use Top P',
      });
    }

    if (data.useMaxTokensInput) {
      inputs.push({
        dataType: 'number',
        id: 'maxTokens' as PortId,
        title: 'Max Tokens',
      });
    }

    if (data.useToolCalling) {
      inputs.push({
        dataType: 'gpt-function[]',
        id: 'functions' as PortId,
        title: 'Tools',
        description: 'Tools available for the model to call.',
      });
    }

    if (data.useThinkingBudgetInput) {
      inputs.push({
        dataType: 'number',
        id: 'thinkingBudget' as PortId,
        title: 'Thinking Budget',
        description: 'The token budget for the model to think before responding.',
      });
    }

    inputs.push({
      dataType: ['chat-message', 'chat-message[]'] as const,
      id: 'prompt' as PortId,
      title: 'Prompt',
    });

    if (data.useHeadersInput) {
      inputs.push({
        dataType: 'object',
        id: 'headers' as PortId,
        title: 'Headers',
        description: 'Additional headers to send to the API.',
      });
    }

    return inputs;
  },

  getOutputDefinitions(data): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];

    outputs.push({
      dataType: 'string',
      id: 'response' as PortId,
      title: 'Response',
    });

    outputs.push({
      dataType: 'chat-message[]',
      id: 'in-messages' as PortId,
      title: 'Messages Sent',
      description: 'All messages sent to the model.',
    });

    outputs.push({
      dataType: 'chat-message[]',
      id: 'all-messages' as PortId,
      title: 'All Messages',
      description: 'All messages, with the response appended.',
    });

    if (data.useToolCalling) {
      outputs.push({
        dataType: 'object[]',
        id: 'function-calls' as PortId,
        title: 'Tool Calls',
        description: 'Tool calls made by the model.',
      });
    }

    return outputs;
  },

  getBody(data): string {
    return dedent`
      ${generativeAiGoogleModels[data.model]?.displayName ?? `Google (${data.model})`}
      ${
        data.useTopP
          ? `Top P: ${data.useTopPInput ? '(Using Input)' : data.top_p}`
          : `Temperature: ${data.useTemperatureInput ? '(Using Input)' : data.temperature}`
      }
      Max Tokens: ${data.maxTokens}
      Thinking Budget: ${data.thinkingBudget ?? 'Automatic'}
    `;
  },

  getEditors(): EditorDefinition<ChatGoogleNode>[] {
    return [
      {
        type: 'dropdown',
        label: 'Model',
        dataKey: 'model',
        useInputToggleDataKey: 'useModelInput',
        options: generativeAiOptions,
      },
      {
        type: 'number',
        label: 'Temperature',
        dataKey: 'temperature',
        useInputToggleDataKey: 'useTemperatureInput',
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        type: 'number',
        label: 'Top P',
        dataKey: 'top_p',
        useInputToggleDataKey: 'useTopPInput',
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        type: 'toggle',
        label: 'Use Top P',
        dataKey: 'useTopP',
        useInputToggleDataKey: 'useUseTopPInput',
      },
      {
        type: 'number',
        label: 'Max Tokens',
        dataKey: 'maxTokens',
        useInputToggleDataKey: 'useMaxTokensInput',
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        step: 1,
      },
      {
        type: 'number',
        label: 'Thinking Budget',
        dataKey: 'thinkingBudget',
        allowEmpty: true,
        step: 1,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        useInputToggleDataKey: 'useThinkingBudgetInput',
        helperMessage: 'The token budget for the model to think before responding. Leave blank for automatic budget.',
      },
      {
        type: 'toggle',
        label: 'Enable Tool Calling',
        dataKey: 'useToolCalling',
      },
      {
        type: 'toggle',
        label: 'Cache (same inputs, same outputs)',
        dataKey: 'cache',
      },
      {
        type: 'toggle',
        label: 'Use for subgraph partial output',
        dataKey: 'useAsGraphPartialOutput',
      },
      {
        type: 'keyValuePair',
        label: 'Headers',
        dataKey: 'headers',
        useInputToggleDataKey: 'useHeadersInput',
        keyPlaceholder: 'Header',
        helperMessage: 'Additional headers to send to the API.',
      },
    ];
  },

  getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
          Legacy Google chat node.

          For new work, prefer \`LLM Chat\`, which keeps provider selection inside one shared node.
        `,
      infoBoxTitle: 'Chat (Google) Node (Legacy)',
      contextMenuTitle: 'Chat (Google, Legacy)',
      group: ['AI'],
    };
  },

  async process(data, inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const output: Outputs = {};

    const rawModel = getInputOrData(data, inputs, 'model');
    const model = rawModel as GenerativeAiGoogleModel;

    const temperature = getInputOrData(data, inputs, 'temperature', 'number');
    const topP = getInputOrData(data, inputs, 'top_p', 'number');
    const useTopP = getInputOrData(data, inputs, 'useTopP', 'boolean');
    const thinkingBudget = getInputOrData(data, inputs, 'thinkingBudget', 'number');

    const { messages, systemPrompt } = getChatGoogleNodeMessages(inputs);

    let prompt = await Promise.all(
      messages.map(async (message): Promise<Content> => {
        if (message.type === 'user' || message.type === 'assistant') {
          const parts = await Promise.all(
            [message.message].flat().map(async (part): Promise<Part> => {
              if (typeof part === 'string') {
                return { text: part };
              } else if (part.type === 'image') {
                return {
                  inlineData: {
                    mimeType: part.mediaType,
                    data: (await uint8ArrayToBase64(part.data))!,
                  },
                };
              } else if (part.type === 'document') {
                return {
                  inlineData: {
                    mimeType: part.mediaType,
                    data: (await uint8ArrayToBase64(part.data))!,
                  },
                };
              } else {
                throw new Error(`Google Vertex AI does not support message parts of type ${part.type}`);
              }
            }),
          );

          if (message.type === 'assistant' && (message.function_calls?.length ?? 0) > 0) {
            if (parts[0]!.text === '') {
              parts.shift(); // remove empty text part
            }

            for (const call of message.function_calls ?? []) {
              parts.push({
                functionCall: {
                  name: call.name,
                  args: JSON.parse(call.arguments),
                },
              });
            }
          }

          return {
            role: match(message.type)
              .with('user', () => 'user')
              .with('assistant', () => 'model')
              .exhaustive(),
            parts,
          };
        }

        if (message.type === 'function') {
          return {
            role: 'function',
            parts: [
              {
                functionResponse: {
                  name: message.name,
                  response: {
                    result: typeof message.message === 'string' ? message.message : '',
                  },
                },
              },
            ],
          };
        }

        throw new Error('Google Vertex AI received an unsupported message type.');
      }),
    );

    // Collapse sequential function responses into a single function response with mutliple parts
    prompt = prompt.reduce((acc: Content[], message) => {
      const lastMessage = acc.at(-1);

      // Shouldn't be undefined but not sure if this is where the crash is happening...
      if (
        lastMessage &&
        message.role === 'function' &&
        lastMessage.role === 'function' &&
        lastMessage?.parts &&
        message.parts
      ) {
        lastMessage.parts.push(...message.parts);
      } else {
        acc.push(message);
      }

      return acc;
    }, [] as Content[]);

    let { maxTokens } = data;

    const tokenizerInfo: TokenizerCallInfo = {
      node: context.node,
      model,
      endpoint: undefined,
    };

    // TODO Better token counting for Google models.
    const tokenMessages: ChatMessage[] = systemPrompt
      ? [{ type: 'system', message: systemPrompt }, ...messages]
      : messages;
    const tokenCount = await context.tokenizer.getTokenCountForMessages(tokenMessages, undefined, tokenizerInfo);

    if (generativeAiGoogleModels[model]) {
      maxTokens = clampMaxTokensToModelLimit(
        output,
        model,
        tokenCount,
        maxTokens,
        generativeAiGoogleModels[model].maxTokens,
      );
    }

    const project = context.getPluginConfig('googleProjectId');
    const location = context.getPluginConfig('googleRegion');
    const applicationCredentials = context.getPluginConfig('googleApplicationCredentials');
    const apiKey = context.getPluginConfig('googleApiKey');

    let tools: Tool[] = [];

    if (data.useToolCalling) {
      const gptTools = coerceTypeOptional(inputs['functions' as PortId], 'gpt-function[]') ?? [];

      if (gptTools) {
        tools = [
          {
            functionDeclarations: gptTools.map(
              (tool): FunctionDeclaration => {
                const parameters = tool.parameters as JsonSchemaFunctionParameters;

                return {
                  name: tool.name,
                  description: tool.description,
                  parameters:
                    Object.keys(parameters.properties ?? {}).length === 0
                      ? undefined
                      : {
                          type: Type.OBJECT,
                          properties: mapValues(parameters.properties ?? {}, (property) => ({
                            // gemini doesn't support union property types, it uses openapi style not jsonschema, what a mess
                            type: toGoogleSchemaType(
                              Array.isArray(property.type) ? property.type.find((type) => type !== 'null') : property.type,
                            ),
                            description: property.description,
                          })),
                          required: parameters.required ?? [],
                        },
                };
              },
            ),
          },
        ];
      }
    }

    if (!apiKey) {
      if (project == null) {
        throw new Error('Google Project ID or Google API Key is not defined.');
      }
      if (location == null) {
        throw new Error('Google Region or Google API Key is not defined.');
      }
      if (applicationCredentials == null) {
        throw new Error('Google Application Credentials or Google API Key is not defined.');
      }
    }

    const headersFromData = (data.headers ?? []).reduce(
      (acc, header) => {
        acc[header.key] = header.value;
        return acc;
      },
      {} as Record<string, string>,
    );
    const additionalHeaders = data.useHeadersInput
      ? (coerceTypeOptional(inputs['headers' as PortId], 'object') as Record<string, string> | undefined) ??
        headersFromData
      : headersFromData;

    const allAdditionalHeaders = cleanHeaders({
      ...context.settings.chatNodeHeaders,
      ...additionalHeaders,
    });

    try {
      return await retry(
        async () => {
          const options: Omit<StreamGenerativeAiOptions, 'apiKey' | 'signal'> = {
            prompt,
            model,
            temperature: useTopP ? undefined : temperature,
            topP: useTopP ? topP : undefined,
            maxOutputTokens: maxTokens,
            systemPrompt,
            topK: undefined,
            tools,
            thinkingBudget,
            additionalHeaders: allAdditionalHeaders,
          };
          const cacheKey = JSON.stringify(options);

          if (data.cache) {
            const cached = cache.get(cacheKey);
            if (cached) {
              return cached;
            }
          }

          const startTime = Date.now();

          let chunks: AsyncGenerator<ChatCompletionChunk>;

          if (data.useToolCalling && !apiKey) {
            throw new Error('Tool calling is only supported when using a generative API key.');
          }

          if (apiKey) {
            chunks = streamGenerativeAi({
              signal: context.signal,
              model,
              prompt,
              maxOutputTokens: maxTokens,
              temperature: useTopP ? undefined : temperature,
              topP: useTopP ? topP : undefined,
              topK: undefined,
              apiKey,
              systemPrompt,
              tools,
              thinkingBudget,
              additionalHeaders: allAdditionalHeaders,
            });
          } else {
            chunks = streamChatCompletions({
              signal: context.signal,
              model: model as GoogleModelsDeprecated,
              prompt,
              max_output_tokens: maxTokens,
              temperature: useTopP ? undefined : temperature,
              top_p: useTopP ? topP : undefined,
              top_k: undefined,
              project: project!,
              location: location!,
              applicationCredentials: applicationCredentials!,
            });
          }

          const responseParts: string[] = [];
          const functionCalls: FunctionCall[] = [];

          let throttleLastCalledTime = Date.now();
          const onPartialOutput = (output: Outputs) => {
            const now = Date.now();
            if (now - throttleLastCalledTime > (context.settings.throttleChatNode ?? 100)) {
              context.onPartialOutputs?.(output);
              throttleLastCalledTime = now;
            }
          };

          for await (const chunk of chunks) {
            if (chunk.completion) {
              responseParts.push(chunk.completion);

              output['response' as PortId] = {
                type: 'string',
                value: responseParts.join('').trim(),
              };
            }

            if (chunk.function_calls) {
              functionCalls.push(...chunk.function_calls);

              output['function-calls' as PortId] = {
                type: 'object[]',
                value: functionCalls.map((fc) => ({
                  id: fc.name,
                  name: fc.name,
                  arguments: fc.args,
                })),
              };
            }

            onPartialOutput?.(output);
          }

          // Call one last time manually to ensure the last output is sent
          context.onPartialOutputs?.(output);

          const endTime = Date.now();

          output['all-messages' as PortId] = createAssistantMessagesOutput(
            messages,
            responseParts.join('').trim() ?? '',
            functionCalls.length === 0
              ? undefined
              : functionCalls.map((fc) => ({
                  type: 'function' as const,
                  id: fc.name!,
                  name: fc.name!,
                  arguments: JSON.stringify(fc.args),
                })),
            { functionCallMode: 'never' },
          );

          output['in-messages' as PortId] = {
            type: 'chat-message[]',
            value: messages,
          };

          if (responseParts.length === 0 && functionCalls.length === 0) {
            throw new Error('No response from Google');
          }

          const responseTokenCount = await context.tokenizer.getTokenCountForString(
            responseParts.join(''),
            tokenizerInfo,
          );
          setRequestAndResponseTokenOutputs(output, tokenCount, responseTokenCount);

          // TODO
          // const cost =
          //   getCostForPrompt(completionMessages, model) + getCostForTokens(responseTokenCount, 'completion', model);

          // output['cost' as PortId] = { type: 'number', value: cost };

          const duration = endTime - startTime;

          output['duration' as PortId] = { type: 'number', value: duration };

          Object.freeze(output);
          cache.set(cacheKey, output);

          return output;
        },
        {
          retries: 10,
          maxRetryTime: 1000 * 60 * 5,
          factor: 2.5,
          minTimeout: 500,
          maxTimeout: 5000,
          randomize: true,
          signal: context.signal,
          onFailedAttempt(err) {
            context.trace(`ChatGoogleNode failed, retrying: ${err.toString()}`);

            const googleError = err as { status?: number; message?: string };

            if (googleError.status && googleError.status >= 400 && googleError.status < 500) {
              if (googleError.status === 429) {
                context.trace('Google API rate limit exceeded, retrying...');
              } else {
                throw new Error(`Google API error: ${googleError.status} ${googleError.message}`);
              }
            }

            if (context.signal.aborted) {
              throw new Error('Aborted');
            }
          },
        },
      );
    } catch (error) {
      const raisedError = getError(error);
      context.trace(raisedError.stack ?? 'Missing stack');
      const err = new Error(`Error processing ChatGoogleNode: ${raisedError.message}`);
      err.cause = raisedError;
      throw err;
    }
  },
};

export const chatGoogleNode = pluginNodeDefinition(ChatGoogleNodeImpl, 'Chat (Google, Legacy)');

export function getChatGoogleNodeMessages(inputs: Inputs) {
  const promptMessages = coercePromptToChatMessages(inputs['prompt' as PortId], { requirePrompt: true });
  const instructionMessages = promptMessages.filter(
    (message) => message.type === 'system' || message.type === 'developer',
  );
  const systemPromptParts = [
    coerceTypeOptional(inputs['systemPrompt' as PortId], 'string'),
    ...instructionMessages.map((message) => coerceTypeOptional({ type: 'chat-message', value: message }, 'string')),
  ].filter((part): part is string => !!part);

  return {
    messages: promptMessages.filter((message) => message.type !== 'system' && message.type !== 'developer'),
    systemPrompt: systemPromptParts.length > 0 ? systemPromptParts.join('\n\n') : undefined,
  };
}
