import { useEffect, useMemo } from 'react';
import { useStore } from 'jotai';
import type {
  ProcessEventMessageMap,
  ProjectId,
  GraphExecutionMetadata,
  LatestDebuggerScope,
} from '@valerypopoff/rivet2-core';
import { getSubgraphProjectKey } from '@valerypopoff/rivet2-core';
import type { ExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import type { ExecutorSessionRuntime, RemoteEventAdmission } from './executorSession.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { executionObservationCoordinatorState } from '../state/executionObservation.js';
import {
  projectState,
  projectsState,
  openedProjectSnapshotsState,
  projectUnsavedChangesState,
} from '../state/savedGraphs.js';
import { loadedRecordingState, getLoadedRecordingForTab } from '../state/execution.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { remoteObservationsState, remoteObservationNoticesState } from '../state/remoteObservation.js';
import { createEmptyProjectExecutionSnapshot, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { hasManagedLatestReceiverConflict } from './managedLatestControlState.js';
import { clearExecutionDataRefs } from '../utils/executionDataStorage.js';
import { stopProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { projectRemoteExecutionEvent } from './remoteExecutionProjection.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import { settleProjectExecutionObservation } from './projectExecutionObservationSettlement.js';

/** Managed transport adapter. Canonical reducers and the existing coordinator own data/lifetimes. */
export function useManagedLatestExecution(registry: ExecutorSessionRegistry) {
  const store = useStore(),
    refStore = useDataRefs();
  const adapter = useMemo(() => {
    const coordinator = store.get(executionObservationCoordinatorState);
    const roots = new Map<ExecutorSessionRuntime, Set<string>>();
    const displayed = new Map<
      ExecutorSessionRuntime,
      { scope: LatestDebuggerScope; admission: ReturnType<typeof coordinator.capture> }
    >();
    const bindings = () => {
      store.get(projectsState);
      return store.get(projectBindingRegistryState).capture();
    };
    const conflict = (id: string, runtime: ExecutorSessionRuntime) =>
      // A newly selected root may just have evicted the previous display's
      // catalogue entry. That known display is not a replacement local run.
      hasManagedLatestReceiverConflict(
        store,
        registry,
        runtime,
        id as ProjectId,
        displayed.get(runtime)?.scope.rootRunId,
      );
    const projectFor = (id: ProjectId) =>
      store.get(projectState).metadata.id === id
        ? store.get(projectState)
        : store.get(openedProjectSnapshotsState)[id]?.project;
    const notice = (id: ProjectId, text: string) => {
      if (store.get(remoteObservationNoticesState)[id] !== text)
        store.set(remoteObservationNoticesState, (previous) => ({ ...previous, [id]: text }));
    };
    function settleDisplay(
      runtime: ExecutorSessionRuntime,
      status: 'completed' | 'error' | 'aborted',
      onlyProject?: ProjectId,
    ) {
      const view = displayed.get(runtime);
      if (!view) return;
      for (const [id, binding] of view.admission.receivers) {
        if (onlyProject && id !== onlyProject) continue;
        const owner = registry.getRemoteDebuggerRuntime(id as ProjectId);
        const info = store.get(projectsState).openedProjects[id as ProjectId];
        if (
          view.admission.blocked.has(id) ||
          (owner && owner !== runtime) ||
          getLoadedRecordingForTab(store.get(loadedRecordingState), id as ProjectId, info?.fsPath)
        )
          continue;
        updateOpenProjectExecutionSnapshot(
          store,
          id as ProjectId,
          (snapshot) => {
            // A new local run or another display owner may already have replaced this view.
            if (snapshot.runActivityJournal?.rootOrder.at(-1) !== view.scope.rootRunId) return snapshot;
            return stopProjectExecutionSnapshot(
              settleProjectExecutionObservation(snapshot, view.scope.rootRunId, status),
            );
          },
          binding.token,
        );
      }
    }
    function disconnect(runtime: ExecutorSessionRuntime, onlyProject?: ProjectId) {
      const owned = roots.get(runtime);
      // Retire metadata before store notifications can reconcile the departed owner.
      if (!onlyProject) roots.delete(runtime);
      settleDisplay(runtime, 'aborted', onlyProject);
      if (onlyProject) {
        // Membership retirement fences every retained admission, not just the
        // currently selected view. Rejoining cannot resurrect old authority.
        for (const key of owned ?? []) coordinator.get(runtime, key)?.blocked.set(onlyProject, 'ownership-conflict');
      } else {
        displayed.delete(runtime);
        coordinator.disconnect(runtime);
      }
      if (owned)
        store.set(remoteObservationsState, (previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([id, entries]) => [
              id,
              entries.filter((entry) => (onlyProject && id !== onlyProject) || !owned.has(entry.id)),
            ]),
          ),
        );
    }
    function receive(
      runtime: ExecutorSessionRuntime,
      message: keyof ProcessEventMessageMap | 'latest-settled' | 'latest-prompt-closed',
      original: unknown,
      context: NonNullable<RemoteEventAdmission['managedLatest']>,
    ) {
      const { scope, selected, reset } = context;
      const key = JSON.stringify([scope.owner, scope.incarnation, scope.rootRunId]);
      let known = roots.get(runtime);
      if (!known) roots.set(runtime, (known = new Set()));
      for (const old of known)
        if (!context.retained.includes(old)) {
          coordinator.settle(runtime, old);
          known.delete(old);
        }
      if (!known.has(key) && message !== 'start') return;
      known.add(key);
      store.get(projectsState);
      const currentBindings = store.get(projectBindingRegistryState);
      const current = (id: string) => currentBindings.get(id);
      const admission =
        coordinator.get(runtime, key) ??
        coordinator.capture(
          runtime,
          key,
          scope.projectId,
          currentBindings.capture(),
          (id) => conflict(id, runtime),
          false,
          'remote-debugger',
        );
      const data = original as {
        execution?: GraphExecutionMetadata;
        project?: { metadata?: { title?: string } };
        node?: { id: string };
        graph?: { metadata?: { id?: string } };
      } | null;
      const execution = data?.execution;
      if (execution) {
        if (!execution.projectId) return;
        if (execution.rootRunId !== scope.rootRunId) return;
        if (message === 'start') admission.graphOwners.set(execution.graphRunId, scope.projectId);
        if (message === 'graphStart') {
          if (
            execution.projectId !== scope.projectId &&
            (!execution.parentGraphRunId || !admission.graphOwners.has(execution.parentGraphRunId))
          )
            return;
          if (admission.graphOwners.size < 4096) admission.graphOwners.set(execution.graphRunId, execution.projectId);
        }
        if (admission.graphOwners.get(execution.graphRunId) !== execution.projectId) return;
      }
      if (!selected) return;
      displayed.set(runtime, { scope, admission });
      const eligible = (id: string) =>
        !conflict(id, runtime) && !coordinator.check(admission, key, id, current, (value) => conflict(value, runtime));
      if (reset) {
        for (const [id, binding] of admission.receivers)
          if (eligible(id)) {
            updateOpenProjectExecutionSnapshot(
              store,
              id as ProjectId,
              (snapshot) => {
                clearExecutionDataRefs(refStore, snapshot.lastRunDataByNode);
                return createEmptyProjectExecutionSnapshot();
              },
              binding.token,
            );
            store.set(remoteObservationsState, (previous) => {
              const next = { ...previous };
              delete next[id as ProjectId];
              return next;
            });
            notice(id as ProjectId, '');
          }
      }
      if (message === 'latest-prompt-closed') {
        const promptId = (original as { promptId: string }).promptId;
        for (const [id, binding] of admission.receivers)
          if (eligible(id))
            updateOpenProjectExecutionSnapshot(
              store,
              id as ProjectId,
              (snapshot) => {
                let changed = false;
                const userInputQuestions = Object.fromEntries(
                  Object.entries(snapshot.userInputQuestions).flatMap(([node, questions]) => {
                    const remaining = questions.filter(
                      (question) =>
                        !(
                          question.latestPrompt?.promptId === promptId &&
                          question.latestPrompt.target.rootRunId === scope.rootRunId &&
                          question.latestPrompt.target.owner === scope.owner &&
                          question.latestPrompt.target.incarnation === scope.incarnation
                        ),
                    );
                    changed ||= remaining.length !== questions.length;
                    return remaining.length ? [[node, remaining]] : [];
                  }),
                );
                return changed ? { ...snapshot, userInputQuestions } : snapshot;
              },
              binding.token,
            );
        return;
      }
      // Transport settlement is not a synthetic graph event. Reuse exact-root
      // display cleanup without feeding it into the processor-event reducers.
      if (message === 'latest-settled') {
        const run = runtime.getLatestDebuggerState()?.runs.find((run) => run.key === key);
        const status = run?.abortRequested ? 'aborted' : run?.outcome ?? 'aborted';
        settleDisplay(runtime, status);
        store.set(remoteObservationsState, (previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([id, entries]) => [
              id,
              entries.map((entry) =>
                entry.id === key
                  ? { ...entry, status: status === 'completed' ? 'complete' : 'interrupted', paused: false }
                  : entry,
              ),
            ]),
          ),
        );
        return;
      }
      const decorated = scope.promptId
        ? { ...(original as object), latestPrompt: { target: scope, promptId: scope.promptId } }
        : original;
      const apply = (id: ProjectId, payload: unknown, activityData?: unknown, activityOnly = false) => {
        if (!eligible(id)) return;
        updateOpenProjectExecutionSnapshot(
          store,
          id,
          (snapshot) =>
            projectRemoteExecutionEvent({
              project: projectFor(id),
              dirty: !!store.get(projectUnsavedChangesState)[id],
              notice: (message) => notice(id, message),
              projectId: id,
              snapshot,
              message,
              data: payload as never,
              refStore,
              activityOnly,
              activityData: activityData as never,
              previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
            }),
          admission.receivers.get(id)?.token,
        );
      };
      const source = scope.projectId as ProjectId;
      apply(source, decorated);
      if (
        execution?.projectId &&
        (execution.projectId !== source || execution.projectScope) &&
        !['start', 'abort', 'trace', 'codeConsole', 'done', 'error', 'userInput'].includes(message)
      ) {
        const id = execution.projectId;
        const parentOwner = execution.parentGraphRunId
          ? admission.graphOwners.get(execution.parentGraphRunId)
          : undefined;
        apply(
          id,
          {
            ...(decorated as object),
            execution: {
              ...execution,
              projectScope: undefined,
              ...(parentOwner !== id ? { parentGraphRunId: undefined, executor: undefined } : {}),
            },
          },
          id === source ? false : original,
        );
        const version = (['latest', 'published'] as const).find(
          (version) => execution.projectScope === getSubgraphProjectKey({ projectId: id, version }),
        );
        if (id !== source && eligible(id))
          store.set(remoteObservationsState, (previous) => ({
            ...previous,
            [id]: [
              {
                id: key,
                sourceProjectId: source,
                sourceTitle: projectFor(source)?.metadata.title ?? 'Source project',
                rootRunId: scope.rootRunId,
                status: 'observing',
                paused: runtime.getLatestDebuggerState()?.runs.find((run) => run.key === key)?.paused ?? false,
                version:
                  previous[id]?.[0]?.version && version && previous[id]![0]!.version !== version
                    ? 'mixed'
                    : version ?? previous[id]?.[0]?.version,
              },
            ],
          }));
      }
      if (execution?.projectId && execution.projectId !== source && message === 'userInput')
        apply(execution.projectId, original, original, true);
      if (message === 'pause' || message === 'resume')
        store.set(remoteObservationsState, (previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([id, entries]) => [
              id,
              entries.map((entry) => (entry.id === key ? { ...entry, paused: message === 'pause' } : entry)),
            ]),
          ),
        );
      if (message === 'done' || message === 'error')
        for (const [id, binding] of admission.receivers)
          if (id !== source && eligible(id)) {
            updateOpenProjectExecutionSnapshot(
              store,
              id as ProjectId,
              (snapshot) =>
                settleProjectExecutionObservation(
                  snapshot,
                  scope.rootRunId,
                  message === 'done' ? 'completed' : 'error',
                ),
              binding.token,
            );
            store.set(remoteObservationsState, (previous) => ({
              ...previous,
              [id]: (previous[id as ProjectId] ?? []).map((item) =>
                item.rootRunId === scope.rootRunId
                  ? { ...item, status: message === 'done' ? 'complete' : 'interrupted', paused: false }
                  : item,
              ),
            }));
          }
    }
    function reconcile() {
      const current = bindings();
      for (const [runtime, keys] of roots)
        for (const key of keys) {
          const admission = coordinator.get(runtime, key);
          if (!admission) continue;
          for (const id of admission.receivers.keys()) {
            if (conflict(id, runtime)) admission.blocked.set(id, 'ownership-conflict');
            coordinator.check(
              admission,
              key,
              id,
              (value) => current.get(value),
              (value) => conflict(value, runtime),
            );
          }
        }
    }
    return {
      receive,
      disconnect,
      reconcile,
      dispose() {
        for (const runtime of roots.keys()) disconnect(runtime);
      },
    };
  }, [registry, store, refStore]);
  useEffect(() => {
    // Compare only canonical ownership facts. Output payloads must not scan
    // every retained admission; no snapshots or payload refs are cached here.
    let previousOwnership = '';
    const reconcileExecutionOwnership = () => {
      const ownership = JSON.stringify(
        Object.entries(store.get(projectExecutionSnapshotsState)).map(([id, snapshot]) => [
          id,
          snapshot?.graphRunning,
          snapshot?.runActivityJournal?.rootOrder.at(-1),
        ]),
      );
      if (ownership === previousOwnership) return;
      previousOwnership = ownership;
      adapter.reconcile();
    };
    reconcileExecutionOwnership();
    const unsubscribers = [projectsState, loadedRecordingState, projectBindingRegistryState].map((atom) =>
      store.sub(atom, adapter.reconcile),
    );
    unsubscribers.push(store.sub(projectExecutionSnapshotsState, reconcileExecutionOwnership));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      adapter.dispose();
    };
  }, [adapter, store]);
  return adapter;
}
