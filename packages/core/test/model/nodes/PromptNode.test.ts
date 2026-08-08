import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  AssemblePromptNodeImpl,
  GraphProcessor,
  PromptNodeImpl,
  globalRivetNodeRegistry,
  type DataValue,
  type InternalProcessContext,
  type NodeId,
  type PortId,
  type PromptNode,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils';

const createNode = (data: Partial<PromptNode['data']>) => {
  return new PromptNodeImpl({
    ...PromptNodeImpl.create(),
    data: {
      ...PromptNodeImpl.create().data,
      ...data,
    },
  });
};

describe('PromptNode', () => {
  const context = {
    graphInputNodeValues: {
      graphValue: { type: 'string', value: 'from graph' },
    },
    contextValues: {
      contextValue: { type: 'string', value: 'from context' },
    },
  } as InternalProcessContext;

  it('interpolates connected prompt text values without reparsing braces in values', async () => {
    const node = createNode({
      promptText: 'Prompt: {{input}}',
    });

    const result = await node.process(
      {
        input: { type: 'string', value: 'foo {{not-a-port}} bar' },
      } satisfies Record<string, DataValue>,
      context,
    );

    assert.deepStrictEqual(result.output, {
      type: 'chat-message',
      value: {
        type: 'user',
        message: 'Prompt: foo {{not-a-port}} bar',
        isCacheBreakpoint: undefined,
      },
    });
  });

  it('interpolates null prompt text inputs as empty strings', async () => {
    const node = createNode({
      promptText: 'Prompt: {{input}}.',
    });

    const result = await node.process(
      {
        input: { type: 'any', value: null },
      } satisfies Record<string, DataValue>,
      context,
    );

    assert.deepStrictEqual(result.output?.value, {
      type: 'user',
      message: 'Prompt: .',
      isCacheBreakpoint: undefined,
    });
  });

  it('interpolates whole null prompt text inputs as empty strings', async () => {
    const node = createNode({
      promptText: '{{input}}',
    });

    const result = await node.process(
      {
        input: { type: 'any', value: null },
      } satisfies Record<string, DataValue>,
      context,
    );

    assert.deepStrictEqual(result.output?.value, {
      type: 'user',
      message: '',
      isCacheBreakpoint: undefined,
    });
  });

  it('normalizes line endings in generated chat message text', async () => {
    const node = createNode({
      promptText: 'First\r\n{{input}}\rThird',
    });

    const result = await node.process(
      {
        input: { type: 'string', value: 'Second\r\nLine' },
      } satisfies Record<string, DataValue>,
      context,
    );

    assert.deepStrictEqual(result.output?.value, {
      type: 'user',
      message: 'First\nSecond\nLine\nThird',
      isCacheBreakpoint: undefined,
    });
  });

  it('preserves multiple system messages through Assemble Prompt', async () => {
    const first = await createNode({ type: 'system', promptText: 'System one' }).process({}, context);
    const second = await createNode({ type: 'system', promptText: 'System two' }).process({}, context);
    const assemblePrompt = new AssemblePromptNodeImpl(AssemblePromptNodeImpl.create());

    const result = await assemblePrompt.process(
      {
        ['message1' as PortId]: first.output,
        ['message2' as PortId]: second.output,
      },
      context,
    );

    assert.deepStrictEqual(result.prompt, {
      type: 'chat-message[]',
      value: [
        { type: 'system', message: 'System one', isCacheBreakpoint: undefined },
        { type: 'system', message: 'System two', isCacheBreakpoint: undefined },
      ],
    });
  });

  it('creates a distinct developer message', async () => {
    const result = await createNode({
      type: 'developer',
      promptText: 'Follow the application rules.',
    }).process({}, context);

    assert.deepStrictEqual(result.output, {
      type: 'chat-message',
      value: {
        type: 'developer',
        message: 'Follow the application rules.',
        isCacheBreakpoint: undefined,
      },
    });
  });

  it('finishes graph execution when a whole prompt text input resolves to an empty string', async () => {
    const promptNode = PromptNodeImpl.create();
    const graph = {
      metadata: {
        id: 'whole-null-prompt-graph',
        name: 'Whole Null Prompt Graph',
        description: '',
      },
      nodes: [
        {
          id: 'null-expression-node' as NodeId,
          type: 'expression',
          title: 'Expression',
          data: {
            expression: 'null',
          },
          visualData: { x: 0, y: 0, width: 250 },
        },
        {
          ...promptNode,
          id: 'prompt-node' as NodeId,
          data: {
            ...promptNode.data,
            promptText: '{{input}}',
          },
          visualData: { x: 300, y: 0, width: 250 },
        },
        {
          id: 'output-node' as NodeId,
          type: 'graphOutput',
          title: 'Graph Output',
          data: {
            id: 'result',
            dataType: 'chat-message',
          },
          visualData: { x: 600, y: 0, width: 250 },
        },
      ],
      connections: [
        {
          outputNodeId: 'null-expression-node' as NodeId,
          outputId: 'output' as PortId,
          inputNodeId: 'prompt-node' as NodeId,
          inputId: 'input' as PortId,
        },
        {
          outputNodeId: 'prompt-node' as NodeId,
          outputId: 'output' as PortId,
          inputNodeId: 'output-node' as NodeId,
          inputId: 'value' as PortId,
        },
      ],
    };
    const processor = new GraphProcessor(
      {
        metadata: {
          id: 'project-1',
          title: 'Project',
          description: '',
          mainGraphId: graph.metadata.id,
        },
        graphs: {
          [graph.metadata.id]: graph,
        },
        plugins: [],
      },
      graph.metadata.id,
      globalRivetNodeRegistry,
    );
    const finishedNodes: string[] = [];

    processor.on('nodeFinish', ({ node }) => {
      finishedNodes.push(node.id);
    });

    const result = await processor.processGraph(testProcessContext());

    assert.deepStrictEqual(result.result, {
      type: 'chat-message',
      value: {
        type: 'user',
        message: '',
        isCacheBreakpoint: undefined,
      },
    });
    assert.deepStrictEqual(finishedNodes, ['null-expression-node', 'prompt-node', 'output-node']);
  });

  it('resolves graph and context interpolation references without exposing prompt input ports', async () => {
    const node = createNode({
      promptText: '{{@graphInputs.graphValue}} / {{@context.contextValue}}',
    });

    assert.deepStrictEqual(node.getInputDefinitions(), []);

    const result = await node.process({}, context);

    assert.deepStrictEqual(result.output?.value, {
      type: 'user',
      message: 'from graph / from context',
      isCacheBreakpoint: undefined,
    });
  });

  it('opts the prompt text editor into word and character stats', () => {
    const node = createNode({});
    const promptTextEditor = node
      .getEditors()
      .find((editor) => editor.type === 'code' && editor.dataKey === 'promptText');

    assert.equal(promptTextEditor?.showTextStats, true);
  });

  it('identifies the generated chat message as its primary Run Activity output', () => {
    const node = createNode({ computeTokenCount: true });

    assert.deepEqual(node.getRunActivityDescriptor(), {
      primaryOutputPortId: 'output',
    });
    assert.equal(
      node.getOutputDefinitions().some((output) => output.id === 'output'),
      true,
    );
  });

  it('keeps AI assist first, then type and prompt text before secondary settings', () => {
    const node = createNode({});
    const editors = node.getEditors();

    assert.deepEqual(
      editors.slice(0, 3).map((editor) => editor.label),
      ['Generate Using AI', 'Type', 'Prompt Text'],
    );
  });
});
