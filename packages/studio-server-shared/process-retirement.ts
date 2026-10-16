/** Pod-local protocol. Retirement is irreversible and never interrupts accepted work. */
export const RETIREMENT_PROTOCOL = 1;
export type RetirementSnapshot = {
  protocol: 1;
  withdrawalProtocol: 1;
  incarnation: string;
  operationId: string | null;
  state: 'serving' | 'withdrawing' | 'draining' | 'drained' | 'failed';
  failureCode?: 'fence_failed' | 'drain_failed';
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class ProcessRetirement {
  private operationId: string | null = null;
  private state: RetirementSnapshot['state'] = 'serving';
  private failureCode: RetirementSnapshot['failureCode'];
  constructor(
    readonly incarnation: string,
    private readonly fence: () => void,
    private readonly drain: () => Promise<void>,
    private readonly onWithdraw: () => void = () => {},
  ) {
    if (!UUID.test(incarnation)) throw new Error('Invalid retirement process identity.');
  }
  snapshot(): RetirementSnapshot {
    return {
      protocol: RETIREMENT_PROTOCOL,
      withdrawalProtocol: 1,
      incarnation: this.incarnation,
      operationId: this.operationId,
      state: this.state,
      ...(this.failureCode ? { failureCode: this.failureCode } : {}),
    };
  }
  get isWithdrawing(): boolean {
    return this.state === 'withdrawing';
  }
  withdraw(operationId: unknown, incarnation: unknown): RetirementSnapshot {
    this.assertIdentity(operationId, incarnation);
    if (this.operationId) return this.snapshot();
    this.operationId = operationId as string;
    this.state = 'withdrawing';
    try {
      this.onWithdraw();
    } catch {
      this.state = 'failed';
      this.failureCode = 'fence_failed';
    }
    return this.snapshot();
  }
  private assertIdentity(operationId: unknown, incarnation: unknown): void {
    if (incarnation !== this.incarnation || typeof operationId !== 'string' || !UUID.test(operationId))
      throw new Error('Invalid retirement operation identity.');
    if (this.operationId && this.operationId !== operationId)
      throw new Error('Another retirement operation owns this process.');
  }
  begin(operationId: unknown, incarnation: unknown): RetirementSnapshot {
    this.assertIdentity(operationId, incarnation);
    if (this.operationId && this.state !== 'withdrawing') return this.snapshot();
    this.operationId = operationId as string;
    this.state = 'draining';
    try {
      this.fence();
      // Observe every failure; a lost acknowledgement must never cause replay or a false drained result.
      void Promise.resolve()
        .then(this.drain)
        .then(
          () => {
            this.state = 'drained';
          },
          () => {
            this.state = 'failed';
            this.failureCode = 'drain_failed';
          },
        );
    } catch {
      this.state = 'failed';
      this.failureCode = 'fence_failed';
    }
    return this.snapshot();
  }
}

/** Counts lifetimes rather than connections. Releasing a browser cannot release its accepted work. */
export class AcceptedWork {
  private accepting = true;
  private active = 0;
  private failure: Error | undefined;
  private waiters = new Set<() => void>();
  get count(): number {
    return this.active;
  }
  get isAccepting(): boolean {
    return this.accepting;
  }
  acquire(): (() => void) | null {
    if (!this.accepting) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    };
  }
  beginDrain(): void {
    this.accepting = false;
  }
  fail(error: Error): void {
    this.failure ??= error;
    this.beginDrain();
  }
  async drain(): Promise<void> {
    this.beginDrain();
    if (this.active)
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    if (this.failure) throw this.failure;
  }
}
