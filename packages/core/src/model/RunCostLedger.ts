import type { ChatV2CallFinishedEvent, LLMProfileAttemptTraceEvent } from './ProcessContext.js';

/** Run-owned provider estimates. It is not an invoice or a graph output. */
export type RunCostSnapshot =
  | { status: 'complete' | 'partial'; knownCostUsd: number }
  | { status: 'unknown'; knownCostUsd: null };

export type RunCostFamily = 'llm' | 'decisionAI';
export type RunCostBreakdown = { llm: RunCostSnapshot; decisionAI: RunCostSnapshot; total: RunCostSnapshot };

type CostSummary = { knownCostUsd: number; hasKnownCost: boolean; hasUnknownCost: boolean };
const emptySummary = (): CostSummary => ({ knownCostUsd: 0, hasKnownCost: false, hasUnknownCost: false });

function addCost(summary: CostSummary, cost: number | null): void {
  if (cost === null) summary.hasUnknownCost = true;
  else {
    summary.knownCostUsd += cost;
    summary.hasKnownCost = true;
  }
}

function readSummary(summary: CostSummary, executionPending = false): RunCostSnapshot {
  if (!Number.isFinite(summary.knownCostUsd)) return { status: 'unknown', knownCostUsd: null };
  if (!summary.hasUnknownCost && !executionPending) return { status: 'complete', knownCostUsd: summary.knownCostUsd };
  if (!summary.hasKnownCost) return { status: 'unknown', knownCostUsd: null };
  return { status: 'partial', knownCostUsd: summary.knownCostUsd };
}

/** One identity set per root run; each scope maintains its inclusive subtotals. */
export class RunCostLedger {
  readonly #parent: RunCostLedger | undefined;
  readonly #seenCalls: Set<string>;
  readonly #costs = { llm: emptySummary(), decisionAI: emptySummary(), total: emptySummary() };

  constructor(parent?: RunCostLedger) {
    this.#parent = parent;
    this.#seenCalls = parent ? parent.#seenCalls : new Set();
  }

  createProjectScope(): RunCostLedger {
    return new RunCostLedger(this);
  }

  observeChat(event: ChatV2CallFinishedEvent): void {
    if (typeof event.callId !== 'string' || !event.callId) {
      this.markUnobserved('llm');
      return;
    }
    this.#record(`llm:${event.callId}`, 'llm', event.pricing.status === 'known' ? event.pricing.costUsd : undefined);
  }

  observeClassifier(event: LLMProfileAttemptTraceEvent): void {
    if (event.family !== 'classifier' || event.attemptIndex === undefined) return;
    if (
      typeof event.eventId !== 'string' ||
      !event.eventId ||
      !Number.isSafeInteger(event.attemptIndex) ||
      event.attemptIndex < 0
    ) {
      this.markUnobserved('decisionAI');
      return;
    }
    this.#record(`decision:${event.eventId}`, 'decisionAI', event.classifierUsage?.estimatedCostUsd);
  }

  /** Legacy Chat does not expose complete per-attempt accounting. */
  observeLegacy(key: string, value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) this.#record(`legacy:${key}`, 'llm', value);
    this.markUnobserved('llm');
  }

  markUnobserved(family?: RunCostFamily): void {
    for (let scope: RunCostLedger | undefined = this; scope; scope = scope.#parent) {
      if (family) scope.#costs[family].hasUnknownCost = true;
      else {
        scope.#costs.llm.hasUnknownCost = true;
        scope.#costs.decisionAI.hasUnknownCost = true;
      }
      scope.#costs.total.hasUnknownCost = true;
    }
  }

  snapshot(executionPending = false): RunCostSnapshot {
    return readSummary(this.#costs.total, executionPending);
  }

  /** Observed amounts now, not a prediction of unfinished or future calls. */
  breakdown(): RunCostBreakdown {
    return {
      llm: readSummary(this.#costs.llm),
      decisionAI: readSummary(this.#costs.decisionAI),
      total: this.snapshot(),
    };
  }

  #record(id: string, family: RunCostFamily, value: unknown): void {
    if (this.#seenCalls.has(id)) return;
    this.#seenCalls.add(id);
    const cost = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    for (let scope: RunCostLedger | undefined = this; scope; scope = scope.#parent) {
      // Preserve physical-observation order for both root and subtree totals.
      addCost(scope.#costs.total, cost);
      addCost(scope.#costs[family], cost);
    }
  }
}
