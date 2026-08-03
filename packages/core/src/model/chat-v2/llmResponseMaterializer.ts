import { inferType } from '../../utils/coerceType.js';
import type { DataValue } from '../DataValue.js';
import type { ChatV2ResponseFormatMode } from './chatV2Types.js';
import { isChatV2StructuredResponseFormat } from './chatV2ResponseFormat.js';

/**
 * The one place where a provider response becomes Rivet's Response value.
 *
 * Providers may return a structured SDK value, JSON text, or ordinary text.
 * Keeping this decision separate from port projection ensures validation sees
 * exactly the same DataValue that a downstream node receives.
 */
export type MaterializedLLMResponse = {
  rawText: string;
  value: DataValue;
  source: 'sdk-structured' | 'text-json' | 'plain-text';
  validation: 'not-requested' | 'valid' | 'invalid';
  validationError?: string;
};

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function materializeLLMResponse(params: {
  rawText: string;
  structuredOutput: unknown | undefined;
  responseFormat: ChatV2ResponseFormatMode | undefined;
  requireObject: boolean | undefined;
}): MaterializedLLMResponse {
  const { rawText, structuredOutput, responseFormat, requireObject } = params;
  let value: DataValue;
  let source: MaterializedLLMResponse['source'];

  if (!isChatV2StructuredResponseFormat(responseFormat)) {
    value = { type: 'string', value: rawText };
    source = 'plain-text';
  } else if (structuredOutput !== undefined) {
    value = inferType(structuredOutput);
    source = 'sdk-structured';
  } else {
    const parsed = tryParseJson(rawText);
    if (parsed === undefined) {
      value = { type: 'string', value: rawText };
      source = 'plain-text';
    } else {
      value = inferType(parsed);
      source = 'text-json';
    }
  }

  const validationRequested = requireObject && responseFormat === 'json_schema';
  const valid = !validationRequested || value.type === 'object';
  return {
    rawText,
    value,
    source,
    validation: !validationRequested ? 'not-requested' : valid ? 'valid' : 'invalid',
    ...(valid
      ? {}
      : {
          validationError:
            `LLM profile response validation failed.\n` +
            `Response format: JSON schema\n` +
            `Parsed Response type: ${value.type}\n` +
            'The provider request succeeded, but the final value prepared for the Response port is not an object. ' +
            'Because "Fail the LLM profile on non-JSON response" is enabled, Rivet rejected this LLM profile. ' +
            'Retry on non-200 does not apply to this validation failure.',
        }),
  };
}
