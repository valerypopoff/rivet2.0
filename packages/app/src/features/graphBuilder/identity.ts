import { type GraphId, type NodeRegistration, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import {
  GRAPH_BUILDER_PROTOCOL_VERSION,
  canonicalGraphBuilderAuthoringStringify,
  compareGraphBuilderStrings,
  hashCanonicalGraphBuilderValue,
  hashGraphBuilderString,
} from '../../domain/graphBuilder/index.js';
import type { PluginState } from '../../state/plugins.js';
import type { EditorPreferences } from '../../state/settings.js';
import type { ResolvedAiAssistModelSettings } from '../../utils/aiAssistModelSettings.js';
import type { GraphBuilderEditorSnapshot } from './editorSnapshot.js';
import { GRAPH_BUILDER_POLICY_VERSION } from './policyManifest.js';

export const GRAPH_BUILDER_AUTHORING_CONTRACT_VERSION = '1';
export const GRAPH_BUILDER_VALIDATION_RULES_VERSION = '1';

export type GraphBuilderBaseIdentity = {
  activeGraphId: GraphId;
  editorRevision: number;
  policyConfigFingerprint: string;
  projectCanonicalIdentity: string;
  projectFingerprint: string;
  projectId: ProjectId;
  protocolVersion: typeof GRAPH_BUILDER_PROTOCOL_VERSION;
  referencedProjectsCanonicalIdentity: string;
  referencedProjectsFingerprint: string;
  registryContractCanonicalIdentity: string;
  registryContractFingerprint: string;
  validationRulesVersion: string;
};

export function createGraphBuilderBaseIdentity(options: {
  assistModel: ResolvedAiAssistModelSettings;
  authoringPreferences: Pick<EditorPreferences, 'applyDefaultNodeColors'>;
  editorRevision: number;
  plugins: readonly PluginState[];
  pluginRefreshCounter: number;
  projectPlugins: Project['plugins'];
  referencedProjects: Record<ProjectId, Project>;
  registry: NodeRegistration<any, any>;
  snapshot: GraphBuilderEditorSnapshot;
}): GraphBuilderBaseIdentity {
  const registryIdentityValue = {
    authoringContractVersion: GRAPH_BUILDER_AUTHORING_CONTRACT_VERSION,
    authoringPreferences: {
      applyDefaultNodeColors: options.authoringPreferences.applyDefaultNodeColors,
    },
    pluginRefreshCounter: options.pluginRefreshCounter,
    plugins: options.plugins
      .map((plugin) => ({
        error: plugin.error ? 'load-error' : undefined,
        id: plugin.id,
        loaded: plugin.loaded,
        spec: plugin.spec,
      }))
      .sort((left, right) => compareGraphBuilderStrings(left.id, right.id)),
    projectPlugins: options.projectPlugins ?? [],
    registeredNodes: options.registry
      .getNodeTypes()
      .map((type) => ({
        displayName: safelyGetDisplayName(options.registry, type),
        pluginId: safelyGetPluginId(options.registry, type),
        type,
      }))
      .sort((left, right) => compareGraphBuilderStrings(left.type, right.type)),
  };
  const registryContractCanonicalIdentity = canonicalGraphBuilderAuthoringStringify(registryIdentityValue);
  const referencedProjectsCanonicalIdentity = canonicalGraphBuilderAuthoringStringify(options.referencedProjects);

  return {
    activeGraphId: options.snapshot.activeGraphId,
    editorRevision: options.editorRevision,
    policyConfigFingerprint: createGraphBuilderPolicyConfigFingerprint(options.assistModel),
    projectCanonicalIdentity: options.snapshot.canonicalIdentity,
    projectFingerprint: options.snapshot.fingerprint,
    projectId: options.snapshot.projectId,
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    referencedProjectsCanonicalIdentity,
    referencedProjectsFingerprint: hashGraphBuilderString(referencedProjectsCanonicalIdentity),
    registryContractCanonicalIdentity,
    registryContractFingerprint: hashGraphBuilderString(registryContractCanonicalIdentity),
    validationRulesVersion: GRAPH_BUILDER_VALIDATION_RULES_VERSION,
  };
}

export function createGraphBuilderPolicyConfigFingerprint(assistModel: ResolvedAiAssistModelSettings): string {
  return hashCanonicalGraphBuilderValue({
    customProviderBaseURL: assistModel.customProviderBaseURL ?? '',
    model: assistModel.model,
    policyVersion: GRAPH_BUILDER_POLICY_VERSION,
    provider: assistModel.provider,
    responseMode: assistModel.provider === 'custom' ? 'text' : 'json-schema',
  });
}

export function graphBuilderBaseIdentityMatches(
  expected: GraphBuilderBaseIdentity,
  current: GraphBuilderBaseIdentity,
): boolean {
  return (
    expected.projectId === current.projectId &&
    expected.activeGraphId === current.activeGraphId &&
    expected.projectCanonicalIdentity === current.projectCanonicalIdentity &&
    expected.registryContractCanonicalIdentity === current.registryContractCanonicalIdentity &&
    expected.referencedProjectsCanonicalIdentity === current.referencedProjectsCanonicalIdentity &&
    expected.policyConfigFingerprint === current.policyConfigFingerprint &&
    expected.validationRulesVersion === current.validationRulesVersion &&
    expected.protocolVersion === current.protocolVersion
  );
}

function safelyGetDisplayName(registry: NodeRegistration<any, any>, type: string): string {
  try {
    return registry.getDynamicDisplayName(type);
  } catch {
    return type;
  }
}

function safelyGetPluginId(registry: NodeRegistration<any, any>, type: string): string | undefined {
  try {
    return registry.getPluginFor(type)?.id;
  } catch {
    return undefined;
  }
}
