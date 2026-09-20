import type { Inputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coerceTypeOptional } from '../../utils/coerceType.js';

export type ClassifierApiKeySource = 'configured' | 'input';

export type ClassifierCredentialNames = {
  programmaticName: string;
  environmentVariableName: string;
};

export type ClassifierProviderCredentials = Record<string, { apiKey?: string | undefined }>;

export const JEV_DEFAULT_CREDENTIAL_NAMES: ClassifierCredentialNames = {
  programmaticName: 'typesafeApiKey',
  environmentVariableName: 'TYPESAFE_API_KEY',
};

const programmaticNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidClassifierProgrammaticCredentialName(name: string): boolean {
  return programmaticNamePattern.test(name);
}

export function isValidClassifierEnvironmentCredentialName(name: string): boolean {
  return environmentVariableNamePattern.test(name);
}

export function normalizeClassifierCredentialNames(
  value: unknown,
  defaults: ClassifierCredentialNames = JEV_DEFAULT_CREDENTIAL_NAMES,
): ClassifierCredentialNames {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Classifier API key names must be an object.');
  }

  const raw = value as Partial<ClassifierCredentialNames> | undefined;
  if (raw?.programmaticName != null && typeof raw.programmaticName !== 'string') {
    throw new Error('Classifier programmatic API key name must be a string.');
  }
  if (raw?.environmentVariableName != null && typeof raw.environmentVariableName !== 'string') {
    throw new Error('Classifier API key environment variable must be a string.');
  }

  const programmaticName = raw?.programmaticName?.trim() || defaults.programmaticName;
  const environmentVariableName = raw?.environmentVariableName?.trim() || defaults.environmentVariableName;
  if (!isValidClassifierProgrammaticCredentialName(programmaticName)) {
    throw new Error('Classifier programmatic API key name must be a JavaScript-style identifier without a leading digit.');
  }
  if (!isValidClassifierEnvironmentCredentialName(environmentVariableName)) {
    throw new Error('Classifier API key environment variable must contain letters, digits, and _ without a leading digit.');
  }
  return { programmaticName, environmentVariableName };
}

export function getClassifierCredentialNamesForDisplay(
  value: unknown,
  defaults: ClassifierCredentialNames = JEV_DEFAULT_CREDENTIAL_NAMES,
): ClassifierCredentialNames {
  try {
    return normalizeClassifierCredentialNames(value, defaults);
  } catch {
    return { ...defaults };
  }
}

export function isDefaultClassifierCredentialNames(
  names: ClassifierCredentialNames,
  defaults: ClassifierCredentialNames = JEV_DEFAULT_CREDENTIAL_NAMES,
): boolean {
  return names.programmaticName === defaults.programmaticName && names.environmentVariableName === defaults.environmentVariableName;
}

export function resolveClassifierApiKey({
  apiKeyNames,
  apiKeySource,
  context,
  defaults,
  inputs,
  providerId,
}: {
  apiKeyNames?: ClassifierCredentialNames | undefined;
  apiKeySource?: ClassifierApiKeySource | undefined;
  context: Pick<InternalProcessContext, 'settings'>;
  defaults: ClassifierCredentialNames;
  inputs: Inputs;
  providerId: string;
}): string {
  if (apiKeySource === 'input') {
    const value = coerceTypeOptional(inputs['apiKey' as PortId], 'string')?.trim();
    if (!value) throw new Error('API Key input is required when API key source is Input port.');
    return value;
  }

  const names = normalizeClassifierCredentialNames(apiKeyNames, defaults);
  const namedValue = resolveNamedClassifierApiKey(context, names);
  if (namedValue) return namedValue;

  if (isDefaultClassifierCredentialNames(names, defaults)) {
    const firstPartyValue = getNonEmptyString(context.settings.classifierProviders?.[providerId]?.apiKey);
    if (firstPartyValue) return firstPartyValue;

    // Compatibility only: old applications stored the key under the removed plugin.
    if (providerId === 'jev') {
      const legacyValue = getNonEmptyString(context.settings.pluginSettings?.typesafe?.typesafeApiKey);
      if (legacyValue) return legacyValue;
    }
  }

  throw new Error(
    `${providerId === 'jev' ? 'Jev' : 'Classifier'} API key is not set. Pass ${names.programmaticName}, configure ${names.environmentVariableName}, or set the configured key in Settings > Classifier.`,
  );
}

function resolveNamedClassifierApiKey(
  context: Pick<InternalProcessContext, 'settings'>,
  names: ClassifierCredentialNames,
): string | undefined {
  const programmaticValue = getNonEmptyString(context.settings?.[names.programmaticName]);
  if (programmaticValue) return programmaticValue;

  const environmentValue = getNonEmptyString(context.settings?.pluginEnv?.[names.environmentVariableName]);
  if (environmentValue) return environmentValue;

  return getNonEmptyString(
    (
      globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env?.[names.environmentVariableName],
  );
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
