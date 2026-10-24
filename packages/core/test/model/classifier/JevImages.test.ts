import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AssembleMessageNodeImpl, ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl } from '../../../src/index.js';
import { getClassifierProvider } from '../../../src/model/classifier/providers.js';
import { assertJevImageLimits } from '../../../src/model/classifier/jev.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { DataValue } from '../../../src/model/DataValue.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const question = { questionId: 'q', type: 'noul' as const, instructions: 'Check the images' };
const reply = () =>
  Response.json({
    model: 'jev-1.14.0',
    answers: { q: { type: 'noul', noul: 0.8 } },
    usage: { input_tokens: 1000, output_tokens: 0 },
  });
// Header-only fixtures for preflight tests; the HTTP simulation uses a complete PNG.
const png = (width = 280, height = 280) => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
};
const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 1, 24, 1, 24, 1]).toString('base64')}`;
const provider = getClassifierProvider('jev');
const args = () => ({
  apiKey: 'fixture',
  model: 'jev-1.14.0',
  state: '',
  questions: [question],
  signal: new AbortController().signal,
});

void test('All image-capable providers accept the same State input forms in inline and real Profile modes', async () => {
  const imageUrl = png();
  const image = { mediaType: 'image/png' as const, data: Buffer.from(imageUrl.split(',')[1]!, 'base64') };
  const assembled = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Before' },
    part2: { type: 'image', value: image },
    part3: { type: 'string', value: 'After' },
  });
  // null is an expected image position, independent of the runtime normalizer.
  const cases: { name: string; input: DataValue; messages?: (string | null)[][] }[] = [
    { name: 'native image', input: { type: 'image', value: image }, messages: [[null]] },
    { name: 'native array', input: { type: 'image[]', value: [image, image] }, messages: [[null, null]] },
    { name: 'data URL', input: { type: 'string', value: imageUrl }, messages: [[null]] },
    { name: 'bare base64', input: { type: 'string', value: imageUrl.split(',')[1]! }, messages: [[null]] },
    {
      name: 'string array',
      input: { type: 'string[]', value: ['Before', imageUrl, 'After'] },
      messages: [['Before', null, 'After']],
    },
    { name: 'Assemble Message', input: assembled.message!, messages: [['Before', null, 'After']] },
    {
      name: 'message array',
      input: {
        type: 'chat-message[]',
        value: [
          { type: 'user', message: ['Before', imageUrl] },
          { type: 'user', message: [imageUrl, 'After'] },
        ],
      },
      messages: [
        ['Before', null],
        [null, 'After'],
      ],
    },
    { name: 'ambiguous image', input: { type: 'any', value: image }, messages: [[null]] },
    {
      name: 'mixed array',
      input: { type: 'any[]', value: ['Before', image, 'After'] },
      messages: [['Before', null, 'After']],
    },
    { name: 'literal JSON', input: { type: 'object', value: { image: imageUrl } } },
  ];
  for (const providerId of ['jev', 'liquid', 'openai', 'perplexity'])
    for (const configurationMode of ['inline', 'profile'] as const)
      for (const fixture of cases) {
        const descriptor = getClassifierProvider(providerId);
        const model = providerId === 'jev' ? 'jev-1.14.0' : descriptor.defaultModel;
        const context = {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: {
            classifierProviders: { [providerId]: { apiKey: 'fixture' } },
          },
        } as InternalProcessContext;
        const profileNode = ClassifierProfileNodeImpl.create();
        Object.assign(profileNode.data, { provider: providerId, model });
        const profile = await new ClassifierProfileNodeImpl(profileNode).process({}, { ...context, node: profileNode });
        let calls = 0;
        let body: any;
        let headers: Headers;
        globalThis.fetch = async (_url, init) => {
          calls++;
          body = JSON.parse(String(init?.body));
          headers = new Headers(init?.headers);
          return Response.json({
            model,
            answers:
              providerId === 'openai'
                ? [{ name: 'q', type: 'predicate', probability: 0.8 }]
                : { q: { type: 'noul', noul: 0.8 } },
            usage: { input_tokens: 1000, output_tokens: 0 },
          });
        };
        const node = ClassifierEvaluateNodeImpl.create();
        Object.assign(node.data, { provider: providerId, model, configurationMode });
        const output = await new ClassifierEvaluateNodeImpl(node).process(
          {
            state: fixture.input,
            question1: { type: 'object', value: question },
            ...(configurationMode === 'profile' ? { classifierProfile: profile.profile! } : {}),
          },
          context,
        );
        const label = `${providerId}/${configurationMode}/${fixture.name}`;
        assert.equal(calls, 1, label);
        assert.deepEqual({ ...(output.answers!.value as object) }, { q: { type: 'noul', noul: 0.8 } }, label);
        assert.equal(output.cost?.type, 'number', label);
        assert.equal(
          headers!.get('TypeSafe-Danger-Zone-Images'),
          providerId === 'jev' && fixture.messages ? 'true' : null,
          label,
        );
        if (!fixture.messages) {
          assert.deepEqual(
            providerId === 'openai' ? body.input : body.state,
            providerId === 'openai' ? JSON.stringify(fixture.input.value) : fixture.input.value,
            label,
          );
          assert.equal(body.assets, undefined, label);
          continue;
        }
        const imageCount = fixture.messages.flat().filter((part) => part === null).length;
        if (providerId === 'openai') {
          assert.deepEqual(
            body.input,
            fixture.messages.map((parts) => ({
              role: 'user',
              content: parts.map((part) =>
                part === null ? { type: 'input_image', image_url: imageUrl } : { type: 'input_text', text: part },
              ),
            })),
            label,
          );
        } else if (providerId === 'perplexity') {
          assert.deepEqual(
            body.state,
            fixture.messages.flatMap((parts, messageIndex) => [
              ...(messageIndex ? ['\n\n'] : []),
              ...parts.flatMap((part, partIndex) => [
                ...(partIndex ? ['\n'] : []),
                part === null ? { type: 'image_url', image_url: { url: imageUrl } } : part,
              ]),
            ]),
            label,
          );
        } else {
          let imageIndex = 0;
          const reference = providerId === 'jev' ? Object.keys(body.assets)[0] : undefined;
          assert.equal(
            body.state,
            fixture.messages
              .map((parts) =>
                parts.map((part) => (part === null ? reference ?? `[Image ${++imageIndex}]` : part)).join('\n'),
              )
              .join('\n\n'),
            label,
          );
          if (providerId === 'jev') {
            assert.deepEqual(
              Object.values(body.assets),
              [{ type: 'image', format: 'png', data_base64: imageUrl.split(',')[1] }],
              label,
            );
            assert.equal(body.images, undefined, label);
          } else assert.deepEqual(body.images, Array(imageCount).fill(imageUrl), label);
        }
      }
});

void test('Jev inline/profile images use stable native assets across retries, preserving order, bytes and Cost', async () => {
  for (const model of ['jev-1.13.0', 'jev-1.14.0', 'jev-latest', 'jev-preview'])
    for (const configurationMode of ['inline', 'profile'] as const) {
      const bodies: any[] = [];
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init?.headers).get('TypeSafe-Danger-Zone-Images'), 'true');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture');
        assert.equal(init?.redirect, 'error');
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : reply();
      };
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, { configurationMode, model, outputUsage: true, outputRequestBody: true });
      const outputs = await new ClassifierEvaluateNodeImpl(node).process(
        {
          state: {
            type: 'chat-message[]',
            value: [
              { type: 'user', message: ['Before', png(), 'Between', jpeg] },
              { type: 'user', message: [png(), 'After'] },
            ],
          },
          question1: { type: 'object', value: question },
          ...(configurationMode === 'profile'
            ? {
                classifierProfile: {
                  type: 'classifier-config' as const,
                  value: {
                    version: 1 as const,
                    configuration: { provider: 'jev', model },
                    credential: { value: 'fixture' },
                  },
                },
              }
            : {}),
        },
        {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: {
            classifierProviders: { jev: { apiKey: 'fixture' } },
          },
        } as InternalProcessContext,
      );
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0], bodies[1], 'Retries must reuse exactly the captured assets and references');
      const [pngRef, jpegRef] = Object.keys(bodies[0].assets);
      assert.match(pngRef!, /^[0-9a-f-]{36}$/);
      assert.equal(bodies[0].model, model);
      assert.equal(bodies[0].state, `Before\n${pngRef}\nBetween\n${jpegRef}\n\n${pngRef}\nAfter`);
      assert.deepEqual(Object.values(bodies[0].assets), [
        { type: 'image', format: 'png', data_base64: png().split(',')[1] },
        { type: 'image', format: 'jpg', data_base64: jpeg.split(',')[1] },
      ]);
      assert.equal('images' in bodies[0], false);
      assert.deepEqual(outputs.requestBody?.value, bodies[0]);
      assert.deepEqual(outputs.cost, { type: 'number', value: 0.000042 });
      assert.equal((outputs.usage?.value as any).totalCost, 0.000042);
    }
});

void test('Jev image capability and dimension failures reject before HTTP; unknown versions stay unsupported', async () => {
  let calls = 0;
  const fetchImplementation = async () => {
    calls++;
    return reply();
  };
  for (const [image, model, reason] of [
    [png(279, 280), 'jev-1.14.0', /280 and 1568/],
    [png(280, 1569), 'jev-1.14.0', /280 and 1568/],
    ['data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'jev-1.14.0', /still PNG or JPEG/],
    [png(), 'jev-1.15.0', /does not support/],
  ] as const) {
    await assert.rejects(
      provider.evaluate({
        ...args(),
        model,
        stateMessages: [{ parts: [{ type: 'image', dataUrl: image }] }],
        fetchImplementation,
      }),
      reason,
    );
  }
  assert.throws(
    () =>
      assertJevImageLimits(
        [
          {
            mediaType: 'image/png',
            width: 280,
            height: 280,
            dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil((16 * 1024 * 1024 + 1) / 3) * 4)}`,
          },
        ],
        () => {},
      ),
    /16 MiB/,
  );
  assert.equal(calls, 0);
  await provider.evaluate({
    ...args(),
    stateMessages: [{ parts: [{ type: 'image', dataUrl: png(1568, 1568) }] }],
    fetchImplementation,
  });
  assert.equal(calls, 1, 'The maximum documented dimensions are inclusive');
});

void test('Jev text-only requests retain their original wire contract and never enable experimental images', async () => {
  for (const state of ['Plain text', { description: 'Structured evidence' }]) {
    await provider.evaluate({
      ...args(),
      state,
      fetchImplementation: async (_url, init) => {
        assert.equal(new Headers(init?.headers).has('TypeSafe-Danger-Zone-Images'), false);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: 'jev-1.14.0',
          state,
          questions: { q: { type: 'noul', instructions: 'Check the images' } },
        });
        return reply();
      },
    });
  }
});
