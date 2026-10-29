import {
  decodeDebuggerTransportSentinels,
  isLatestDebuggerScope,
  type LatestDebuggerScope,
  type LatestDebuggerExecutionMessage,
  readLatestDebuggerExecution,
} from '@valerypopoff/rivet2-core';
import { getEventOccurredAt } from '../utils/recordedNodeTiming.js';

export type LatestFrame = { message: string; data: unknown; rivetScope: LatestDebuggerScope };
type LatestRunPhase = 'running' | 'outputs-ready' | 'finishing' | 'completed' | 'error' | 'aborted' | 'settled';
export type LatestRun = {
  key: string;
  scope: LatestDebuggerScope;
  title: string;
  startedAt: number;
  order: number;
  phase: LatestRunPhase;
  paused: boolean;
  readonly status: LatestRunPhase | 'paused' | 'abort-requested';
  abortRequested?: boolean;
  outcome?: 'completed' | 'error';
  incomplete: boolean;
  eligible: boolean;
};
const keyOf = (scope: LatestDebuggerScope) => JSON.stringify([scope.owner, scope.incarnation, scope.rootRunId]);
const compareAdmissions = (a: LatestRun, b: LatestRun) => a.startedAt - b.startedAt || a.order - b.order;
const isPromptIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;

export function isLatestRunSettled(run: Pick<LatestRun, 'phase'>): boolean {
  return ['completed', 'error', 'aborted', 'settled'].includes(run.phase);
}

export function getLatestRunControlPolicy(run: LatestRun) {
  const running = !isLatestRunSettled(run);
  const controllable = running && !run.abortRequested;
  return {
    running,
    paused: running && run.paused,
    canAbort: controllable,
    canPause: controllable && !run.paused,
    canResume: controllable && run.paused,
  };
}

/** One bounded wire buffer, not a parallel collection of execution snapshots. */
export class LatestDebuggerRuns {
  readonly runs = new Map<string, LatestRun>();
  selected?: string;
  following = true;
  private order = 0;
  private bytes = 0;
  private frames: { key: string; raw: string; bytes: number }[] = [];
  // Metadata only, globally bounded by the same event limit. Never callbacks or
  // another snapshot/payload store; closed prompts need no retained tombstone.
  private prompts = new Map<string, { run: string; graphRunId: string; processId: string }>();
  constructor(
    private readonly eligible: (projectId: string) => boolean,
    private readonly limits = { runs: 32, events: 8192, bytes: 32 * 1024 * 1024 },
  ) {}

  receive(frame: LatestFrame, raw: string): LatestRun | undefined {
    if (!isLatestDebuggerScope(frame.rivetScope)) return;
    const key = keyOf(frame.rivetScope);
    let run = this.runs.get(key);
    const data = frame.data as {
      project?: { metadata?: { title?: string } };
      execution?: { rootRunId?: string; projectId?: string; parentGraphRunId?: string; graphRunId?: string };
      processId?: string;
      promptId?: string;
    } | null;
    if (data?.execution?.rootRunId && data.execution.rootRunId !== frame.rivetScope.rootRunId) return;
    if (
      run &&
      (run.scope.projectId !== frame.rivetScope.projectId ||
        run.scope.channel !== frame.rivetScope.channel ||
        run.scope.promptLifecycle !== frame.rivetScope.promptLifecycle)
    )
      return;
    if (
      frame.message === 'start' &&
      (frame.data as { project?: { metadata?: { id?: string } } })?.project?.metadata?.id !== frame.rivetScope.projectId
    )
      return;
    if (run && isLatestRunSettled(run)) return;
    if (!run) {
      if (frame.message !== 'start') return;
      run = {
        key,
        scope: frame.rivetScope,
        title: data?.project?.metadata?.title ?? frame.rivetScope.projectId,
        startedAt: frame.rivetScope.admittedAt ?? getEventOccurredAt(data) ?? Date.now(),
        order: ++this.order,
        phase: 'running',
        paused: false,
        get status() {
          if (isLatestRunSettled(this)) return this.phase;
          if (this.abortRequested) return 'abort-requested';
          return this.paused ? 'paused' : this.phase;
        },
        incomplete: false,
        eligible: this.eligible(frame.rivetScope.projectId),
      };
      this.runs.set(key, run);
    }
    if (data?.execution?.projectId && this.eligible(data.execution.projectId)) run.eligible = true;
    if (frame.message === 'pause' && !run.abortRequested) run.paused = true;
    if (frame.message === 'resume' && !run.abortRequested) run.paused = false;
    if (frame.message === 'abort') {
      run.abortRequested = true;
    }
    if (
      frame.message === 'graphOutputsReady' &&
      !run.abortRequested &&
      !data?.execution?.parentGraphRunId &&
      data?.execution?.projectId === run.scope.projectId
    )
      run.phase = 'outputs-ready';
    if (frame.message === 'done' || frame.message === 'error') {
      run.outcome = frame.message === 'done' ? 'completed' : 'error';
      run.phase = 'finishing';
    }
    if (frame.message === 'latest-settled') {
      run.phase = run.abortRequested ? 'aborted' : run.outcome ?? 'settled';
      run.paused = false;
      if (!run.outcome) run.incomplete = true;
    }
    if (
      frame.message === 'userInput' &&
      frame.rivetScope.promptId &&
      isPromptIdentity(data?.execution?.graphRunId) &&
      isPromptIdentity(data?.processId)
    ) {
      this.prompts.set(JSON.stringify([key, frame.rivetScope.promptId]), {
        run: key,
        graphRunId: data.execution.graphRunId,
        processId: data.processId,
      });
      while (this.prompts.size > this.limits.events) {
        const oldest = this.prompts.keys().next().value!;
        const removed = this.prompts.get(oldest)!;
        this.prompts.delete(oldest);
        const affected = this.runs.get(removed.run);
        if (affected) affected.incomplete = true;
      }
    }
    if (frame.message === 'latest-prompt-closed') {
      if (!isPromptIdentity(data?.promptId)) return;
      this.prompts.delete(JSON.stringify([key, data.promptId]));
    }
    if (
      [
        'done',
        'error',
        'abort',
        'latest-settled',
        'nodeFinish',
        'nodeError',
        'nodeExcluded',
        'graphAbort',
        'graphError',
      ].includes(frame.message)
    ) {
      for (const [id, prompt] of this.prompts)
        if (
          prompt.run === key &&
          (['done', 'error', 'abort', 'latest-settled'].includes(frame.message) ||
            (prompt.graphRunId === data?.execution?.graphRunId &&
              (frame.message.startsWith('graph') || prompt.processId === data.processId)))
        )
          this.prompts.delete(id);
    }
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes <= this.limits.bytes) {
      this.frames.push({ key, raw, bytes });
      this.bytes += bytes;
    } else run.incomplete = true;
    while (this.frames.length > this.limits.events || this.bytes > this.limits.bytes) {
      const removed = this.frames.shift()!;
      this.bytes -= removed.bytes;
      const affected = this.runs.get(removed.key);
      if (affected) affected.incomplete = true;
    }
    const selected = this.runs.get(this.selected ?? '');
    if (this.following && run.eligible && (!selected || compareAdmissions(run, selected) > 0)) this.selected = key;
    while (this.runs.size > this.limits.runs) {
      const oldest = [...this.runs.values()].sort(compareAdmissions).find((run) => run.key !== this.selected)?.key;
      if (!oldest) break;
      this.runs.delete(oldest);
      for (const [id, prompt] of this.prompts) if (prompt.run === oldest) this.prompts.delete(id);
      this.frames = this.frames.filter((frame) => {
        if (frame.key !== oldest) return true;
        this.bytes -= frame.bytes;
        return false;
      });
    }
    return run;
  }
  select(key: string) {
    if (!this.runs.get(key)?.eligible) return false;
    this.following = false;
    this.selected = key;
    return true;
  }
  markIncomplete(key?: string) {
    for (const run of this.runs.values()) if (key === undefined || run.key === key) run.incomplete = true;
    // A stream gap may contain a closure; old pending proof is no longer valid.
    if (key === undefined) this.prompts.clear();
    else for (const [id, prompt] of this.prompts) if (prompt.run === key) this.prompts.delete(id);
  }
  follow() {
    this.following = true;
    this.selected = this.orderedRuns().at(-1)?.key;
  }
  replay(): LatestDebuggerExecutionMessage[] {
    return this.frames
      .filter((frame) => frame.key === this.selected)
      .flatMap((frame) => {
        const decoded = readLatestDebuggerExecution(decodeDebuggerTransportSentinels(JSON.parse(frame.raw)));
        if (!decoded) {
          this.markIncomplete(frame.key);
          return [];
        }
        if (decoded.message === 'userInput' && !this.canReplayPrompt(decoded.rivetScope)) {
          const run = this.runs.get(frame.key);
          if (run && run.scope.promptLifecycle !== 1) run.incomplete = true;
          return { ...decoded, data: { ...decoded.data, isReplay: true } };
        }
        return decoded;
      });
  }
  private canReplayPrompt(scope: LatestDebuggerScope): boolean {
    const run = this.runs.get(keyOf(scope));
    return (
      scope.promptLifecycle === 1 &&
      !!scope.promptId &&
      !!run &&
      !isLatestRunSettled(run) &&
      !run.abortRequested &&
      this.prompts.has(JSON.stringify([run.key, scope.promptId]))
    );
  }
  state() {
    return {
      following: this.following,
      selected: this.selected,
      runs: this.orderedRuns().map((run) => ({ ...run })),
    };
  }
  private orderedRuns() {
    return [...this.runs.values()].filter((run) => run.eligible).sort(compareAdmissions);
  }
}
