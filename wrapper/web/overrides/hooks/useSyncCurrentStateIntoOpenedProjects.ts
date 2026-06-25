import { useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../../../../rivet/packages/app/src/state/graph';
import {
  loadedProjectState,
  type OpenedProjectInfo,
  type OpenedProjectSnapshot,
  type OpenedProjectsInfo,
  openedProjectSnapshotsState,
  openedProjectsState,
  openedProjectsSortedIdsState,
  projectDataState,
  projectUnsavedChangesState,
  projectState,
  projectsState,
  savedProjectContentDigestsState,
} from '../../../../rivet/packages/app/src/state/savedGraphs';
import { trivetState } from '../../../../rivet/packages/app/src/state/trivet';
import { addOpenedProject } from '../../../../rivet/packages/app/src/utils/openedProjects.js';
import { useExecutorSessionState } from '../../../../rivet/packages/app/src/hooks/useExecutorSession.js';
import {
  projectExecutorModesEqual,
  resolveCurrentProjectExecutorMode,
  sanitizeProjectExecutorMode,
  type ProjectExecutorMode,
} from '../../../../rivet/packages/app/src/utils/projectExecutorMode.js';
import {
  buildCurrentProjectContentSnapshot,
  getProjectContentDigest,
  markProjectClean,
  markProjectDirtyFlag,
} from '../../../../rivet/packages/app/src/utils/projectUnsavedChanges.js';
import { selectedExecutorState } from '../state/settings';
import { resolveHostedProjectTitle, withHostedProjectTitle } from '../../dashboard/openedProjectMetadata';
import { primeOpenedProjectSession, syncOpenedProjectSessionIds } from '../../io/openedProjectSessionCache';

type LegacyOpenedProjectInfo = Partial<OpenedProjectInfo> & {
  project?: (Omit<Project, 'data'> & { data?: Project['data'] }) | null;
};

function shouldRegisterCurrentProjectInOpenedProjects({
  currentProjectId,
  loadedProjectPath,
  openedProjectIds,
  suppressedClosedProjectIds,
}: {
  currentProjectId: ProjectId;
  loadedProjectPath: string | null | undefined;
  openedProjectIds: ProjectId[];
  suppressedClosedProjectIds: ReadonlySet<ProjectId>;
}) {
  if (suppressedClosedProjectIds.has(currentProjectId)) {
    return false;
  }

  if (openedProjectIds.length > 0 && !openedProjectIds.includes(currentProjectId)) {
    return false;
  }

  // After the last tab closes, Rivet can still retain a pathless scratch project
  // in projectState. Do not resurrect that stale project as a persisted tab.
  if (openedProjectIds.length === 0 && !loadedProjectPath) {
    return false;
  }

  return true;
}

function normalizeOpenedProjectEntry(previousProjectId: ProjectId, entry: LegacyOpenedProjectInfo) {
  const legacyProject = entry.project ?? null;
  const projectId = (entry.projectId ?? legacyProject?.metadata?.id ?? previousProjectId) as ProjectId;
  const fsPath = entry.fsPath ?? null;
  const executorMode = sanitizeProjectExecutorMode(entry.executorMode);
  const title = resolveHostedProjectTitle(
    {
      metadata: {
        ...legacyProject?.metadata,
        title: entry.title ?? legacyProject?.metadata?.title,
      },
    } as Pick<Project, 'metadata'>,
    fsPath,
  );
  const openedGraph = entry.openedGraph ?? legacyProject?.metadata?.mainGraphId;
  const info: OpenedProjectInfo = {
    projectId,
    title,
    fsPath,
    ...(executorMode ? { executorMode } : {}),
    ...(openedGraph ? { openedGraph: openedGraph as GraphId } : {}),
  };
  const rawExecutorMode = entry.executorMode as ProjectExecutorMode | undefined;
  const executorModeChanged =
    rawExecutorMode == null
      ? executorMode !== undefined
      : !executorMode || !projectExecutorModesEqual(rawExecutorMode, executorMode);

  return {
    projectId,
    info,
    legacyProject,
    changed:
      projectId !== previousProjectId ||
      entry.projectId !== projectId ||
      entry.title !== title ||
      entry.fsPath !== fsPath ||
      entry.openedGraph !== openedGraph ||
      executorModeChanged ||
      'project' in entry,
  };
}

function normalizeOpenedProjects(
  previousProjects: OpenedProjectsInfo,
  options: {
    currentProjectId: ProjectId | undefined;
    openedProjectSnapshots: Record<ProjectId, OpenedProjectSnapshot>;
  },
): OpenedProjectsInfo {
  let changed = false;
  const seenProjectIds = new Set<ProjectId>();
  const nextOpenedProjects: Record<ProjectId, OpenedProjectInfo> = {};
  const nextOpenedProjectIds: ProjectId[] = [];

  for (const previousProjectId of previousProjects.openedProjectsSortedIds) {
    const entry = previousProjects.openedProjects[previousProjectId] as LegacyOpenedProjectInfo | undefined;
    if (!entry) {
      changed = true;
      continue;
    }

    const normalized = normalizeOpenedProjectEntry(previousProjectId, entry);

    if (seenProjectIds.has(normalized.projectId)) {
      changed = true;
      const existingInfo = nextOpenedProjects[normalized.projectId];
      if (existingInfo && !existingInfo.fsPath && normalized.info.fsPath) {
        nextOpenedProjects[normalized.projectId] = normalized.info;
      }
      continue;
    }

    const hasActivatableSnapshot =
      Boolean(options.openedProjectSnapshots[normalized.projectId]) ||
      Boolean(normalized.legacyProject) ||
      options.currentProjectId === normalized.projectId;

    if (!normalized.info.fsPath && !hasActivatableSnapshot) {
      changed = true;
      continue;
    }

    seenProjectIds.add(normalized.projectId);
    nextOpenedProjects[normalized.projectId] = normalized.info;
    nextOpenedProjectIds.push(normalized.projectId);

    if (normalized.changed) {
      changed = true;
    }
  }

  if (!changed) {
    changed = Object.keys(previousProjects.openedProjects).length !== nextOpenedProjectIds.length;
  }

  return changed
    ? {
        openedProjects: nextOpenedProjects,
        openedProjectsSortedIds: nextOpenedProjectIds,
      }
    : previousProjects;
}

export function useSyncCurrentStateIntoOpenedProjects({ enabled = true }: { enabled?: boolean } = {}) {
  const setProjects = useSetAtom(projectsState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);

  const currentProject = useAtomValue(projectState);
  const currentProjectData = useAtomValue(projectDataState);
  const loadedProject = useAtomValue(loadedProjectState);
  const currentGraph = useAtomValue(graphState);
  const currentTrivetState = useAtomValue(trivetState);
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const executorSession = useExecutorSessionState();
  const executorTargetType = executorSession.target?.type;
  const executorTargetUrl = executorSession.target?.url;
  const executorTarget = useMemo(
    () =>
      executorTargetType != null && executorTargetUrl != null
        ? {
            type: executorTargetType,
            url: executorTargetUrl,
          }
        : null,
    [executorTargetType, executorTargetUrl],
  );
  const savedProjectContentDigests = useAtomValue(savedProjectContentDigestsState);
  const openedProjects = useAtomValue(openedProjectsState);
  const openedProjectSnapshots = useAtomValue(openedProjectSnapshotsState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const currentExecutorMode = useMemo(
    () =>
      resolveCurrentProjectExecutorMode({
        selectedExecutor,
        target: executorTarget,
      }),
    [executorTarget, selectedExecutor],
  );
  const currentProjectWithData = useMemo(
    () => ({
      ...currentProject,
      data: currentProjectData,
    }),
    [currentProject, currentProjectData],
  );
  const previousOpenedProjectIdsRef = useRef<ProjectId[]>([]);
  const suppressedClosedProjectIdsRef = useRef<Set<ProjectId>>(new Set());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    syncOpenedProjectSessionIds(openedProjectIds);
  }, [enabled, openedProjectIds]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    setProjects((previousProjects) =>
      normalizeOpenedProjects(previousProjects, {
        currentProjectId,
        openedProjectSnapshots,
      }),
    );
  }, [currentProject.metadata.id, enabled, openedProjectSnapshots, setProjects]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    setOpenedProjectSnapshots((previousSnapshots) => {
      let changed = false;
      const nextSnapshots = { ...previousSnapshots };
      const openProjectIdSet = new Set(openedProjectIds);

      for (const entry of Object.values(openedProjects) as LegacyOpenedProjectInfo[]) {
        const legacyProject = entry.project ?? null;
        const projectId = (entry.projectId ?? legacyProject?.metadata?.id) as ProjectId | undefined;
        if (!legacyProject || !projectId || nextSnapshots[projectId]) {
          continue;
        }

        nextSnapshots[projectId] = {
          project: withHostedProjectTitle(legacyProject, entry.fsPath),
          data: legacyProject.data,
        };
        changed = true;
      }

      for (const projectId of Object.keys(nextSnapshots) as ProjectId[]) {
        if (!openProjectIdSet.has(projectId)) {
          delete nextSnapshots[projectId];
          changed = true;
        }
      }

      return changed ? nextSnapshots : previousSnapshots;
    });
  }, [enabled, openedProjectIds, openedProjects, setOpenedProjectSnapshots]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    const previousOpenedProjectIds = previousOpenedProjectIdsRef.current;

    if (
      currentProjectId &&
      previousOpenedProjectIds.includes(currentProjectId) &&
      !openedProjectIds.includes(currentProjectId)
    ) {
      suppressedClosedProjectIdsRef.current.add(currentProjectId);
    }

    for (const openedProjectId of openedProjectIds) {
      suppressedClosedProjectIdsRef.current.delete(openedProjectId);
    }

    previousOpenedProjectIdsRef.current = openedProjectIds;
  }, [currentProject.metadata.id, enabled, openedProjectIds]);

  // Clear the file-backed loaded path when the last opened project tab is gone.
  // This keeps scratch-project state from still looking file-backed after everything closes.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (openedProjectIds.length === 0 && loadedProject.path) {
      setLoadedProject({ loaded: false, path: '' });
    }
  }, [enabled, loadedProject.path, openedProjectIds.length, setLoadedProject]);

  // Ensure the active project exists in the opened-project registry unless the user just closed
  // that active tab. Rivet 2.0 keeps full project content in openedProjectSnapshotsState; this
  // registry is lightweight tab metadata only.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    if (!currentProjectId) {
      return;
    }

    if (
      !shouldRegisterCurrentProjectInOpenedProjects({
        currentProjectId,
        loadedProjectPath: loadedProject.path,
        openedProjectIds,
        suppressedClosedProjectIds: suppressedClosedProjectIdsRef.current,
      })
    ) {
      return;
    }

    setProjects((previousProjects) => {
      const existingProject = previousProjects.openedProjects[currentProjectId];
      const nextOpenedGraph = currentGraph?.metadata?.id;
      const nextFsPath = loadedProject.path ?? existingProject?.fsPath ?? null;
      const projectForTab = withHostedProjectTitle(currentProjectWithData, nextFsPath);
      const nextTitle = resolveHostedProjectTitle(projectForTab, nextFsPath);
      const nextProjects = addOpenedProject(previousProjects, projectForTab, {
        ...(loadedProject.path ? { fsPath: loadedProject.path } : {}),
        ...(nextOpenedGraph ? { openedGraph: nextOpenedGraph } : {}),
        executorMode: currentExecutorMode,
      });
      const nextProject = nextProjects.openedProjects[currentProjectId];

      if (
        existingProject?.title === nextTitle &&
        existingProject?.fsPath === nextFsPath &&
        existingProject?.openedGraph === nextOpenedGraph &&
        projectExecutorModesEqual(existingProject?.executorMode, currentExecutorMode) &&
        previousProjects.openedProjectsSortedIds.includes(currentProjectId)
      ) {
        return previousProjects;
      }

      return nextProject ? nextProjects : previousProjects;
    });
  }, [
    currentExecutorMode,
    currentGraph?.metadata?.id,
    currentProject,
    currentProjectWithData,
    enabled,
    loadedProject.path,
    openedProjectIds,
    setProjects,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    if (!currentProjectId || !openedProjectIds.includes(currentProjectId)) {
      return;
    }

    const expectedProjectPath = openedProjects[currentProjectId]?.fsPath ?? null;
    const loadedProjectPath = loadedProject.path ?? null;

    if (expectedProjectPath && loadedProjectPath && expectedProjectPath !== loadedProjectPath) {
      return;
    }

    primeOpenedProjectSession(currentProjectId, {
      fsPath: expectedProjectPath ?? loadedProjectPath,
      testData: {
        testSuites: currentTrivetState.testSuites,
      },
    });
  }, [
    currentProject.metadata.id,
    currentTrivetState.testSuites,
    enabled,
    loadedProject.path,
    openedProjectIds,
    openedProjects,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    if (!currentProjectId || !currentGraph) {
      return;
    }

    const snapshot = buildCurrentProjectContentSnapshot({
      project: currentProject,
      graph: currentGraph,
    });
    const savedDigest = savedProjectContentDigests[currentProjectId];

    if (!savedDigest) {
      setSavedProjectContentDigests((previousDigests) => markProjectClean(previousDigests, snapshot));
      setProjectUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, currentProjectId, false));
      return;
    }

    const currentDigest = getProjectContentDigest(snapshot);
    setProjectUnsavedChanges((previousFlags) =>
      markProjectDirtyFlag(previousFlags, currentProjectId, currentDigest !== savedDigest),
    );
  }, [
    currentGraph,
    currentProject,
    enabled,
    savedProjectContentDigests,
    setProjectUnsavedChanges,
    setSavedProjectContentDigests,
  ]);
}
