import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deserializeProject,
  type GraphId,
  type Inputs,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  createAiAssistVercelGeneratorChatNodeDefinition,
  normalizeAiAssistGeneratorResponseForTaggedHelper,
} from './aiAssistVercelGenerator.js';

function createProject(): Project {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: {
      ['graph' as GraphId]: {
        metadata: {
          id: 'graph' as GraphId,
          name: 'Graph',
        },
        nodes: [
          {
            id: 'text' as NodeId,
            type: 'text',
            title: 'Text',
            visualData: { x: 0, y: 0 },
            data: { text: 'hello' },
          },
        ],
        connections: [],
      },
    },
  };
}

function createTaggedPromptInputs(message: string): Inputs {
  return {
    ['prompt' as PortId]: {
      type: 'chat-message',
      value: {
        type: 'user',
        message,
      },
    },
  };
}

test('bundled AI assist generator graph stores Vercel adapter nodes directly', () => {
  const projectText = readFileSync(
    fileURLToPath(new URL('../../graphs/code-node-generator.rivet-project', import.meta.url)),
    'utf8',
  );
  const [project] = deserializeProject(projectText);
  const nodes = Object.values(project.graphs).flatMap((graph) => graph.nodes);
  const adapterNodes = nodes.filter((node) => node.type === 'aiAssistGeneratorChatV2');

  assert.equal(nodes.some((node) => node.type === 'chat' || node.type === 'chatAnthropic'), false);
  assert.equal(adapterNodes.length, 2);
  assert.deepEqual(
    adapterNodes.map((node) => (node.data as Record<string, unknown>).aiAssistGeneratorChatBranch).sort(),
    ['anthropic', 'openaiCompatible'],
  );
  assert.equal(adapterNodes.some((node) => 'aiAssistGeneratorChatSourceType' in (node.data as Record<string, unknown>)), false);
});

test('AI assist generator Vercel adapter preserves the legacy generator graph port contract', () => {
  const definition = createAiAssistVercelGeneratorChatNodeDefinition({
    displayName: 'GPT-5',
    graphApi: 'openai',
    model: 'gpt-5',
    provider: 'openai',
  });
  const node = definition.impl.create();
  const impl = new definition.impl(node, undefined);

  const inputIds = impl.getInputDefinitions([], {}, createProject(), {}).map((input) => input.id);
  const outputIds = impl.getOutputDefinitions([], {}, createProject(), {}).map((output) => output.id);

  assert.deepEqual(
    inputIds.filter((id) => ['prompt', 'systemPrompt', 'system', 'model', 'functions', 'tools'].includes(id)),
    ['systemPrompt', 'system', 'model', 'prompt', 'functions', 'tools'],
  );
  assert.deepEqual(outputIds, ['response', 'function-calls', 'all-messages']);
});

test('AI assist generator adapter owns the Vercel SDK path instead of legacy chat transport', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./aiAssistVercelGenerator.ts', import.meta.url)),
    'utf8',
  );

  assert.match(source, /runChatV2Pipeline/);
  assert.match(source, /createChatV2Model/);
  assert.match(source, /emitPartialOutputs: false/);
  assert.match(source, /getInputRawString\(inputs, 'stop'\)/);
  assert.doesNotMatch(source, /streamChatCompletions/);
  assert.doesNotMatch(source, /openAiCompatibleBaseURLToChatEndpoint/);
});

test('AI assist generator wraps plain text for tagged response helper graphs', () => {
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      'Generated text',
      createTaggedPromptInputs('Return the result inside <answer> tags. Close with </answer>.'),
    ),
    '<answer>Generated text</answer>',
  );
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      'Prompt instructions',
      createTaggedPromptInputs('Write the prompt inside <Instructions> tags and close with </Instructions>.'),
    ),
    '<Instructions>Prompt instructions</Instructions>',
  );
});

test('AI assist generator leaves already-tagged or untagged-contract responses alone', () => {
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      '<answer>Already wrapped</answer>',
      createTaggedPromptInputs('Return the result inside <answer> tags. Close with </answer>.'),
    ),
    '<answer>Already wrapped</answer>',
  );
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      'Plain response',
      createTaggedPromptInputs('Return a plain response.'),
    ),
    'Plain response',
  );
});
