import type { ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import type { ProjectBinding } from './projectBindingRegistry.js';
import type { DisplayAdmission } from './executionDisplayPolicy.js';
import { createExecutionObservationCoordinator } from './executionObservationCoordinator.js';
import { normalizeExecutionEvent, type ExecutionSourceKind } from './executionEventNormalization.js';

type Options = {
  bindings(): Map<string, ProjectBinding>;
  conflict(id: ProjectId): boolean;
  settle?(id: ProjectId, root: string, status: 'completed' | 'error' | 'aborted', token: number): void;
  project<K extends keyof ProcessEventMessageMap>(
    id: ProjectId,
    message: K,
    data: ProcessEventMessageMap[K],
    activityData: ProcessEventMessageMap[K] | false,
    token: number,
  ): void;
};
type Run = {
  admission: DisplayAdmission;
  members: Set<ProjectId>;
  terminal: boolean;
  abortRequested?: boolean;
};

/** Local/Node display adapter. No commands, React, Jotai, payload storage or transport. */
export function createLocalExecutionObservationRouter(coordinator = createExecutionObservationCoordinator()) {
  const sources = new Map<object, Map<string, Run>>();
  const legacySource = {};
  function settleDisplay(run: Run, root: string, options: Options, status: 'completed' | 'error' | 'aborted') {
    const bindings = options.bindings();
    // Physical cleanup may follow source closure. Finish only still-owned
    // receiver evidence; source loss must not leave those journals running forever.
    const settlementAdmission = { ...run.admission, requireSourceBinding: false };
    for (const id of run.members) {
      if (
        id === run.admission.sourceProjectId ||
        coordinator.check(
          settlementAdmission,
          root,
          id,
          (id) => bindings.get(id),
          (id) => options.conflict(id as ProjectId),
        )
      )
        continue;
      options.settle?.(id, root, status, run.admission.receivers.get(id)!.token);
    }
  }
  return {
    receive<K extends keyof ProcessEventMessageMap>(
      entryId: ProjectId,
      message: K,
      data: ProcessEventMessageMap[K],
      options: Options,
      source = legacySource,
      kind: ExecutionSourceKind = 'browser',
    ) {
      const event = normalizeExecutionEvent({ source, kind, sourceProjectId: entryId, message, data });
      if (event.origin === 'replay' || event.origin === 'recording') return;
      const execution = event.execution;
      if (!execution?.projectId) return;
      let roots = sources.get(source);
      let run = roots?.get(execution.rootRunId);
      const bindings = options.bindings();
      const conflict = (id: string) => options.conflict(id as ProjectId);
      if (!run) {
        if (
          (message !== 'start' && message !== 'graphStart') ||
          execution.projectId !== entryId ||
          execution.parentGraphRunId
        )
          return;
        const bundleKey = bindings.get(entryId)?.bundleKey;
        if (!bundleKey) return;
        const receivers = new Map([...bindings].filter(([, binding]) => binding.bundleKey === bundleKey));
        run = {
          admission: coordinator.capture(source, execution.rootRunId, entryId, receivers, conflict, true, kind),
          members: new Set(),
          terminal: false,
        };
        if (!roots) sources.set(source, (roots = new Map()));
        roots.set(execution.rootRunId, run);
      }
      if (event.lifecycle === 'display-terminal' && execution.projectId === entryId && !execution.parentGraphRunId) {
        if (!run.terminal)
          settleDisplay(
            run,
            execution.rootRunId,
            options,
            message === 'graphFinish' || message === 'done' ? 'completed' : run.abortRequested ? 'aborted' : 'error',
          );
        run.terminal = true;
        // Legacy callers have no settlement signal. Their compatibility lifetime
        // ends here; real browser adapters retain fences until waitForRunCompletion.
        if (source === legacySource) {
          roots!.delete(execution.rootRunId);
          coordinator.settle(source, execution.rootRunId);
          if (!roots!.size) sources.delete(source);
        } else if (kind !== 'browser' && kind !== 'recording') {
          // Older Node transports do not prove process settlement. Bound only
          // completed display tombstones; never evict an active root/fence.
          const completed = [...roots!].filter(([, run]) => run.terminal);
          for (const [root] of completed.slice(0, Math.max(0, completed.length - 32))) {
            roots!.delete(root);
            coordinator.settle(source, root);
          }
        }
        return;
      }
      if (run.terminal || run.admission.sourceProjectId !== entryId) return;
      if (
        (message === 'graphAbort' || message === 'abort') &&
        execution.projectId === entryId &&
        !execution.parentGraphRunId
      )
        run.abortRequested = true;
      if (
        coordinator.check(run.admission, execution.rootRunId, execution.projectId, (id) => bindings.get(id), conflict)
      )
        return;
      const parentOwner = execution.parentGraphRunId
        ? run.admission.graphOwners.get(execution.parentGraphRunId)
        : undefined;
      run.admission.graphOwners.set(execution.graphRunId, execution.projectId);
      if (execution.projectId === entryId && !execution.projectScope) return;
      if (['userInput', 'start', 'done', 'error', 'abort'].includes(message)) return;
      run.members.add(execution.projectId);
      options.project(
        execution.projectId,
        message,
        {
          ...(data as object),
          execution: {
            ...execution,
            projectScope: undefined,
            ...(parentOwner !== execution.projectId ? { parentGraphRunId: undefined, executor: undefined } : {}),
          },
        } as ProcessEventMessageMap[K],
        execution.projectId === entryId ? false : data,
        run.admission.receivers.get(execution.projectId)!.token,
      );
    },
    reconcile(options: Options) {
      const bindings = options.bindings();
      for (const roots of sources.values())
        for (const [root, run] of roots)
          for (const id of run.admission.receivers.keys())
            coordinator.check(
              run.admission,
              root,
              id,
              (id) => bindings.get(id),
              (id) => options.conflict(id as ProjectId),
            );
    },
    settle(source: object, options?: Options) {
      if (options)
        for (const [root, run] of sources.get(source) ?? [])
          if (!run.terminal) settleDisplay(run, root, options, 'aborted');
      sources.delete(source);
      coordinator.disconnect(source);
    },
    dispose(options?: Options) {
      for (const source of [...sources.keys()]) this.settle(source, options);
      sources.clear();
    },
    inspect: () => ({ sources: sources.size, roots: [...sources.values()].reduce((n, roots) => n + roots.size, 0) }),
  };
}
