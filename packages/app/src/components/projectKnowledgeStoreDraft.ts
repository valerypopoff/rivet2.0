import {
  createKnowledgeStoreFieldDraftDefaults,
  normalizeKnowledgeStoreConnectionDraftConfig,
  normalizeKnowledgeStoreCredentialFields,
  type KnowledgeStoreConnectionDefinition,
  type KnowledgeStoreFieldNormalizationResult,
  type KnowledgeMetadata,
  type KnowledgeStoreProviderDefinition,
} from '@valerypopoff/rivet2-core';

export type ProjectKnowledgeStoreDraft = {
  connectionId: string;
  displayName: string;
  providerId: string;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  isNew: boolean;
};

export function createNewKnowledgeStoreDraft(
  connectionId: string,
  provider: KnowledgeStoreProviderDefinition,
): ProjectKnowledgeStoreDraft {
  return {
    connectionId,
    displayName: '',
    providerId: provider.id,
    config: createKnowledgeStoreFieldDraftDefaults(provider.connectionConfigSpec),
    credentials: {},
    isNew: true,
  };
}

export function createExistingKnowledgeStoreDraft(
  connectionId: string,
  definition: KnowledgeStoreConnectionDefinition,
  credentials: Record<string, string>,
): ProjectKnowledgeStoreDraft {
  return {
    connectionId,
    displayName: definition.displayName,
    providerId: definition.provider,
    config: { ...definition.config },
    credentials: { ...credentials },
    isNew: false,
  };
}

export function duplicateKnowledgeStoreDraft(
  connectionId: string,
  definition: KnowledgeStoreConnectionDefinition,
  existingDisplayNames: Iterable<string>,
): ProjectKnowledgeStoreDraft {
  const usedNames = new Set([...existingDisplayNames].map((name) => name.toLocaleLowerCase()));
  const baseName = `${definition.displayName} copy`;
  let displayName = baseName;
  let suffix = 2;
  while (usedNames.has(displayName.toLocaleLowerCase())) displayName = `${baseName} ${suffix++}`;

  return {
    connectionId,
    displayName,
    providerId: definition.provider,
    config: { ...definition.config },
    credentials: {},
    isNew: true,
  };
}

export function switchNewKnowledgeStoreDraftProvider(
  draft: ProjectKnowledgeStoreDraft,
  provider: KnowledgeStoreProviderDefinition,
): ProjectKnowledgeStoreDraft {
  if (!draft.isNew) return draft;
  return {
    ...draft,
    providerId: provider.id,
    config: createKnowledgeStoreFieldDraftDefaults(provider.connectionConfigSpec),
    credentials: {},
  };
}

export function normalizeProjectKnowledgeStoreDraftFields(
  draft: ProjectKnowledgeStoreDraft,
  provider: KnowledgeStoreProviderDefinition,
): { config: KnowledgeMetadata; credentials: Record<string, string> } {
  if (draft.providerId !== provider.id) {
    throw new Error(`Knowledge store draft provider "${draft.providerId}" does not match provider "${provider.id}".`);
  }
  return {
    config: unwrapNormalizedFields(
      normalizeKnowledgeStoreConnectionDraftConfig(provider.connectionConfigSpec, draft.config),
    ),
    credentials: unwrapNormalizedFields(
      normalizeKnowledgeStoreCredentialFields(provider.credentialConfigSpec ?? [], draft.credentials),
    ),
  };
}

function unwrapNormalizedFields<T>(result: KnowledgeStoreFieldNormalizationResult<T>): T {
  if (result.ok) return result.value;
  const { code, fieldLabel } = result.issue;
  switch (code) {
    case 'required':
      throw new Error(`${fieldLabel} is required.`);
    case 'expected-boolean':
      throw new Error(`${fieldLabel} must be a boolean.`);
    case 'expected-finite-number':
      throw new Error(`${fieldLabel} must be a finite number.`);
    case 'expected-string':
      throw new Error(`${fieldLabel} must be a string.`);
    case 'unsupported-select-value':
      throw new Error(`${fieldLabel} has an unsupported value.`);
    default:
      code satisfies never;
      throw new Error('Unsupported Knowledge Store field issue.');
  }
}
