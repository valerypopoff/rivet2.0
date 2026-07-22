import { coerceType, coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/inputs.js';
import type { ChatCompletionOptions, ChatCompletionTool } from '../../utils/openai.js';
import type { Inputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatNodeData } from '../nodes/ChatNodeBase.js';

export function resolveChatToolChoice(data: ChatNodeData, inputs: Inputs): ChatCompletionOptions['tool_choice'] {
  const toolChoiceMode = getInputOrData(data, inputs, 'toolChoice', 'string') as 'none' | 'auto' | 'function';

  if (!toolChoiceMode || !data.enableFunctionUse) {
    return undefined;
  }

  if (toolChoiceMode === 'function') {
    return {
      type: 'function',
      function: {
        name: getInputOrData(data, inputs, 'toolChoiceFunction', 'string'),
      },
    };
  }

  return toolChoiceMode;
}

export function resolveChatResponseSchema(inputs: Inputs) {
  const responseSchemaInput = inputs['responseSchema' as PortId];

  if (responseSchemaInput?.type === 'gpt-function') {
    return responseSchemaInput.value.parameters;
  }

  if (responseSchemaInput != null) {
    return coerceType(responseSchemaInput, 'object');
  }

  return undefined;
}

export function resolveOpenAIResponseFormat(data: ChatNodeData, inputs: Inputs) {
  const responseFormat = getInputOrData(data, inputs, 'responseFormat') as 'text' | 'json' | 'json_schema' | '';

  if (!responseFormat?.trim()) {
    return undefined;
  }

  if (responseFormat === 'json') {
    return { type: 'json_object' } as const;
  }

  if (responseFormat === 'json_schema') {
    return {
      type: 'json_schema' as const,
      json_schema: {
        name: getInputOrData(data, inputs, 'responseSchemaName', 'string') || 'response_schema',
        strict: true,
        schema: resolveChatResponseSchema(inputs) ?? {},
      },
    };
  }

  return {
    type: 'text',
  } as const;
}

export function resolveAdditionalHeaders(data: ChatNodeData, inputs: Inputs) {
  const headersFromData = (data.headers ?? []).reduce(
    (acc, header) => {
      acc[header.key] = header.value;
      return acc;
    },
    {} as Record<string, string>,
  );

  return data.useHeadersInput
    ? (coerceTypeOptional(inputs['headers' as PortId], 'object') as Record<string, string> | undefined) ??
        headersFromData
    : headersFromData;
}

export function resolveAdditionalParameters(data: ChatNodeData, inputs: Inputs) {
  const additionalParametersFromData = (data.additionalParameters ?? []).reduce(
    (acc, param) => {
      acc[param.key] = Number.isNaN(parseFloat(param.value)) ? param.value : parseFloat(param.value);
      return acc;
    },
    {} as Record<string, string | number>,
  );

  return data.useAdditionalParametersInput
    ? (coerceTypeOptional(inputs['additionalParameters' as PortId], 'object') as Record<string, string> | undefined) ??
        additionalParametersFromData
    : additionalParametersFromData;
}

export function resolveChatTools(inputs: Inputs): ChatCompletionTool[] {
  const functions = coerceTypeOptional(inputs['functions' as PortId], 'gpt-function[]');
  return (functions ?? []).map(
    (fn): ChatCompletionTool => ({
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
        strict: fn.strict,
      },
      type: 'function',
    }),
  );
}

export function resolvePredictionObject(data: ChatNodeData, inputs: Inputs) {
  const predictedOutput = data.usePredictedOutput
    ? coerceTypeOptional(inputs['predictedOutput' as PortId], 'string[]')
    : undefined;

  if (!predictedOutput) {
    return undefined;
  }

  return predictedOutput.length === 1
    ? { type: 'content' as const, content: predictedOutput[0]! }
    : { type: 'content' as const, content: predictedOutput.map((part) => ({ type: 'text', text: part })) };
}

export function resolveAudioAndModalities(data: ChatNodeData, inputs: Inputs) {
  const voice = getInputOrData(data, inputs, 'audioVoice');

  let modalities: ('text' | 'audio')[] | undefined = [];
  if (data.modalitiesIncludeText) {
    modalities.push('text');
  }
  if (data.modalitiesIncludeAudio) {
    modalities.push('audio');

    if (!voice) {
      throw new Error('Audio voice must be specified if audio is enabled.');
    }
  }

  if (modalities.length === 0) {
    modalities = undefined;
  }

  const audio = modalities?.includes('audio')
    ? {
        voice,
        format:
          (getInputOrData(data, inputs, 'audioFormat') as 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16' | undefined) ??
          'wav',
      }
    : undefined;

  return { modalities, audio };
}
