import type { ChartNode, NodeGraph, PluginLoadSpec, Project } from '@valerypopoff/rivet2-core';

export type PluginUsageRegistry = {
  getPluginFor(type: string): { id: string } | undefined;
};

export type PluginUsageState = {
  loaded: boolean;
  spec: PluginLoadSpec;
  error?: string;
  plugin?: { id: string };
};

type ProjectPluginUsageInput = {
  appPluginStates: PluginUsageState[];
  currentGraph?: NodeGraph;
  project: Pick<Project, 'graphs' | 'nodePrefabs' | 'plugins'>;
  registry: PluginUsageRegistry;
};

export function getPluginSpecId(spec: PluginLoadSpec): string {
  return spec.id;
}

export function getPluginSpecLabel(spec: PluginLoadSpec): string {
  switch (spec.type) {
    case 'built-in':
      return spec.name || spec.id;
    case 'package':
      return `${spec.package}@${spec.tag}`;
    case 'uri':
      return spec.uri;
  }
}

export function getPluginSpecDetails(spec: PluginLoadSpec): string {
  switch (spec.type) {
    case 'built-in':
      return `Built-in: ${spec.id}`;
    case 'package':
      return `${spec.package}@${spec.tag}`;
    case 'uri':
      return spec.uri;
  }
}

export function pluginSpecMatchesSearch(spec: PluginLoadSpec, searchText: string): boolean {
  const normalizedSearchText = searchText.trim().toLowerCase();
  if (!normalizedSearchText) {
    return true;
  }

  return [getPluginSpecLabel(spec), getPluginSpecId(spec), getPluginSpecDetails(spec)].some((value) =>
    value.toLowerCase().includes(normalizedSearchText),
  );
}

export function dedupePluginSpecs(specs: PluginLoadSpec[] | undefined): PluginLoadSpec[] {
  const seen = new Set<string>();
  const result: PluginLoadSpec[] = [];

  for (const spec of specs ?? []) {
    const id = getPluginSpecId(spec);
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    result.push(spec);
  }

  return result;
}

export function getMissingAppPluginSpecs(
  projectPluginSpecs: PluginLoadSpec[] | undefined,
  appPluginSpecs: PluginLoadSpec[] | undefined,
): PluginLoadSpec[] {
  const appPluginIds = new Set((appPluginSpecs ?? []).map(getPluginSpecId));

  return dedupePluginSpecs(projectPluginSpecs).filter((spec) => !appPluginIds.has(getPluginSpecId(spec)));
}

export function pluginSpecsEqual(left: PluginLoadSpec[] | undefined, right: PluginLoadSpec[] | undefined): boolean {
  const leftSpecs = left ?? [];
  const rightSpecs = right ?? [];

  return (
    leftSpecs.length === rightSpecs.length &&
    leftSpecs.every((leftSpec, index) => pluginSpecEquals(leftSpec, rightSpecs[index]))
  );
}

export function deriveProjectPluginSpecsFromGraphs({
  appPluginStates,
  currentGraph,
  project,
  registry,
}: ProjectPluginUsageInput): PluginLoadSpec[] {
  const currentProjectSpecs = dedupePluginSpecs(project.plugins);
  const specByRuntimePluginId = new Map<string, PluginLoadSpec>();

  for (const state of appPluginStates) {
    if (state.loaded && !state.error && state.plugin?.id) {
      specByRuntimePluginId.set(state.plugin.id, state.spec);
    }
  }

  const usedSpecsById = new Map<string, PluginLoadSpec>();
  let hasUnresolvedNodeTypes = false;

  for (const node of getProjectNodes(project, currentGraph)) {
    const lookup = getPluginSpecForNode(node, registry, specByRuntimePluginId);
    if (lookup.unresolved) {
      hasUnresolvedNodeTypes = true;
    }

    if (lookup.spec) {
      usedSpecsById.set(getPluginSpecId(lookup.spec), lookup.spec);
    }
  }

  const nextSpecs: PluginLoadSpec[] = [];
  const seen = new Set<string>();

  for (const existingSpec of currentProjectSpecs) {
    const specId = getPluginSpecId(existingSpec);
    const usedSpec = usedSpecsById.get(specId);

    if (usedSpec) {
      pushSpec(nextSpecs, seen, usedSpec);
    } else if (hasUnresolvedNodeTypes) {
      pushSpec(nextSpecs, seen, existingSpec);
    }
  }

  for (const state of appPluginStates) {
    const usedSpec = usedSpecsById.get(getPluginSpecId(state.spec));
    if (usedSpec) {
      pushSpec(nextSpecs, seen, usedSpec);
    }
  }

  return nextSpecs;
}

export function withDerivedProjectPluginSpecs<TProject extends Pick<Project, 'graphs' | 'nodePrefabs' | 'plugins'>>(
  project: TProject,
  options: Omit<ProjectPluginUsageInput, 'project'>,
): TProject {
  const plugins = deriveProjectPluginSpecsFromGraphs({
    ...options,
    project,
  });

  if (pluginSpecsEqual(project.plugins, plugins)) {
    return project;
  }

  return {
    ...project,
    plugins,
  };
}

function getProjectNodes(project: Pick<Project, 'graphs' | 'nodePrefabs'>, currentGraph?: NodeGraph): ChartNode[] {
  const graphs = new Map(Object.entries(project.graphs ?? {}));

  if (currentGraph) {
    const graphId = currentGraph.metadata?.id ?? '__current__';
    graphs.set(graphId, currentGraph);
  }

  return [
    ...Array.from(graphs.values()).flatMap((graph) => graph.nodes ?? []),
    ...Object.values(project.nodePrefabs ?? {}).map((prefab) => prefab.sourceNode),
  ];
}

function getPluginSpecForNode(
  node: ChartNode,
  registry: PluginUsageRegistry,
  specByRuntimePluginId: Map<string, PluginLoadSpec>,
): { spec?: PluginLoadSpec; unresolved: boolean } {
  try {
    const plugin = registry.getPluginFor(node.type);
    if (!plugin) {
      return { unresolved: false };
    }

    const spec = specByRuntimePluginId.get(plugin.id);
    return spec ? { spec, unresolved: false } : { unresolved: false };
  } catch {
    return { unresolved: true };
  }
}

function pushSpec(specs: PluginLoadSpec[], seen: Set<string>, spec: PluginLoadSpec): void {
  const specId = getPluginSpecId(spec);
  if (seen.has(specId)) {
    return;
  }

  seen.add(specId);
  specs.push(spec);
}

function pluginSpecEquals(left: PluginLoadSpec, right: PluginLoadSpec | undefined): boolean {
  if (!right || left.type !== right.type || left.id !== right.id) {
    return false;
  }

  switch (left.type) {
    case 'built-in':
      return right.type === 'built-in' && left.name === right.name;
    case 'uri':
      return right.type === 'uri' && left.uri === right.uri;
    case 'package':
      return right.type === 'package' && left.package === right.package && left.tag === right.tag;
  }
}
