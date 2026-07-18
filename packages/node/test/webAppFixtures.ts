import { type GraphId, type NodeGraph, type Project, type UiGraphId } from '../src/index.js';

export const TEST_GRAPH_ID = 'main-graph' as GraphId;
export const TEST_UI_GRAPH_ID = 'ui-graph' as UiGraphId;

export function makeWebAppActionRequest(
  options: { componentId?: string; revisionKey?: string; state?: Record<string, unknown> } = {},
): Request {
  return new Request('https://example.test/app/actions/run', {
    body: JSON.stringify({
      componentId: options.componentId ?? 'run-button',
      ...(options.revisionKey === undefined ? {} : { revisionKey: options.revisionKey }),
      state: options.state ?? { prompt: 'hello' },
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

export type TestWebAppProjectOptions = {
  delay?: number;
  includeProgress?: boolean;
  outputId?: string;
};

export function makeWebAppProject(options: TestWebAppProjectOptions = {}): Project {
  const { delay = 0, includeProgress = false, outputId = includeProgress ? 'result' : 'value' } = options;
  const nodes: NodeGraph['nodes'] = [
    {
      data: { dataType: 'string', id: 'input' },
      id: 'input-node' as never,
      title: 'Input',
      type: 'graphInput',
      visualData: { x: 0, y: 0 },
    },
  ];
  const connections: NodeGraph['connections'] = [];
  let outputSourceNodeId = 'input-node';
  let outputSourcePortId = 'data';

  if (includeProgress) {
    nodes.push({
      data: { message: 'Preparing response', percent: 40, useMessageInput: false, usePercentInput: false },
      id: 'progress-node' as never,
      title: 'Progress',
      type: 'reportProgress',
      visualData: { x: 200, y: 0 },
    });
    connections.push({
      inputId: 'value' as never,
      inputNodeId: 'progress-node' as never,
      outputId: 'data' as never,
      outputNodeId: 'input-node' as never,
    });
    outputSourceNodeId = 'progress-node';
    outputSourcePortId = 'value';
  }

  if (delay > 0) {
    nodes.push({
      data: { delay },
      id: 'delay-node' as never,
      title: 'Delay',
      type: 'delay',
      visualData: { x: 400, y: 0 },
    });
    connections.push({
      inputId: 'input1' as never,
      inputNodeId: 'delay-node' as never,
      outputId: outputSourcePortId as never,
      outputNodeId: outputSourceNodeId as never,
    });
    outputSourceNodeId = 'delay-node';
    outputSourcePortId = 'output1';
  }

  nodes.push({
    data: { dataType: 'string', id: outputId },
    id: 'output-node' as never,
    title: 'Output',
    type: 'graphOutput',
    visualData: { x: 600, y: 0 },
  });
  connections.push({
    inputId: 'value' as never,
    inputNodeId: 'output-node' as never,
    outputId: outputSourcePortId as never,
    outputNodeId: outputSourceNodeId as never,
  });

  return {
    graphs: {
      [TEST_GRAPH_ID]: {
        connections,
        metadata: { description: '', id: TEST_GRAPH_ID, name: 'Main Graph' },
        nodes,
      },
    },
    metadata: {
      description: '',
      id: 'project' as never,
      mainGraphId: TEST_GRAPH_ID,
      title: 'Project',
    },
    uiGraphs: {
      [TEST_UI_GRAPH_ID]: {
        components: [
          {
            action: {
              graphId: TEST_GRAPH_ID,
              inputs: { input: { key: 'prompt', type: 'state' } },
              outputKey: outputId,
              outputStateKey: 'result',
              type: 'runGraph',
            },
            id: 'run-button' as never,
            label: 'Run',
            type: 'button',
          },
        ],
        id: TEST_UI_GRAPH_ID,
        name: includeProgress ? 'App' : 'Test App',
      },
    },
  } as Project;
}

export function makeExternalStatusProject(): Project {
  const project = makeWebAppProject({ outputId: 'value' });
  project.graphs[TEST_GRAPH_ID]!.nodes = [
    {
      data: { dataType: 'string', id: 'input' },
      id: 'input-node' as never,
      title: 'Input',
      type: 'graphInput',
      visualData: { x: 0, y: 0 },
    },
    {
      data: { functionName: 'setWebAppStatus', useErrorOutput: false, useFunctionNameInput: false },
      id: 'status-node' as never,
      title: 'Set web app status',
      type: 'externalCall',
      visualData: { x: 200, y: 0 },
    },
    {
      data: { dataType: 'string', id: 'value' },
      id: 'output-node' as never,
      title: 'Output',
      type: 'graphOutput',
      visualData: { x: 400, y: 0 },
    },
  ];
  project.graphs[TEST_GRAPH_ID]!.connections = [
    {
      inputId: 'arguments' as never,
      inputNodeId: 'status-node' as never,
      outputId: 'data' as never,
      outputNodeId: 'input-node' as never,
    },
    {
      inputId: 'value' as never,
      inputNodeId: 'output-node' as never,
      outputId: 'result' as never,
      outputNodeId: 'status-node' as never,
    },
  ];
  return project;
}

export function makeStoredValueProject(mode: 'get' | 'set'): Project {
  const project = makeWebAppProject({ outputId: 'value' });
  const storedValueNode = {
    data:
      mode === 'get'
        ? { dataType: 'any', key: 'analysis', onDemand: false, useKeyInput: false, wait: false }
        : { dataType: 'any', key: 'analysis', useKeyInput: false },
    id: 'storage-node' as never,
    title: mode === 'get' ? 'Get Stored Value' : 'Set Stored Value',
    type: (mode === 'get' ? 'getStoredValue' : 'setStoredValue') as 'getStoredValue' | 'setStoredValue',
    visualData: { x: 400, y: 0 },
  };
  project.graphs[TEST_GRAPH_ID]!.nodes = [
    {
      data: { dataType: 'string', id: 'input' },
      id: 'input-node' as never,
      title: 'Input',
      type: 'graphInput',
      visualData: { x: 0, y: 0 },
    },
    storedValueNode,
    {
      data: { dataType: 'any', id: 'value' },
      id: 'output-node' as never,
      title: 'Output',
      type: 'graphOutput',
      visualData: { x: 600, y: 0 },
    },
  ];
  project.graphs[TEST_GRAPH_ID]!.connections = [
    ...(mode === 'set'
      ? [
          {
            inputId: 'value' as never,
            inputNodeId: 'storage-node' as never,
            outputId: 'data' as never,
            outputNodeId: 'input-node' as never,
          },
        ]
      : []),
    {
      inputId: 'value' as never,
      inputNodeId: 'output-node' as never,
      outputId: (mode === 'get' ? 'value' : 'saved-value') as never,
      outputNodeId: 'storage-node' as never,
    },
  ];
  return project;
}
