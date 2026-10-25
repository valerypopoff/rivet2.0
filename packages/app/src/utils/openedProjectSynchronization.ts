import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo, OpenedProjectSnapshot, OpenedProjectsInfo } from '../state/savedGraphs.js';
import { isValidOpenedProjectSnapshot } from './openedProjectSnapshots.js';
import {
  projectExecutorModesEqual,
  sanitizeProjectExecutorMode,
  type ProjectExecutorMode,
} from './projectExecutorMode.js';

/** Explicit-tab hosts own opening/closing; the editor owns synchronization and recovery. */
export type OpenedProjectSynchronizationPolicy = {
  mode: 'explicit-tabs';
  resolveTitle?: (project: Pick<Project, 'metadata'>, path?: string | null) => string;
  onOpenProjectIdsChanged?: (ids: readonly ProjectId[]) => void;
};

type LegacyOpenedProjectInfo = Partial<OpenedProjectInfo> & { project?: Project | null };
type RecoveryOptions = {
  currentProjectId?: ProjectId;
  openedProjectSnapshots: Record<ProjectId, OpenedProjectSnapshot>;
  resolveTitle?: OpenedProjectSynchronizationPolicy['resolveTitle'];
  normalizeExecutorMode?: (mode: ProjectExecutorMode | undefined) => ProjectExecutorMode | undefined;
};

const string = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Repair the metadata and legacy snapshots together, before stripping legacy payloads. */
export function reconcileOpenedProjectRegistry(previous: OpenedProjectsInfo, options: RecoveryOptions) {
  const openedProjects = new Map<ProjectId, OpenedProjectInfo>();
  let changed = false;
  let snapshots = options.openedProjectSnapshots;
  const setSnapshot = (id: ProjectId, snapshot: OpenedProjectSnapshot | undefined) => {
    if (snapshots === options.openedProjectSnapshots) snapshots = { ...snapshots };
    if (snapshot)
      Object.defineProperty(snapshots, id, { value: snapshot, enumerable: true, configurable: true, writable: true });
    else delete snapshots[id];
  };
  for (const previousId of previous.openedProjectsSortedIds) {
    const entry = previous.openedProjects[previousId] as LegacyOpenedProjectInfo | undefined;
    if (!entry || typeof entry !== 'object') {
      changed = true;
      continue;
    }
    const legacyProject = entry.project;
    const projectId = (string(entry.projectId) ?? string(legacyProject?.metadata?.id) ?? previousId) as ProjectId;
    const fsPath = string(entry.fsPath) ?? null;
    const rawTitle = string(entry.title) ?? string(legacyProject?.metadata?.title);
    const titleProject = { metadata: { id: projectId, title: rawTitle ?? '', description: '' } };
    const title = options.resolveTitle?.(titleProject, fsPath) ?? rawTitle ?? 'Untitled Project';
    const executorMode = (options.normalizeExecutorMode ?? sanitizeProjectExecutorMode)(entry.executorMode);
    const openedGraph = (string(entry.openedGraph) ?? string(legacyProject?.metadata?.mainGraphId)) as
      | GraphId
      | undefined;
    const info: OpenedProjectInfo = {
      projectId,
      title,
      fsPath,
      ...(string(entry.bundleManifestPath) ? { bundleManifestPath: string(entry.bundleManifestPath) } : {}),
      ...(typeof entry.hostedBundleKey === 'string' || entry.hostedBundleKey === null
        ? { hostedBundleKey: entry.hostedBundleKey }
        : {}),
      ...(typeof entry.bundleMember === 'boolean' ? { bundleMember: entry.bundleMember } : {}),
      ...(executorMode ? { executorMode } : {}),
      ...(openedGraph ? { openedGraph } : {}),
    };
    const legacySnapshot = { project: legacyProject, data: legacyProject?.data };
    const validLegacy = isValidOpenedProjectSnapshot(legacySnapshot, projectId);
    if (
      !fsPath &&
      options.currentProjectId !== projectId &&
      !validLegacy &&
      !isValidOpenedProjectSnapshot(snapshots[projectId], projectId)
    ) {
      changed = true;
      continue;
    }
    if (!isValidOpenedProjectSnapshot(snapshots[projectId], projectId) && validLegacy) {
      setSnapshot(projectId, {
        project: { ...legacyProject!, metadata: { ...legacyProject!.metadata, title } },
        data: legacyProject!.data,
      });
    }
    const existing = openedProjects.get(projectId);
    if (existing) {
      changed = true;
      if (!existing.fsPath && fsPath) openedProjects.set(projectId, info);
      continue;
    }
    openedProjects.set(projectId, info);
    if (
      projectId !== previousId ||
      'project' in entry ||
      entry.projectId !== projectId ||
      entry.title !== title ||
      entry.fsPath !== fsPath ||
      entry.openedGraph !== openedGraph ||
      entry.hostedBundleKey !== info.hostedBundleKey ||
      entry.bundleManifestPath !== info.bundleManifestPath ||
      entry.bundleMember !== info.bundleMember ||
      (entry.executorMode !== undefined && executorMode === undefined) ||
      !projectExecutorModesEqual(entry.executorMode, executorMode)
    )
      changed = true;
  }
  if (Object.keys(previous.openedProjects).length !== openedProjects.size) changed = true;
  for (const id of Object.keys(snapshots) as ProjectId[]) {
    if (!openedProjects.has(id) || !isValidOpenedProjectSnapshot(snapshots[id], id)) setSnapshot(id, undefined);
  }
  return {
    projects: changed
      ? { openedProjects: Object.fromEntries(openedProjects), openedProjectsSortedIds: [...openedProjects.keys()] }
      : previous,
    snapshots,
  };
}
