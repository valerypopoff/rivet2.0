import { randomUUID } from 'node:crypto';
import type { ScheduledOccurrence } from '../../../studio-server-shared/scheduled-run-types.js';
import { ScheduledRunStore, type ClaimedRun, type ScheduledRunScope } from './store.js';
import { beginScheduledActivity } from './activity.js';
import { settleBeforeDeadline } from '../shutdown-deadline.js';

export class ScheduledRunService {
  readonly owner = randomUUID();
  private stopping = false;
  private draining = false;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private shutdown?: Promise<void>;
  private retirementFailure?: Error;
  get activeCount() {
    return this.active.size;
  }
  constructor(
    readonly store: ScheduledRunStore,
    private readonly run: (
      job: ClaimedRun,
      owner: string,
      signal: AbortSignal,
    ) => Promise<Partial<ScheduledOccurrence>>,
    private readonly mayStart: () => boolean = () => true,
    private readonly maxConcurrent = 2,
    private readonly options: {
      scope?: ScheduledRunScope;
      acquirePermit?: () => { release(): void } | undefined;
    } = {},
  ) {}
  start() {
    if (this.started || this.stopping || this.draining) return;
    this.started = true;
    const poll = async () => {
      if (this.stopping || this.draining) return;
      await this.tick().catch(() => {
        console.error('[scheduled-runs] Scheduler storage unavailable; no work was acknowledged.');
      });
      if (!this.stopping && !this.draining) this.timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
  }
  tick(): Promise<void> {
    if (this.polling) return this.polling;
    const operation = this.pollOnce();
    this.polling = operation;
    void operation
      .finally(() => {
        if (this.polling === operation) this.polling = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private async pollOnce() {
    if (this.stopping || this.draining || !this.mayStart()) return;
    const releaseActivity = beginScheduledActivity();
    let permit: { release(): void } | undefined;
    let job: ClaimedRun | undefined;
    try {
      permit = this.active.size < this.maxConcurrent ? this.options.acquirePermit?.() : undefined;
      const capacity = this.active.size < this.maxConcurrent && (!this.options.acquirePermit || permit);
      // Keep due-time/lease reconciliation alive while every local slot is busy.
      // Zero permits housekeeping but never another claim, even if a locally
      // unwinding execution's durable lease has already expired.
      job = await this.store.tick(this.owner, capacity ? this.maxConcurrent : 0, this.options.scope);
    } catch (error) {
      this.retirementFailure ??= new Error('Scheduled claim ownership is unconfirmed.');
      releaseActivity();
      permit?.release();
      throw error;
    }
    if (!job) {
      releaseActivity();
      permit?.release();
      return;
    }
    const claimed = job;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Execution time limit exceeded.')),
      job.draft.timeoutMinutes * 60_000,
    );
    let heartbeatPending: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = this.store
        .heartbeat(job.occurrence.id, this.owner)
        .then(
          (valid) => {
            if (!valid) controller.abort(new Error('Execution ownership lost or cancellation requested.'));
          },
          () => controller.abort(new Error('Execution ownership could not be renewed.')),
        )
        .finally(() => {
          heartbeatPending = undefined;
        });
    }, 5000);
    const task = (async () => {
      try {
        let result: Partial<ScheduledOccurrence>;
        try {
          if (this.stopping || !this.mayStart()) controller.abort();
          controller.signal.throwIfAborted();
          result = await this.run(claimed, this.owner, controller.signal);
        } catch {
          result = {
            status: controller.signal.aborted ? 'interrupted' : 'failed',
            reason: controller.signal.aborted
              ? 'Execution interrupted; check side effects before retrying.'
              : 'Project unavailable, invalid main graph, or execution preparation failed.',
          };
        }
        // A failed acknowledgement is not a graph failure. Leave durable lease
        // recovery to report an uncertain outcome, never overwrite success with
        // a fabricated failure or invoke the graph again.
        if (!(await this.store.finish(job.occurrence.id, this.owner, result)))
          this.retirementFailure ??= new Error('Scheduled outcome persistence is unconfirmed.');
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        await heartbeatPending;
        this.active.delete(claimed.occurrence.id);
        releaseActivity();
        permit?.release();
      }
    })().catch(() => {
      this.retirementFailure ??= new Error('Scheduled outcome persistence is unconfirmed.');
      console.error('[scheduled-runs] Outcome could not be committed; interruption recovery will reconcile it.');
    });
    this.active.set(job.occurrence.id, { controller, task });
  }
  beginDrain(): void {
    this.draining = true;
    clearTimeout(this.timer);
  }

  async drainAcceptedWork(): Promise<void> {
    this.beginDrain();
    // A claim already in flight may create another accepted run. Wait for it
    // before taking the execution snapshot, retaining heartbeats and stores.
    await this.polling;
    await Promise.all([...this.active.values()].map((a) => a.task));
    if (this.retirementFailure) throw this.retirementFailure;
  }

  stop(graceMs = 30_000): Promise<void> {
    return (this.shutdown ??= this.stopOnce(Date.now() + Math.max(0, graceMs)));
  }
  private async stopOnce(deadline: number) {
    this.stopping = true;
    clearTimeout(this.timer);
    const polling = Promise.resolve(this.polling).catch(() => undefined);
    // A stuck claim must not consume unbounded shutdown time. It still observes
    // stopping before invocation when it eventually returns.
    await settleBeforeDeadline(polling, deadline);
    await settleBeforeDeadline(Promise.all([...this.active.values()].map((a) => a.task)), deadline);
    for (const a of this.active.values()) a.controller.abort(new Error('Server stopping.'));
    // Do not close stores beneath an execution still unwinding its recording.
    const settled = polling
      .then(() => Promise.all([...this.active.values()].map((a) => a.task)))
      .then(() => this.store.close())
      .catch(() => {
        console.error('[scheduled-runs] Store shutdown failed; durable leases will reconcile unfinished work.');
      });
    await settleBeforeDeadline(settled, deadline + 5000);
  }
}
