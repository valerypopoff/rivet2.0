import type { ChartNode } from '../NodeBase.js';
import type { NodeGraph } from '../NodeGraph.js';
import type { Project } from '../Project.js';

const legacyTypesafePluginId = 'typesafe';

function isLegacyTypesafePlugin(spec: NonNullable<Project['plugins']>[number]): boolean {
  return spec.type === 'built-in' && spec.id === legacyTypesafePluginId;
}

/**
 * Converts the former TypeSafe plugin node family into the first-party
 * classifier contract. It is intentionally idempotent because project data
 * reaches Core through imports, hosted snapshots, recordings, and copies.
 */
export function normalizeClassifierProject(project: Project): void {
  for (const graph of Object.values(project.graphs)) normalizeClassifierGraph(graph);
  for (const prefab of Object.values(project.nodePrefabs ?? {})) normalizeClassifierNode(prefab.sourceNode);

  if (project.plugins?.some(isLegacyTypesafePlugin)) {
    project.plugins = project.plugins.filter((plugin) => !isLegacyTypesafePlugin(plugin));
  }
}

/**
 * Checks whether a project still needs the in-place legacy migration. Hosts
 * which receive a caller-owned project object use this before cloning, so a
 * compatibility repair never mutates the caller's snapshot.
 */
export function hasLegacyClassifierProjectData(project: Project): boolean {
  return (
    project.plugins?.some(isLegacyTypesafePlugin) === true ||
    Object.values(project.graphs).some(hasLegacyClassifierGraphData) ||
    Object.values(project.nodePrefabs ?? {}).some((prefab) => hasLegacyClassifierNodeData(prefab.sourceNode))
  );
}

export function normalizeClassifierGraph(graph: NodeGraph): void {
  for (const node of graph.nodes) normalizeClassifierNode(node);
}

export function hasLegacyClassifierGraphData(graph: NodeGraph): boolean {
  return graph.nodes.some(hasLegacyClassifierNodeData);
}

export function normalizeClassifierNode(node: ChartNode): void {
  const legacyNode = node as ChartNode & { type: string; title: string; data: unknown };
  switch (legacyNode.type) {
    case 'jevChoiceQuestion':
      normalizeQuestionNode(legacyNode, 'choice', 'Jev Choice Question');
      return;
    case 'jevScoreQuestion':
      normalizeQuestionNode(legacyNode, 'score', 'Jev Score Question');
      return;
    case 'jevNoulQuestion':
      normalizeQuestionNode(legacyNode, 'noul', 'Jev Noul Question');
      return;
    case 'jevEvaluate':
      normalizeEvaluateNode(legacyNode);
      return;
    case 'classifierEvaluate':
      if (hasDeprecatedGlobalCredentialNames(legacyNode)) normalizeEvaluateNode(legacyNode);
      return;
    default:
      return;
  }
}

function hasLegacyClassifierNodeData(node: ChartNode): boolean {
  return (
    node.type === 'jevChoiceQuestion' ||
    node.type === 'jevScoreQuestion' ||
    node.type === 'jevNoulQuestion' ||
    node.type === 'jevEvaluate' ||
    (node.type === 'classifierEvaluate' && hasDeprecatedGlobalCredentialNames(node as ChartNode & { data: unknown }))
  );
}

function hasDeprecatedGlobalCredentialNames(node: ChartNode & { data: unknown }): boolean {
  return Object.prototype.hasOwnProperty.call(asRecord(node.data), 'apiKeyNames');
}

function normalizeQuestionNode(
  node: ChartNode & { type: string; title: string; data: unknown },
  questionType: 'choice' | 'score' | 'noul',
  legacyTitle: string,
): void {
  node.type = 'classifierQuestion';
  node.data = {
    ...asRecord(node.data),
    questionType,
  };
  if (node.title === legacyTitle) node.title = 'Classifier Question';
}

function normalizeEvaluateNode(node: ChartNode & { type: string; title: string; data: unknown }): void {
  const legacyData = asRecord(node.data);
  const legacyApiKeyNames = legacyData.apiKeyNames;
  const existingNames = asRecord(legacyData.apiKeyNamesByProvider);
  const apiKeyNamesByProvider =
    legacyApiKeyNames === undefined || Object.prototype.hasOwnProperty.call(existingNames, 'jev')
      ? existingNames
      : { ...existingNames, jev: legacyApiKeyNames };
  const { apiKeyNames: _legacyApiKeyNames, ...dataWithoutLegacyNames } = legacyData;

  node.type = 'classifierEvaluate';
  node.data = {
    ...dataWithoutLegacyNames,
    provider: typeof legacyData.provider === 'string' && legacyData.provider ? legacyData.provider : 'jev',
    ...(Object.keys(apiKeyNamesByProvider).length > 0 ? { apiKeyNamesByProvider } : {}),
  };
  if (node.title === 'Jev Evaluate') node.title = 'Classifier Evaluate';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
