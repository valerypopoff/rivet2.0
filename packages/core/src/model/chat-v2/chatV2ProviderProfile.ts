import type { Inputs } from '../GraphProcessor.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { PortId } from '../NodeBase.js';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import {
  createChatV2Model,
  resolveChatV2ProviderConfig,
  type CreateChatV2ModelOptions,
  type ResolvedChatV2ProviderConfig,
} from './providerOptions.js';
import type { ChatV2Model, ChatV2Provider } from './chatV2Types.js';
import { getChatV2ProviderCapabilities } from './chatV2ProviderRegistry.js';

export type ChatV2CredentialReference = {
  source: 'input' | 'settings' | 'plugin' | 'programmatic' | 'environment' | 'none';
  name?: string | undefined;
};

export type ChatV2CredentialResult = {
  value?: string | undefined;
  reference: ChatV2CredentialReference;
};

export type ChatV2ProviderProfile = {
  provider: ChatV2Provider;
  modelId: string;
  baseURL?: string | undefined;
  hasCustomHeaders: boolean;
  credential: ChatV2CredentialReference;
  capabilities: {
    builtInTools: boolean;
    structuredOutput: boolean;
  };
};

type ProviderContext = Pick<InternalProcessContext, 'getPluginConfig' | 'settings'>;

function getStringSetting(settings: InternalProcessContext['settings'], key: string): string | undefined {
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resolveConfiguredCredential(
  provider: ChatV2Provider,
  context: ProviderContext,
  options: {
    customProgrammaticName?: string | undefined;
    customEnvironmentName?: string | undefined;
  },
): ChatV2CredentialResult {
  switch (provider) {
    case 'openai': {
      const value = context.settings.openAiApiKey || context.settings.openAiKey || undefined;
      return { value, reference: { source: value ? 'settings' : 'none' } };
    }
    case 'anthropic': {
      const settingsValue = context.settings.anthropicApiKey || undefined;
      if (settingsValue) return { value: settingsValue, reference: { source: 'settings' } };
      const pluginValue = context.getPluginConfig('anthropicApiKey') || undefined;
      return { value: pluginValue, reference: { source: pluginValue ? 'plugin' : 'none' } };
    }
    case 'google': {
      const settingsValue = context.settings.googleApiKey || undefined;
      if (settingsValue) return { value: settingsValue, reference: { source: 'settings' } };
      const pluginValue = context.getPluginConfig('googleApiKey') || undefined;
      return { value: pluginValue, reference: { source: pluginValue ? 'plugin' : 'none' } };
    }
    case 'custom': {
      const programmaticName = options.customProgrammaticName?.trim();
      const environmentName = options.customEnvironmentName?.trim();
      const programmaticValue = programmaticName ? getStringSetting(context.settings, programmaticName) : undefined;
      if (programmaticValue) {
        return {
          value: programmaticValue,
          reference: { source: 'programmatic', name: programmaticName },
        };
      }

      if (environmentName) {
        const pluginEnvValue = context.settings.pluginEnv?.[environmentName];
        if (pluginEnvValue) {
          return { value: pluginEnvValue, reference: { source: 'environment', name: environmentName } };
        }
        const processValue = (
          globalThis as typeof globalThis & {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process?.env?.[environmentName];
        if (processValue) {
          return { value: processValue, reference: { source: 'environment', name: environmentName } };
        }
      }

      const value = context.settings.customAiApiKey || undefined;
      if (value) return { value, reference: { source: 'settings' } };

      const missing = [
        programmaticName ? `programmatic key ${programmaticName}` : undefined,
        environmentName ? `env var ${environmentName}` : undefined,
      ].filter(Boolean);
      if (missing.length > 0) {
        const hint = programmaticName
          ? `pass ${programmaticName}`
          : 'set Alternative programmatic key name and pass that named run option';
        throw new Error(
          `Custom provider API key ${missing.join(' and ')} is not set. Use Input port, configure Settings > LLM, ${hint}, or configure the environment variable.`,
        );
      }

      return { reference: { source: 'none' } };
    }
  }
}

export function resolveChatV2Credential(options: {
  provider: ChatV2Provider;
  context: ProviderContext;
  apiKeySource?: 'configured' | 'input' | undefined;
  inputs?: Inputs | undefined;
  customProgrammaticName?: string | undefined;
  customEnvironmentName?: string | undefined;
}): ChatV2CredentialResult {
  if (options.apiKeySource === 'input') {
    const value = coerceTypeOptional(options.inputs?.['apiKey' as PortId], 'string')?.trim();
    if (!value) throw new Error('API Key input is required when API key source is Input port.');
    return { value, reference: { source: 'input' } };
  }

  return resolveConfiguredCredential(options.provider, options.context, options);
}

export async function createResolvedChatV2Provider(options: {
  provider: ChatV2Provider;
  modelId: string;
  context: ProviderContext;
  baseURL?: string | undefined;
  headers?: Record<string, string> | undefined;
  credential: ChatV2CredentialResult;
  onRequestBody?: CreateChatV2ModelOptions['onRequestBody'];
  onResponseBody?: CreateChatV2ModelOptions['onResponseBody'];
  transformRequestBody?: CreateChatV2ModelOptions['transformRequestBody'];
}): Promise<{
  profile: ChatV2ProviderProfile;
  model: ChatV2Model;
  config: ResolvedChatV2ProviderConfig;
}> {
  const config = await resolveChatV2ProviderConfig(options.provider, options.modelId, options.context, {
    baseURL: options.baseURL,
    headers: options.headers,
  });
  const model = createChatV2Model(options.provider, options.modelId, options.context, {
    ...config,
    apiKey: options.credential.value,
    onRequestBody: options.onRequestBody,
    onResponseBody: options.onResponseBody,
    transformRequestBody: options.transformRequestBody,
  });

  return {
    profile: {
      provider: options.provider,
      modelId: options.modelId,
      baseURL: config.baseURL,
      hasCustomHeaders: Object.keys(config.headers ?? {}).length > 0,
      credential: options.credential.reference,
      capabilities: {
        builtInTools: getChatV2ProviderCapabilities(options.provider).builtInTools,
        structuredOutput: getChatV2ProviderCapabilities(options.provider).structuredOutput,
      },
    },
    model,
    config,
  };
}
