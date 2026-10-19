import type { GraphExecutionMetadata, ProcessEventMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { getSubgraphProjectKey } from '@valerypopoff/rivet2-core';

export type RemoteObservation = {
  id: string;
  sourceProjectId: ProjectId;
  sourceTitle: string;
  rootRunId: string;
  status: 'observing' | 'complete' | 'interrupted' | 'blocked';
  message?: string;
  version?: 'latest' | 'published' | 'mixed';
  needsInput?: boolean;
  paused?: boolean;
};
type Receiver = { token: number };
type Member = { token: number; observation: RemoteObservation };
type Run = {
  projectId: ProjectId;
  receivers: Map<ProjectId, Receiver>;
  owners: Map<string, ProjectId>;
  members: Map<ProjectId, Member>;
  pendingInputs: Set<string>;
  settled: boolean;
  abortRequested?: boolean;
  paused?: boolean;
};
type Source = { serial: number; projectId: ProjectId; runs: Map<string, Run> };

/** Metadata-only admission/lifetime owner. Never opens a socket or sends controls. */
export function createRemoteExecutionObservationRouter(options: {
  eligible?(projectId: ProjectId, source: object): boolean;
  receivers(): Map<ProjectId, Receiver>;
  conflict(projectId: ProjectId, source: object): string | undefined;
  publish(projectId: ProjectId, observation: RemoteObservation): void;
  remove(projectId: ProjectId, id: string): void;
  notice(sourceProjectId: ProjectId, message: string | undefined): void;
  project<K extends keyof ProcessEventMessageMap>(
    projectId: ProjectId,
    message: K,
    data: ProcessEventMessageMap[K],
    activityData: ProcessEventMessageMap[K] | false,
  ): void;
  settle(projectId: ProjectId, rootRunId: string, status: 'completed' | 'error' | 'aborted'): void;
}) {
  const sources = new Map<object, Source>();
  let serial = 0;
  function isCurrent(projectId: ProjectId, member: Member) {
    return options.receivers().get(projectId)?.token === member.token;
  }
  function update(projectId: ProjectId, member: Member, patch: Partial<RemoteObservation>) {
    if (
      !isCurrent(projectId, member) ||
      Object.keys(patch).every((key) =>
        Object.is(member.observation[key as keyof RemoteObservation], patch[key as keyof RemoteObservation]),
      )
    )
      return;
    const next = { ...member.observation, ...patch };
    member.observation = next;
    options.publish(projectId, next);
  }
  function forget(run: Run) {
    for (const [id, member] of run.members) options.remove(id, member.observation.id);
  }
  function blocked(key: object, run: Run, root: string, id: ProjectId, member: Member) {
    if (!isCurrent(id, member) || member.observation.status === 'blocked') return true;
    const conflict =
      options.eligible?.(id, key) === false
        ? 'This project no longer belongs to this Remote Debugger session.'
        : options.conflict(id, key);
    if (!conflict) return false;
    if (!run.settled && id !== run.projectId) options.settle(id, root, 'aborted');
    update(id, member, { status: 'blocked', message: conflict, needsInput: false, paused: false });
    return true;
  }
  return {
    receive<K extends keyof ProcessEventMessageMap>(
      key: object,
      sourceProjectId: ProjectId,
      title: string,
      message: K,
      data: ProcessEventMessageMap[K],
      accepted: boolean,
    ) {
      const event = data as {
        execution?: GraphExecutionMetadata;
        replayRecordedAt?: number;
        processId?: string;
      } | null;
      if (!accepted || Number.isFinite(event?.replayRecordedAt)) return;
      // Even a legacy or mid-run source owns its warning's lifetime. Keeping
      // this empty source record lets disconnect/dispose remove that notice.
      let source = sources.get(key);
      if (!source) {
        source = { serial: ++serial, projectId: sourceProjectId, runs: new Map() };
        sources.set(key, source);
      }
      const execution = event?.execution;
      if (message === 'start' && (!execution?.projectId || !execution.rootRunId)) {
        options.notice(
          sourceProjectId,
          'This runtime does not provide project ownership. Only the source project can be debugged.',
        );
        return;
      }
      if (!execution?.projectId || !execution.rootRunId) return;
      let run = source.runs.get(execution.rootRunId);
      if (message === 'start' && !run) {
        if (execution.projectId !== sourceProjectId) return;
        const receivers = options.receivers();
        // The actual root owns its own tab, even if that tab retained a passive
        // view of an earlier/concurrent root over this same shared connection.
        for (const previousSource of sources.values())
          for (const [root, previous] of previousSource.runs) {
            // An earlier active source also owns its tab. A later root on the
            // same socket must not enroll it as a passive receiver mid-run.
            if (
              previousSource === source &&
              !previous.settled &&
              previous.projectId !== sourceProjectId &&
              previous.receivers.get(previous.projectId)?.token === receivers.get(previous.projectId)?.token
            )
              receivers.delete(previous.projectId);
            const member = previous.members.get(sourceProjectId);
            if (!member) continue;
            if (!previous.settled && member.observation.status !== 'blocked' && isCurrent(sourceProjectId, member))
              options.settle(sourceProjectId, root, 'aborted');
            options.remove(sourceProjectId, member.observation.id);
            previous.members.delete(sourceProjectId);
            previous.receivers.delete(sourceProjectId);
          }
        if ([...source.runs.values()].filter((item) => !item.settled).length >= 32) {
          options.notice(
            sourceProjectId,
            'Dependency observation capacity reached. Existing observations continue; this run is visible only in its source project.',
          );
          return;
        }
        run = {
          projectId: sourceProjectId,
          receivers,
          owners: new Map([[execution.graphRunId, sourceProjectId]]),
          members: new Map(),
          pendingInputs: new Set(),
          settled: false,
        };
        source.runs.set(execution.rootRunId, run);
        options.notice(sourceProjectId, undefined);
      }
      // Never infer admission from a child event, a matching node ID, or a last-run decision.
      if (!run) {
        if (message === 'graphStart' && [...source.runs.values()].filter((item) => !item.settled).length < 32)
          options.notice(
            sourceProjectId,
            'This run started before dependency observation was admitted. Open the projects before starting the next remote run.',
          );
        return;
      }
      if (run.settled) return;
      if (message === 'pause' || message === 'resume') {
        run.paused = message === 'pause';
        for (const [id, member] of run.members)
          if (!blocked(key, run, execution.rootRunId, id, member)) update(id, member, { paused: run.paused });
        return;
      }
      const isRootGraph = !execution.parentGraphRunId && execution.projectId === sourceProjectId;
      // Core emits graphAbort before awaiting node/branch cleanup. Retain the
      // observation until the later graphFinish/graphError or done/error.
      if (message === 'graphAbort' && isRootGraph) run.abortRequested = true;
      // Exact root graph terminals also cover older runtimes whose processor
      // done/error messages do not yet include execution metadata.
      const rootGraphTerminal = isRootGraph && ['graphFinish', 'graphError'].includes(message);
      if (message === 'done' || message === 'error' || rootGraphTerminal) {
        const successful = message === 'done' || message === 'graphFinish';
        for (const [id, member] of run.members) {
          if (blocked(key, run, execution.rootRunId, id, member)) continue;
          if (id !== sourceProjectId)
            options.settle(
              id,
              execution.rootRunId,
              successful ? 'completed' : run.abortRequested ? 'aborted' : 'error',
            );
          update(id, member, { status: successful ? 'complete' : 'interrupted', needsInput: false, paused: false });
        }
        run.settled = true;
        const completed = [...source.runs.entries()].filter(([, item]) => item.settled);
        for (const [root, old] of completed.slice(0, Math.max(0, completed.length - 32))) {
          forget(old);
          source.runs.delete(root);
        }
        return;
      }
      const parentOwner = execution.parentGraphRunId ? run.owners.get(execution.parentGraphRunId) : undefined;
      if (message === 'graphStart') {
        if (execution.projectId !== sourceProjectId && !parentOwner) {
          options.notice(
            sourceProjectId,
            'A dependency event has no known caller in this run. Its project data is not projected.',
          );
          return;
        }
        if (run.owners.size >= 4096 && !run.owners.has(execution.graphRunId)) {
          options.notice(
            sourceProjectId,
            'Dependency graph observation capacity reached. Some graph details are unavailable.',
          );
          return;
        }
        run.owners.set(execution.graphRunId, execution.projectId);
      }
      if (run.owners.get(execution.graphRunId) !== execution.projectId) return;
      // A wait belongs to the runtime root, not a visible receiving tab. Source
      // prompts and terminals from closed/stopped children must update it too.
      const pendingBefore = run.pendingInputs.size;
      const inputKey = JSON.stringify([execution.graphRunId, execution.projectId, event?.processId]);
      if (message === 'userInput' && event?.processId) run.pendingInputs.add(inputKey);
      if ((message === 'nodeFinish' || message === 'nodeError' || message === 'nodeExcluded') && event?.processId)
        run.pendingInputs.delete(inputKey);
      if (pendingBefore !== run.pendingInputs.size)
        for (const [target, entry] of run.members)
          if (!blocked(key, run, execution.rootRunId, target, entry))
            update(target, entry, { needsInput: run.pendingInputs.size > 0 });
      if (execution.projectId === sourceProjectId && !execution.projectScope) return;
      const id = execution.projectId;
      const receiver = run.receivers.get(id);
      if (options.eligible?.(id, key) === false) return;
      if (!receiver || receiver.token !== options.receivers().get(id)?.token) return;
      if (run.owners.get(execution.graphRunId) !== id) return;
      const version = (['latest', 'published'] as const).find(
        (version) => execution.projectScope === getSubgraphProjectKey({ projectId: id, version }),
      );
      let member = run.members.get(id);
      if (!member) {
        const conflict = options.conflict(id, key);
        member = {
          token: receiver.token,
          observation: {
            id: JSON.stringify([source.serial, execution.rootRunId, id]),
            sourceProjectId,
            sourceTitle: title,
            rootRunId: execution.rootRunId,
            status: conflict ? 'blocked' : 'observing',
            message: conflict,
            version,
            needsInput: !conflict && run.pendingInputs.size > 0,
            paused: !conflict && run.paused,
          },
        };
        run.members.set(id, member);
        options.publish(id, member.observation);
      }
      // A new local run, playback or independent debugger must win even if it
      // starts after this root was admitted. Do not resume halfway through it.
      if (blocked(key, run, execution.rootRunId, id, member)) return;
      if (version)
        update(id, member, {
          version: member.observation.version && member.observation.version !== version ? 'mixed' : version,
        });
      if (['start', 'abort', 'trace', 'codeConsole'].includes(message)) return;
      options.project(
        id,
        message,
        {
          ...(data as object),
          execution: {
            ...execution,
            projectScope: undefined,
            ...(parentOwner !== id ? { parentGraphRunId: undefined, executor: undefined } : {}),
          },
        } as ProcessEventMessageMap[K],
        id === sourceProjectId ? false : data,
      );
    },
    disconnect(key: object) {
      const source = sources.get(key);
      if (!source) return;
      for (const [root, run] of source.runs) {
        for (const [id, member] of run.members) {
          if (
            !run.settled &&
            id !== run.projectId &&
            member.observation.status !== 'blocked' &&
            options.receivers().get(id)?.token === member.token
          )
            options.settle(id, root, 'aborted');
        }
        forget(run);
        options.notice(run.projectId, undefined);
      }
      options.notice(source.projectId, undefined);
      sources.delete(key);
    },
    sweep() {
      const current = options.receivers();
      for (const source of sources.values())
        for (const run of source.runs.values()) {
          for (const [id, member] of run.members)
            if (current.get(id)?.token !== member.token) {
              options.remove(id, member.observation.id);
              run.members.delete(id);
            }
        }
    },
    reconcileOwnership() {
      for (const [key, source] of sources)
        for (const [root, run] of source.runs)
          for (const [id, member] of run.members) blocked(key, run, root, id, member);
    },
    dispose() {
      for (const key of [...sources.keys()]) this.disconnect(key);
    },
  };
}
