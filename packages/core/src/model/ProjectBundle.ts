import type { Project } from './Project.js';
import { getSubgraphTargetBoundaryIssue, type SubGraphNode } from './nodes/SubGraphNode.js';
import { getGraphBoundary, type GraphBoundary } from './GraphBoundaryCache.js';
import { resolveNodePrefabInstance } from './NodePrefabResolver.js';
import type { PluginLoadSpec } from './PluginLoadSpec.js';
import { findStronglyConnectedComponents } from './CycleDetector.js';
import type { ReferencedGraphAliasNode } from './nodes/ReferencedGraphAliasNode.js';

/** Deliberate, user-facing bundle validation failures; never raw storage errors. */
export class ProjectBundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectBundleError';
  }
}

/** Portable, immutable project snapshots. Paths are relative to the manifest. */
export type ProjectBundleFile = { path: string; bytes: number; sha256: string };
export type ProjectBundleArtifact = {
  id: string;
  projectId: string;
  title: string;
  version: 'latest' | 'published';
  revision: string;
  project: ProjectBundleFile;
  datasets?: ProjectBundleFile;
};
export type ProjectBundleManifest = {
  format: 'rivet-project-bundle';
  schemaVersion: 1;
  requiredLoaderVersion: 1;
  exportingRuntimeVersion: string;
  rootArtifact: string;
  artifacts: ProjectBundleArtifact[];
  targets: { projectId: string; version: 'latest' | 'published'; artifact: string }[];
  references: { projectId: string; artifact: string }[];
  plugins: PluginLoadSpec[];
};

export const PROJECT_BUNDLE_MANIFEST = 'rivet-bundle.json';
export const PROJECT_BUNDLE_MAX_ARTIFACTS = 256;

export function projectBundleTargetKey(projectId: string, version: string): string {
  return JSON.stringify([projectId, version]);
}

function samePluginRequirement(left: PluginLoadSpec, right: PluginLoadSpec): boolean {
  if (left.id !== right.id || left.type !== right.type) return false;
  if (left.type === 'built-in') return true; // Display names are not runtime identity.
  if (left.type === 'package' && right.type === 'package')
    return left.package === right.package && left.tag === right.tag;
  return left.type === 'uri' && right.type === 'uri' && left.uri === right.uri;
}

function* projectSubgraphs(project: Project) {
  for (const [sourceGraphId, graph] of Object.entries(project.graphs)) {
    for (const authored of graph.nodes) {
      const node = resolveNodePrefabInstance(project, authored);
      if (!node.disabled && node.type === 'nodePrefabInstance')
        throw new ProjectBundleError(`Bundle contains an unresolved library node ${node.id}.`);
      if (node.disabled || node.type !== 'subGraph') continue;
      const data = (node as SubGraphNode).data;
      if (data.targetProjectId) {
        if (data.targetVersion !== undefined && data.targetVersion !== 'latest' && data.targetVersion !== 'published')
          throw new ProjectBundleError('Invalid Subgraph project version.');
      } else if (data.targetScope === 'other-projects') {
        throw new ProjectBundleError(`Subgraph ${node.title || node.id} has no selected project.`);
      }
      yield { sourceGraphId, data };
    }
  }
}

export function listProjectBundleCalls(
  project: Project,
): { projectId: string; version: 'latest' | 'published'; graphId: string; boundary?: GraphBoundary }[] {
  const calls: ReturnType<typeof listProjectBundleCalls> = [];
  for (const { data } of projectSubgraphs(project)) {
    if (data.targetProjectId)
      calls.push({
        projectId: data.targetProjectId,
        version: data.targetVersion ?? 'latest',
        graphId: data.graphId,
        boundary: data.targetBoundary,
      });
  }
  return calls;
}

/** Uses the same saved wire contract as runtime execution, without running any nodes. */
export function validateProjectBundleCall(
  call: ReturnType<typeof listProjectBundleCalls>[number],
  target: Project,
): void {
  if (!Object.hasOwn(target.graphs, call.graphId))
    throw new ProjectBundleError(`Subgraph dependency is missing graph ${call.graphId}.`);
  const boundary = getGraphBoundary(target, call.graphId as keyof Project['graphs']);
  if (!boundary) throw new ProjectBundleError(`Subgraph dependency is missing graph ${call.graphId}.`);
  const issue = getSubgraphTargetBoundaryIssue(call.boundary, boundary);
  if (issue) throw new ProjectBundleError(`Subgraph dependency has an incompatible boundary. ${issue}`);
}

/** Reject missing bindings and cross-project dependency cycles before executing any graph. */
export function validateProjectBundleProjects(
  manifest: ProjectBundleManifest,
  projects: ReadonlyMap<string, Project>,
): void {
  const targets = new Map(manifest.targets.map((t) => [projectBundleTargetKey(t.projectId, t.version), t.artifact]));
  const references = new Map(manifest.references.map((r) => [r.projectId, r.artifact]));
  const plugins = new Map(manifest.plugins.map((plugin) => [plugin.id, plugin]));
  type Vertex = { edges: { target: Vertex; crossProject: boolean }[] };
  const vertices = new Map<string, Vertex>();
  const graphKey = (artifact: string, graph: string) => JSON.stringify([artifact, graph]);
  for (const artifact of manifest.artifacts) {
    const project = projects.get(artifact.id);
    if (!project || project.metadata.id !== artifact.projectId)
      throw new ProjectBundleError('Bundle project identity mismatch.');
    for (const requirement of project.plugins ?? []) {
      const declared = plugins.get(requirement.id);
      if (!declared || !samePluginRequirement(declared, requirement))
        throw new ProjectBundleError(`Bundle is missing the required plugin declaration ${requirement.id}.`);
    }
    for (const graphId of Object.keys(project.graphs)) vertices.set(graphKey(artifact.id, graphId), { edges: [] });
  }
  for (const artifact of manifest.artifacts) {
    const project = projects.get(artifact.id)!;
    for (const { sourceGraphId, data } of projectSubgraphs(project)) {
      let targetId = artifact.id;
      if (data.targetProjectId) {
        const call = {
          projectId: data.targetProjectId,
          version: data.targetVersion ?? 'latest',
          graphId: data.graphId,
          boundary: data.targetBoundary,
        };
        const id = targets.get(projectBundleTargetKey(call.projectId, call.version));
        const target = id && projects.get(id);
        if (!id || !target)
          throw new ProjectBundleError(`Bundle is missing Subgraph ${call.projectId}:${call.version}:${call.graphId}`);
        validateProjectBundleCall(call, target);
        targetId = id;
      }
      const target = vertices.get(graphKey(targetId, data.graphId));
      if (target)
        vertices.get(graphKey(artifact.id, sourceGraphId))!.edges.push({
          target,
          crossProject: Boolean(data.targetProjectId),
        });
    }
    for (const reference of project.references ?? []) {
      if (!references.has(reference.id))
        throw new ProjectBundleError(`Bundle is missing referenced project ${reference.id}`);
    }
    for (const [sourceGraphId, graph] of Object.entries(project.graphs)) {
      for (const authored of graph.nodes) {
        const node = resolveNodePrefabInstance(project, authored);
        if (node.disabled || node.type !== 'referencedGraphAlias') continue;
        const { projectId, graphId } = (node as ReferencedGraphAliasNode).data;
        const targetId = references.get(projectId);
        const target = targetId && vertices.get(graphKey(targetId, graphId));
        if (!target) throw new ProjectBundleError(`Bundle is missing referenced graph ${projectId}:${graphId}`);
        // Legacy-only recursion keeps its existing semantics, but aliases can
        // participate in a cycle containing an explicit cross-project call.
        vertices.get(graphKey(artifact.id, sourceGraphId))!.edges.push({ target, crossProject: false });
      }
    }
  }
  // Project-level cycles can be legitimate: A/main → B/main → A/helper.
  // Reject only a recursive graph-call component containing a cross-project edge.
  for (const component of findStronglyConnectedComponents([...vertices.values()], (v) =>
    v.edges.map((e) => e.target),
  )) {
    const members = new Set(component);
    if (component.some((v) => v.edges.some((e) => e.crossProject && members.has(e.target))))
      throw new ProjectBundleError('Subgraph cross-project dependency cycle in bundle.');
  }
}

export function validateProjectBundleManifest(value: unknown): ProjectBundleManifest {
  const fail = (message: string): never => {
    throw new ProjectBundleError(`Invalid project bundle: ${message}`);
  };
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail('expected object');
  const string = (v: unknown): string =>
    typeof v === 'string' && v.length > 0 && v.length <= 4096 ? v : fail('expected nonempty string');
  const array = (v: unknown): unknown[] =>
    Array.isArray(v) && v.length <= PROJECT_BUNDLE_MAX_ARTIFACTS ? v : fail('invalid or oversized list');
  const version = (v: unknown): 'latest' | 'published' =>
    v === 'latest' || v === 'published' ? v : fail('unknown project version');
  const paths = new Set<string>();
  const file = (v: unknown): ProjectBundleFile => {
    const obj = object(v),
      path = string(obj.path);
    if (
      path.includes('\\') ||
      path.includes(':') ||
      path.includes('\0') ||
      path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(path.toLowerCase())
    )
      fail('unsafe or duplicate artifact path');
    paths.add(path.toLowerCase());
    if (!Number.isSafeInteger(obj.bytes) || (obj.bytes as number) < 0 || (obj.bytes as number) > 64 * 1024 * 1024)
      fail('invalid artifact size (maximum 64 MiB per file)');
    if (typeof obj.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(obj.sha256)) fail('invalid checksum');
    return { path, bytes: obj.bytes as number, sha256: obj.sha256 as string };
  };
  const obj = object(value);
  if (obj.format !== 'rivet-project-bundle' || obj.schemaVersion !== 1 || obj.requiredLoaderVersion !== 1)
    fail('unsupported format or loader version; update @valerypopoff/rivet2-node');
  const artifacts = array(obj.artifacts).map((v): ProjectBundleArtifact => {
    const a = object(v);
    return {
      id: string(a.id),
      projectId: string(a.projectId),
      title: string(a.title),
      version: version(a.version),
      revision: string(a.revision),
      project: file(a.project),
      ...(a.datasets === undefined ? {} : { datasets: file(a.datasets) }),
    };
  });
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  if (!artifacts.length || byId.size !== artifacts.length) fail('empty or duplicate artifacts');
  if (new Set(artifacts.map((a) => projectBundleTargetKey(a.projectId, a.version))).size !== artifacts.length)
    fail('duplicate project/version artifacts');
  const rootArtifact = string(obj.rootArtifact);
  if (!byId.has(rootArtifact)) fail('missing root artifact');
  const targetKeys = new Set<string>(),
    referenceIds = new Set<string>();
  const targets = array(obj.targets).map((v) => {
    const t = object(v),
      projectId = string(t.projectId),
      selectedVersion = version(t.version),
      artifact = string(t.artifact);
    const key = projectBundleTargetKey(projectId, selectedVersion),
      a = byId.get(artifact);
    if (targetKeys.has(key) || !a || a.projectId !== projectId || a.version !== selectedVersion)
      fail('invalid or duplicate target binding');
    targetKeys.add(key);
    return { projectId, version: selectedVersion, artifact };
  });
  const references = array(obj.references).map((v) => {
    const r = object(v),
      projectId = string(r.projectId),
      artifact = string(r.artifact);
    if (referenceIds.has(projectId) || byId.get(artifact)?.projectId !== projectId)
      fail('invalid or duplicate reference binding');
    referenceIds.add(projectId);
    return { projectId, artifact };
  });
  const pluginSpecs = array(obj.plugins).map((v): PluginLoadSpec => {
    const p = object(v),
      id = string(p.id);
    if (p.type === 'built-in') return { type: p.type, id, name: string(p.name) };
    if (p.type === 'package') return { type: p.type, id, package: string(p.package), tag: string(p.tag) };
    if (p.type === 'uri') return { type: p.type, id, uri: string(p.uri) };
    return fail('invalid plugin requirement');
  });
  const pluginsById = new Map<string, PluginLoadSpec>();
  for (const plugin of pluginSpecs) {
    const previous = pluginsById.get(plugin.id);
    if (previous && !samePluginRequirement(previous, plugin)) fail(`conflicting requirements for plugin ${plugin.id}`);
    if (!previous) pluginsById.set(plugin.id, plugin);
  }
  return {
    format: 'rivet-project-bundle',
    schemaVersion: 1,
    requiredLoaderVersion: 1,
    exportingRuntimeVersion: string(obj.exportingRuntimeVersion),
    rootArtifact,
    artifacts,
    targets,
    references,
    plugins: [...pluginsById.values()],
  };
}
