import { isValidChatV2EnvironmentCredentialName, type Project } from '@valerypopoff/rivet2-core';

export function getLLMChatV2ApiKeyEnvVarNames(project: Project): string[] {
  const names = new Set<string>();
  const nodes = [
    ...Object.values(project.graphs).flatMap((graph) => graph.nodes),
    ...Object.values(project.nodePrefabs ?? {}).map((prefab) => prefab.sourceNode),
  ];

  for (const node of nodes) {
    if (node.type !== 'llmChatV2' && node.type !== 'llmProfile') continue;

    const data = node.data as {
      provider?: unknown;
      apiKeySource?: unknown;
      providerApiKeyNames?: unknown;
      customProviderApiKeyEnvVarName?: unknown;
    };
    if (data.apiKeySource === 'input' || typeof data.provider !== 'string') continue;

    if (data.provider === 'custom') {
      addString(names, data.customProviderApiKeyEnvVarName);
    } else if (data.provider === 'openai' || data.provider === 'anthropic' || data.provider === 'google') {
      const providerNames = asRecord(data.providerApiKeyNames)?.[data.provider];
      addString(names, asRecord(providerNames)?.environmentVariableName, isValidChatV2EnvironmentCredentialName);
    }
  }

  return [...names];
}

/** @deprecated Use getLLMChatV2ApiKeyEnvVarNames. */
export const getLLMChatV2CustomProviderApiKeyEnvVarNames = getLLMChatV2ApiKeyEnvVarNames;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addString(names: Set<string>, value: unknown, validate: (name: string) => boolean = () => true): void {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (name && validate(name)) names.add(name);
}
