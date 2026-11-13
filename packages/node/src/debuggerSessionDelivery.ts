import type { WebSocket } from 'ws';
import {
  ExecutorReliableInbox,
  ExecutorReliableOutbox,
  type ExecutorRequestPhase,
  EXECUTOR_RELIABLE_PROCESS_BYTES,
  EXECUTOR_RELIABLE_SESSION_BYTES,
  EXECUTOR_RELIABLE_MAX_BYTES,
  ExecutorRecoveryError,
  executorDeliveryPolicy,
} from '@valerypopoff/rivet2-core';
import { stringifyDebuggerPayloadForTransport } from './debuggerPayloadSanitizer.js';
import { projectDebuggerEnvelope } from './debuggerSessionProjection.js';

type Event = { sequence: number; order: number; payload: string; bytes: number; requestId?: string };
export type ReliableProcessBudget = { bytes: number };

/** One bounded writer for live delivery and replay. Only diagnostics are evictable. */
export class DebuggerSessionDelivery {
  readonly outbox = new ExecutorReliableOutbox(EXECUTOR_RELIABLE_SESSION_BYTES, 256 * 1024);
  readonly inbox: ExecutorReliableInbox;
  readonly phases = new Map<string, ExecutorRequestPhase['phase']>();
  readonly incomplete = new Set<string>();
  #evictedThrough = new Map<string, number>();
  events: Event[] = [];
  bytes = 0;
  sequence = 0;
  #order = 0;
  #cursor = 0;
  #socket?: WebSocket;
  #timer?: ReturnType<typeof setTimeout>;
  #ready = false;
  #partialNotices = new Set<string>();
  #pressured = false;
  constructor(
    private readonly limits: { bytes: number; events: number },
    private readonly budget: ReliableProcessBudget,
  ) {
    this.inbox = new ExecutorReliableInbox(() => this.#socket?.close(4410, 'incomplete-transfer'), budget);
  }

  get activeCount() {
    return [...this.phases.values()].filter((phase) => phase !== 'settled').length;
  }
  canAcceptRun() {
    return (
      this.activeCount < 32 &&
      this.outbox.size < 3968 &&
      this.outbox.bytes < EXECUTOR_RELIABLE_SESSION_BYTES - EXECUTOR_RELIABLE_MAX_BYTES &&
      this.budget.bytes < EXECUTOR_RELIABLE_PROCESS_BYTES - EXECUTOR_RELIABLE_MAX_BYTES
    );
  }

  bind(socket: WebSocket, cursor: number) {
    this.#socket = socket;
    this.#cursor = cursor;
    for (const [requestId, sequence] of this.#evictedThrough) if (sequence > cursor) this.incomplete.add(requestId);
    this.#partialNotices = new Set(this.incomplete);
    this.#ready = true;
    this.inbox.resetTransfer();
    this.outbox.replay();
    const requests = [...this.phases]
      .filter(([, phase]) => phase !== 'settled')
      .map(([requestId, phase]) => ({ requestId, phase }));
    socket.send(
      JSON.stringify({
        message: 'executor-session-state',
        data: {
          requests,
          incompleteRequests: this.#takePartialNotices(Math.max(0, 32 - requests.length)),
        },
      }),
    );
    socket.once('close', () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.inbox.resetTransfer();
        this.#cancelPump();
      }
    });
    this.#schedule();
  }
  #takePartialNotices(count = 32) {
    const ids = [...this.#partialNotices].slice(0, count);
    for (const id of ids) this.#partialNotices.delete(id);
    return ids;
  }
  #markIncomplete(requestId: string) {
    if (!this.incomplete.has(requestId)) this.#partialNotices.add(requestId);
    this.incomplete.add(requestId);
  }

  send(envelope: Record<string, any>, emergency = false): void {
    const order = ++this.#order;
    const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : undefined;
    if (requestId && this.phases.has(requestId)) {
      if (envelope.message === 'start') this.phases.set(requestId, 'running');
      if (envelope.message === 'graphOutputsReady') this.phases.set(requestId, 'outputs-ready');
      if (
        envelope.message === 'done' ||
        (envelope.message === 'error' &&
          (envelope.data?.code !== 'executor-result-unavailable' || envelope.data.executionStatus === 'completed'))
      )
        this.phases.set(requestId, 'settled');
    }
    if (executorDeliveryPolicy(envelope.message) === 'reliable') {
      // Start only establishes display identity; authored project content is not a result.
      const projected = envelope.message === 'start' ? projectDebuggerEnvelope(envelope) : envelope;
      if (projected.diagnosticsIncomplete && requestId) this.#markIncomplete(requestId);
      this.#retain(stringifyDebuggerPayloadForTransport(projected), order, emergency);
    } else {
      const projected = projectDebuggerEnvelope(envelope);
      if (projected.diagnosticsIncomplete && requestId) this.#markIncomplete(requestId);
      let payload = stringifyDebuggerPayloadForTransport({ ...projected, rivetSequence: ++this.sequence });
      let bytes = Buffer.byteLength(payload);
      // Custom serialization can expand a small-looking value. Enforce the wire bound as well.
      if (bytes >= 64 * 1024) {
        if (requestId) this.#markIncomplete(requestId);
        payload = JSON.stringify({
          message: 'trace',
          requestId,
          rivetSequence: this.sequence,
          diagnosticsIncomplete: true,
          data: 'Oversized run detail was omitted.',
        });
        bytes = Buffer.byteLength(payload);
      }
      this.events.push({ sequence: this.sequence, order, payload, bytes, requestId });
      this.bytes += bytes;
      this.trim(this.limits.bytes, this.limits.events);
    }
    this.#schedule();
  }

  #retain(payload: string, order: number, emergency: boolean) {
    const bytes = Buffer.byteLength(payload);
    if (this.budget.bytes + bytes > EXECUTOR_RELIABLE_PROCESS_BYTES - (emergency ? 0 : 16 * 1024 * 1024))
      throw new ExecutorRecoveryError('retention-limit');
    this.outbox.add(payload, order, emergency);
    this.budget.bytes += bytes;
  }

  trim(bytes: number, count = this.limits.events) {
    while (this.events.length && (this.bytes > bytes || this.events.length > count)) {
      const removed = this.events.shift()!;
      this.bytes -= removed.bytes;
      if (removed.requestId) this.#evictedThrough.set(removed.requestId, removed.sequence);
      // History retention is not evidence loss for an observer that already received it.
      // A reconnect compares its actual received cursor with the evicted range in bind().
      if (removed.sequence > this.#cursor) {
        if (removed.requestId) this.#markIncomplete(removed.requestId);
      }
    }
  }

  acknowledge(id: unknown) {
    const before = this.outbox.bytes;
    this.outbox.acknowledge(id);
    this.budget.bytes -= before - this.outbox.bytes;
  }

  /** Only completed dataset replies may use the replayable client-to-server lane. */
  receive(value: unknown): { id: number; message?: Record<string, any> } | undefined {
    const item = this.inbox.receive(value);
    if (!item) return;
    if (item.text === undefined) return { id: item.id };
    const message = JSON.parse(item.text);
    if (message?.type !== 'datasets:response' || typeof message.data?.requestId !== 'string')
      throw new ExecutorRecoveryError('invalid-transfer');
    return { id: item.id, message };
  }
  receipt(id: number) {
    this.#socket?.send(JSON.stringify({ message: 'executor-receipt', data: { id } }));
  }
  #cancelPump() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  #schedule() {
    if (this.#timer || !this.#socket) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pump();
    }, 0);
    this.#timer.unref?.();
  }
  #pump() {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      for (let batch = 0; batch < 32; batch++) {
        if (socket.bufferedAmount > (this.#pressured ? 256 * 1024 : 1024 * 1024)) {
          if (!this.#pressured)
            console.warn('[executor-session] Writer backpressure', {
              bufferedBytes: socket.bufferedAmount,
              diagnosticBytes: this.bytes,
              reliableBytes: this.outbox.bytes,
            });
          this.#pressured = true;
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#pump();
          }, 10);
          this.#timer.unref?.();
          return;
        }
        this.#pressured = false;
        const first = this.events[0]?.sequence ?? this.sequence + 1;
        if (this.#cursor < first - 1) {
          socket.send(
            JSON.stringify({
              message: 'executor-diagnostics-gap',
              data: { after: this.#cursor, through: first - 1, requestIds: this.#takePartialNotices() },
            }),
          );
          this.#cursor = first - 1;
          continue;
        } else if (this.#partialNotices.size) {
          socket.send(
            JSON.stringify({
              message: 'executor-diagnostics-gap',
              data: { after: this.#cursor, through: this.#cursor, requestIds: this.#takePartialNotices() },
            }),
          );
          continue;
        }
        const event = this.events.find((item) => item.sequence > this.#cursor);
        const reliableOrder = this.outbox.peekOrder();
        if (reliableOrder !== undefined && (!event || reliableOrder < event.order)) {
          socket.send(JSON.stringify({ message: 'executor-reliable', data: this.outbox.next() }));
        } else if (event) {
          socket.send(event.payload);
          this.#cursor = event.sequence;
        } else {
          if (this.#ready) socket.send(JSON.stringify({ message: 'executor-session-ready', data: { protocol: 2 } }));
          this.#ready = false;
          return;
        }
      }
      this.#schedule();
    } catch {
      // A transport failure keeps the ledger for the same authenticated owner.
      socket.terminate();
    }
  }
  dispose() {
    this.#cancelPump();
    this.#socket = undefined;
    this.budget.bytes -= this.outbox.bytes;
    this.outbox.clear();
    this.inbox.clear();
    this.#evictedThrough.clear();
    this.#partialNotices.clear();
    this.phases.clear();
    this.incomplete.clear();
    this.events = [];
    this.bytes = 0;
  }
}
