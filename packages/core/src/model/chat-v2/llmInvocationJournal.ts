import type { ChatV2CallFinishedEvent } from '../ProcessContext.js';
import type { LLMAttempt } from './llmProfileFallback.js';

export type LLMInvocationJournalEvent =
  | { type: 'model-call'; event: ChatV2CallFinishedEvent }
  | { type: 'llm-attempt'; attempt: LLMAttempt }
  | { type: 'tool-round'; kind: 'connected' | 'internal'; count: number }
  | { type: 'terminal'; kind: 'final-model-answer' | 'released-unresolved-calls' | 'failed' | 'cancelled' };

/**
 * Invocation-scoped, append-only facts collected from physical provider calls.
 * It stores physical-call accounting alongside the full developer-visible LLM
 * attempt diagnostics selected by the node.
 */
export class LLMInvocationJournal {
  readonly #modelCalls: ChatV2CallFinishedEvent[] = [];
  readonly #events: LLMInvocationJournalEvent[] = [];
  readonly #llmAttempts: LLMAttempt[] = [];

  recordModelCall(event: ChatV2CallFinishedEvent): void {
    // The host observer is allowed to inspect the same event after this local
    // observer returns. Preserve an immutable-at-recording-time snapshot so a
    // later observer cannot rewrite this invocation's accounting facts.
    const snapshot = {
      ...event,
      ...(event.rawUsage == null ? {} : { rawUsage: { ...event.rawUsage } }),
      ...(event.normalizedUsage == null ? {} : { normalizedUsage: { ...event.normalizedUsage } }),
      pricing: { ...event.pricing },
    };
    this.#modelCalls.push(snapshot);
    this.#events.push({ type: 'model-call', event: snapshot });
  }

  recordToolRound(event: { kind: 'connected' | 'internal'; count: number }): void {
    this.#events.push({ type: 'tool-round', ...event });
  }

  recordLLMAttempt(attempt: LLMAttempt): void {
    const snapshot = { ...attempt };
    this.#llmAttempts.push(snapshot);
    this.#events.push({ type: 'llm-attempt', attempt: snapshot });
  }

  recordTerminal(event: { kind: Extract<LLMInvocationJournalEvent, { type: 'terminal' }>['kind'] }): void {
    this.#events.push({ type: 'terminal', ...event });
  }

  get modelCalls(): readonly ChatV2CallFinishedEvent[] {
    return this.#modelCalls;
  }

  get events(): readonly LLMInvocationJournalEvent[] {
    return this.#events;
  }

  get llmAttempts(): readonly LLMAttempt[] {
    return this.#llmAttempts;
  }
}
