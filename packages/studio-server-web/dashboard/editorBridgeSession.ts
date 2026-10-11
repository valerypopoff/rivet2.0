import {
  cloneValidatedDashboardToEditorCommand,
  type DashboardToEditorCommand,
} from '../../studio-server-shared/editor-bridge';

export type BridgeResult<T> =
  | { status: 'completed'; value: T }
  | {
      status: 'expired' | 'unknown' | 'replaced' | 'closed' | 'overloaded';
    };
type Entry = {
  command: DashboardToEditorCommand;
  bytes: number;
  durable: boolean;
  dispatched: boolean;
  reply?: string;
  settle?: (result: BridgeResult<unknown>) => void;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: number;
};
const durableCommands = new Set<DashboardToEditorCommand['type']>([
  'workflow-paths-moved',
  'delete-workflow-project',
  'refresh-open-project-from-disk',
]);

/** One dashboard owns a bounded bridge lifetime, independent of React renders. */
export class EditorBridgeSession {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private sequence = 0;
  private instance: string | null = null;
  private send: ((command: DashboardToEditorCommand) => void) | null = null;
  private closed = false;
  constructor(
    private readonly options: {
      maxEntries?: number;
      maxBytes?: number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
      now?: () => number;
      onUndelivered?: (command: DashboardToEditorCommand) => void;
      onReconciliationRequired?: () => void;
    } = {},
  ) {}

  nextId(kind: string): string {
    return `${kind}:${Date.now()}:${this.sequence++}`;
  }

  /** React's development effect probe can dispose and remount the same owner. */
  activate(): void {
    this.closed = false;
  }

  ready(instance: string, send: (command: DashboardToEditorCommand) => void): void {
    if (this.closed) return;
    if (this.instance && this.instance !== instance) this.detach();
    this.instance = instance;
    this.send = send;
    for (const [id, entry] of this.entries) if (!entry.dispatched) this.dispatch(id, entry);
  }

  detach(): void {
    this.send = null;
    // Commands queued before first readiness remain valid. A replacement editor
    // cannot own requests made against its predecessor.
    if (!this.instance) return;
    for (const [id, entry] of this.entries) {
      if (entry.durable && !entry.dispatched) {
        this.clearTimer(entry);
        entry.settle?.({ status: 'replaced' });
        entry.settle = undefined;
        entry.reply = undefined;
      } else this.finish(id, { status: 'replaced' });
    }
    this.instance = null;
  }

  post(command: DashboardToEditorCommand): boolean {
    const id = this.nextId(command.type);
    const entry = this.admit(id, command);
    if (!entry) return false;
    if (!entry.durable) {
      entry.deadline = this.now() + 120_000;
      entry.timer = this.setTimer(() => this.expire(id, entry), 120_000);
    }
    this.dispatch(id, entry);
    return true;
  }

  request<T>(
    command: DashboardToEditorCommand & { requestId: string },
    reply: string,
    timeoutMs: number,
  ): Promise<BridgeResult<T>> {
    return new Promise((resolve) => {
      const entry = this.admit(command.requestId, command);
      if (!entry) {
        resolve({ status: this.closed ? 'closed' : 'overloaded' });
        return;
      }
      entry.reply = reply;
      entry.settle = resolve as (result: BridgeResult<unknown>) => void;
      entry.deadline = this.now() + timeoutMs;
      entry.timer = this.setTimer(() => this.expire(command.requestId, entry), timeoutMs);
      this.dispatch(command.requestId, entry);
    });
  }

  acknowledge<T>(id: string | undefined, reply: string, value: T): boolean {
    if (!id) return false;
    const entry = this.entries.get(id);
    if (!entry?.dispatched || entry.reply !== reply) return false;
    if (entry.deadline !== undefined && this.now() >= entry.deadline) {
      this.expire(id, entry);
      return false;
    }
    this.finish(id, { status: 'completed', value });
    return true;
  }

  cancelQueued(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.dispatched || entry.durable) return false;
    this.finish(id, { status: 'expired' });
    return true;
  }

  dispose(): void {
    this.closed = true;
    this.send = null;
    this.instance = null;
    for (const id of this.entries.keys()) this.finish(id, { status: 'closed' });
  }

  get pendingCount(): number {
    return this.entries.size;
  }
  get pendingBytes(): number {
    return this.bytes;
  }

  private admit(id: string, command: DashboardToEditorCommand): Entry | undefined {
    if (this.closed) return;
    if (this.entries.has(id) || this.entries.size >= (this.options.maxEntries ?? 128)) {
      this.requireReconciliation(command);
      return;
    }
    const detached = cloneValidatedDashboardToEditorCommand(command);
    const bytes = new TextEncoder().encode(JSON.stringify(detached)).byteLength;
    if (bytes + this.bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) {
      this.requireReconciliation(command);
      return;
    }
    const entry: Entry = { command: detached, bytes, durable: durableCommands.has(command.type), dispatched: false };
    this.entries.set(id, entry);
    this.bytes += bytes;
    return entry;
  }

  private dispatch(id: string, entry: Entry): void {
    if (!this.send) return;
    if (entry.deadline !== undefined && this.now() >= entry.deadline) {
      this.expire(id, entry);
      if (!this.entries.has(id)) return;
    }
    try {
      entry.dispatched = true;
      this.send(entry.command);
      if (!entry.settle) this.finish(id, { status: 'completed', value: undefined });
    } catch {
      this.finish(id, { status: 'unknown' });
      this.options.onUndelivered?.(entry.command);
    }
  }

  private finish(id: string, result: BridgeResult<unknown>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
    this.clearTimer(entry);
    entry.settle?.(result);
    if (result.status !== 'completed' && result.status !== 'closed') this.requireReconciliation(entry.command);
  }
  private requireReconciliation(command: DashboardToEditorCommand): void {
    if (durableCommands.has(command.type)) this.options.onReconciliationRequired?.();
  }
  private expire(id: string, entry: Entry): void {
    if (this.entries.get(id) !== entry) return;
    const result = { status: entry.dispatched ? 'unknown' : 'expired' } as const;
    // A committed change outlives its acknowledgement deadline. Undispatched
    // notifications remain deliverable; lost dispatched ones require a fresh
    // authoritative reconciliation, never replay of the old command.
    if (entry.durable && !entry.dispatched) {
      this.clearTimer(entry);
      entry.deadline = undefined;
      entry.settle?.(result);
      entry.settle = undefined;
      entry.reply = undefined;
    } else {
      const wasRequest = Boolean(entry.settle);
      this.finish(id, result);
      if (!wasRequest) this.options.onUndelivered?.(entry.command);
    }
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  private setTimer(callback: () => void, ms: number) {
    return (this.options.setTimer ?? setTimeout)(callback, ms);
  }
  private clearTimer(entry: Entry) {
    if (entry.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(entry.timer);
    entry.timer = undefined;
  }
}
