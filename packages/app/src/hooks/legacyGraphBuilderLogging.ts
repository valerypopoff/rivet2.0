import type { ChatV2CallFinishedEvent } from '@valerypopoff/rivet2-core';

const SAFE_DATA_TYPE_PATTERN = /^[a-z][a-z0-9[\]-]{0,47}$/i;

function summarizeValue(value: unknown): string {
  if (value == null) {
    return value === null ? 'null' : 'undefined';
  }

  switch (typeof value) {
    case 'string':
      return `string(${value.length} chars)`;
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isFinite(value) ? 'number' : 'non-finite number';
    case 'bigint':
      return 'bigint';
    case 'function':
      return 'function';
    case 'symbol':
      return 'symbol';
    case 'object':
      if (Array.isArray(value)) {
        return `array(${value.length} items)`;
      }
      return `object(${Object.keys(value).length} keys)`;
  }

  return 'unknown';
}

/**
 * Legacy Graph Creator diagnostics deliberately describe value shape only.
 * Arguments and results can contain prompts, node settings, or credentials and
 * must not be copied into the in-editor transcript.
 */
export function summarizeLegacyGraphBuilderArguments(args: readonly unknown[]): string {
  if (args.length === 0) {
    return '(no args)';
  }

  return args.map((value, index) => `arg${index + 1}=${summarizeValue(value)}`).join(', ');
}

export function summarizeLegacyGraphBuilderResult(result: unknown): string {
  if (typeof result === 'object' && result != null && 'type' in result && 'value' in result) {
    const dataValue = result as { type: unknown; value: unknown };
    const dataType =
      typeof dataValue.type === 'string' && SAFE_DATA_TYPE_PATTERN.test(dataValue.type) ? dataValue.type : 'unknown';
    return `DataValue(${dataType}, ${summarizeValue(dataValue.value)})`;
  }

  return summarizeValue(result);
}

export function assertLegacyGraphBuilderFinished(receivedFinalEvent: boolean): void {
  if (!receivedFinalEvent) {
    throw new Error('The legacy Graph Builder stopped before reporting a completed result.');
  }
}

type LegacyGraphBuilderAccountingSummary = Readonly<{
  physicalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  abortedAttempts: number;
  usageCompleteness: 'complete' | 'partial' | 'unavailable';
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  pricingCompleteness: 'complete' | 'partial' | 'unavailable';
  costUsd: number | null;
}>;

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Retains aggregate accounting only. Provider/model identifiers, request
 * bodies, messages, finish reasons, errors, and per-attempt records are never
 * stored by the legacy rollback path.
 */
export class LegacyGraphBuilderAccounting {
  #physicalAttempts = 0;
  #successfulAttempts = 0;
  #failedAttempts = 0;
  #abortedAttempts = 0;
  #completeUsageAttempts = 0;
  #observedUsageAttempts = 0;
  #promptTokens = 0;
  #completionTokens = 0;
  #totalTokens = 0;
  #pricedAttempts = 0;
  #costUsd = 0;

  record(event: ChatV2CallFinishedEvent): void {
    this.#physicalAttempts += 1;
    if (event.outcome === 'success') {
      this.#successfulAttempts += 1;
    } else if (event.outcome === 'aborted') {
      this.#abortedAttempts += 1;
    } else {
      this.#failedAttempts += 1;
    }

    const promptTokens = event.normalizedUsage?.promptTokens;
    const completionTokens = event.normalizedUsage?.completionTokens;
    const totalTokens = event.normalizedUsage?.totalTokens;
    const hasAnyUsage = [promptTokens, completionTokens, totalTokens].some(isNonNegativeFiniteNumber);
    const hasCompleteUsage =
      isNonNegativeFiniteNumber(promptTokens) &&
      isNonNegativeFiniteNumber(completionTokens) &&
      isNonNegativeFiniteNumber(totalTokens);
    if (hasAnyUsage) {
      this.#observedUsageAttempts += 1;
    }
    if (hasCompleteUsage) {
      this.#completeUsageAttempts += 1;
      this.#promptTokens += promptTokens;
      this.#completionTokens += completionTokens;
      this.#totalTokens += totalTokens;
    }

    if (isNonNegativeFiniteNumber(event.pricing.costUsd)) {
      this.#pricedAttempts += 1;
      this.#costUsd += event.pricing.costUsd;
    }
  }

  snapshot(): LegacyGraphBuilderAccountingSummary {
    const usageCompleteness =
      this.#physicalAttempts > 0 && this.#completeUsageAttempts === this.#physicalAttempts
        ? 'complete'
        : this.#observedUsageAttempts > 0
          ? 'partial'
          : 'unavailable';
    const pricingCompleteness =
      this.#physicalAttempts > 0 && this.#pricedAttempts === this.#physicalAttempts
        ? 'complete'
        : this.#pricedAttempts > 0
          ? 'partial'
          : 'unavailable';

    return {
      physicalAttempts: this.#physicalAttempts,
      successfulAttempts: this.#successfulAttempts,
      failedAttempts: this.#failedAttempts,
      abortedAttempts: this.#abortedAttempts,
      usageCompleteness,
      promptTokens: usageCompleteness === 'complete' ? this.#promptTokens : null,
      completionTokens: usageCompleteness === 'complete' ? this.#completionTokens : null,
      totalTokens: usageCompleteness === 'complete' ? this.#totalTokens : null,
      pricingCompleteness,
      costUsd: pricingCompleteness === 'complete' ? this.#costUsd : null,
    };
  }
}

function formatNullableNumber(value: number | null): string {
  return value == null ? 'unknown' : String(value);
}

export function formatLegacyGraphBuilderAccounting(summary: LegacyGraphBuilderAccountingSummary): string {
  return [
    `attempts=${summary.physicalAttempts}`,
    `outcomes=${summary.successfulAttempts}/${summary.failedAttempts}/${summary.abortedAttempts}`,
    `usage=${summary.usageCompleteness}`,
    `promptTokens=${formatNullableNumber(summary.promptTokens)}`,
    `completionTokens=${formatNullableNumber(summary.completionTokens)}`,
    `totalTokens=${formatNullableNumber(summary.totalTokens)}`,
    `pricing=${summary.pricingCompleteness}`,
    `costUsd=${formatNullableNumber(summary.costUsd)}`,
  ].join(' ');
}
