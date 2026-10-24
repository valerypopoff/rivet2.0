import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { AssembleMessageNodeImpl, ClassifierEvaluateNodeImpl } from '../src/index.js';
import type { InternalProcessContext } from '../src/model/ProcessContext.js';

// Explicit local simulation only: never load saved credentials or call Jev.
const base = new URL(process.env.RIVET_JEV_SIMULATION_URL ?? 'http://127.0.0.1:4921/jev');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = `${base.href.replace(/\/$/, '')}/v1/systemone`;
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const contents = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(contents));
  return Buffer.concat([length, contents, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(280, 0);
header.writeUInt32BE(280, 4);
header[8] = 8;
header[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.alloc((280 * 3 + 1) * 280))),
  chunk('IEND', Buffer.alloc(0)),
]);
const nativeImage = { mediaType: 'image/png' as const, data: png };
const assembled = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
  part1: { type: 'string', value: 'Before' },
  part2: { type: 'image', value: nativeImage },
  part3: { type: 'string', value: 'After' },
});
const states = [
  { name: 'native', value: { type: 'image' as const, value: nativeImage } },
  { name: 'assembled', value: assembled.message! },
];
const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
  requests++;
  // Change only the destination. The real HTTP client, headers/body, signal and parser run unchanged.
  return realFetch(endpoint, init);
};
try {
  for (const configurationMode of ['inline', 'profile'] as const)
    for (const state of states) {
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, { model: 'jev-1.14.0', configurationMode, outputRequestBody: true });
      const output = await new ClassifierEvaluateNodeImpl(node).process(
        {
          state: state.value,
          question1: { type: 'object', value: { questionId: 'q', type: 'noul', instructions: 'Is this black?' } },
          ...(configurationMode === 'profile'
            ? {
                classifierProfile: {
                  type: 'classifier-config' as const,
                  value: {
                    version: 1 as const,
                    configuration: { provider: 'jev', model: 'jev-1.14.0' },
                    credential: { value: 'fixture' },
                  },
                },
              }
            : {}),
        },
        {
          executor: 'nodejs',
          signal: AbortSignal.timeout(10_000),
          settings: {
            classifierProviders: { jev: { apiKey: 'fixture' } },
          },
        } as InternalProcessContext,
      );
      assert.deepEqual(output.cost, { type: 'number', value: 0.000042 });
      const body = output.requestBody!.value as Record<string, any>;
      assert.equal(Object.keys(body.assets).length, 1);
      const [reference] = Object.keys(body.assets);
      assert.equal(body.state, state.name === 'native' ? reference : `Before\n${reference}\nAfter`);
      assert.equal(
        Object.values(body.assets as Record<string, { data_base64: string }>)[0]!.data_base64,
        png.toString('base64'),
      );
      if (state.name === 'native') {
        const rejected = await realFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(rejected.status, 400, 'The mock must reject the documented missing opt-in header');
      }
    }
  assert.equal(requests, 4);
  console.log(
    'Jev image simulation passed: inline/profile, native and assembled PNG inputs, numeric Cost, missing-header rejection.',
  );
} finally {
  globalThis.fetch = realFetch;
}
