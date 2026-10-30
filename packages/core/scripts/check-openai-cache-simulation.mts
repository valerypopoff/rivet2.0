import assert from 'node:assert/strict';
import { ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl, type InternalProcessContext } from '../src/index.js';
import { RunCostLedger } from '../src/model/RunCostLedger.js';

const base = new URL(process.env.RIVET_OPENAI_CACHE_SIMULATION_URL ?? 'http://127.0.0.1:4934/openai');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = `${base.href.replace(/\/$/, '')}/v1/decisions`;
const realFetch = globalThis.fetch;
const manual = {
  inputPerMillionTokens: 2,
  outputPerMillionTokens: 0,
  cacheReadPerMillionTokens: 0.5,
  cacheWritePerMillionTokens: 3,
};
let calls = 0;
try {
  globalThis.fetch = (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    calls++;
    return realFetch(endpoint, init);
  };
  for (const configurationMode of ['inline', 'profile'] as const)
    for (const tokenPricing of [undefined, manual])
      for (const scenario of ['cache-accounting', 'cache-invalid', 'cache-partial']) {
        const invalid = scenario !== 'cache-accounting';
        const ledger = new RunCostLedger();
        const context = {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: { classifierProviders: { openai: { apiKey: 'fixture-key' } } },
          onLLMProfileAttempt: (event) => ledger.observeClassifier(event),
        } as InternalProcessContext;
        const profile = ClassifierProfileNodeImpl.create();
        Object.assign(profile.data, { provider: 'openai', tokenPricing });
        const profileOutput = await new ClassifierProfileNodeImpl(profile).process({}, { ...context, node: profile });
        const node = ClassifierEvaluateNodeImpl.create();
        Object.assign(node.data, {
          provider: 'openai',
          configurationMode,
          tokenPricing,
          outputUsage: true,
          outputResponseBody: true,
        });
        const result = await new ClassifierEvaluateNodeImpl(node).process(
          {
            state: { type: 'string', value: scenario },
            question1: { type: 'object', value: { questionId: 'ready', type: 'noul', instructions: 'Ready?' } },
            ...(configurationMode === 'profile' ? { classifierProfile: profileOutput.profile! } : {}),
          },
          context,
        );
        assert.deepEqual({ ...(result.answers!.value as object) }, { ready: { type: 'noul', noul: 0.8 } });
        const expected = tokenPricing ? 0.0015 : (500 * 0.1 + 400 * 0.01 + 100 * 0.125) / 1e6;
        assert.equal(result.cost!.type, invalid ? 'control-flow-excluded' : 'number');
        if (!invalid) assert.equal(result.cost!.value, expected);
        assert.deepEqual(
          ledger.snapshot(),
          invalid ? { status: 'unknown', knownCostUsd: null } : { status: 'complete', knownCostUsd: expected },
        );
        const native = result.responseBody!.value as { usage: unknown };
        assert.deepEqual(native.usage, {
          input_tokens: 1000,
          output_tokens: 0,
          input_tokens_details: {
            cached_tokens: scenario === 'cache-invalid' ? 901 : 400,
            ...(scenario === 'cache-partial' ? {} : { cache_write_tokens: 100 }),
          },
        });
        assert.doesNotMatch(JSON.stringify(result), /fixture-key/);
      }
  assert.equal(calls, 12);
  console.log(
    'OpenAI cache real-HTTP checks passed: inline/Profile, catalog/override rates, invalid/partial-cache unknown costs, native diagnostics and run ledger.',
  );
} finally {
  globalThis.fetch = realFetch;
}
