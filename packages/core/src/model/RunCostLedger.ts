import type { ChatV2CallFinishedEvent, LLMProfileAttemptTraceEvent } from './ProcessContext.js';

/** Run-owned provider estimates. It is not an invoice or a graph output. */
export type RunCostSnapshot =
  | { status: 'complete' | 'partial'; knownCostUsd: number }
  | { status: 'unknown'; knownCostUsd: null };

/** Receives physical-call observations directly, before display/recording filters. */
export class RunCostLedger {
  #calls = new Map<string, number | null>();
  #hasUnobservedWork = false;

  observeChat(event: ChatV2CallFinishedEvent): void {
    if (typeof event.callId !== 'string' || !event.callId) {
      this.markUnobserved();
      return;
    }
    this.#record(`llm:${event.callId}`, event.pricing.status === 'known' ? event.pricing.costUsd : undefined);
  }

  observeClassifier(event: LLMProfileAttemptTraceEvent): void {
    if (event.family !== 'classifier' || event.attemptIndex === undefined) return;
    if (
      typeof event.eventId !== 'string' ||
      !event.eventId ||
      !Number.isSafeInteger(event.attemptIndex) ||
      event.attemptIndex < 0
    ) {
      this.markUnobserved();
      return;
    }
    this.#record(`decision:${event.eventId}`, event.classifierUsage?.estimatedCostUsd);
  }

  /** Legacy Chat does not expose complete per-attempt accounting. */
  observeLegacy(key: string, value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) this.#record(`legacy:${key}`, value);
    this.markUnobserved();
  }

  markUnobserved(): void {
    this.#hasUnobservedWork = true;
  }

  snapshot(executionPending = false): RunCostSnapshot {
    let known = 0;
    let knownCount = 0;
    let hasUnknownCost = this.#hasUnobservedWork || executionPending;
    for (const cost of this.#calls.values()) {
      if (cost === null) hasUnknownCost = true;
      else {
        known += cost;
        knownCount++;
      }
    }
    if (!Number.isFinite(known)) return { status: 'unknown', knownCostUsd: null };
    if (!hasUnknownCost) return { status: 'complete', knownCostUsd: known };
    if (knownCount === 0) return { status: 'unknown', knownCostUsd: null };
    return { status: 'partial', knownCostUsd: known };
  }

  #record(id: string, value: unknown): void {
    if (this.#calls.has(id)) return;
    this.#calls.set(id, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  }
}
