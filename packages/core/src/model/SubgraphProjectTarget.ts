import type { DatasetProvider } from '../integrations/DatasetProvider.js';
import type { Project, ProjectId } from './Project.js';
import type { GraphId } from './NodeGraph.js';
import type { ExecutionRecorder } from '../recording/ExecutionRecorder.js';
import type { NodeId } from './NodeBase.js';

/** Hosts resolve targets from saved storage; portable bundles resolve their captured snapshots. Never an editor tab. */
export type SubgraphProjectVersion = 'latest' | 'published';

export type SubgraphProjectTarget = {
  projectId: ProjectId;
  version: SubgraphProjectVersion;
  /** Actual graph owner, supplied by the processor rather than persisted node configuration. */
  callerProjectId?: ProjectId;
};

/** Historical display evidence only; never a target-resolution or access authority. */
export type SubgraphTargetDisplaySnapshot = {
  nodeId: NodeId;
  targetProjectId: ProjectId;
  targetVersion: SubgraphProjectVersion;
  targetGraphId: GraphId;
  projectName?: string;
  graphName?: string;
};

/** Copy only display fields from optional recording/transport data. */
export function readSubgraphTargetDisplaySnapshots(value: unknown): SubgraphTargetDisplaySnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const snapshots: SubgraphTargetDisplaySnapshot[] = [];
  for (const item of value) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
    const { nodeId, targetProjectId, targetVersion, targetGraphId, projectName, graphName } = item;
    if (
      typeof nodeId !== 'string' ||
      !nodeId.trim() ||
      typeof targetProjectId !== 'string' ||
      !targetProjectId.trim() ||
      typeof targetGraphId !== 'string' ||
      !targetGraphId.trim() ||
      (targetVersion !== 'latest' && targetVersion !== 'published') ||
      (projectName !== undefined && typeof projectName !== 'string') ||
      (graphName !== undefined && typeof graphName !== 'string')
    )
      continue;
    const hasProjectName = typeof projectName === 'string' && projectName.trim().length > 0;
    const hasGraphName = typeof graphName === 'string' && graphName.trim().length > 0;
    if (!hasProjectName && !hasGraphName) continue;
    snapshots.push({
      nodeId: nodeId as NodeId,
      targetProjectId: targetProjectId as ProjectId,
      targetVersion,
      targetGraphId: targetGraphId as GraphId,
      ...(hasProjectName ? { projectName } : {}),
      ...(hasGraphName ? { graphName } : {}),
    });
  }
  return snapshots.length ? snapshots : undefined;
}

export type ResolvedSubgraphProject = {
  project: Project;
  /** The selected project's dataset snapshot, when it differs from the caller's. */
  datasetProvider?: DatasetProvider;
  revisionKey?: string;
  /** Exact saved artifact used for execution, including embedded attachments. */
  projectContents?: string;
  datasetsContents?: string;
  /** Current source location for recording ownership; not used to execute. */
  sourceProjectPath?: string;
};

export type SubgraphProjectRun = {
  /** Logical run creation time, captured before execution; optional for older hosts. */
  createdAt?: string;
  target: SubgraphProjectTarget;
  resolved: ResolvedSubgraphProject;
  graphId: GraphId;
  recorder: ExecutionRecorder;
  status: 'succeeded' | 'failed';
  durationMs: number;
  errorMessage?: string;
  /** The caller's run correlation key, shared with its own recording when available. */
  correlationId?: string;
};

export type SubgraphProjectLoader = {
  loadTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject>;
  /** Recheck caller-dependent policy even when a target snapshot is already cached. */
  validateTarget?(target: SubgraphProjectTarget): Promise<void>;
};

/** Internal definition key; not a project metadata ID or a persisted reference. */
export function getSubgraphProjectKey(target: SubgraphProjectTarget): ProjectId {
  return `\u0000rivet-subgraph:${target.version}:${encodeURIComponent(target.projectId)}` as ProjectId;
}

export function isSubgraphProjectKey(key: string): boolean {
  return key.startsWith('\u0000rivet-subgraph:');
}
