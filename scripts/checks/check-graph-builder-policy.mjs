import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NodeRegistration,
  deserializeProject,
  graphInputNode,
  graphOutputNode,
  llmChatV2Node,
  serializeProject,
  textNode,
} from '../../packages/core/src/index.ts';
import {
  GRAPH_BUILDER_POLICY_ASSET_PATH,
  GRAPH_BUILDER_POLICY_MANIFEST_PATH,
  buildGraphBuilderPolicyManifest,
  buildGraphBuilderPolicyProject,
  validateGraphBuilderPolicyAsset,
} from './lib/graph-builder-policy-asset.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const assetPath = join(repoRoot, GRAPH_BUILDER_POLICY_ASSET_PATH);
const manifestPath = join(repoRoot, GRAPH_BUILDER_POLICY_MANIFEST_PATH);
const shouldWrite = process.argv.includes('--write');

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, '\n');
}

function serializeExpectedProject() {
  const serialized = serializeProject(buildGraphBuilderPolicyProject());
  if (typeof serialized !== 'string') {
    throw new TypeError('Core serializeProject did not return a Rivet project string.');
  }
  return normalizeLineEndings(serialized);
}

function serializeExpectedManifest() {
  return `${JSON.stringify(buildGraphBuilderPolicyManifest(), null, 2)}\n`;
}

const expectedProjectText = serializeExpectedProject();
const expectedManifestText = serializeExpectedManifest();

if (shouldWrite) {
  writeFileSync(assetPath, expectedProjectText);
  writeFileSync(manifestPath, expectedManifestText);
  console.log('Updated the checked Graph Builder policy project and manifest.');
  process.exit(0);
}

const missingFiles = [
  [assetPath, GRAPH_BUILDER_POLICY_ASSET_PATH],
  [manifestPath, GRAPH_BUILDER_POLICY_MANIFEST_PATH],
]
  .filter(([absolutePath]) => !existsSync(absolutePath))
  .map(([, relativePath]) => relativePath);

if (missingFiles.length > 0) {
  console.error('Graph Builder policy assets are missing:');
  for (const file of missingFiles) console.error(`- ${file}`);
  console.error('Run: yarn check:graph-builder-policy --write');
  process.exit(1);
}

const currentProjectText = normalizeLineEndings(readFileSync(assetPath, 'utf8'));
const currentManifestText = normalizeLineEndings(readFileSync(manifestPath, 'utf8'));
let project;
let manifest;

try {
  [project] = deserializeProject(currentProjectText);
} catch (error) {
  console.error(`Graph Builder policy project cannot be deserialized: ${error.message}`);
  process.exit(1);
}

try {
  manifest = JSON.parse(currentManifestText);
} catch (error) {
  console.error(`Graph Builder policy manifest is not valid JSON: ${error.message}`);
  process.exit(1);
}

const contractErrors = validateGraphBuilderPolicyAsset(project, manifest);
const minimalRegistry = new NodeRegistration()
  .register(graphInputNode)
  .register(graphOutputNode)
  .register(textNode)
  .register(llmChatV2Node);

for (const graph of Object.values(project.graphs)) {
  const implementations = new Map();
  for (const node of graph.nodes) {
    if (!minimalRegistry.isRegistered(node.type)) {
      contractErrors.push(`Node ${node.id} is unavailable in the dedicated minimal policy registry.`);
      continue;
    }
    implementations.set(node.id, minimalRegistry.createDynamicImpl(node));
  }
  for (const connection of graph.connections) {
    const output = implementations
      .get(connection.outputNodeId)
      ?.getOutputDefinitions()
      .find((candidate) => candidate.id === connection.outputId);
    const input = implementations
      .get(connection.inputNodeId)
      ?.getInputDefinitions()
      .find((candidate) => candidate.id === connection.inputId);
    if (!output) {
      contractErrors.push(`Connection references missing output ${connection.outputNodeId}/${connection.outputId}.`);
    }
    if (!input) {
      contractErrors.push(`Connection references missing input ${connection.inputNodeId}/${connection.inputId}.`);
    }
  }
}

if (contractErrors.length > 0) {
  console.error('Graph Builder policy asset violates its checked contract:');
  for (const error of contractErrors) console.error(`- ${error}`);
  process.exit(1);
}

const freshnessErrors = [];
if (currentProjectText !== expectedProjectText) {
  freshnessErrors.push(GRAPH_BUILDER_POLICY_ASSET_PATH);
}
if (currentManifestText !== expectedManifestText) {
  freshnessErrors.push(GRAPH_BUILDER_POLICY_MANIFEST_PATH);
}

if (freshnessErrors.length > 0) {
  console.error('Graph Builder policy assets are valid but stale:');
  for (const file of freshnessErrors) console.error(`- ${file}`);
  console.error('Run: yarn check:graph-builder-policy --write');
  process.exit(1);
}

console.log('Graph Builder policy project and manifest are valid and fresh.');
