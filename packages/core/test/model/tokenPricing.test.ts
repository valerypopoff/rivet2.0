import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateTokenUsageCost, validateTokenPricing } from '../../src/model/tokenPricing.js';
import { calculateChatV2UsageCost, getChatV2SystemTokenPricing } from '../../src/model/chat-v2/modelRegistry.js';
import {
  calculateClassifierUsageCost,
  getClassifierProvider,
  getClassifierSystemTokenPricing,
} from '../../src/model/classifier/providers.js';
import { normalizeLLMProfileValue, createDefaultLLMProfileValue } from '../../src/model/chat-v2/llmProfile.js';
import { normalizeClassifierProfileValue, normalizeClassifierProfiles } from '../../src/model/classifier/profile.js';
import { classifierProfileHealthIdentity } from '../../src/model/classifier/profile.js';
import { normalizeChatV2Usage } from '../../src/model/chat-v2/chatV2Outputs.js';
import { notifyChatV2CallFinished } from '../../src/model/chat-v2/chatV2CallObserver.js';
import type { RunChatV2PipelineOptions, StreamChatV2Result } from '../../src/model/chat-v2/chatV2Types.js';
import type { ChatV2CallFinishedEvent } from '../../src/model/ProcessContext.js';
import { ClassifierProfileNodeImpl } from '../../src/model/nodes/ClassifierProfileNode.js';
import type { ClassifierProfileValue } from '../../src/model/classifier/profile.js';
import { testProcessContext } from '../testUtils.js';

test('clearing optional cache prices in an authored Decision AI profile remains executable before save/reload', async () => {
  const node = ClassifierProfileNodeImpl.create();
  node.data.tokenPricing = {
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 8,
    cacheReadPerMillionTokens: undefined,
    cacheWritePerMillionTokens: undefined,
  };
  const result = await new ClassifierProfileNodeImpl(node).process(
    {},
    { ...testProcessContext(), node, signal: new AbortController().signal },
  );
  assert.deepEqual((result.profile!.value as ClassifierProfileValue).configuration.tokenPricing, {
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 8,
  });
  assert.ok(
    Object.hasOwn(node.data.tokenPricing, 'cacheReadPerMillionTokens'),
    'runtime normalization must not mutate authored data',
  );
});

const pricing = {
  inputPerMillionTokens: 2,
  outputPerMillionTokens: 8,
  cacheReadPerMillionTokens: 0.5,
  cacheWritePerMillionTokens: 3,
};

test('normalized Decision AI profiles compose into fallback arrays without optional metadata or blank titles', async () => {
  const candidate = normalizeClassifierProfileValue({
    version: 1,
    configuration: { provider: 'jev', model: 'jev-latest', tokenPricing: pricing },
    credential: {},
  });
  assert.deepEqual(normalizeClassifierProfiles([candidate, candidate]), [candidate, candidate]);
  const node = ClassifierProfileNodeImpl.create();
  node.title = '   ';
  node.data.tokenPricing = pricing;
  const result = await new ClassifierProfileNodeImpl(node).process(
    {},
    { ...testProcessContext(), node, signal: new AbortController().signal },
  );
  const profile = result.profile!.value as ClassifierProfileValue;
  assert.equal(Object.hasOwn(profile, 'profileName'), false, 'blank display metadata must actually be absent');
  assert.deepEqual(normalizeClassifierProfiles([profile, profile]), [profile, profile]);
});

test('shared prices apply to reported cache subsets exactly once, preserve genuine zero and reject malformed usage', () => {
  assert.equal(
    calculateTokenUsageCost(
      { inputPerMillionTokens: -1, outputPerMillionTokens: 8 },
      { inputTokens: 1, outputTokens: 1 },
    ),
    undefined,
  );
  assert.equal(
    calculateTokenUsageCost(pricing, {
      inputTokens: 1000,
      outputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 400, cacheWriteTokens: 100 },
    }),
    0.0023,
  );
  assert.equal(
    calculateTokenUsageCost(
      { inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
      { inputTokens: 10, outputTokens: 3 },
    ),
    0,
  );
  assert.equal(
    calculateTokenUsageCost(
      { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
      { inputTokens: 1000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 400 } },
    ),
    0.0028,
  );
  for (const usage of [
    undefined,
    { inputTokens: 1 },
    { inputTokens: -1, outputTokens: 0 },
    { inputTokens: NaN, outputTokens: 0 },
    { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: 10, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 11 } },
  ])
    assert.equal(calculateTokenUsageCost(pricing, usage), undefined);
});

test('system rate lookup uses each catalog unit and unknown models stay unknown', () => {
  const rates = getChatV2SystemTokenPricing('openai', 'gpt-4o');
  assert.ok(rates);
  assert.deepEqual(
    getChatV2SystemTokenPricing('openai', ' gpt-4o '),
    rates,
    'preview uses the same trimmed model as runtime',
  );
  assert.equal(
    calculateChatV2UsageCost('openai', 'gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }),
    rates.inputPerMillionTokens,
  );
  assert.equal(getChatV2SystemTokenPricing('custom', 'private'), undefined);
  assert.equal(getClassifierSystemTokenPricing('jev', 'private'), undefined);
  const provider = getClassifierProvider('jev');
  assert.equal(
    getClassifierSystemTokenPricing('jev')?.inputPerMillionTokens,
    calculateClassifierUsageCost(
      provider,
      { input_tokens: 1_000_000, output_tokens: 0 },
      { requestedModel: provider.defaultModel, responseModel: provider.defaultModel },
    ),
  );
});

test('explicit rates override provider dollar amounts and allow private model estimates without changing default behavior', () => {
  const metadata = { openrouter: { usage: { cost: 99 } } };
  const usage = { inputTokens: 1000, outputTokens: 100 };
  assert.equal(calculateChatV2UsageCost('openrouter', 'private', usage, metadata), 99);
  assert.equal(calculateChatV2UsageCost('openrouter', 'private', usage, metadata, pricing), 0.0028);
  assert.equal(calculateChatV2UsageCost('custom', 'private', usage, undefined, pricing), 0.0028);
  assert.equal(
    calculateClassifierUsageCost(
      getClassifierProvider('jev'),
      { input_tokens: 1000, output_tokens: 100 },
      { requestedModel: 'private', responseModel: 'private-resolved' },
      pricing,
    ),
    0.0028,
  );
});

test('both profile formats retain detached validated rates; invalid or incomplete overrides fail instead of becoming free', () => {
  const llm = createDefaultLLMProfileValue();
  llm.configuration.tokenPricing = { ...pricing };
  const decision = {
    version: 1,
    configuration: { provider: 'jev', model: 'jev-latest', tokenPricing: { ...pricing } },
    credential: {},
  };
  const resolvedLLM = normalizeLLMProfileValue(llm);
  const resolvedDecision = normalizeClassifierProfileValue(decision);
  llm.configuration.tokenPricing.inputPerMillionTokens = 99;
  decision.configuration.tokenPricing.inputPerMillionTokens = 99;
  assert.deepEqual(resolvedLLM.configuration.tokenPricing, pricing);
  assert.deepEqual(resolvedDecision.configuration.tokenPricing, pricing);
  assert.equal(
    normalizeLLMProfileValue(llm).healthIdentity?.key,
    resolvedLLM.healthIdentity?.key,
    'pricing must not reset LLM suspension',
  );
  assert.equal(
    classifierProfileHealthIdentity(normalizeClassifierProfileValue(decision), 'project' as never, 'node' as never).key,
    classifierProfileHealthIdentity(resolvedDecision, 'project' as never, 'node' as never).key,
    'pricing must not reset Decision AI suspension',
  );
  for (const value of [
    null,
    {},
    { ...pricing, inputPerMillionTokens: -1 },
    { ...pricing, outputPerMillionTokens: Infinity },
    { ...pricing, cacheReadPerMillionTokens: NaN },
  ]) {
    assert.throws(() => validateTokenPricing(value), /Token pricing/);
    assert.throws(
      () => normalizeLLMProfileValue({ ...llm, configuration: { ...llm.configuration, tokenPricing: value } }),
      /Token pricing/,
    );
    assert.throws(
      () =>
        normalizeClassifierProfileValue({
          ...decision,
          configuration: { ...decision.configuration, tokenPricing: value },
        }),
      /Token pricing|not JSON-compatible/,
    );
  }
  assert.equal(normalizeLLMProfileValue(createDefaultLLMProfileValue()).configuration.tokenPricing, undefined);
});

test('cache estimates are identical in output and accounting, including malformed provider cache fields', () => {
  for (const cacheReadTokens of [400, -1, NaN, null, 1200]) {
    const usage = {
      inputTokens: 1000,
      outputTokens: 100,
      inputTokenDetails: { cacheReadTokens },
    } as unknown as NonNullable<StreamChatV2Result['usage']>;
    const events: ChatV2CallFinishedEvent[] = [];
    const options = {
      provider: 'custom',
      modelId: 'private',
      tokenPricing: pricing,
      context: {
        node: { id: 'node' },
        processId: 'process',
        onChatV2CallFinished: (event: ChatV2CallFinishedEvent) => events.push(event),
      },
    } as unknown as RunChatV2PipelineOptions;
    notifyChatV2CallFinished(options, {
      callId: 'call' as never,
      attemptIndex: 0,
      outcome: 'success',
      result: { usage } as StreamChatV2Result,
    });
    const expected = cacheReadTokens === 400 ? 0.0022 : undefined;
    assert.equal(normalizeChatV2Usage(usage, options)?.totalCost, expected);
    assert.equal(events[0]?.pricing.costUsd, expected);
  }
});
