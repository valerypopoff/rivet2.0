import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeGraph, NodeId, Project } from '@valerypopoff/rivet2-core';
import {
  getDuplicateToolNameWarning,
  getDuplicateToolNodeIds,
  getMissingAutoDelegateToolGraphWarnings,
} from './toolWarnings.js';

function node(type: string, data: Record<string, unknown>, id: string): ChartNode {
  return {
    id: id as NodeId,
    type,
    title: type,
    visualData: { x: 0, y: 0, width: 200 },
    data,
  } as ChartNode;
}

function graph(id: string, name: string, nodes: ChartNode[], connections: NodeGraph['connections'] = []): NodeGraph {
  return {
    metadata: { id: id as GraphId, name, description: '' },
    nodes,
    connections,
  };
}

function project(...graphs: NodeGraph[]): Pick<Project, 'graphs'> {
  return {
    graphs: Object.fromEntries(
      graphs.map((candidate, index) => [candidate.metadata?.id ?? (`graph-${index}` as GraphId), candidate]),
    ),
  };
}

test('Tool warnings detect duplicate enabled static names in one LLM Tool registry without warning dynamic or disabled Tools', () => {
  const first = node('gptFunction', { name: 'weather' }, 'first');
  const second = node('gptFunction', { name: 'weather' }, 'second');
  const dynamic = node('gptFunction', { name: 'weather', useNameInput: true }, 'dynamic');
  const disabled = { ...node('gptFunction', { name: 'weather' }, 'disabled'), disabled: true };
  const tools = node('array', {}, 'tools');
  const llm = node('llmChatV2', { useToolCalling: true }, 'llm');
  const duplicates = getDuplicateToolNodeIds(
    graph('main', 'Main', [first, second, dynamic, disabled, tools, llm], [
      { outputNodeId: first.id, outputId: 'function' as any, inputNodeId: tools.id, inputId: 'input-1' as any },
      { outputNodeId: second.id, outputId: 'function' as any, inputNodeId: tools.id, inputId: 'input-2' as any },
      { outputNodeId: dynamic.id, outputId: 'function' as any, inputNodeId: tools.id, inputId: 'input-3' as any },
      { outputNodeId: disabled.id, outputId: 'function' as any, inputNodeId: tools.id, inputId: 'input-4' as any },
      { outputNodeId: tools.id, outputId: 'array' as any, inputNodeId: llm.id, inputId: 'functions' as any },
    ]),
  );

  assert.deepEqual(new Set(duplicates), new Set([first.id, second.id]));
  assert.equal(
    getDuplicateToolNameWarning(first, duplicates),
    'Another Tool in this LLM Chat\'s Tools input uses the name "weather".',
  );
  assert.equal(getDuplicateToolNameWarning(dynamic, duplicates), undefined);
  assert.equal(getDuplicateToolNameWarning(disabled, duplicates), undefined);
});

test('duplicate names in separate LLM Tool registries do not warn either Tool', () => {
  const first = node('gptFunction', { name: 'weather' }, 'first');
  const second = node('gptFunction', { name: 'weather' }, 'second');
  const firstLlm = node('llmChatV2', { useToolCalling: true }, 'first-llm');
  const secondLlm = node('llmChatV2', { useToolCalling: true }, 'second-llm');
  const duplicates = getDuplicateToolNodeIds(
    graph('main', 'Main', [first, second, firstLlm, secondLlm], [
      { outputNodeId: first.id, outputId: 'function' as any, inputNodeId: firstLlm.id, inputId: 'functions' as any },
      { outputNodeId: second.id, outputId: 'function' as any, inputNodeId: secondLlm.id, inputId: 'functions' as any },
    ]),
  );

  assert.deepEqual([...duplicates], []);
  assert.equal(getDuplicateToolNameWarning(first, duplicates), undefined);
  assert.equal(getDuplicateToolNameWarning(second, duplicates), undefined);
});

test('Tool warnings follow the actual LLM continuation and auto-delegate handler rules', () => {
  const tool = node('gptFunction', { name: 'weather' }, 'tool');
  const array = node('array', {}, 'array');
  const llm = node('llmChatV2', { useToolCalling: true, autoContinueToolCalls: true }, 'llm');
  const delegate = node(
    'delegateFunctionCall',
    { autoDelegate: true, fallBackToExternalCall: false, unknownHandler: undefined },
    'delegate',
  );
  const main = graph('main', 'Main', [tool, array, llm, delegate], [
    { outputNodeId: tool.id, outputId: 'function' as any, inputNodeId: array.id, inputId: 'input-1' as any },
    { outputNodeId: array.id, outputId: 'array' as any, inputNodeId: llm.id, inputId: 'functions' as any },
    {
      outputNodeId: llm.id,
      outputId: 'function-calls' as any,
      inputNodeId: delegate.id,
      inputId: 'function-call' as any,
    },
  ]);

  const missing = getMissingAutoDelegateToolGraphWarnings(main, project(main));
  assert.match(missing.get(tool.id) ?? '', /needs a graph named "weather"/);

  const handler = graph('handler', 'weather', []);
  assert.deepEqual([...getMissingAutoDelegateToolGraphWarnings(main, project(main, handler))], []);

  // Graph rows render only their basename in the project tree, but their
  // stored name includes a folder path. Auto Delegate accepts that legacy
  // contains match at runtime, so the editor warning must not contradict it.
  const folderedHandler = graph('foldered-handler', 'Tools/weather', []);
  assert.deepEqual([...getMissingAutoDelegateToolGraphWarnings(main, project(main, folderedHandler))], []);

  const externalFallback = {
    ...main,
    nodes: main.nodes.map((candidate) =>
      candidate.id === delegate.id
        ? {
            ...candidate,
            data: { ...(candidate.data as Record<string, unknown>), fallBackToExternalCall: true },
          }
        : candidate,
    ),
  };
  assert.equal(
    getMissingAutoDelegateToolGraphWarnings(externalFallback, project(externalFallback)).get(tool.id),
    'Auto Delegate needs a graph named "weather" for Tool "weather".',
  );
});
