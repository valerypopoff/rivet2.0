import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { AssembleMessageNodeImpl, ClassifierEvaluateNodeImpl, ClassifierQuestionNodeImpl } from '../src/index.js';
import type { InternalProcessContext } from '../src/model/ProcessContext.js';

// Explicit local simulation only: never load saved credentials or call Jev.
const base = new URL(process.env.RIVET_JEV_SIMULATION_URL ?? 'http://127.0.0.1:4921/jev');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = `${base.href.replace(/\/$/, '')}/v1/systemone`;
const openaiEndpoint = new URL('../openai/v1/decisions', `${base.href.replace(/\/$/, '')}/`).href;
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
  assert.ok(['https://api.typesafe.ai/v1/systemone', 'https://api.openai.com/v1/decisions'].includes(String(url)));
  requests++;
  // Change only the destination. The real HTTP client, headers/body, signal and parser run unchanged.
  return realFetch(String(url).includes('api.openai.com') ? openaiEndpoint : endpoint, init);
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
  for (const provider of ['jev', 'openai'])
    for (const configurationMode of ['inline', 'profile'] as const)
      for (const input of states) {
        const questionNode = ClassifierQuestionNodeImpl.create();
        Object.assign(questionNode.data, { questionId: 'q', questionType: 'noul', useInstructionsInput: true });
        const context = {
          executor: 'nodejs',
          signal: AbortSignal.timeout(10_000),
          settings: { classifierProviders: { [provider]: { apiKey: 'fixture' } } },
        } as InternalProcessContext;
        const question = await new ClassifierQuestionNodeImpl(questionNode).process(
          { instructions: input.value },
          context,
        );
        const model = provider === 'jev' ? 'jev-1.14.0' : 'gpt-6-luna';
        const node = ClassifierEvaluateNodeImpl.create();
        Object.assign(node.data, { provider, model, configurationMode, outputRequestBody: true });
        const result = await new ClassifierEvaluateNodeImpl(node).process(
          {
            question1: question.question,
            ...(configurationMode === 'profile'
              ? {
                  classifierProfile: {
                    type: 'classifier-config' as const,
                    value: {
                      version: 1 as const,
                      configuration: { provider, model },
                      credential: { value: 'fixture' },
                    },
                  },
                }
              : {}),
          },
          context,
        );
        const body = result.requestBody!.value as Record<string, any>;
        if (provider === 'jev') {
          assert.equal(body.state, '');
          const [reference] = Object.keys(body.assets);
          assert.equal(
            body.questions.q.instructions,
            input.name === 'native' ? reference : `Before\n${reference}\nAfter`,
          );
          assert.equal(body.assets[reference!].data_base64, png.toString('base64'));
        } else {
          assert.equal(body.input, '');
          const parts = body.questions[0].instructions;
          assert.deepEqual(
            parts.find((part: any) => part.type === 'input_image'),
            { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
          );
          if (input.name === 'assembled')
            assert.deepEqual(
              parts.map((part: any) => part.text ?? 'IMAGE'),
              ['Before', 'IMAGE', 'After'],
            );
        }
        assert.equal((result.answers!.value as any).q.noul, 0.8);
      }
  for (const configurationMode of ['inline', 'profile'] as const)
    for (const local of [false, true]) {
      const context = {
        executor: 'nodejs',
        signal: AbortSignal.timeout(10_000),
        settings: { classifierProviders: { jev: { apiKey: 'fixture' } } },
      } as InternalProcessContext;
      const question = ClassifierQuestionNodeImpl.create();
      Object.assign(question.data, {
        questionId: 'q',
        questionType: 'box',
        instructions: 'Find the object',
        useInstructionsInput: local,
      });
      const built = await new ClassifierQuestionNodeImpl(question).process(
        local ? { instructions: assembled.message } : {},
        context,
      );
      const run = ClassifierEvaluateNodeImpl.create();
      Object.assign(run.data, { model: 'jev-1.14.0', configurationMode, outputRequestBody: true });
      const result = await new ClassifierEvaluateNodeImpl(run).process(
        {
          question1: built.question,
          ...(!local ? { state: states[0]!.value } : {}),
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
        context,
      );
      assert.deepEqual((result.answers!.value as any).q, {
        type: 'box',
        box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 },
        confidence: 0.92,
      });
      const body = result.requestBody!.value as any;
      assert.equal(body.questions.q.type, 'box');
      assert.equal('criteria' in body.questions.q, false);
      assert.equal(result.cost!.value, 0.000042);
    }
  assert.equal(requests, 16);
  console.log(
    'Image simulation passed: shared State, question Instructions and Jev Bounding Box, inline/profile, missing-header rejection.',
  );
} finally {
  globalThis.fetch = realFetch;
}
