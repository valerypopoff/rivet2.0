import { useEffect, useRef } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../state/graph.js';
import { loadedProjectState, openedProjectSnapshotsState, projectState, projectsState } from '../state/savedGraphs.js';
import { selectedExecutorState } from '../state/settings.js';
import { addOpenedProject, resolveSyncedOpenedProjectFsPathOptions } from '../utils/openedProjects.js';
import { projectExecutorModesEqual, resolveCurrentProjectExecutorMode } from '../utils/projectExecutorMode.js';
import { reconcileOpenedProjectRegistry } from '../utils/openedProjectSynchronization.js';
import { useProviders } from '../providers/ProvidersContext.js';
import { useExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import { useOwnExecutorSessionState } from './useExecutorSession.js';
import { useSyncProjectDirtyState } from './useSyncProjectDirtyState.js';

export function useSyncCurrentStateIntoOpenedProjects({ enabled = true }: { enabled?: boolean } = {}) {
  const store = useStore();
  const executorSessions = useExecutorSessionRegistry();
  const { openedProjectSync: policy, projectActivation } = useProviders();
  const currentProject = useAtomValue(projectState);
  const loadedProject = useAtomValue(loadedProjectState);
  const currentGraphId = useAtomValue(graphState).metadata?.id;
  const projects = useAtomValue(projectsState);
  const snapshots = useAtomValue(openedProjectSnapshotsState);
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const { target } = useOwnExecutorSessionState();
  const targetType = target?.type;
  const targetUrl = target?.url;
  const normalizeExecutorMode = projectActivation?.normalizeExecutorMode;
  // Seed from render: a layout-phase close can precede our first passive effect.
  const previousIds = useRef<readonly ProjectId[]>(projects.openedProjectsSortedIds);
  const suppressedClosedIds = useRef(new Set<ProjectId>());
  const explicitTabs = policy?.mode === 'explicit-tabs';
  useSyncProjectDirtyState(enabled);

  useEffect(() => {
    if (!enabled) return;
    // Read the current store, not a render's intermediate project/path snapshot.
    const project = store.get(projectState);
    const id = project.metadata.id;
    let previous = store.get(projectsState);
    if (explicitTabs) {
      const recovered = reconcileOpenedProjectRegistry(previous, {
        currentProjectId: id,
        openedProjectSnapshots: store.get(openedProjectSnapshotsState),
        resolveTitle: policy.resolveTitle,
        normalizeExecutorMode,
      });
      if (recovered.snapshots !== store.get(openedProjectSnapshotsState))
        store.set(openedProjectSnapshotsState, recovered.snapshots);
      if (recovered.projects !== previous) store.set(projectsState, recovered.projects);
      previous = recovered.projects;
    }
    const ids = previous.openedProjectsSortedIds;
    if (id && previousIds.current.includes(id) && !ids.includes(id)) suppressedClosedIds.current.add(id);
    for (const openId of ids) suppressedClosedIds.current.delete(openId);
    previousIds.current = ids;
    const loadedPath = store.get(loadedProjectState).path;
    const canRegister =
      Boolean(id) &&
      (!explicitTabs ||
        (!suppressedClosedIds.current.has(id) && (ids.length > 0 ? ids.includes(id) : Boolean(loadedPath))));
    if (!canRegister) {
      // A closed workspace releases its path; legacy recovery of a still-loaded
      // file must retain that same path when rebuilding its missing tab entry.
      if (explicitTabs && ids.length === 0 && loadedPath) store.set(loadedProjectState, { loaded: false, path: '' });
      return;
    }

    // The active project may have changed after render. Its own live session,
    // not the rendered tab's target or bundle observer, owns persisted mode.
    const mode = resolveCurrentProjectExecutorMode({
      selectedExecutor: store.get(selectedExecutorState),
      target: executorSessions.getRuntime(id).buildSessionState().target,
    });
    const currentExecutorMode = normalizeExecutorMode ? normalizeExecutorMode(mode) : mode;
    const existing = previous.openedProjects[id];
    const graphId = store.get(graphState).metadata?.id;
    const openedGraph = graphId && (!explicitTabs || project.graphs[graphId]) ? graphId : existing?.openedGraph;
    const fsPathOptions = resolveSyncedOpenedProjectFsPathOptions(previous, id, loadedPath);
    const path = 'fsPath' in fsPathOptions ? fsPathOptions.fsPath ?? null : existing?.fsPath ?? null;
    const title = policy?.resolveTitle?.(project, path) ?? project.metadata.title;
    if (
      existing?.title === title &&
      existing?.fsPath === path &&
      existing?.openedGraph === openedGraph &&
      projectExecutorModesEqual(existing?.executorMode, currentExecutorMode) &&
      ids.includes(id)
    )
      return;
    store.set(
      projectsState,
      addOpenedProject(
        previous,
        { ...project, metadata: { ...project.metadata, title } },
        {
          ...fsPathOptions,
          ...(openedGraph ? { openedGraph } : {}),
          executorMode: currentExecutorMode,
        },
      ),
    );
  }, [
    currentGraphId,
    currentProject,
    enabled,
    explicitTabs,
    executorSessions,
    loadedProject.path,
    normalizeExecutorMode,
    policy,
    projects,
    selectedExecutor,
    snapshots,
    store,
    targetType,
    targetUrl,
  ]);

  const openIds = projects.openedProjectsSortedIds;
  useEffect(() => {
    if (enabled) policy?.onOpenProjectIdsChanged?.(store.get(projectsState).openedProjectsSortedIds);
  }, [enabled, openIds, policy, store]);
}
