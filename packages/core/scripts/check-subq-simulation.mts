import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { ClassifierEvaluateNodeImpl, getClassifierProvider } from '../src/index.js';
import type { InternalProcessContext } from '../src/model/ProcessContext.js';

// Destination substitution only; no saved settings, upstream calls or real credentials.
const base = new URL(process.env.RIVET_SUBQ_SIMULATION_URL ?? 'http://127.0.0.1:4922/subq');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = `${base.href.replace(/\/$/, '')}/v1/systemone`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
// This HTTP fixture is a complete valid 1x1 RGBA PNG, not just an image header.
const imageData: Buffer[] = [];
for (let offset = 8; offset < png.length; ) {
  const length = png.readUInt32BE(offset);
  assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
  if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
    imageData.push(png.subarray(offset + 8, offset + 8 + length));
  offset += length + 12;
}
assert.equal(inflateSync(Buffer.concat(imageData)).length, 5);
const originalFetch = globalThis.fetch;
let fixture = '';
const requests: string[] = [];
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.subq.ai/v1/systemone');
  requests.push(String(init?.body));
  return originalFetch(`${endpoint}${fixture ? `?fixture=${fixture}` : ''}`, init);
};
try {
  for (const configurationMode of ['inline', 'profile'] as const) {
    const node = ClassifierEvaluateNodeImpl.create();
    Object.assign(node.data, {
      provider: 'subq',
      configurationMode,
      outputRequestBody: true,
      outputResponseBody: true,
      catchRequestFailed: true,
    });
    const inputs = {
      state: { type: 'image' as const, value: { mediaType: 'image/png' as const, data: png } },
      question1: {
        type: 'object[]' as const,
        value: [
          { questionId: 'gate', type: 'noul', instructions: 'Check' },
          { questionId: 'route', type: 'choice', instructions: 'Route', criteria: { a: 'A', b: null } },
          { questionId: 'score', type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
        ],
      },
      ...(configurationMode === 'profile'
        ? {
            classifierProfile: {
              type: 'classifier-config' as const,
              value: {
                version: 1 as const,
                configuration: { provider: 'subq', model: 'subq-snap-1.1' },
                credential: { value: 'fixture-key' },
              },
            },
          }
        : {}),
    };
    const ctx = {
      executor: 'nodejs',
      signal: AbortSignal.timeout(5000),
      settings: { classifierProviders: { subq: { apiKey: 'fixture-key' } } },
    } as InternalProcessContext;
    fixture = '';
    const output = await new ClassifierEvaluateNodeImpl(node).process(inputs, ctx);
    assert.deepEqual(output.cost, { type: 'number', value: 0.00004 });
    assert.equal(Object.keys(output.answers!.value as object).length, 3);
    assert.deepEqual((output.requestBody!.value as Record<string, unknown>).images, [
      { mediaType: 'image/png', base64: png.toString('base64') },
    ]);
    fixture = 'credits';
    const before = requests.length;
    const rejected = await new ClassifierEvaluateNodeImpl(node).process(inputs, ctx);
    assert.equal(rejected.runFailed!.value, true);
    assert.match(String(rejected.runError!.value), /402/);
    assert.equal(requests.length - before, 1);
    assert.equal((rejected.responseBody!.value as any).detail.error_type, 'insufficient_credits');
    fixture = 'forbidden';
    const beforeForbidden = requests.length;
    const forbidden = await new ClassifierEvaluateNodeImpl(node).process(inputs, ctx);
    assert.equal(forbidden.runFailed!.value, true);
    assert.match(String(forbidden.runError!.value), /access denied.*permissions.*model access/);
    assert.doesNotMatch(String(forbidden.runError!.value), /authentication failed/);
    assert.equal(requests.length - beforeForbidden, 1);
    assert.equal((forbidden.responseBody!.value as any).detail.error_type, 'model_access_denied');
  }
  const provider = getClassifierProvider('subq');
  const args = {
    apiKey: 'fixture-key',
    model: provider.defaultModel,
    state: '',
    questions: [{ questionId: 'q', type: 'noul' as const, instructions: 'Check' }],
    signal: AbortSignal.timeout(5000),
  };
  fixture = 'rate-limit';
  const before = requests.length;
  await provider.evaluate(args);
  assert.equal(requests.length - before, 2);
  assert.equal(requests.at(-1), requests.at(-2), 'A retry must preserve the request snapshot');
  fixture = 'slow';
  await assert.rejects(provider.evaluate({ ...args, timeoutMs: 50 }), (error: any) => error.kind === 'timeout');
  assert.equal(requests.length, 9);
  console.log(
    'SubQ simulation passed: real HTTP, inline/profile, three question types, images, Cost, credits, model access denied, identical rate-limit retry, timeout.',
  );
} finally {
  globalThis.fetch = originalFetch;
}
