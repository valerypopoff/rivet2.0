import { randomUUID } from 'node:crypto';
import type { ScheduledOccurrence } from '../../../studio-server-shared/scheduled-run-types.js';
import { ScheduledRunStore, type ClaimedRun } from './store.js';
import { beginScheduledActivity } from './activity.js';
import { settleBeforeDeadline } from '../shutdown-deadline.js';

export class ScheduledRunService {
  readonly owner = randomUUID();
  private stopping = false;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private shutdown?: Promise<void>;
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
  ) {}
  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    const poll = async () => {
      if (this.stopping) return;
      await this.tick().catch(() => {
        console.error('[scheduled-runs] Scheduler storage unavailable; no work was acknowledged.');
      });
      if (!this.stopping) this.timer = setTimeout(() => void poll(), 2000);
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
    if (this.stopping || !this.mayStart() || this.active.size >= this.maxConcurrent) return;
    const releaseActivity = beginScheduledActivity();
    let job: ClaimedRun | undefined;
    try {
      job = await this.store.tick(this.owner, this.maxConcurrent);
    } catch (error) {
      releaseActivity();
      throw error;
    }
    if (!job) {
      releaseActivity();
      return;
    }
    const claimed = job;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Execution time limit exceeded.')),
      job.draft.timeoutMinutes * 60_000,
    );
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void this.store
        .heartbeat(job.occurrence.id, this.owner)
        .then(
          (valid) => {
            if (!valid) controller.abort(new Error('Execution ownership lost or cancellation requested.'));
          },
          () => controller.abort(new Error('Execution ownership could not be renewed.')),
        )
        .finally(() => {
          heartbeatPending = false;
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
        await this.store.finish(job.occurrence.id, this.owner, result);
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        this.active.delete(claimed.occurrence.id);
        releaseActivity();
      }
    })().catch(() => {
      console.error('[scheduled-runs] Outcome could not be committed; interruption recovery will reconcile it.');
    });
    this.active.set(job.occurrence.id, { controller, task });
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
