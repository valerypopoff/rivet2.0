import type { DatasetRequestMap, ProcessEventMessageMap } from './ExecutorProtocol.js';

/** Hosted executor transport, independent from the managed latest-debugger protocol. */
export const EXECUTOR_SESSION_V2 = 'rivet-session-v2';
// Preserve the ordinary WebSocket's 100 MiB message ceiling while chunking the wire payload.
// Published browser-storage RPC has separate limits and does not use this transport.
export const EXECUTOR_RELIABLE_MAX_BYTES = 100 * 1024 * 1024;
export const EXECUTOR_RELIABLE_SESSION_BYTES = 256 * 1024 * 1024;
export const EXECUTOR_RELIABLE_PROCESS_BYTES = 512 * 1024 * 1024;
export const EXECUTOR_RELIABLE_MAX_ITEMS = 4096;
export const EXECUTOR_TRANSFER_TIMEOUT_MS = 60_000;

// Exhaustive for current process events: additions must choose a delivery policy.
const deliveryPolicy: Record<keyof ProcessEventMessageMap, 'reliable' | 'diagnostic'> = {
  start: 'reliable',
  done: 'reliable',
  error: 'reliable',
  abort: 'reliable',
  graphOutputsReady: 'reliable',
  webAppStoragePatch: 'reliable',
  userInput: 'reliable',
  pause: 'reliable',
  resume: 'reliable',
  codeConsole: 'diagnostic',
  nodeStart: 'diagnostic',
  nodeFinish: 'diagnostic',
  nodeError: 'diagnostic',
  nodeExcluded: 'diagnostic',
  graphAbort: 'diagnostic',
  graphStart: 'diagnostic',
  graphFinish: 'diagnostic',
  partialOutput: 'diagnostic',
  progress: 'diagnostic',
  llmCallFinished: 'diagnostic',
  llmChatOutputSnapshot: 'diagnostic',
  llmProfileAttempt: 'diagnostic',
  toolCallFinished: 'diagnostic',
  nodeOutputsCleared: 'diagnostic',
  streamingOutputWatchSummary: 'diagnostic',
  graphError: 'diagnostic',
  trace: 'diagnostic',
};
const datasetMessages: Record<keyof DatasetRequestMap, true> = {
  'datasets:get-metadata': true,
  'datasets:get-for-project': true,
  'datasets:get-data': true,
  'datasets:put-data': true,
  'datasets:put-row': true,
  'datasets:put-metadata': true,
  'datasets:clear-data': true,
  'datasets:delete': true,
  'datasets:knn': true,
  'datasets:export-for-project': true,
};
export function executorDeliveryPolicy(message: string): 'reliable' | 'diagnostic' {
  if (
    message === 'graph-upload-allowed' ||
    message === 'executor-owner-retiring' ||
    Object.hasOwn(datasetMessages, message)
  )
    return 'reliable';
  if (Object.hasOwn(deliveryPolicy, message)) return deliveryPolicy[message as keyof typeof deliveryPolicy];
  throw new ExecutorRecoveryError('invalid-transfer');
}
// JSON escaping expands a UTF-16 code unit at most sixfold; frames stay below 64 KiB.
const CHUNK_CHARACTERS = 8192;
export type ExecutorRecoveryReason =
  | 'identity-mismatch'
  | 'protocol-mismatch'
  | 'sequence-gap'
  | 'recovery-deadline'
  | 'observer-replaced'
  | 'owner-unavailable'
  | 'retention-limit'
  | 'invalid-transfer';
export class ExecutorRecoveryError extends Error {
  constructor(readonly reason: ExecutorRecoveryReason) {
    super(`Executor session could not be resumed (${reason}). Run outcome is unknown; it was not resubmitted.`);
    this.name = 'ExecutorRecoveryError';
  }
}
export type ExecutorReliableChunk = { id: number; index: number; count: number; bytes: number; text: string };
export type ExecutorBufferBudget = { bytes: number; maxBytes?: number };
export type ExecutorRequestPhase = { requestId: string; phase: 'accepted' | 'running' | 'outputs-ready' | 'settled' };
const safeId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Retains each payload once; replay resets only its cursor. */
export class ExecutorReliableOutbox {
  #nextId = 0;
  #items = new Map<number, { text: string; bytes: number; index: number; order: number; sent: boolean }>();
  bytes = 0;
  constructor(
    readonly maxBytes = EXECUTOR_RELIABLE_SESSION_BYTES,
    readonly reservedBytes = 0,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(reservedBytes) ||
      reservedBytes < 0 ||
      reservedBytes >= maxBytes
    )
      throw new Error('Invalid executor reliable retention limits');
  }
  get size() {
    return this.#items.size;
  }
  add(text: string, order?: number, emergency = false): number {
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      bytes > EXECUTOR_RELIABLE_MAX_BYTES ||
      this.bytes + bytes > this.maxBytes - (emergency ? 0 : this.reservedBytes) ||
      this.size >= EXECUTOR_RELIABLE_MAX_ITEMS - (emergency || !this.reservedBytes ? 0 : 128)
    )
      throw new ExecutorRecoveryError('retention-limit');
    const id = ++this.#nextId;
    this.#items.set(id, { text, bytes, index: 0, order: order ?? id, sent: false });
    this.bytes += bytes;
    return id;
  }
  acknowledge(id: unknown): boolean {
    if (!safeId(id) || id > this.#nextId) throw new ExecutorRecoveryError('invalid-transfer');
    const item = this.#items.get(id);
    if (!item) return false;
    if (!item.sent) throw new ExecutorRecoveryError('invalid-transfer');
    this.bytes -= item.bytes;
    this.#items.delete(id);
    return true;
  }
  replay() {
    for (const item of this.#items.values()) item.index = 0;
  }
  peekOrder(): number | undefined {
    for (const item of this.#items.values())
      if (item.index < Math.max(1, Math.ceil(item.text.length / CHUNK_CHARACTERS))) return item.order;
    return undefined;
  }
  next(): ExecutorReliableChunk | undefined {
    for (const [id, item] of this.#items) {
      const count = Math.max(1, Math.ceil(item.text.length / CHUNK_CHARACTERS));
      if (item.index >= count) continue;
      const index = item.index++;
      if (item.index === count) item.sent = true;
      // Move a boundary before a surrogate pair, never through it. Adjacent chunks share the same boundary.
      const boundary = (offset: number) =>
        offset > 0 &&
        offset < item.text.length &&
        /[\uD800-\uDBFF]/.test(item.text[offset - 1]!) &&
        /[\uDC00-\uDFFF]/.test(item.text[offset]!)
          ? offset - 1
          : offset;
      return {
        id,
        index,
        count,
        bytes: item.bytes,
        text: item.text.slice(
          boundary(index * CHUNK_CHARACTERS),
          boundary(Math.min(item.text.length, (index + 1) * CHUNK_CHARACTERS)),
        ),
      };
    }
    return undefined;
  }
  clear() {
    this.#items.clear();
    this.bytes = 0;
  }
}

/** Ordered bounded reassembly. Consumed IDs survive transport replacement. */
export class ExecutorReliableInbox {
  #consumed = 0;
  #transfer?: { id: number; count: number; total: number; parts: string[]; bytes: number };
  #timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly onExpiry?: () => void,
    private readonly budget?: ExecutorBufferBudget,
  ) {
    if (
      budget &&
      (!Number.isSafeInteger(budget.bytes) ||
        budget.bytes < 0 ||
        !Number.isSafeInteger(budget.maxBytes ?? EXECUTOR_RELIABLE_PROCESS_BYTES) ||
        (budget.maxBytes ?? EXECUTOR_RELIABLE_PROCESS_BYTES) < 1)
    )
      throw new Error('Invalid executor receive budget');
  }
  receive(value: unknown): { id: number; text?: string } | undefined {
    if (!value || typeof value !== 'object') throw new ExecutorRecoveryError('invalid-transfer');
    const part = value as ExecutorReliableChunk;
    if (
      !safeId(part.id) ||
      !safeId(part.count) ||
      part.count > Math.ceil(EXECUTOR_RELIABLE_MAX_BYTES / CHUNK_CHARACTERS) ||
      !Number.isSafeInteger(part.index) ||
      part.index < 0 ||
      part.index >= part.count ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 0 ||
      part.bytes > EXECUTOR_RELIABLE_MAX_BYTES ||
      typeof part.text !== 'string' ||
      part.text.length > CHUNK_CHARACTERS + 1
    )
      throw new ExecutorRecoveryError('invalid-transfer');
    if (part.id <= this.#consumed) return { id: part.id };
    if (!this.#transfer) {
      if (this.budget) {
        if (this.budget.bytes + part.bytes > (this.budget.maxBytes ?? EXECUTOR_RELIABLE_PROCESS_BYTES))
          throw new ExecutorRecoveryError('retention-limit');
        this.budget.bytes += part.bytes;
      }
      this.#transfer = { id: part.id, count: part.count, total: part.bytes, parts: [], bytes: 0 };
      this.#timer = setTimeout(() => {
        this.resetTransfer();
        this.onExpiry?.();
      }, EXECUTOR_TRANSFER_TIMEOUT_MS);
      this.#timer.unref?.();
    }
    const transfer = this.#transfer;
    if (
      transfer.id !== part.id ||
      transfer.count !== part.count ||
      transfer.total !== part.bytes ||
      transfer.parts.length !== part.index
    )
      throw new ExecutorRecoveryError('invalid-transfer');
    transfer.bytes += new TextEncoder().encode(part.text).byteLength;
    if (transfer.bytes > transfer.total) throw new ExecutorRecoveryError('invalid-transfer');
    transfer.parts.push(part.text);
    if (transfer.parts.length !== transfer.count) return;
    if (transfer.bytes !== transfer.total) throw new ExecutorRecoveryError('invalid-transfer');
    const text = transfer.parts.join('');
    this.resetTransfer();
    this.#consumed = part.id;
    return { id: part.id, text };
  }
  resetTransfer() {
    if (this.#transfer && this.budget) this.budget.bytes -= this.#transfer.total;
    this.#transfer = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  clear() {
    this.#consumed = 0;
    this.resetTransfer();
  }
}
