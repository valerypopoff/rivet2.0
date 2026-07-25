import type { Project } from '@valerypopoff/rivet2-core';

export function getLLMChatV2CustomProviderApiKeyEnvVarNames(project: Project): string[] {
  const names = new Set<string>();

  for (const graph of Object.values(project.graphs)) {
    for (const node of graph.nodes) {
      const data = node.data as {
        provider?: string;
        apiKeySource?: string;
        customProviderApiKeyEnvVarName?: unknown;
      };

      if (
        (node.type === 'llmChatV2' || node.type === 'llmProfile') &&
        data.provider === 'custom' &&
        data.apiKeySource !== 'input' &&
        typeof data.customProviderApiKeyEnvVarName === 'string'
      ) {
        const envVarName = data.customProviderApiKeyEnvVarName.trim();
        if (envVarName) {
          names.add(envVarName);
        }
      }
    }
  }

  return [...names];
}
