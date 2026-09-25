import type { DatasetProvider } from '../integrations/DatasetProvider.js';
import type { Project, ProjectId } from './Project.js';
import type { GraphId } from './NodeGraph.js';
import type { ExecutionRecorder } from '../recording/ExecutionRecorder.js';

/** Studio Server resolves these targets from saved storage, never from an editor tab. */
export type SubgraphProjectVersion = 'latest' | 'published';

export type SubgraphProjectTarget = {
  projectId: ProjectId;
  version: SubgraphProjectVersion;
};

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
};

/** Internal definition key; not a project metadata ID or a persisted reference. */
export function getSubgraphProjectKey(target: SubgraphProjectTarget): ProjectId {
  return `\u0000rivet-subgraph:${target.version}:${encodeURIComponent(target.projectId)}` as ProjectId;
}

export function isSubgraphProjectKey(key: string): boolean {
  return key.startsWith('\u0000rivet-subgraph:');
}
