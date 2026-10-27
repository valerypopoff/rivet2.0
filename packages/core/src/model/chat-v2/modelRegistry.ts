import { anthropicModels } from '../../plugins/anthropic/anthropic.js';
import { generativeAiGoogleModels } from '../../plugins/google/google.js';
import { openaiModels } from '../../utils/openai.js';
import type { ChatV2Provider } from './chatV2Types.js';
import { calculateTokenUsageCost, type TokenPricing } from '../tokenPricing.js';

const TOKENS_PER_THOUSAND = 1_000;

export type ChatV2ModelInfo = {
  maxTokens: number;
  displayName: string;
  /** USD per token, not per thousand tokens. Omitted when Rivet cannot estimate this model safely. */
  cost?: {
    prompt: number;
    completion: number;
  };
};

type PerThousandTokenModelInfo = Omit<ChatV2ModelInfo, 'cost'> & {
  /** USD per 1,000 tokens, as used by legacy Chat model catalogs. */
  cost?: NonNullable<ChatV2ModelInfo['cost']>;
  /** Keep a selectable legacy model visible while deliberately withholding an unreliable rate. */
  pricing?: 'unpriced';
};

type TokenUsageForCost = {
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
};

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizePerThousandTokenModelRegistry(
  provider: string,
  models: Record<string, PerThousandTokenModelInfo>,
): Record<string, ChatV2ModelInfo> {
  return Object.fromEntries(
    Object.entries(models).map(([modelId, model]) => {
      if (model.pricing === 'unpriced') {
        if (model.cost != null) {
          throw new Error(`Unpriced ${provider} LLM Chat model ${modelId} must not define a rate.`);
        }

        return [
          modelId,
          {
            maxTokens: model.maxTokens,
            displayName: model.displayName,
          },
        ];
      }

      if (
        model.cost == null ||
        !isFiniteNonNegative(model.cost.prompt) ||
        !isFiniteNonNegative(model.cost.completion)
      ) {
        throw new Error(`Invalid ${provider} LLM Chat pricing for model ${modelId}.`);
      }

      return [
        modelId,
        {
          maxTokens: model.maxTokens,
          displayName: model.displayName,
          cost: {
            prompt: model.cost.prompt / TOKENS_PER_THOUSAND,
            completion: model.cost.completion / TOKENS_PER_THOUSAND,
          },
        },
      ];
    }),
  );
}

const chatV2ModelRegistry = {
  // OpenAI and Google catalogs predate LLM Chat V2 and store USD per 1,000
  // tokens for their legacy nodes. Normalize them once at this boundary.
  openai: normalizePerThousandTokenModelRegistry('OpenAI', openaiModels),
  anthropic: anthropicModels,
  google: normalizePerThousandTokenModelRegistry('Google', generativeAiGoogleModels),
  // Routing prices vary by upstream endpoint. Use reported call cost, not
  // another provider's static rate for a similarly named model.
  openrouter: {},
  custom: {},
} satisfies Record<ChatV2Provider, Record<string, ChatV2ModelInfo>>;

export function getChatV2ModelRegistry() {
  return chatV2ModelRegistry;
}

export function getChatV2ModelInfo(provider: ChatV2Provider, modelId: string): ChatV2ModelInfo | undefined {
  const providerModels = chatV2ModelRegistry[provider] as Record<string, ChatV2ModelInfo>;
  return providerModels[modelId];
}

export function getChatV2SystemTokenPricing(provider: ChatV2Provider, modelId: string): TokenPricing | undefined {
  const cost = getChatV2ModelInfo(provider, modelId.trim())?.cost;
  return cost == null
    ? undefined
    : { inputPerMillionTokens: cost.prompt * 1_000_000, outputPerMillionTokens: cost.completion * 1_000_000 };
}

export function calculateChatV2Cost(
  provider: ChatV2Provider,
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const model = getChatV2ModelInfo(provider, modelId);
  if (model?.cost == null || !isFiniteNonNegative(promptTokens) || !isFiniteNonNegative(completionTokens)) {
    return undefined;
  }

  const cost = model.cost.prompt * promptTokens + model.cost.completion * completionTokens;
  return isFiniteNonNegative(cost) ? cost : undefined;
}

/**
 * Uses reported OpenRouter cost; estimates other providers only when both
 * billable text-token counts are available. Cache discounts, long-context
 * premiums, and provider tool fees are not modeled in those estimates.
 */
export function calculateChatV2UsageCost(
  provider: ChatV2Provider,
  modelId: string,
  usage: TokenUsageForCost | undefined,
  providerMetadata?: Record<string, Record<string, unknown>>,
  tokenPricing?: TokenPricing,
): number | undefined {
  if (tokenPricing !== undefined) return calculateTokenUsageCost(tokenPricing, usage);
  if (provider === 'openrouter') {
    const reportedUsage = providerMetadata?.openrouter?.usage;
    const cost =
      reportedUsage != null && typeof reportedUsage === 'object'
        ? (reportedUsage as { cost?: unknown }).cost
        : undefined;
    return isFiniteNonNegative(cost) ? cost : undefined;
  }
  if (!isFiniteNonNegative(usage?.inputTokens) || !isFiniteNonNegative(usage.outputTokens)) {
    return undefined;
  }

  return calculateChatV2Cost(provider, modelId, usage.inputTokens, usage.outputTokens);
}
