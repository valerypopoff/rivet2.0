import { graphBuilderPolicyManifest } from '../../graphBuilderAssets.js';
import {
  GRAPH_BUILDER_POLICY_ALLOWED_NODE_TYPES,
  GRAPH_BUILDER_POLICY_ASSET_PATH,
  GRAPH_BUILDER_POLICY_IDS,
  GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS,
  GRAPH_BUILDER_POLICY_PROJECT_ID,
  GRAPH_BUILDER_POLICY_VERSION,
} from './policyAssetContract.js';

export { GRAPH_BUILDER_POLICY_ALLOWED_NODE_TYPES, GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS };

export type GraphBuilderPolicyVariantName = 'schema' | 'text';
export const GRAPH_BUILDER_POLICY_ACTIVE_VARIANT = 'text' as const satisfies GraphBuilderPolicyVariantName;
export const GRAPH_BUILDER_POLICY_RESPONSE_MODE = 'exact-json-text';

export type GraphBuilderPolicyVariantManifest = {
  graphId: string;
  llmNodeId: string;
  policyTurnInputNodeId: string;
  responseSchemaInputNodeId?: string;
  decisionOutputNodeId: string;
  responseFormat: 'json_schema' | '';
};

export type GraphBuilderPolicyManifest = {
  version: 1;
  policyVersion: string;
  assetPath: string;
  projectId: string;
  normalizedPromptSha256: string;
  allowedInjectedLlmDataKeys: string[];
  variants: Record<GraphBuilderPolicyVariantName, GraphBuilderPolicyVariantManifest>;
};

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePolicyManifest(value: unknown): GraphBuilderPolicyManifest {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Graph Builder policy manifest must be an object.');
  }

  const manifest = value as Partial<GraphBuilderPolicyManifest>;
  if (
    manifest.version !== 1 ||
    manifest.policyVersion !== GRAPH_BUILDER_POLICY_VERSION ||
    manifest.assetPath !== GRAPH_BUILDER_POLICY_ASSET_PATH ||
    manifest.projectId !== GRAPH_BUILDER_POLICY_PROJECT_ID ||
    typeof manifest.normalizedPromptSha256 !== 'string' ||
    !Array.isArray(manifest.allowedInjectedLlmDataKeys) ||
    manifest.variants == null ||
    typeof manifest.variants !== 'object'
  ) {
    throw new Error('Graph Builder policy manifest is incomplete.');
  }

  if (!equalStringArrays(manifest.allowedInjectedLlmDataKeys, GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS)) {
    throw new Error('Graph Builder policy manifest LLM injection allowlist does not match the host contract.');
  }

  for (const name of ['schema', 'text'] as const) {
    const variant = manifest.variants[name];
    if (
      variant == null ||
      typeof variant.graphId !== 'string' ||
      typeof variant.llmNodeId !== 'string' ||
      typeof variant.policyTurnInputNodeId !== 'string' ||
      typeof variant.decisionOutputNodeId !== 'string' ||
      (variant.responseFormat !== 'json_schema' && variant.responseFormat !== '')
    ) {
      throw new Error(`Graph Builder policy manifest ${name} variant is incomplete.`);
    }
  }

  if (
    manifest.variants.schema.responseFormat !== 'json_schema' ||
    manifest.variants.schema.graphId !== GRAPH_BUILDER_POLICY_IDS.schema.graph ||
    manifest.variants.schema.llmNodeId !== GRAPH_BUILDER_POLICY_IDS.schema.llm ||
    manifest.variants.schema.policyTurnInputNodeId !== GRAPH_BUILDER_POLICY_IDS.schema.policyTurnInput ||
    manifest.variants.schema.responseSchemaInputNodeId !== GRAPH_BUILDER_POLICY_IDS.schema.responseSchemaInput ||
    manifest.variants.schema.decisionOutputNodeId !== GRAPH_BUILDER_POLICY_IDS.schema.decisionOutput ||
    typeof manifest.variants.schema.responseSchemaInputNodeId !== 'string' ||
    manifest.variants.text.responseFormat !== '' ||
    manifest.variants.text.graphId !== GRAPH_BUILDER_POLICY_IDS.text.graph ||
    manifest.variants.text.llmNodeId !== GRAPH_BUILDER_POLICY_IDS.text.llm ||
    manifest.variants.text.policyTurnInputNodeId !== GRAPH_BUILDER_POLICY_IDS.text.policyTurnInput ||
    manifest.variants.text.decisionOutputNodeId !== GRAPH_BUILDER_POLICY_IDS.text.decisionOutput ||
    manifest.variants.text.responseSchemaInputNodeId != null
  ) {
    throw new Error('Graph Builder policy manifest response-format variants do not match the host contract.');
  }

  return manifest as GraphBuilderPolicyManifest;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const GRAPH_BUILDER_POLICY_MANIFEST = deepFreeze(parsePolicyManifest(graphBuilderPolicyManifest));
export { GRAPH_BUILDER_POLICY_VERSION };
