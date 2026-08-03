import type { ChatV2CredentialResult } from './chatV2ProviderProfile.js';
import {
  createLLMChatV2NodeData,
  llmChatV2ProfileDataKeys,
  type LLMChatV2NodeData,
  type LLMChatV2ProfileData,
} from './llmChatV2NodeData.js';

export const LLM_PROFILE_VALUE_VERSION = 1 as const;

/**
 * Every input port owned by an LLM Profile, including ports that are hidden
 * until their matching provider or input toggle is enabled. This lets editor
 * operations preserve recoverable connections across configuration changes.
 */
export { llmProfileInputIds } from './llmProfileFieldRegistry.js';

export type LLMProfileValue = {
  version: typeof LLM_PROFILE_VALUE_VERSION;
  configuration: LLMChatV2ProfileData;
  credential: ChatV2CredentialResult;
};

export function createLLMProfileNodeData(): LLMChatV2ProfileData {
  return pickLLMChatV2ProfileData(createLLMChatV2NodeData());
}

export function createDefaultLLMProfileValue(): LLMProfileValue {
  return {
    version: LLM_PROFILE_VALUE_VERSION,
    configuration: createLLMProfileNodeData(),
    credential: { reference: { source: 'none' } },
  };
}

export function pickLLMChatV2ProfileData(data: LLMChatV2NodeData): LLMChatV2ProfileData {
  return Object.fromEntries(llmChatV2ProfileDataKeys.map((key) => [key, data[key]])) as LLMChatV2ProfileData;
}

export function applyLLMProfileToNodeData(data: LLMChatV2NodeData, profile: LLMProfileValue): LLMChatV2NodeData {
  return {
    ...data,
    ...profile.configuration,
    configurationMode: 'profile',
  };
}
