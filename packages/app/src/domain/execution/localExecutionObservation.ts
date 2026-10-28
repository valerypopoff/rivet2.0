import type { ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import type { ProjectBinding } from './projectBindingRegistry.js';
import type { DisplayAdmission } from './executionDisplayPolicy.js';
import { createExecutionObservationCoordinator } from './executionObservationCoordinator.js';
import { normalizeExecutionEvent, type ExecutionSourceKind } from './executionEventNormalization.js';

type Options = {
  bindings(): Map<string, ProjectBinding>;
  conflict(id: ProjectId): boolean;
  reset?(id: ProjectId, token: number, isCurrent: () => boolean): boolean | void;
  settle?(id: ProjectId, root: string, status: 'completed' | 'error' | 'aborted', token: number): void;
  project<K extends keyof ProcessEventMessageMap>(
    id: ProjectId,
    message: K,
    data: ProcessEventMessageMap[K],
    activityData: ProcessEventMessageMap[K] | false,
    token: number,
    isCurrent: () => boolean,
  ): void;
};
type Run = {
  root: string;
  order: number;
  admission: DisplayAdmission;
  members: Set<ProjectId>;
  terminal: boolean;
  abortRequested?: boolean;
};
type Display = {
  order: number;
  sourceId: ProjectId;
  sourceToken: number;
  token: number;
  passive: boolean;
};

/** Local/Node display adapter. No commands, React, Jotai, payload storage or transport. */
export function createLocalExecutionObservationRouter(coordinator = createExecutionObservationCoordinator()) {
  const sources = new Map<object, Map<string, Run>>();
  const legacySource = {};
  // One payload-free owner per open binding, retained across processor settlement.
  // Root order is workspace admission order, never a timestamp or a child arrival.
  const displays = new Map<ProjectId, Display>();
  let nextOrder = 0;
  function isCurrentDisplay(run: Run, id: ProjectId, display: Display, options: Options): boolean {
    if ((displays.get(run.admission.sourceProjectId as ProjectId)?.order ?? 0) > run.order) {
      run.admission.blocked.set(id, 'superseded-local-run');
      return false;
    }
    return (
      displays.get(id) === display &&
      !coordinator.check(
        run.admission,
        run.root,
        id,
        (id) => options.bindings().get(id),
        (id) => options.conflict(id as ProjectId),
      )
    );
  }
  function claim(run: Run, id: ProjectId, options: Options, passive: boolean): boolean {
    const previous = displays.get(id);
    if (
      (previous && previous.order > run.order) ||
      (displays.get(run.admission.sourceProjectId as ProjectId)?.order ?? 0) > run.order
    ) {
      run.admission.blocked.set(id, 'superseded-local-run');
      return false;
    }
    if (previous?.order === run.order) return true;
    const display: Display = {
      order: run.order,
      sourceId: run.admission.sourceProjectId as ProjectId,
      sourceToken: run.admission.receivers.get(run.admission.sourceProjectId)!.token,
      token: run.admission.receivers.get(id)!.token,
      passive,
    };
    displays.set(id, display); // Claim before reset can notify synchronous subscribers.
    const isCurrent = () => isCurrentDisplay(run, id, display, options);
    if (passive && options.reset?.(id, display.token, isCurrent) === false) {
      if (displays.get(id) === display) displays.delete(id);
      if (!run.admission.blocked.has(id))
        run.admission.blocked.set(
          id,
          (displays.get(id)?.order ?? 0) > run.order ? 'superseded-local-run' : 'ownership-conflict',
        );
      return false;
    }
    return isCurrent();
  }
  function settleDisplay(run: Run, root: string, options: Options, status: 'completed' | 'error' | 'aborted') {
    const bindings = options.bindings();
    // Physical cleanup may follow source closure. Finish only still-owned
    // receiver evidence; source loss must not leave those journals running forever.
    const settlementAdmission = {
      ...run.admission,
      requireSourceBinding: false,
      // Exact-root settlement may finish retained activity, never paint new data.
      blocked: new Map([...run.admission.blocked].filter(([, reason]) => reason !== 'superseded-local-run')),
    };
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
          root: execution.rootRunId,
          order: ++nextOrder,
          admission: coordinator.capture(source, execution.rootRunId, entryId, receivers, conflict, true, kind),
          members: new Set(),
          terminal: false,
        };
        if (!roots) sources.set(source, (roots = new Map()));
        roots.set(execution.rootRunId, run);
        if (!claim(run, entryId, options, false)) return;
        // Clear only this source's previously owned dependencies. An unrelated
        // open bundle member is not a participant merely because it is open.
        for (const [id, display] of displays) {
          if (!display.passive || display.sourceId !== entryId || display.sourceToken !== bindings.get(entryId)?.token)
            continue;
          if (coordinator.check(run.admission, run.root, id, (id) => options.bindings().get(id), conflict)) continue;
          claim(run, id, options, true);
        }
      }
      if (event.lifecycle === 'display-terminal' && execution.projectId === entryId && !execution.parentGraphRunId) {
        if (!run.terminal) {
          // Settlement writes notify synchronous subscribers. Close admission
          // first so their late child frames cannot reopen a terminating root.
          run.terminal = true;
          settleDisplay(
            run,
            execution.rootRunId,
            options,
            message === 'graphFinish' || message === 'done' ? 'completed' : run.abortRequested ? 'aborted' : 'error',
          );
        }
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
      // Cancellation belongs to execution lifecycle bookkeeping, even after a
      // newer root owns the canvas. It does not authorize display projection.
      if (event.lifecycle === 'abort-requested' && execution.projectId === entryId && !execution.parentGraphRunId)
        run.abortRequested = true;
      // A newer root from this source supersedes even dependencies the older
      // root has not reached yet. Receiver-only fencing cannot cover that case.
      if ((displays.get(entryId)?.order ?? 0) > run.order) {
        run.admission.blocked.set(execution.projectId, 'superseded-local-run');
        return;
      }
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
      if (!claim(run, execution.projectId, options, execution.projectId !== entryId)) return;
      run.members.add(execution.projectId);
      const currentRun = run;
      const projectId = execution.projectId;
      const display = displays.get(projectId)!;
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
        () => isCurrentDisplay(currentRun, projectId, display, options),
      );
    },
    reconcile(options: Options) {
      const bindings = options.bindings();
      for (const [id, display] of displays)
        if (
          bindings.get(id)?.token !== display.token ||
          bindings.get(display.sourceId)?.token !== display.sourceToken ||
          (display.passive && options.conflict(id))
        )
          displays.delete(id);
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
      const roots = sources.get(source);
      // Retire the exact old source map before callbacks. Reentrant work must
      // not join its cleanup or be erased if it establishes a fresh admission.
      sources.delete(source);
      coordinator.disconnect(source);
      if (options)
        for (const [root, run] of roots ?? [])
          if (!run.terminal) {
            run.terminal = true;
            settleDisplay(run, root, options, 'aborted');
          }
    },
    dispose(options?: Options) {
      for (const source of [...sources.keys()]) this.settle(source, options);
      sources.clear();
      displays.clear();
    },
    inspect: () => ({ sources: sources.size, roots: [...sources.values()].reduce((n, roots) => n + roots.size, 0) }),
  };
}
