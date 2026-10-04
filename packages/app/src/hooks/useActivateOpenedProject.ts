import { useStore } from 'jotai';
import type { GraphId } from '@valerypopoff/rivet2-core';
import { graphState, isReadOnlyGraphState } from '../state/graph.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { isPathBasedIOProvider } from '../io/IOProvider.js';
import { useIOProvider } from '../providers/ProvidersContext.js';
import {
  openedProjectSnapshotsState,
  type OpenedProjectInfo,
  projectState,
  projectsState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs.js';
import { handleError } from '../utils/errorHandling.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import type { EvaluationProjectFileData } from '../io/IOProvider.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';
import { normalizeProjectSnapshot } from './workspaceHost/projectSnapshot.js';
import { isValidOpenedProjectSnapshot } from '../utils/openedProjectSnapshots.js';
import { runLatestProjectActivation } from '../utils/projectActivationCoordinator.js';
import { markProjectClean } from '../utils/projectUnsavedChanges.js';

type ActivationPolicy = {
  getEvaluation?: (info: OpenedProjectInfo) => EvaluationProjectFileData | undefined;
  cacheEvaluation?: (info: OpenedProjectInfo, evaluation: EvaluationProjectFileData) => void;
  normalizeExecutorMode?: (mode: OpenedProjectInfo['executorMode']) => OpenedProjectInfo['executorMode'];
};

/** Shared tab activation owner. Hosts can cache Evaluation data, not replace
 * snapshot selection, identity checks, saved baselines, or race semantics. */
export function useActivateOpenedProject(policy: ActivationPolicy = {}) {
  const ioProvider = useIOProvider();
  const callbacks = useRivetAppHostCallbacks();
  const workspaceTransitions = useWorkspaceTransitions();
  const store = useStore();

  return (projectInfo: OpenedProjectInfo, options?: { preferredGraphId?: GraphId }): Promise<boolean> =>
    runLatestProjectActivation(store, async (isCurrent, signal) => {
      try {
        const currentInfo = store.get(projectsState).openedProjects[projectInfo.projectId];
        if (!currentInfo) {
          return false;
        }
        projectInfo = currentInfo;
        const requestedPath = projectInfo.fsPath;
        const isTabCurrent = () => {
          const latest = store.get(projectsState).openedProjects[projectInfo.projectId];
          return isCurrent() && latest !== undefined && latest.fsPath === requestedPath;
        };
        const currentProject = store.get(projectState);
        const currentGraph = store.get(graphState);
        const openedProjectSnapshots = store.get(openedProjectSnapshotsState);
        if (currentProject.metadata.id === projectInfo.projectId) {
          const target = store.get(projectWorkspaceTargetsState)[projectInfo.projectId];
          if (
            options?.preferredGraphId &&
            (currentGraph.metadata?.id !== options.preferredGraphId ||
              (target != null && target.type !== 'graph') ||
              store.get(isReadOnlyGraphState))
          ) {
            const graph = currentProject.graphs[options.preferredGraphId];
            if (!graph) {
              throw new Error('The selected graph is no longer in the open project.');
            }
            workspaceTransitions.switchGraph(graph);
          }
          return true;
        }

        let storedSnapshot = isValidOpenedProjectSnapshot(
          openedProjectSnapshots[projectInfo.projectId],
          projectInfo.projectId,
        )
          ? openedProjectSnapshots[projectInfo.projectId]
          : undefined;

        let project = storedSnapshot?.project;
        let data = storedSnapshot?.data;
        let markClean = false;
        let evaluation = policy.getEvaluation?.(projectInfo);

        const needsSavedBaseline = store.get(savedProjectContentDigestsState)[projectInfo.projectId] == null;
        if (
          projectInfo.fsPath &&
          isPathBasedIOProvider(ioProvider) &&
          (!project || (policy.getEvaluation !== undefined && !evaluation) || needsSavedBaseline)
        ) {
          const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath, {
            signal,
            deferCommit: true,
          });
          const latestInfo = store.get(projectsState).openedProjects[projectInfo.projectId];
          if (!isTabCurrent() || !latestInfo) {
            return false;
          }
          projectInfo = latestInfo;
          if (loadedProject.project.metadata.id !== projectInfo.projectId) {
            throw new Error(
              'The saved path now belongs to a different project. Close this tab and reopen from the project tree.',
            );
          }
          // A saved-file read may supply a missing baseline/Evaluation cache,
          // but an existing workspace snapshot is not a request to re-import
          // datasets or accept the disk revision over local edits.
          const snapshotBeforeCommit = store.get(openedProjectSnapshotsState)[projectInfo.projectId];
          if (
            !isValidOpenedProjectSnapshot(snapshotBeforeCommit, projectInfo.projectId) &&
            loadedProject.commit &&
            !(await loadedProject.commit(isTabCurrent))
          )
            return false;
          if (!isTabCurrent()) return false;
          projectInfo = store.get(projectsState).openedProjects[projectInfo.projectId]!;
          const latestSnapshot = store.get(openedProjectSnapshotsState)[projectInfo.projectId];
          storedSnapshot = isValidOpenedProjectSnapshot(latestSnapshot, projectInfo.projectId)
            ? latestSnapshot
            : undefined;
          project = storedSnapshot?.project ?? loadedProject.project;
          data = storedSnapshot ? storedSnapshot.data : loadedProject.project.data;
          markClean = !storedSnapshot;
          evaluation = loadedProject.evaluation;
          policy.cacheEvaluation?.(projectInfo, evaluation);
          if (store.get(savedProjectContentDigestsState)[projectInfo.projectId] == null) {
            const saved = normalizeProjectSnapshot({ project: loadedProject.project });
            store.set(savedProjectContentDigestsState, (digests) =>
              markProjectClean(digests, { project: saved.project }),
            );
          }
        }

        if (!project) {
          throw new Error(`No in-memory snapshot is available for "${projectInfo.title}".`);
        }

        // Stored tabs are object snapshots rather than serialized project files.
        // Normalize them at their restore boundary as well as when the app first
        // hydrates storage, so direct callers cannot revive legacy Jev node types.
        const normalized = normalizeProjectSnapshot({ project, data });
        project = normalized.project;
        data = normalized.data;
        const graphToLoad = options?.preferredGraphId ? project.graphs[options.preferredGraphId] : undefined;
        if (options?.preferredGraphId && !graphToLoad) {
          throw new Error('The selected graph is no longer in the open project.');
        }

        return await workspaceTransitions.loadProject({
          project,
          data,
          fsPath: projectInfo.fsPath,
          // A stored tab restores its full workspace target/navigation. The last
          // graph id is a fallback only when recovering content from disk.
          openedGraph: storedSnapshot ? undefined : projectInfo.openedGraph,
          executorMode: policy.normalizeExecutorMode
            ? policy.normalizeExecutorMode(projectInfo.executorMode)
            : projectInfo.executorMode,
          evaluationData: evaluation?.evaluationData,
          evaluationDatasets: evaluation?.evaluationDatasets,
          markClean,
          graphToLoad,
          onLoaded: () => {
            store.set(openedProjectSnapshotsState, (snapshots) =>
              isValidOpenedProjectSnapshot(snapshots[projectInfo.projectId], projectInfo.projectId)
                ? snapshots
                : { ...snapshots, [projectInfo.projectId]: { project, data } },
            );
          },
        });
      } catch (err) {
        if (!isCurrent()) return false;
        callbacks.onOpenError?.({
          error: err,
          operation: 'loadProject',
          path: projectInfo.fsPath,
          projectId: projectInfo.projectId,
          openedGraph: projectInfo.openedGraph,
        });
        handleError(err, 'Failed to load opened project', {
          metadata: {
            fsPath: projectInfo.fsPath,
            openedGraph: projectInfo.openedGraph,
            projectId: projectInfo.projectId,
            projectTitle: projectInfo.title,
          },
        });
        return false;
      }
    });
}
