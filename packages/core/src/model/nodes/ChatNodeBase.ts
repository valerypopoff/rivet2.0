import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getError } from '../../utils/errors.js';
import { dedent } from '../../utils/misc.js';
import {
  OpenAIError,
  openAiModelOptions,
  openaiModels,
  type ChatCompletionOptions,
  chatCompletions,
  streamChatCompletions,
  defaultOpenaiSupported,
  type OpenAIModel,
} from '../../utils/openai.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { ChartNode, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import type { ChatNode } from './ChatNode.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import { cleanHeaders, getInputOrData } from '../../utils/inputs.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { chatMessageToOpenAIChatCompletionMessage } from '../../utils/chatMessageToOpenAIChatCompletionMessage.js';
import { DEFAULT_CHAT_ENDPOINT } from '../../utils/defaults.js';
import type { TokenizerCallInfo } from '../../integrations/Tokenizer.js';
import retry from 'p-retry';
import {
  resolveAdditionalHeaders,
  resolveAdditionalParameters,
  resolveAudioAndModalities,
  resolveChatToolChoice,
  resolveChatTools,
  resolveOpenAIResponseFormat,
  resolvePredictionObject,
} from '../chat/openAIChatRequest.js';
import { coercePromptToChatMessages, prependSystemPrompt } from '../chat/chatMessages.js';
import { clampMaxTokensToModelLimit } from '../chat/tokenBudget.js';
import {
  applyOpenAINonStreamingResponse,
  applyOpenAIStreamingResponse,
  handleOpenAIRetryableFailure,
} from '../chat/openAIChatRuntime.js';

export type ChatNodeConfigData = {
  model: string;
  temperature: number;
  useTopP: boolean;
  top_p?: number;
  maxTokens: number;
  stop?: string;
  presencePenalty?: number;
  frequencyPenalty?: number;
  enableFunctionUse?: boolean;
  user?: string;
  numberOfChoices?: number;
  endpoint?: string;
  overrideModel?: string;
  overrideMaxTokens?: number;
  headers?: { key: string; value: string }[];
  seed?: number;
  toolChoice?: 'none' | 'auto' | 'function';
  toolChoiceFunction?: string;
  responseFormat?: '' | 'text' | 'json' | 'json_schema';
  parallelFunctionCalling?: boolean;
  additionalParameters?: { key: string; value: string }[];
  responseSchemaName?: string;
  useServerTokenCalculation?: boolean;
  outputUsage?: boolean;
  usePredictedOutput?: boolean;
  reasoningEffort?: '' | 'low' | 'medium' | 'high';

  modalitiesIncludeText?: boolean;
  modalitiesIncludeAudio?: boolean;

  audioVoice?: string;
  audioFormat?: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';

  systemPromptMode?: 'developer' | 'system';
  reasoningMode?: 'non-reasoning' | 'reasoning';
};

export type ChatNodeData = ChatNodeConfigData & {
  useModelInput: boolean;
  useTemperatureInput: boolean;
  useTopPInput: boolean;
  useTopP: boolean;
  useUseTopPInput: boolean;
  useMaxTokensInput: boolean;
  useStop: boolean;
  useStopInput: boolean;
  usePresencePenaltyInput: boolean;
  useFrequencyPenaltyInput: boolean;
  useUserInput?: boolean;
  useNumberOfChoicesInput?: boolean;
  useEndpointInput?: boolean;
  useHeadersInput?: boolean;
  useSeedInput?: boolean;
  useToolChoiceInput?: boolean;
  useToolChoiceFunctionInput?: boolean;
  useResponseFormatInput?: boolean;
  useAdditionalParametersInput?: boolean;
  useResponseSchemaNameInput?: boolean;
  useAudioVoiceInput?: boolean;
  useAudioFormatInput?: boolean;
  useReasoningEffortInput?: boolean;
  /** Given the same set of inputs, return the same output without hitting GPT */
  cache: boolean;

  useAsGraphPartialOutput?: boolean;
};

// Temporary
const cache = new Map<string, Outputs>();

export const ChatNodeBase = {
  defaultData: (): ChatNodeData => ({
    model: 'gpt-5',
    useModelInput: false,
    temperature: 0.5,
    useTemperatureInput: false,
    top_p: 1,
    useTopPInput: false,
    useTopP: false,
    useUseTopPInput: false,
    maxTokens: 1024,
    useMaxTokensInput: false,
    useStop: false,
    stop: '',
    useStopInput: false,
    presencePenalty: undefined,
    usePresencePenaltyInput: false,
    frequencyPenalty: undefined,
    useFrequencyPenaltyInput: false,
    user: undefined,
    useUserInput: false,
    enableFunctionUse: false,
    cache: false,
    useAsGraphPartialOutput: true,
    parallelFunctionCalling: true,
    additionalParameters: [],
    useAdditionalParametersInput: false,
    useServerTokenCalculation: true,
    outputUsage: false,
    usePredictedOutput: false,
    modalitiesIncludeAudio: false,
    modalitiesIncludeText: false,
    reasoningEffort: '',
    useReasoningEffortInput: false,
  }),

  getInputDefinitions: (data: ChatNodeData): NodeInputDefinition[] => {
    const inputs: NodeInputDefinition[] = [];

    if (data.useEndpointInput) {
      inputs.push({
        dataType: 'string',
        id: 'endpoint' as PortId,
        title: 'Endpoint',
        description:
          'The endpoint to use for the OpenAI API. You can use this to replace with any OpenAI-compatible API. Leave blank for the default: https://api.openai.com/api/v1/chat/completions',
      });
    }

    inputs.push({
      id: 'systemPrompt' as PortId,
      title: 'System Prompt',
      dataType: 'string',
      required: false,
      description: 'The system prompt to send to the model.',
      coerced: true,
    });

    if (data.useModelInput) {
      inputs.push({
        id: 'model' as PortId,
        title: 'Model',
        dataType: 'string',
        required: false,
        description: 'The model to use for the chat.',
      });
    }

    if (data.useTemperatureInput) {
      inputs.push({
        dataType: 'number',
        id: 'temperature' as PortId,
        title: 'Temperature',
        description:
          'What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.',
      });
    }

    if (data.useTopPInput) {
      inputs.push({
        dataType: 'number',
        id: 'top_p' as PortId,
        title: 'Top P',
        description:
          'An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.',
      });
    }

    if (data.useUseTopPInput) {
      inputs.push({
        dataType: 'boolean',
        id: 'useTopP' as PortId,
        title: 'Use Top P',
        description: 'Whether to use top p sampling, or temperature sampling.',
      });
    }

    if (data.useMaxTokensInput) {
      inputs.push({
        dataType: 'number',
        id: 'maxTokens' as PortId,
        title: 'Max Tokens',
        description: 'The maximum number of tokens to generate in the chat completion.',
      });
    }

    if (data.useStopInput) {
      inputs.push({
        dataType: 'string',
        id: 'stop' as PortId,
        title: 'Stop',
        description: 'A sequence where the API will stop generating further tokens.',
      });
    }

    if (data.usePresencePenaltyInput) {
      inputs.push({
        dataType: 'number',
        id: 'presencePenalty' as PortId,
        title: 'Presence Penalty',
        description: `Number between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.`,
      });
    }

    if (data.useFrequencyPenaltyInput) {
      inputs.push({
        dataType: 'number',
        id: 'frequencyPenalty' as PortId,
        title: 'Frequency Penalty',
        description: `Number between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim.`,
      });
    }

    if (data.useUserInput) {
      inputs.push({
        dataType: 'string',
        id: 'user' as PortId,
        title: 'User',
        description:
          'A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse.',
      });
    }

    if (data.useNumberOfChoicesInput) {
      inputs.push({
        dataType: 'number',
        id: 'numberOfChoices' as PortId,
        title: 'Number of Choices',
        description: 'If greater than 1, the model will return multiple choices and the response will be an array.',
      });
    }

    if (data.useHeadersInput) {
      inputs.push({
        dataType: 'object',
        id: 'headers' as PortId,
        title: 'Headers',
        description: 'Additional headers to send to the API.',
      });
    }

    inputs.push({
      dataType: ['chat-message', 'chat-message[]'] as const,
      id: 'prompt' as PortId,
      title: 'Prompt',
      description: 'The prompt message or messages to send to the model.',
      coerced: true,
    });

    if (data.enableFunctionUse) {
      inputs.push({
        dataType: ['gpt-function', 'gpt-function[]'] as const,
        id: 'functions' as PortId,
        title: 'Functions',
        description: 'Functions to use in the model. To connect multiple functions, use an Array node.',
        coerced: false,
      });
    }

    if (data.useSeedInput) {
      inputs.push({
        dataType: 'number',
        id: 'seed' as PortId,
        title: 'Seed',
        coerced: true,
        description:
          'If specified, OpenAI will make a best effort to sample deterministically, such that repeated requests with the same `seed` and parameters should return the same result.',
      });
    }

    if (data.useToolChoiceInput) {
      inputs.push({
        dataType: 'string',
        id: 'toolChoice' as PortId,
        title: 'Tool Choice',
        coerced: true,
        description:
          'Controls which (if any) function is called by the model. `none` is the default when no functions are present. `auto` is the default if functions are present. `function` forces the model to call a function.',
      });
    }

    if (data.useToolChoiceInput || data.useToolChoiceFunctionInput) {
      inputs.push({
        dataType: 'string',
        id: 'toolChoiceFunction' as PortId,
        title: 'Tool Choice Function',
        coerced: true,
        description: 'The name of the function to force the model to call.',
      });
    }

    if (data.useResponseFormatInput) {
      inputs.push({
        dataType: 'string',
        id: 'responseFormat' as PortId,
        title: 'Response Format',
        coerced: true,
        description: 'The format to force the model to reply in.',
      });
    }

    if (data.useAdditionalParametersInput) {
      inputs.push({
        dataType: 'object',
        id: 'additionalParameters' as PortId,
        title: 'Additional Parameters',
        description: 'Additional chat completion parameters to send to the API.',
      });
    }

    if (data.responseFormat === 'json_schema') {
      inputs.push({
        dataType: 'object',
        id: 'responseSchema' as PortId,
        title: 'Response Schema',
        description: 'The JSON schema that the response will adhere to (Structured Outputs).',
        required: true,
      });

      if (data.useResponseSchemaNameInput) {
        inputs.push({
          dataType: 'string',
          id: 'responseSchemaName' as PortId,
          title: 'Response Schema Name',
          description: 'The name of the JSON schema that the response will adhere to (Structured Outputs).',
          required: false,
        });
      }
    }

    if (data.usePredictedOutput) {
      inputs.push({
        dataType: 'string[]',
        id: 'predictedOutput' as PortId,
        title: 'Predicted Output',
        description: 'The predicted output from the model.',
        coerced: true,
      });
    }

    if (data.useAudioVoiceInput) {
      inputs.push({
        dataType: 'string',
        id: 'audioVoice' as PortId,
        title: 'Audio Voice',
        description: 'The voice to use for audio responses. See your model for supported voices.',
      });
    }

    if (data.useAudioFormatInput) {
      inputs.push({
        dataType: 'string',
        id: 'audioFormat' as PortId,
        title: 'Audio Format',
        description: 'The format to use for audio responses.',
      });
    }

    return inputs;
  },

  getOutputDefinitions: (data: ChatNodeData): NodeInputDefinition[] => {
    const outputs: NodeOutputDefinition[] = [];

    if (data.useNumberOfChoicesInput || (data.numberOfChoices ?? 1) > 1) {
      outputs.push({
        dataType: 'string[]',
        id: 'response' as PortId,
        title: 'Responses',
        description: 'All responses from the model.',
      });
    } else {
      outputs.push({
        dataType: 'string',
        id: 'response' as PortId,
        title: 'Response',
        description: 'The textual response from the model.',
      });
    }

    if (data.enableFunctionUse) {
      if (data.parallelFunctionCalling) {
        outputs.push({
          dataType: 'object[]',
          id: 'function-calls' as PortId,
          title: 'Function Calls',
          description: 'The function calls that were made, if any.',
        });
      } else {
        outputs.push({
          dataType: 'object',
          id: 'function-call' as PortId,
          title: 'Function Call',
          description: 'The function call that was made, if any.',
        });
      }
    }

    outputs.push({
      dataType: 'chat-message[]',
      id: 'in-messages' as PortId,
      title: 'Messages Sent',
      description: 'All messages sent to the model.',
    });

    if (!(data.useNumberOfChoicesInput || (data.numberOfChoices ?? 1) > 1)) {
      outputs.push({
        dataType: 'chat-message[]',
        id: 'all-messages' as PortId,
        title: 'All Messages',
        description: 'All messages, with the response appended.',
      });
    }

    outputs.push({
      dataType: 'number',
      id: 'responseTokens' as PortId,
      title: 'Response Tokens',
      description: 'The number of tokens in the response from the LLM. For a multi-response, this is the sum.',
    });

    if (data.outputUsage) {
      outputs.push({
        dataType: 'object',
        id: 'usage' as PortId,
        title: 'Usage',
        description: 'Usage statistics for the model.',
      });
    }

    if (data.modalitiesIncludeAudio) {
      outputs.push({
        dataType: 'audio',
        id: 'audio' as PortId,
        title: 'Audio',
        description: 'The audio response from the model.',
      });

      outputs.push({
        dataType: 'string',
        id: 'audioTranscript' as PortId,
        title: 'Transcript',
        description: 'The transcript of the audio response.',
      });
    }

    return outputs;
  },

  getEditors: (): EditorDefinition<ChatNode>[] => {
    return [
      {
        type: 'dropdown',
        label: 'GPT Model',
        dataKey: 'model',
        useInputToggleDataKey: 'useModelInput',
        options: openAiModelOptions,
        disableIf: (data) => {
          return !!data.overrideModel?.trim();
        },
        helperMessage: (data) => {
          if (data.overrideModel?.trim()) {
            return `Model overridden to: ${data.overrideModel}`;
          }
          if (data.model === 'local-model') {
            return 'Local model is an indicator for your own convenience, it does not affect the local LLM used.';
          }
        },
      },
      {
        type: 'group',
        label: 'Parameters',
        editors: [
          {
            type: 'number',
            label: 'Temperature',
            dataKey: 'temperature',
            useInputToggleDataKey: 'useTemperatureInput',
            min: 0,
            max: 2,
            step: 0.1,
            helperMessage:
              'What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.',
          },
          {
            type: 'number',
            label: 'Top P',
            dataKey: 'top_p',
            useInputToggleDataKey: 'useTopPInput',
            min: 0,
            max: 1,
            step: 0.1,
            helperMessage:
              'An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.',
          },
          {
            type: 'toggle',
            label: 'Use Top P',
            dataKey: 'useTopP',
            useInputToggleDataKey: 'useUseTopPInput',
            helperMessage: 'Whether to use top p sampling, or temperature sampling.',
          },
          {
            type: 'number',
            label: 'Max Tokens',
            dataKey: 'maxTokens',
            useInputToggleDataKey: 'useMaxTokensInput',
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            step: 1,
            helperMessage: 'The maximum number of tokens to generate in the chat completion.',
          },
          {
            type: 'string',
            label: 'Stop',
            dataKey: 'stop',
            useInputToggleDataKey: 'useStopInput',
            helperMessage: 'A sequence where the API will stop generating further tokens.',
          },
          {
            type: 'number',
            label: 'Presence Penalty',
            dataKey: 'presencePenalty',
            useInputToggleDataKey: 'usePresencePenaltyInput',
            min: 0,
            max: 2,
            step: 0.1,
            allowEmpty: true,
            helperMessage: `Number between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.`,
          },
          {
            type: 'number',
            label: 'Frequency Penalty',
            dataKey: 'frequencyPenalty',
            useInputToggleDataKey: 'useFrequencyPenaltyInput',
            min: 0,
            max: 2,
            step: 0.1,
            allowEmpty: true,
            helperMessage: `Number between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim.`,
          },
          {
            type: 'dropdown',
            label: 'Reasoning Effort',
            dataKey: 'reasoningEffort',
            useInputToggleDataKey: 'useReasoningEffortInput',
            options: [
              { value: '', label: 'Unset' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
            defaultValue: '',
            helperMessage:
              'Adjust the level of reasoning depth the model should apply. Only applies to reasoning models such as o3-mini.',
          },
          {
            type: 'dropdown',
            label: 'Response Format',
            dataKey: 'responseFormat',
            useInputToggleDataKey: 'useResponseFormatInput',
            options: [
              { value: '', label: 'Default' },
              { value: 'text', label: 'Text' },
              { value: 'json', label: 'JSON Object' },
              { value: 'json_schema', label: 'JSON Schema' },
            ],
            defaultValue: '',
            helperMessage: 'The format to force the model to reply in.',
          },
          {
            type: 'string',
            label: 'Response Schema Name',
            dataKey: 'responseSchemaName',
            useInputToggleDataKey: 'useResponseSchemaNameInput',
            helperMessage:
              'The name of the JSON schema that the response will adhere to (Structured Outputs). Defaults to response_schema',
            hideIf: (data) => data.responseFormat !== 'json_schema',
          },
          {
            type: 'number',
            label: 'Seed',
            dataKey: 'seed',
            useInputToggleDataKey: 'useSeedInput',
            step: 1,
            allowEmpty: true,
            helperMessage:
              'If specified, OpenAI will make a best effort to sample deterministically, such that repeated requests with the same `seed` and parameters should return the same result.',
          },
        ],
      },
      {
        type: 'group',
        label: 'GPT Tools',
        editors: [
          {
            type: 'toggle',
            label: 'Enable Function Use',
            dataKey: 'enableFunctionUse',
          },
          {
            type: 'toggle',
            label: 'Enable Parallel Function Calling',
            dataKey: 'parallelFunctionCalling',
            hideIf: (data) => !data.enableFunctionUse,
          },
          {
            type: 'dropdown',
            label: 'Tool Choice',
            dataKey: 'toolChoice',
            useInputToggleDataKey: 'useToolChoiceInput',
            options: [
              { value: '', label: 'Default' },
              { value: 'none', label: 'None' },
              { value: 'auto', label: 'Auto' },
              { value: 'function', label: 'Function' },
              { value: 'required', label: 'Required' },
            ],
            defaultValue: '',
            helperMessage:
              'Controls which (if any) function is called by the model. None is the default when no functions are present. Auto is the default if functions are present.',
            hideIf: (data) => !data.enableFunctionUse,
          },
          {
            type: 'string',
            label: 'Tool Choice Function',
            dataKey: 'toolChoiceFunction',
            useInputToggleDataKey: 'useToolChoiceFunctionInput',
            helperMessage: 'The name of the function to force the model to call.',
            hideIf: (data) => data.toolChoice !== 'function' || !data.enableFunctionUse,
          },
        ],
      },
      {
        type: 'group',
        label: 'Features',
        editors: [
          {
            type: 'toggle',
            label: 'Enable Predicted Output',
            dataKey: 'usePredictedOutput',
            helperMessage:
              'If on, enables an input port for the predicted output from the model, when many of the output tokens are known ahead of time.',
          },
          {
            type: 'toggle',
            label: 'Modalities: Text',
            dataKey: 'modalitiesIncludeText',
            helperMessage: 'If on, the model will include text in its responses. Only relevant for multimodal models.',
          },
          {
            type: 'toggle',
            label: 'Modalities: Audio',
            dataKey: 'modalitiesIncludeAudio',
            helperMessage: 'If on, the model will include audio in its responses. Only relevant for multimodal models.',
          },
          {
            type: 'string',
            label: 'Audio Voice',
            dataKey: 'audioVoice',
            useInputToggleDataKey: 'useAudioVoiceInput',
            helperMessage:
              'The voice to use for audio responses. See your model for supported voices. OpenAI voices are: alloy, ash, coral, echo, fable, onyx, nova, sage, and shimmer.',
            hideIf: (data) => !data.modalitiesIncludeAudio,
          },
          {
            type: 'dropdown',
            label: 'Audio Format',
            dataKey: 'audioFormat',
            useInputToggleDataKey: 'useAudioFormatInput',
            options: [
              { value: 'wav', label: 'WAV' },
              { value: 'mp3', label: 'MP3' },
              { value: 'flac', label: 'FLAC' },
              { value: 'opus', label: 'OPUS' },
              { value: 'pcm16', label: 'PCM16' },
            ],
            defaultValue: 'wav',
            hideIf: (data) => !data.modalitiesIncludeAudio,
          },
        ],
      },
      {
        type: 'group',
        label: 'Advanced',
        editors: [
          {
            type: 'toggle',
            label: 'Use Server Token Calculation',
            dataKey: 'useServerTokenCalculation',
            helperMessage:
              'If on, do not calculate token counts on the client side, and rely on the server providing the token count.',
          },
          {
            type: 'toggle',
            label: 'Output Usage Statistics',
            dataKey: 'outputUsage',
            helperMessage: 'If on, output usage statistics for the model, such as token counts and cost.',
          },
          {
            type: 'string',
            label: 'User',
            dataKey: 'user',
            useInputToggleDataKey: 'useUserInput',
            helperMessage:
              'A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse.',
          },
          {
            type: 'number',
            label: 'Number of Choices',
            dataKey: 'numberOfChoices',
            useInputToggleDataKey: 'useNumberOfChoicesInput',
            min: 1,
            max: 10,
            step: 1,
            defaultValue: 1,
            helperMessage:
              'If greater than 1, the model will return multiple choices and the response will be an array.',
          },
          {
            type: 'string',
            label: 'Endpoint',
            dataKey: 'endpoint',
            useInputToggleDataKey: 'useEndpointInput',
            helperMessage:
              'The endpoint to use for the OpenAI API. You can use this to replace with any OpenAI-compatible API. Leave blank for the default: https://api.openai.com/api/v1/chat/completions',
          },
          {
            type: 'string',
            label: 'Custom Model',
            dataKey: 'overrideModel',
            helperMessage: 'Overrides the model selected above with a custom string for the model.',
          },
          {
            type: 'number',
            label: 'Custom Max Tokens',
            dataKey: 'overrideMaxTokens',
            allowEmpty: true,
            helperMessage:
              'Overrides the max number of tokens a model can support. Leave blank for preconfigured token limits.',
          },
          {
            type: 'dropdown',
            label: 'System Prompt Mode',
            dataKey: 'systemPromptMode',
            options: [
              { value: '', label: 'Auto' },
              { value: 'developer', label: 'Developer Mode' },
              { value: 'system', label: 'System Mode' },
            ],
            defaultValue: '',
            helperMessage: 'Should system prompt messages be sent as `developer` messages or `system` messages?',
          },
          {
            type: 'dropdown',
            label: 'Reasoning Mode',
            dataKey: 'reasoningMode',
            options: [
              { value: '', label: 'Auto' },
              { value: 'non-reasoning', label: 'Non-Reasoning Mode' },
              { value: 'reasoning', label: 'Reasoning Mode' },
            ],
            defaultValue: '',
            helperMessage:
              'Use a reasoning model with max_completion_tokens and max_reasoning_tokens instead of max_tokens.',
          },
          {
            type: 'keyValuePair',
            label: 'Headers',
            dataKey: 'headers',
            useInputToggleDataKey: 'useHeadersInput',
            keyPlaceholder: 'Header',
            helperMessage: 'Additional headers to send to the API.',
          },
          {
            type: 'toggle',
            label: 'Cache In Rivet',
            dataKey: 'cache',
            helperMessage:
              'If on, requests with the same parameters and messages will be cached in Rivet, for immediate responses without an API call.',
          },
          {
            type: 'toggle',
            label: 'Use for subgraph partial output',
            dataKey: 'useAsGraphPartialOutput',
            helperMessage:
              'If on, streaming responses from this node will be shown in Subgraph nodes that call this graph.',
          },
          {
            type: 'keyValuePair',
            label: 'Additional Parameters',
            dataKey: 'additionalParameters',
            useInputToggleDataKey: 'useAdditionalParametersInput',
            keyPlaceholder: 'Parameter',
            valuePlaceholder: 'Value',
            helperMessage:
              'Additional chat completion parameters to send to the API. If the value appears to be a number, it will be sent as a number.',
          },
        ],
      },
    ];
  },

  getBody: (data: ChatNodeData): string | undefined => {
    return dedent`
      ${data.endpoint ? `${data.endpoint}` : ''}
      ${data.useMaxTokensInput ? 'Max Tokens: (Using Input)' : `${data.maxTokens} tokens`}
      Model: ${data.useModelInput ? '(Using Input)' : data.overrideModel || data.model}
      ${data.useTopP ? 'Top P' : 'Temperature'}:
      ${
        data.useTopP
          ? data.useTopPInput
            ? '(Using Input)'
            : data.top_p
          : data.useTemperatureInput
            ? '(Using Input)'
            : data.temperature
      }
      ${data.useStop ? `Stop: ${data.useStopInput ? '(Using Input)' : data.stop}` : ''}
      ${
        (data.frequencyPenalty ?? 0) !== 0
          ? `Frequency Penalty: ${data.useFrequencyPenaltyInput ? '(Using Input)' : data.frequencyPenalty}`
          : ''
      }
      ${
        (data.presencePenalty ?? 0) !== 0
          ? `Presence Penalty: ${data.usePresencePenaltyInput ? '(Using Input)' : data.presencePenalty}`
          : ''
      }
    `.trim();
  },

  process: async (
    data: ChatNodeData,
    node: ChartNode,
    inputs: Inputs,
    context: InternalProcessContext,
  ): Promise<Outputs> => {
    const output: Outputs = {};

    const model = getInputOrData(data, inputs, 'model');
    const temperature = getInputOrData(data, inputs, 'temperature', 'number');

    const topP = data.useTopPInput ? coerceTypeOptional(inputs['top_p' as PortId], 'number') ?? data.top_p : data.top_p;

    const useTopP = getInputOrData(data, inputs, 'useTopP', 'boolean');
    const stop = data.useStopInput
      ? data.useStop
        ? coerceTypeOptional(inputs['stop' as PortId], 'string') ?? data.stop
        : undefined
      : data.stop;

    const presencePenalty = getInputOrData(data, inputs, 'presencePenalty', 'number');
    const frequencyPenalty = getInputOrData(data, inputs, 'frequencyPenalty', 'number');
    const numberOfChoices = getInputOrData(data, inputs, 'numberOfChoices', 'number');
    const endpoint = getInputOrData(data, inputs, 'endpoint');
    const overrideModel = getInputOrData(data, inputs, 'overrideModel');
    const seed = getInputOrData(data, inputs, 'seed', 'number');
    const parallelFunctionCalling = getInputOrData(data, inputs, 'parallelFunctionCalling', 'boolean');
    const toolChoice = resolveChatToolChoice(data, inputs);
    const openaiResponseFormat = resolveOpenAIResponseFormat(data, inputs);
    const additionalHeaders = resolveAdditionalHeaders(data, inputs);
    const additionalParameters = resolveAdditionalParameters(data, inputs);

    // If using a model input, that's priority, otherwise override > main
    const finalModel = data.useModelInput && inputs['model' as PortId] != null ? model : overrideModel || model;

    const functions = coerceTypeOptional(inputs['functions' as PortId], 'gpt-function[]');
    const tools = resolveChatTools(inputs);

    const { messages } = getChatNodeMessages(inputs);

    const isModernModel =
      finalModel.startsWith('o1') ||
      finalModel.startsWith('o3') ||
      finalModel.startsWith('o4') ||
      finalModel.startsWith('gpt-5');

    let isReasoningModel = false;
    if (data.reasoningMode === 'reasoning') {
      isReasoningModel = true;
    } else if (!data.reasoningMode && isModernModel) {
      isReasoningModel = true;
    }

    let useDeveloperPrompts = false;
    if (data.systemPromptMode === 'developer') {
      useDeveloperPrompts = true;
    } else if (!data.systemPromptMode && isModernModel) {
      useDeveloperPrompts = true;
    }

    const completionMessages = await Promise.all(
      messages.map((message) => chatMessageToOpenAIChatCompletionMessage(message, { useDeveloperPrompts })),
    );

    let { maxTokens } = data;

    const openaiModel = {
      ...(openaiModels[finalModel as keyof typeof openaiModels] ?? {
        maxTokens: data.overrideMaxTokens ?? 8192,
        cost: {
          completion: 0,
          prompt: 0,
        },
        displayName: 'Custom Model',
      }),
    };

    if (data.overrideMaxTokens) {
      openaiModel.maxTokens = data.overrideMaxTokens;
    }

    const isMultiResponse = data.useNumberOfChoicesInput || (data.numberOfChoices ?? 1) > 1;

    // Resolve to final endpoint if configured in ProcessContext
    const configuredEndpoint = endpoint || context.settings.openAiEndpoint || DEFAULT_CHAT_ENDPOINT;
    const resolvedEndpointAndHeaders = context.getChatNodeEndpoint
      ? await context.getChatNodeEndpoint(configuredEndpoint, finalModel)
      : {
          endpoint: configuredEndpoint,
          headers: {},
        };

    const allAdditionalHeaders = cleanHeaders({
      ...context.settings.chatNodeHeaders,
      ...additionalHeaders,
      ...resolvedEndpointAndHeaders.headers,
    });

    let inputTokenCount: number = 0;

    const tokenizerInfo: TokenizerCallInfo = {
      node,
      model: finalModel,
      endpoint: resolvedEndpointAndHeaders.endpoint,
    };

    if (!data.useServerTokenCalculation) {
      inputTokenCount = await context.tokenizer.getTokenCountForMessages(messages, functions, tokenizerInfo);

      maxTokens = clampMaxTokensToModelLimit(output, model, inputTokenCount, maxTokens, openaiModel.maxTokens);
    }

    const predictionObject = resolvePredictionObject(data, inputs);
    const { modalities, audio } = resolveAudioAndModalities(data, inputs);

    const reasoningEffort = getInputOrData(data, inputs, 'reasoningEffort') as '' | 'low' | 'medium' | 'high';

    const supported =
      (openaiModels[finalModel as keyof typeof openaiModels] as OpenAIModel | undefined)?.supported ??
      defaultOpenaiSupported;

    try {
      return await retry(
        async () => {
          const options: Omit<ChatCompletionOptions, 'auth' | 'signal'> = {
            messages: completionMessages,
            model: finalModel,
            top_p: useTopP ? topP : undefined,
            n: numberOfChoices,
            frequency_penalty: frequencyPenalty,
            presence_penalty: presencePenalty,
            stop: stop || undefined,
            tools: tools.length > 0 ? tools : undefined,
            endpoint: resolvedEndpointAndHeaders.endpoint,
            seed,
            response_format: openaiResponseFormat,
            tool_choice: toolChoice,
            parallel_tool_calls:
              tools.length > 0 && supported.parallelFunctionCalls ? parallelFunctionCalling : undefined,
            prediction: predictionObject,
            modalities,
            audio,
            reasoning_effort: reasoningEffort || undefined,
            ...additionalParameters,
          };

          const isO1Beta = finalModel.startsWith('o1-preview') || finalModel.startsWith('o1-mini');

          if (isReasoningModel) {
            options.max_completion_tokens = maxTokens;
          } else {
            options.temperature = useTopP ? undefined : temperature; // Not supported in o1-preview
            options.max_tokens = maxTokens;
          }

          const cacheKey = JSON.stringify(options);

          if (data.cache) {
            const cached = cache.get(cacheKey);
            if (cached) {
              context.markResultAsEditorCacheHit?.();
              return cached;
            }
          }

          const startTime = Date.now();

          // Non-streaming APIs
          if (isO1Beta || audio) {
            const response = await chatCompletions({
              auth: {
                apiKey: context.settings.openAiKey ?? '',
                organization: context.settings.openAiOrganization,
              },
              headers: allAdditionalHeaders,
              signal: context.signal,
              timeout: context.settings.chatNodeTimeout,
              ...options,
            });

            if ('error' in response) {
              throw new OpenAIError(400, response.error);
            }

            await applyOpenAINonStreamingResponse({
              response,
              output,
              messages,
              isMultiResponse,
              modalities,
              audioFormat: audio?.format,
              modelCosts:
                finalModel in openaiModels ? openaiModels[finalModel as keyof typeof openaiModels].cost : undefined,
              durationMs: Date.now() - startTime,
            });

            Object.freeze(output);
            cache.set(cacheKey, output);

            return output;
          }

          const chunks = streamChatCompletions({
            auth: {
              apiKey: context.settings.openAiKey ?? '',
              organization: context.settings.openAiOrganization,
            },
            headers: allAdditionalHeaders,
            signal: context.signal,
            timeout: context.settings.chatNodeTimeout,
            ...options,
          });

          await applyOpenAIStreamingResponse({
            chunks,
            output,
            messages,
            isMultiResponse,
            parallelFunctionCalling: data.parallelFunctionCalling,
            context,
            tokenizer: context.tokenizer,
            tokenizerInfo,
            inputTokenCount,
            numberOfChoices,
            useServerTokenCalculation: data.useServerTokenCalculation,
            modelCosts: {
              prompt:
                finalModel in openaiModels ? openaiModels[finalModel as keyof typeof openaiModels].cost.prompt : 0,
              completion:
                finalModel in openaiModels ? openaiModels[finalModel as keyof typeof openaiModels].cost.completion : 0,
            },
          });

          output['duration' as PortId] = { type: 'number', value: Date.now() - startTime };

          Object.freeze(output);
          cache.set(cacheKey, output);

          return output;
        },
        {
          forever: true,
          retries: 10000,
          maxRetryTime: 1000 * 60 * 5,
          factor: 2.5,
          minTimeout: 500,
          maxTimeout: 5000,
          randomize: true,
          signal: context.signal,
          onFailedAttempt(originalError) {
            handleOpenAIRetryableFailure({ originalError, context });
          },
        },
      );
    } catch (error) {
      context.trace(getError(error).stack ?? 'Missing stack');
      throw new Error(`Error processing ChatNode: ${(error as Error).message}`, { cause: error });
    }
  },
};

export function getChatNodeMessages(inputs: Inputs) {
  const prompt = inputs['prompt' as PortId];
  const systemPrompt = inputs['systemPrompt' as PortId];
  const messages = prependSystemPrompt(coercePromptToChatMessages(prompt), systemPrompt);
  return { messages, systemPrompt };
}
