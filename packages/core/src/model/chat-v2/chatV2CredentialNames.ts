import type { ChatV2Provider } from './chatV2Types.js';

export type ChatV2BuiltInProvider = Exclude<ChatV2Provider, 'custom'>;

export type ChatV2CredentialNames = {
  programmaticName: string;
  environmentVariableName: string;
};

export type ChatV2CredentialNamesByProvider = Partial<Record<ChatV2BuiltInProvider, ChatV2CredentialNames>>;

export const CHAT_V2_DEFAULT_CREDENTIAL_NAMES = {
  openai: {
    programmaticName: 'openAiApiKey',
    environmentVariableName: 'OPENAI_API_KEY',
  },
  anthropic: {
    programmaticName: 'anthropicApiKey',
    environmentVariableName: 'ANTHROPIC_API_KEY',
  },
  google: {
    programmaticName: 'googleApiKey',
    environmentVariableName: 'GOOGLE_GENERATIVE_AI_API_KEY',
  },
} as const satisfies Record<ChatV2BuiltInProvider, ChatV2CredentialNames>;

const programmaticNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isChatV2BuiltInProvider(provider: ChatV2Provider): provider is ChatV2BuiltInProvider {
  return Object.hasOwn(CHAT_V2_DEFAULT_CREDENTIAL_NAMES, provider);
}

export function isValidChatV2ProgrammaticCredentialName(name: string): boolean {
  return programmaticNamePattern.test(name);
}

export function isValidChatV2EnvironmentCredentialName(name: string): boolean {
  return environmentVariableNamePattern.test(name);
}

export function getChatV2DefaultCredentialNames(provider: ChatV2BuiltInProvider): ChatV2CredentialNames {
  return { ...CHAT_V2_DEFAULT_CREDENTIAL_NAMES[provider] };
}

export function getChatV2CredentialNamesForDisplay(
  provider: ChatV2BuiltInProvider,
  value: unknown,
): ChatV2CredentialNames {
  try {
    return normalizeChatV2CredentialNames(provider, value);
  } catch {
    return getChatV2DefaultCredentialNames(provider);
  }
}

export function normalizeChatV2CredentialNames(provider: ChatV2BuiltInProvider, value: unknown): ChatV2CredentialNames {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${provider} API key names must be an object.`);
  }

  const raw = value as Partial<ChatV2CredentialNames> | undefined;
  if (raw?.programmaticName != null && typeof raw.programmaticName !== 'string') {
    throw new Error(`${provider} programmatic API key name must be a string.`);
  }
  if (raw?.environmentVariableName != null && typeof raw.environmentVariableName !== 'string') {
    throw new Error(`${provider} API key environment variable must be a string.`);
  }

  const defaults = CHAT_V2_DEFAULT_CREDENTIAL_NAMES[provider];
  const programmaticName = raw?.programmaticName?.trim() || defaults.programmaticName;
  const environmentVariableName = raw?.environmentVariableName?.trim() || defaults.environmentVariableName;

  if (!isValidChatV2ProgrammaticCredentialName(programmaticName)) {
    throw new Error(
      `${provider} programmatic API key name must be a JavaScript-style identifier (letters, digits, _, or $, and not starting with a digit).`,
    );
  }
  if (!isValidChatV2EnvironmentCredentialName(environmentVariableName)) {
    throw new Error(
      `${provider} API key environment variable must contain only letters, digits, and _, and must not start with a digit.`,
    );
  }

  return { programmaticName, environmentVariableName };
}

export function normalizeChatV2CredentialNamesByProvider(value: unknown): ChatV2CredentialNamesByProvider | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Built-in provider API key names must be an object.');
  }

  const raw = value as Record<string, unknown>;
  const unsupportedProvider = Object.keys(raw).find(
    (provider) => !Object.hasOwn(CHAT_V2_DEFAULT_CREDENTIAL_NAMES, provider),
  );
  if (unsupportedProvider) {
    throw new Error(`Unsupported provider API key names entry: ${unsupportedProvider}.`);
  }

  const normalized: ChatV2CredentialNamesByProvider = {};
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    if (raw[provider] != null) {
      normalized[provider] = normalizeChatV2CredentialNames(provider, raw[provider]);
    }
  }

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

export function isDefaultChatV2CredentialNames(provider: ChatV2BuiltInProvider, names: ChatV2CredentialNames): boolean {
  const defaults = CHAT_V2_DEFAULT_CREDENTIAL_NAMES[provider];
  return (
    names.programmaticName === defaults.programmaticName &&
    names.environmentVariableName === defaults.environmentVariableName
  );
}

export function getNonDefaultChatV2CredentialNames(
  provider: ChatV2Provider,
  namesByProvider: ChatV2CredentialNamesByProvider | undefined,
): ChatV2CredentialNames | undefined {
  if (!isChatV2BuiltInProvider(provider) || namesByProvider?.[provider] == null) return undefined;

  try {
    const names = normalizeChatV2CredentialNames(provider, namesByProvider[provider]);
    return isDefaultChatV2CredentialNames(provider, names) ? undefined : names;
  } catch {
    return undefined;
  }
}
