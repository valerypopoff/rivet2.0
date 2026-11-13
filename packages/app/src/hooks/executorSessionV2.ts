import {
  ExecutorReliableInbox,
  ExecutorReliableOutbox,
  ExecutorRecoveryError,
  EXECUTOR_RELIABLE_PROCESS_BYTES,
  executorDeliveryPolicy,
  type ExecutorRecoveryReason,
} from '@valerypopoff/rivet2-core';

const reliableBudget = { bytes: 0 };

/** Reliable replies and received-delivery identities belong to a logical session, not a socket. */
export class ExecutorSessionV2 {
  active = false;
  readonly incomplete = new Set<string>();
  readonly outbox = new ExecutorReliableOutbox();
  readonly inbox = new ExecutorReliableInbox(() => this.options.fail('invalid-transfer'), reliableBudget);
  #dataset = new Map<string, number | null>();
  #timer?: ReturnType<typeof setTimeout>;
  #epoch = 0;
  constructor(
    private readonly options: {
      socket(): WebSocket | null;
      ready(): boolean;
      fail(reason: ExecutorRecoveryReason): void;
      partial(requests: string[]): void;
    },
  ) {}

  receive(raw: string): { raw?: string; envelope?: any; receipt?: number } | undefined {
    if (!this.active) return { raw };
    const envelope = JSON.parse(raw);
    if (envelope.message === 'executor-reliable') {
      const item = this.inbox.receive(envelope.data);
      if (!item) return;
      if (item.text === undefined) return { receipt: item.id };
      const message = JSON.parse(item.text);
      if (!message || typeof message.message !== 'string' || executorDeliveryPolicy(message.message) !== 'reliable')
        throw new ExecutorRecoveryError('invalid-transfer');
      if (message.diagnosticsIncomplete && typeof message.requestId === 'string') this.markPartial([message.requestId]);
      return { raw: item.text, envelope: message, receipt: item.id };
    }
    if (envelope.message === 'executor-receipt') {
      const before = this.outbox.bytes;
      this.outbox.acknowledge(envelope.data?.id);
      reliableBudget.bytes -= before - this.outbox.bytes;
      for (const [id, delivery] of this.#dataset) if (delivery === envelope.data.id) this.#dataset.delete(id);
      return;
    }
    if (envelope.message === 'executor-session-state') {
      if (
        !Array.isArray(envelope.data?.requests) ||
        envelope.data.requests.length > 32 ||
        envelope.data.requests.some(
          (item: any) =>
            !item ||
            typeof item.requestId !== 'string' ||
            item.requestId.length > 200 ||
            !['accepted', 'running', 'outputs-ready', 'settled'].includes(item.phase),
        )
      )
        throw new ExecutorRecoveryError('invalid-transfer');
      this.markPartial(envelope.data.incompleteRequests);
      return;
    }
    if (envelope.message === 'executor-diagnostics-gap') {
      if (
        !Number.isSafeInteger(envelope.data?.after) ||
        envelope.data.after < 0 ||
        !Number.isSafeInteger(envelope.data?.through) ||
        envelope.data.through < envelope.data.after
      )
        throw new ExecutorRecoveryError('invalid-transfer');
      this.markPartial(envelope.data.requestIds);
      return { raw, envelope };
    }
    if (envelope.diagnosticsIncomplete && typeof envelope.requestId === 'string')
      this.markPartial([envelope.requestId]);
    return { raw, envelope };
  }
  markPartial(ids: unknown) {
    if (!Array.isArray(ids) || ids.length > 4096 || ids.some((id) => typeof id !== 'string' || id.length > 200))
      throw new ExecutorRecoveryError('invalid-transfer');
    const fresh = ids.filter((id) => !this.incomplete.has(id));
    for (const id of fresh) this.incomplete.add(id);
    if (this.incomplete.size > 4096) throw new ExecutorRecoveryError('retention-limit');
    if (fresh.length) this.options.partial(fresh);
  }
  acknowledge(id: number) {
    const socket = this.options.socket();
    if (socket?.readyState === WebSocket.OPEN)
      this.#write(socket, JSON.stringify({ type: 'executor-receipt', data: { id } }));
  }
  #write(socket: WebSocket, payload: string): boolean {
    try {
      socket.send(payload);
      return true;
    } catch {
      // The send may have reached the peer. Keep delivery IDs and replay only after reconnecting.
      this.suspend();
      try {
        socket.close();
      } catch {
        this.options.fail('owner-unavailable');
      }
      return false;
    }
  }
  dataset(requestId: string, operation: (reply: (payload: unknown) => void) => Promise<void>) {
    if (this.#dataset.has(requestId)) return;
    if (this.#dataset.size >= 256) throw new ExecutorRecoveryError('retention-limit');
    this.#dataset.set(requestId, null);
    const epoch = this.#epoch;
    const complete = (payload: unknown, error?: string) => {
      if (epoch !== this.#epoch || this.#dataset.get(requestId) !== null) return;
      try {
        const text = JSON.stringify({
          type: 'datasets:response',
          data: { requestId, payload, ...(error ? { error } : {}) },
        });
        const bytes = new TextEncoder().encode(text).byteLength;
        if (reliableBudget.bytes + bytes > EXECUTOR_RELIABLE_PROCESS_BYTES)
          throw new ExecutorRecoveryError('retention-limit');
        const id = this.outbox.add(text);
        reliableBudget.bytes += bytes;
        this.#dataset.set(requestId, id);
        this.flush();
      } catch {
        this.options.fail('retention-limit');
      }
    };
    void operation((payload) => complete(payload)).catch(() =>
      complete(undefined, 'Executor dataset operation failed. It was not repeated.'),
    );
  }
  flush() {
    if (this.#timer || !this.options.ready()) return;
    const socket = this.options.socket();
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (let count = 0; count < 16; count++) {
      if ((socket.bufferedAmount ?? 0) > 1024 * 1024) break;
      const frame = this.outbox.next();
      if (!frame) return;
      if (!this.#write(socket, JSON.stringify({ type: 'executor-reliable', data: frame }))) return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, 10);
  }
  suspend() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.inbox.resetTransfer();
    this.outbox.replay();
  }
  clear() {
    this.#epoch++;
    reliableBudget.bytes -= this.outbox.bytes;
    this.suspend();
    this.active = false;
    this.inbox.clear();
    this.outbox.clear();
    this.#dataset.clear();
    this.incomplete.clear();
  }
}
