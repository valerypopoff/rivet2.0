export type CustomProviderApi = 'completions' | 'responses';

export type CustomProviderApiContract = Readonly<{
  api: CustomProviderApi;
  adapter: 'openai-compatible' | 'openai-responses';
  providerOptionsKey: 'custom' | 'openai';
  endpointPath: '/chat/completions' | '/responses';
  label: 'Custom Completions' | 'Custom Responses';
  structuredOutput: 'raw-response-format' | 'sdk-output';
  parallelToolCalls: 'enabled-only-raw-field' | 'openai-option';
}>;

export const customProviderApiOptions = [
  { value: 'completions', label: 'Completions' },
  { value: 'responses', label: 'Responses' },
] as const;

const customProviderApiContracts: Record<CustomProviderApi, CustomProviderApiContract> = {
  completions: {
    api: 'completions',
    adapter: 'openai-compatible',
    providerOptionsKey: 'custom',
    endpointPath: '/chat/completions',
    label: 'Custom Completions',
    structuredOutput: 'raw-response-format',
    parallelToolCalls: 'enabled-only-raw-field',
  },
  responses: {
    api: 'responses',
    adapter: 'openai-responses',
    providerOptionsKey: 'openai',
    endpointPath: '/responses',
    label: 'Custom Responses',
    structuredOutput: 'sdk-output',
    parallelToolCalls: 'openai-option',
  },
};

/**
 * Keep legacy nodes on Chat Completions while rejecting corrupt/API-authored
 * values before a provider request is created.
 */
export function parseCustomProviderApi(value: unknown): CustomProviderApi {
  switch (value) {
    case undefined:
    case 'completions':
      return 'completions';
    case 'responses':
      return 'responses';
    default:
      throw new Error(`Unsupported Custom provider API: ${String(value)}.`);
  }
}

export function getCustomProviderApiContract(value: unknown): CustomProviderApiContract {
  return customProviderApiContracts[parseCustomProviderApi(value)];
}
