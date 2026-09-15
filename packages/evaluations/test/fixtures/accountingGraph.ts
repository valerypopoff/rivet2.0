import { createLLMChatV2NodeData, createLLMProfileNodeData, type NodeGraph } from '@valerypopoff/rivet2-core';

/** Real provider, profile and tool events shared by the four adapter tests. */
export function accountingGraph(baseURL: string): NodeGraph {
  return {
    nodes: [
      { id: 'prompt', type: 'text', title: 'Prompt', data: { text: 'fixture prompt' }, visualData: { x: 0, y: 0 } },
      {
        id: 'profile',
        type: 'llmProfile',
        title: 'Accounting profile',
        data: {
          ...createLLMProfileNodeData(),
          provider: 'custom',
          model: 'fixture',
          customProviderBaseURL: baseURL,
          apiKeySource: 'input',
        },
        visualData: { x: 0, y: 200 },
      },
      {
        id: 'tool',
        type: 'gptFunction',
        title: 'Tool',
        data: {
          name: 'fixture_tool',
          description: 'Returns a controlled tool result',
          schema: '{"type":"object","properties":{}}',
        },
        visualData: { x: 0, y: 400 },
      },
      {
        id: 'llm',
        type: 'llmChatV2',
        title: 'LLM',
        data: {
          ...createLLMChatV2NodeData(),
          configurationMode: 'profile',
          useToolCalling: true,
          autoContinueToolCalls: true,
        },
        visualData: { x: 300, y: 0 },
      },
      {
        id: 'delegate',
        type: 'delegateFunctionCall',
        title: 'Delegate',
        data: {
          handlers: [{ key: 'fixture_tool', value: 'accounting-tool' }],
          autoDelegate: false,
          fallBackToExternalCall: false,
          passthroughErrors: true,
        },
        visualData: { x: 600, y: 200 },
      },
      {
        id: 'output',
        type: 'graphOutput',
        title: 'Output',
        data: { id: 'response', dataType: 'string' },
        visualData: { x: 600, y: 0 },
      },
    ],
    connections: [
      { outputNodeId: 'prompt', outputId: 'output', inputNodeId: 'profile', inputId: 'apiKey' },
      { outputNodeId: 'prompt', outputId: 'output', inputNodeId: 'llm', inputId: 'prompt' },
      { outputNodeId: 'profile', outputId: 'profile', inputNodeId: 'llm', inputId: 'llmProfile' },
      { outputNodeId: 'tool', outputId: 'function', inputNodeId: 'llm', inputId: 'functions' },
      { outputNodeId: 'llm', outputId: 'function-calls', inputNodeId: 'delegate', inputId: 'function-call' },
      { outputNodeId: 'llm', outputId: 'response', inputNodeId: 'output', inputId: 'value' },
    ],
  } as NodeGraph;
}

export const accountingToolGraph = {
  metadata: { id: 'accounting-tool', name: 'Accounting tool', description: '' },
  nodes: [
    { id: 'tool-text', type: 'text', title: 'Tool result', data: { text: 'tool result' }, visualData: { x: 0, y: 0 } },
    {
      id: 'tool-output',
      type: 'graphOutput',
      title: 'Tool output',
      data: { id: 'output', dataType: 'string' },
      visualData: { x: 300, y: 0 },
    },
  ],
  connections: [{ outputNodeId: 'tool-text', outputId: 'output', inputNodeId: 'tool-output', inputId: 'value' }],
} as NodeGraph;

export function accountingProviderResponse(round: number, fail: boolean) {
  if (round % 2 === 1 && fail) return { status: 503, body: { error: { message: 'fixture unavailable' } } };
  return {
    status: 200,
    body: {
      id: 'accounting-fixture',
      object: 'chat.completion',
      created: 1,
      model: 'fixture',
      choices: [
        {
          index: 0,
          message:
            round % 2 === 0
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'fixture-call',
                      type: 'function',
                      function: { name: 'fixture_tool', arguments: '{}' },
                    },
                  ],
                }
              : { role: 'assistant', content: 'evaluation response' },
          finish_reason: round % 2 === 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  };
}
