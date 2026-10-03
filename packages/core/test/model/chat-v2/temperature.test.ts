import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpenAI } from '@ai-sdk/openai';
import { normalizeTemperature } from '../../../src/model/chat-v2/temperature.js';
import { createLLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import { getLLMChatV2BodySections } from '../../../src/model/chat-v2/llmChatV2Body.js';
import { getLLMProfileBodySections } from '../../../src/model/chat-v2/llmProfileBody.js';
import { normalizeLLMProfileValue } from '../../../src/model/chat-v2/llmProfile.js';
import { createDefaultLLMProfileValue } from '../../../src/model/chat-v2/llmProfileTypes.js';
import { resolveLLMProfileNodeValue } from '../../../src/model/chat-v2/llmProfileNodeRuntime.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';
import { resolveLLMChatV2GenerationParameters } from '../../../src/model/chat-v2/chatV2RuntimeOptions.js';
import { normalizeSerializedLLMChatV2Node } from '../../../src/model/chat-v2/llmChatV2NodeMigration.js';
import { LLMChatV2NodeImpl } from '../../../src/model/nodes/LLMChatV2Node.js';
import { LLMProfileNodeImpl } from '../../../src/model/nodes/LLMProfileNode.js';
import { deserializeProject, serializeProject } from '../../../src/utils/serialization/serialization.js';
import { generateChatV2, streamChatV2 } from '../../../src/model/chat-v2/aiSdkBridge.js';
import type { PortId } from '../../../src/model/NodeBase.js';
import type { Project } from '../../../src/model/Project.js';
import type { ChatV2Model, StreamChatV2Options } from '../../../src/model/chat-v2/chatV2Types.js';

const bodyTemperature = (
  sections: ReturnType<typeof getLLMProfileBodySections> | ReturnType<typeof getLLMChatV2BodySections>,
) => sections.flatMap((section) => section.fields).find((field) => field.label === 'Temperature');

describe('optional Temperature contract', () => {
  it('normalizes historical empties, preserves finite values, and rejects malformed configuration', () => {
    for (const value of [undefined, null, NaN]) assert.equal(normalizeTemperature(value), undefined);
    for (const value of [0, 0.1, 0.35, 1.75]) assert.equal(normalizeTemperature(value), value);
    for (const value of [Infinity, -Infinity, 'hot', '0.5', {}, true]) {
      assert.throws(() => normalizeTemperature(value), /finite number/);
    }
    assert.equal(createLLMChatV2NodeData().temperature, 0.5);
  });

  it('omits empty Temperature from both bodies, including JSON recovery, and preserves input indicators', () => {
    for (const temperature of [undefined, null, NaN, 0, 0.35]) {
      const data = { ...createLLMChatV2NodeData(), temperature } as ReturnType<typeof createLLMChatV2NodeData>;
      for (const snapshot of [data, JSON.parse(JSON.stringify(data))]) {
        for (const buildBody of [getLLMChatV2BodySections, getLLMProfileBodySections]) {
          assert.deepEqual(
            bodyTemperature(buildBody(snapshot)),
            Number.isFinite(temperature) ? { label: 'Temperature', value: String(temperature) } : undefined,
          );
          assert.equal(bodyTemperature(buildBody({ ...snapshot, useTemperatureInput: true }))?.value, '(Using Input)');
        }
      }
    }
  });

  it('profile normalization never resurrects the creation default or invalid historical value', () => {
    for (const temperature of [undefined, null, NaN, 0, 0.35]) {
      const profile = createDefaultLLMProfileValue();
      Object.assign(profile.configuration, { temperature });
      if (temperature === undefined) delete profile.configuration.temperature;
      const normalized = normalizeLLMProfileValue(profile);
      assert.equal(normalized.configuration.temperature, normalizeTemperature(temperature));
      assert.equal(
        normalizeLLMProfileValue(JSON.parse(JSON.stringify(normalized))).configuration.temperature,
        normalizeTemperature(temperature),
      );
      const resolved = resolveLLMProfileNodeValue({
        data: profile.configuration,
        inputs: {},
        context: { getPluginConfig: () => undefined, settings: {} } as never,
      });
      assert.equal(resolved.configuration.temperature, normalizeTemperature(temperature));
    }
  });

  it('input mode preserves fallback only for absent inputs, accepts zero and rejects malformed supplied inputs', () => {
    const data = { ...createLLMChatV2NodeData(), useTemperatureInput: true, temperature: 0.35 };
    const resolve = (value: unknown, type = 'number') =>
      resolveLLMChatV2GenerationParameters(data, { ['temperature' as PortId]: { type, value } } as never).temperature;
    assert.equal(resolveLLMChatV2GenerationParameters(data, {}).temperature, 0.35);
    assert.equal(resolve(0), 0);
    assert.equal(resolve('0.2', 'string'), 0.2);
    for (const [value, type] of [
      [NaN, 'number'],
      [Infinity, 'number'],
      [null, 'number'],
      ['', 'string'],
      ['bad', 'string'],
      ['0.2bad', 'string'],
      [[], 'number[]'],
    ]) {
      assert.throws(() => resolve(value, type as string), /Temperature input/);
    }
    assert.equal(
      resolveLLMChatV2GenerationParameters(
        { ...data, useTemperatureInput: false },
        { ['temperature' as PortId]: { type: 'number', value: NaN } },
      ).temperature,
      0.35,
    );
    assert.equal(resolveLLMChatV2GenerationParameters({ ...data, temperature: undefined }, {}).temperature, undefined);
  });

  it("a recovered Profile consumed by Chat cannot resurrect Chat's creation default", async () => {
    for (const temperature of [undefined, null, NaN, 0, 0.35]) {
      const profileNode = LLMProfileNodeImpl.create();
      Object.assign(profileNode.data, { temperature });
      const context = {
        signal: new AbortController().signal,
        settings: { openAiApiKey: 'synthetic-key' },
        getPluginConfig: () => undefined,
      } as never;
      const output = await new LLMProfileNodeImpl(profileNode).process({}, context);
      const recoveredProfile = JSON.parse(JSON.stringify(output['profile' as PortId]));
      const chat = LLMChatV2NodeImpl.create();
      assert.equal(chat.data.temperature, 0.5);
      const runtime = await resolveLLMChatV2RuntimeConfig({
        nodeId: chat.id,
        data: { ...chat.data, configurationMode: 'profile' },
        inputs: {
          ['prompt' as PortId]: { type: 'string', value: 'fixture' },
          ['llmProfile' as PortId]: recoveredProfile,
        },
        context,
      });
      const observed: Record<string, unknown>[] = [];
      await runtime.runPipeline({
        ...runtime.runOptions,
        emitPartialOutputs: false,
        executeGenerate: async (args) => {
          observed.push(args as Record<string, unknown>);
          return { text: 'ok', finishReason: 'stop' } as never;
        },
      });
      assert.equal(observed.length, 1);
      assert.equal(Object.hasOwn(observed[0]!, 'temperature'), Number.isFinite(temperature));
      assert.equal(observed[0]!.temperature, normalizeTemperature(temperature));
    }
  });

  it('repairs only affected node types idempotently and round-trips through project save/load', () => {
    for (const create of [LLMChatV2NodeImpl.create, LLMProfileNodeImpl.create]) {
      for (const temperature of [undefined, null, NaN, 0, 0.35]) {
        const node = create();
        Object.assign(node.data, { temperature });
        normalizeSerializedLLMChatV2Node(node);
        const once = JSON.stringify(node);
        normalizeSerializedLLMChatV2Node(node);
        assert.equal(JSON.stringify(node), once);
        assert.equal(node.data.temperature, normalizeTemperature(temperature));
        const project = {
          metadata: { id: 'temperature-project', title: 'Temperature', description: '' },
          graphs: {
            graph: { metadata: { id: 'graph', name: 'Graph', description: '' }, nodes: [node], connections: [] },
          },
          plugins: [],
        } as unknown as Project;
        const serialized = serializeProject(project);
        assert.doesNotMatch(serialized as string, /temperature:\s*(?:null|\.nan|undefined)/i);
        const [restored] = deserializeProject(serialized);
        assert.equal(
          (restored.graphs['graph' as keyof typeof restored.graphs]!.nodes[0]!.data as typeof node.data).temperature,
          normalizeTemperature(temperature),
        );
      }
    }
    const unrelated = { ...LLMChatV2NodeImpl.create(), type: 'other', data: { temperature: null } };
    normalizeSerializedLLMChatV2Node(unrelated);
    assert.equal(unrelated.data.temperature, null);
  });

  it('normal Save repairs untouched legacy recovery, variants and library sources without mutating them', () => {
    for (const create of [LLMChatV2NodeImpl.create, LLMProfileNodeImpl.create]) {
      for (const temperature of [undefined, null, NaN, 0, 0.35]) {
        const node = create();
        Object.assign(node.data, { temperature });
        node.variants = [{ id: 'legacy', data: { ...node.data } }];
        const project = {
          metadata: { id: 'recovery', title: 'Recovery', description: '' },
          plugins: [],
          graphs: {
            graph: { metadata: { id: 'graph', name: 'Graph', description: '' }, nodes: [node], connections: [] },
          },
          nodePrefabs: { source: { id: 'source', sourceNode: node } },
        } as unknown as Project;
        const serialized = serializeProject(project);
        assert.doesNotMatch(serialized as string, /temperature:\s*(?:null|\.nan|undefined)/i);
        assert.ok(Object.is(node.data.temperature, temperature));
        assert.ok(Object.is(node.variants[0]!.data.temperature, temperature));
        const [restored] = deserializeProject(serialized);
        const restoredNode = Object.values(restored.graphs)[0]!.nodes[0]!;
        for (const data of [
          restoredNode.data,
          restoredNode.variants![0]!.data,
          Object.values(restored.nodePrefabs!)[0]!.sourceNode.data,
        ]) {
          assert.equal((data as { temperature?: number }).temperature, normalizeTemperature(temperature));
        }
      }
    }
  });

  it('loading legacy YAML repairs main, variant and library-source values before any Save', () => {
    for (const create of [LLMChatV2NodeImpl.create, LLMProfileNodeImpl.create]) {
      const node = create();
      node.variants = [{ id: 'legacy', data: { ...node.data } }];
      const project = {
        metadata: { id: 'legacy', title: 'Legacy', description: '' },
        plugins: [],
        graphs: {
          graph: { metadata: { id: 'graph', name: 'Graph', description: '' }, nodes: [node], connections: [] },
        },
        nodePrefabs: { source: { id: 'source', sourceNode: node } },
      } as unknown as Project;
      const serialized = serializeProject(project) as string;
      assert.equal((serialized.match(/temperature: 0\.5/g) ?? []).length, 4);
      // Inject the historical wire values after serialization, so this test
      // exercises the compatibility reader rather than the Save-time repair.
      for (const historicalValue of ['null', '.nan']) {
        const legacyYaml = serialized.replaceAll('temperature: 0.5', `temperature: ${historicalValue}`);
        const [restored] = deserializeProject(legacyYaml);
        const restoredNode = Object.values(restored.graphs)[0]!.nodes[0]!;
        const restoredSource = Object.values(restored.nodePrefabs!)[0]!.sourceNode;
        for (const data of [
          restoredNode.data,
          restoredNode.variants![0]!.data,
          restoredSource.data,
          restoredSource.variants![0]!.data,
        ]) {
          assert.equal(Object.hasOwn(data as object, 'temperature'), false);
        }
        const once = JSON.stringify(restored);
        normalizeSerializedLLMChatV2Node(restoredNode);
        normalizeSerializedLLMChatV2Node(restoredSource);
        assert.equal(JSON.stringify(restored), once);
      }
    }
  });

  it('SDK argument construction omits unset values for generate and stream, preserves zero and decimals', async () => {
    for (const temperature of [undefined, null, NaN, 0, 0.35]) {
      const observed: Record<string, unknown>[] = [];
      const options: StreamChatV2Options = {
        model: {} as ChatV2Model,
        messages: [],
        temperature: temperature as number,
        executeGenerate: async (args) => {
          observed.push(args as Record<string, unknown>);
          return { text: 'ok', finishReason: 'stop' } as never;
        },
        executeStream: async (args) => {
          observed.push(args as Record<string, unknown>);
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta' as const, id: 'text', text: 'ok' };
            })(),
          };
        },
      };
      await generateChatV2(options);
      await streamChatV2(options);
      assert.equal(observed.length, 2);
      for (const args of observed) {
        assert.equal(Object.hasOwn(args, 'temperature'), Number.isFinite(temperature));
        assert.equal(args.temperature, normalizeTemperature(temperature));
      }
    }
  });

  it('real provider wire bodies omit unset Temperature for both transports without network access', async () => {
    for (const temperature of [undefined, null, NaN, 0, 0.35]) {
      const bodies: Record<string, unknown>[] = [];
      const model = createOpenAI({
        apiKey: 'synthetic-key',
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          const envelope = {
            id: 'completion',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
          if (!body.stream)
            return new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } });
          const chunk = {
            ...envelope,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      }).chat('gpt-4o');
      const options = { model, messages: [{ role: 'user', content: 'Hello' }], temperature } as StreamChatV2Options;
      await generateChatV2(options);
      await streamChatV2(options);
      assert.equal(bodies.length, 2);
      for (const body of bodies) {
        assert.equal(Object.hasOwn(body, 'temperature'), Number.isFinite(temperature));
        assert.equal(body.temperature, normalizeTemperature(temperature));
      }
    }
  });
});
