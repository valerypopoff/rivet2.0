import {
  type LatestDebuggerScope,
  isLatestDebuggerScope,
  readLatestDebuggerExecution,
  type LatestDebuggerExecutionMessage,
  isLatestDebuggerSession,
  readLatestDebuggerControl,
  isLatestDebuggerControlResult,
} from '@valerypopoff/rivet2-core';
import { LatestDebuggerRuns, getLatestRunControlPolicy } from './latestDebuggerRuns.js';
import { readLatestDebuggerDiagnostic } from './latestDebuggerDiagnostic.js';

/** Managed protocol state only. The parent owns sockets; the catalogue owns run history. */
export class ManagedLatestSession {
  runs?: LatestDebuggerRuns;
  channel?: string | null;
  requestedChannel?: string | null;
  ready = false;
  observation = false;
  private generation = 0;
  private projectionRevision = 0;
  private readonly cursors = new Map<string, number>();
  private readonly diagnostics = new Set<string>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  get pendingCount() {
    return this.pending.size;
  }
  constructor(
    private readonly options: {
      eligible(id: string): boolean;
      deliver(
        frame: LatestDebuggerExecutionMessage,
        selected: boolean,
        reset: boolean,
        replay: boolean,
        retained: string[],
      ): void;
      notify(): void;
      warn(message: string, options?: { toastId: string }): void;
      canSend(): boolean;
      send(raw: string): boolean;
    },
  ) {}
  dispatch(frame: LatestDebuggerExecutionMessage, selected: boolean, reset = false, replay = false) {
    if (!this.runs) return;
    this.options.deliver(frame, selected, reset, replay, [...this.runs.runs.keys()]);
  }
  receive(message: string, data: unknown, scope: unknown, raw: string) {
    if (!this.runs || !this.ready || !isLatestDebuggerScope(scope) || scope.channel !== this.channel) return;
    const frame = readLatestDebuggerExecution({ message, data, rivetScope: scope });
    if (!frame) {
      const generation = this.generation;
      const key = JSON.stringify([scope.owner, scope.incarnation, scope.rootRunId]);
      const run = this.runs.runs.get(key);
      if (!run || run.scope.projectId !== scope.projectId || run.scope.promptLifecycle !== scope.promptLifecycle)
        return;
      this.runs.markIncomplete(key);
      if (this.runs.selected === key) this.rebuild();
      else this.options.notify();
      if (generation === this.generation)
        this.warnOnce(
          'unsupported-event',
          'This run contains unsupported debugger events. Retained history is incomplete.',
        );
      return;
    }
    const revision = this.projectionRevision;
    const previous = this.runs.selected;
    const run = this.runs.receive(frame, raw);
    if (!run) return;
    if (previous !== this.runs.selected) {
      this.dispatch(frame, false);
      if (revision !== this.projectionRevision) return;
      this.rebuild();
    } else this.dispatch(frame, this.runs.selected === run.key);
    if (
      revision === this.projectionRevision &&
      [
        'start',
        'done',
        'error',
        'pause',
        'resume',
        'abort',
        'graphStart',
        'graphOutputsReady',
        'latest-settled',
      ].includes(message)
    )
      this.options.notify();
  }
  select(key?: string) {
    if (!this.runs) return;
    if (key === undefined) this.runs.follow();
    else if (!this.runs.select(key)) return;
    this.rebuild();
  }
  suspend() {
    this.ready = false;
  }
  getSelectedControlPolicy() {
    const run = this.runs?.runs.get(this.runs.selected ?? '');
    return run && getLatestRunControlPolicy(run);
  }
  sendSelectedControl(action: string) {
    if (!this.ready || !this.options.canSend()) return false;
    const run = this.runs?.runs.get(this.runs.selected ?? '');
    if (!run || (action !== 'pause' && action !== 'resume' && action !== 'abort')) return false;
    const policy = getLatestRunControlPolicy(run);
    if (!(action === 'pause' ? policy.canPause : action === 'resume' ? policy.canResume : policy.canAbort))
      return false;
    const generation = this.generation;
    if (action === 'pause') {
      this.runs!.select(run.key);
      this.options.notify();
    }
    return generation === this.generation && this.sendControl(action, run.scope);
  }
  rebuild() {
    const revision = ++this.projectionRevision;
    const frames = this.runs?.replay() ?? [];
    const run = this.runs?.runs.get(this.runs.selected ?? '');
    if (run && !frames.some((frame) => frame.message === 'start')) {
      this.dispatch({ message: 'trace', data: '', rivetScope: run.scope }, true, true, true);
      // Missing start limits detail, not the live root's lifecycle. Project the
      // retained tail through the original admission without inventing a start.
      for (const frame of frames) {
        if (revision !== this.projectionRevision) return;
        this.dispatch(frame, true, false, true);
      }
    } else
      for (const [index, frame] of frames.entries()) {
        if (revision !== this.projectionRevision) return;
        this.dispatch(frame, true, index === 0, true);
      }
    if (revision === this.projectionRevision) this.options.notify();
  }

  sendControl(action: string, target: LatestDebuggerScope, extra: Record<string, unknown> = {}) {
    if (!this.ready || !this.options.canSend() || this.pending.size >= 32) return false;
    const commandId = crypto.randomUUID();
    const command = readLatestDebuggerControl({
      type: 'latest-control',
      data: { commandId, target, action, ...extra },
    });
    if (!command) return false;
    const generation = this.generation;
    const timer = setTimeout(() => {
      if (generation !== this.generation || this.pending.get(commandId) !== timer) return;
      this.pending.delete(commandId);
      this.options.warn('Debugger command outcome is unknown. Inspect runtime state; the command was not retried.');
    }, 10_000);
    // Register before sending: effects may acknowledge or retire synchronously.
    this.pending.set(commandId, timer);
    let sent = false;
    try {
      return (sent = this.options.send(JSON.stringify(command)));
    } finally {
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(commandId);
      }
    }
  }

  acceptEnvelope(
    envelope: {
      message?: string;
      data?: {
        protocol?: number;
        channel?: unknown;
        channelIsolation?: boolean;
        runScopedControls?: boolean;
        commandId?: string;
        status?: string;
        reason?: string;
      };
      rivetEventId?: string;
    },
    value: unknown,
    context: { external: boolean; named: boolean; fail(): void; onReady(): void },
  ): boolean | undefined {
    if (context.external && envelope.message === 'latest-session' && envelope.data?.protocol === 2) {
      const expected = this.requestedChannel;
      if (expected === undefined) {
        context.fail();
        return false;
      }
      if (
        !isLatestDebuggerSession(value) ||
        value.data.channel !== expected ||
        (this.channel !== undefined && this.channel !== expected)
      ) {
        context.fail();
        return false;
      }
      this.channel = expected;
      this.runs ??= new LatestDebuggerRuns(this.options.eligible);
      this.observation = true;
      this.ready = true;
      context.onReady();
      return false;
    }
    if (context.external && envelope.message === 'latest-session') {
      // A verified logical v2 session cannot resume as a legacy observer.
      // Unknown versions never inherit readiness or controls either.
      if (envelope.data?.protocol !== 1 || this.channel !== undefined || context.named) {
        context.fail();
        return false;
      }
      this.observation = true;
      context.onReady();
      return false;
    }
    if ((this.channel !== undefined || context.named) && !this.ready) return false;
    if (envelope.message === 'latest-control-result') {
      if (!isLatestDebuggerControlResult(value)) return false;
      const id = envelope.data?.commandId;
      const timer = id ? this.pending.get(id) : undefined;
      if (timer) {
        clearTimeout(timer);
        this.pending.delete(id!);
        if (envelope.data?.status !== 'accepted')
          this.options.warn(envelope.data?.reason ?? 'Debugger control was not confirmed.');
      }
      return false;
    }
    if (this.observation && typeof envelope.rivetEventId === 'string') {
      const split = envelope.rivetEventId.lastIndexOf(':');
      const origin = envelope.rivetEventId.slice(0, split),
        sequence = Number(envelope.rivetEventId.slice(split + 1));
      if (
        envelope.rivetEventId.length > 200 ||
        split < 1 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence <= (this.cursors.get(origin) ?? 0)
      )
        return false;
      this.cursors.set(origin, sequence);
      if (this.cursors.size > 256) this.cursors.delete(this.cursors.keys().next().value!);
    }
    if (this.observation) {
      const diagnostic = readLatestDebuggerDiagnostic(value);
      if (diagnostic) {
        const generation = this.generation;
        if (this.runs && diagnostic.code !== 'owner-unavailable') {
          this.runs.markIncomplete();
          // Invalidate already displayed prompts too, not only future
          // selection replay. Reconstruction never sends commands.
          this.rebuild();
        } else this.options.notify();
        if (generation === this.generation) this.warnOnce(diagnostic.code, diagnostic.message);
        return false;
      }
    }

    return undefined;
  }
  reset() {
    this.generation++;
    this.projectionRevision++;
    this.runs = undefined;
    this.channel = undefined;
    this.ready = false;
    this.observation = false;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.cursors.clear();
    this.diagnostics.clear();
  }
  private warnOnce(code: string, message: string) {
    if (this.diagnostics.has(code)) return;
    this.diagnostics.add(code);
    this.options.warn(message, { toastId: `latest-debugger-${code}` });
  }
}
