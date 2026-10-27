/** All rates are USD per one million tokens. Cache counts are subsets of inputTokens. */
export type TokenPricing = {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheReadPerMillionTokens?: number;
  cacheWritePerMillionTokens?: number;
};

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateTokenPricing(value: unknown): TokenPricing | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Token pricing override must be an object.');
  const result: Record<string, number> = {};
  for (const key of [
    'inputPerMillionTokens',
    'outputPerMillionTokens',
    'cacheReadPerMillionTokens',
    'cacheWritePerMillionTokens',
  ] as const) {
    const rate = (value as Record<string, unknown>)[key];
    if (rate === undefined && key.startsWith('cache')) continue;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)
      throw new Error(`Token pricing ${key} must be a finite, non-negative USD rate.`);
    result[key] = rate;
  }
  return result as TokenPricing;
}

export function calculateTokenUsageCost(
  pricing: TokenPricing,
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      }
    | undefined,
): number | undefined {
  try {
    const validated = validateTokenPricing(pricing);
    if (!validated) return undefined;
    pricing = validated;
  } catch {
    return undefined;
  }
  const { inputTokens, outputTokens, inputTokenDetails } = usage ?? {};
  const read = inputTokenDetails?.cacheReadTokens === undefined ? 0 : inputTokenDetails.cacheReadTokens;
  const write = inputTokenDetails?.cacheWriteTokens === undefined ? 0 : inputTokenDetails.cacheWriteTokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens) || !isTokenCount(read) || !isTokenCount(write))
    return undefined;
  if (read + write > inputTokens) return undefined;
  const total =
    ((inputTokens - read - write) * pricing.inputPerMillionTokens +
      read * (pricing.cacheReadPerMillionTokens ?? pricing.inputPerMillionTokens) +
      write * (pricing.cacheWritePerMillionTokens ?? pricing.inputPerMillionTokens) +
      outputTokens * pricing.outputPerMillionTokens) /
    1_000_000;
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}
