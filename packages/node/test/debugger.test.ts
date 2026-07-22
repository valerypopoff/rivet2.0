import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  WarningsPort,
  createDebuggerTransportUndefinedSentinel,
  decodeDebuggerTransportSentinels,
  type ChartNode,
  type DataType,
  type DatasetId,
  type GraphId,
  type GraphProcessor,
  type GraphRunId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
  type RemoteRunRequestId,
  type RootRunId,
  type Settings,
} from '@valerypopoff/rivet2-core';
import WebSocket, { type WebSocketServer } from 'ws';
import {
  DEBUGGER_HEARTBEAT_INTERVAL_MS,
  DEBUGGER_HEARTBEAT_TIMEOUT_MS,
  startDebuggerServer,
  type DebuggerClientState,
} from '../src/debugger.js';
import { DebuggerDatasetProvider } from '../src/native/DebuggerDatasetProvider.js';
import { createProcessor } from '../src/api.js';
import { loadTestGraphs } from './testUtils.js';
import { makeThrowingCodeProject } from './runtimeSpeedFixtures.js';
import { stringifyDebuggerPayloadForTransport } from '../src/debuggerPayloadSanitizer.js';

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  pingCount = 0;
  sentMessages: string[] = [];
  terminated = false;
  sendCallbackError: Error | undefined;
  sendThrowError: Error | undefined;

  ping() {
    this.pingCount += 1;
  }

  send(message: string, callback?: (err?: Error) => void) {
    if (this.sendThrowError) {
      throw this.sendThrowError;
    }

    this.sentMessages.push(message);
    callback?.(this.sendCallbackError);
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

class FakeWebSocketServer extends EventEmitter {
  clients = new Set<WebSocket>();

  connect(socket: FakeWebSocket) {
    this.clients.add(socket as unknown as WebSocket);
    socket.once('close', () => {
      this.clients.delete(socket as unknown as WebSocket);
    });
    this.emit('connection', socket);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 250;

  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await wait(5);
    }
  }
}

function fakeProcessor(id = 'processor-1'): GraphProcessor {
  return { id } as unknown as GraphProcessor;
}

function getSentDebuggerMessage(socket: FakeWebSocket, message: string) {
  return socket.sentMessages
    .map((sentMessage) => JSON.parse(sentMessage))
    .find((sentMessage) => sentMessage.message === message);
}

function getSentDebuggerMessages(socket: FakeWebSocket, message: string) {
  return socket.sentMessages
    .map((sentMessage) => JSON.parse(sentMessage))
    .filter((sentMessage) => sentMessage.message === message);
}

function makeExecution(graphId = 'graph-1' as GraphId) {
  return {
    graphId,
    graphRunId: `${graphId}-run` as GraphRunId,
    rootRunId: 'root-run' as RootRunId,
  };
}

function makeUploadedProject(id: string, title: string): Project {
  const graphId = `${id}-graph` as GraphId;
  return {
    graphs: {
      [graphId]: {
        connections: [],
        metadata: {
          description: '',
          id: graphId,
          name: graphId,
        },
        nodes: [],
      },
    },
    metadata: {
      description: '',
      id: id as ProjectId,
      mainGraphId: graphId,
      title,
    },
    plugins: [],
  };
}

it('forwards internal run state to the dynamic graph runner', async () => {
  const server = new FakeWebSocketServer();
  const socket = new FakeWebSocket();
  const frozenNodeOutputs = {
    ['graph-1' as GraphId]: {
      ['node-1' as NodeId]: [
        {
          ['output' as PortId]: {
            type: 'object',
            value: {
              messages: [{ isCacheBreakpoint: undefined, role: 'user' }],
            },
          },
        },
      ],
    },
  };
  const transportFrozenNodeOutputs = {
    ['graph-1' as GraphId]: {
      ['node-1' as NodeId]: [
        {
          ['output' as PortId]: {
            type: 'object',
            value: {
              messages: [{ isCacheBreakpoint: createDebuggerTransportUndefinedSentinel(), role: 'user' }],
            },
          },
        },
      ],
    },
  };
  let receivedFrozenNodeOutputs: unknown;
  let receivedProjectPath: unknown;
  let receivedReturnWhenGraphOutputsReady: unknown;
  let receivedWebAppStorage: unknown;
  startDebuggerServer({
    server: server as unknown as WebSocketServer,
    dynamicGraphRun: async (options) => {
      receivedFrozenNodeOutputs = options.frozenNodeOutputs;
      receivedProjectPath = options.projectPath;
      receivedReturnWhenGraphOutputsReady = options.returnWhenGraphOutputsReady;
      receivedWebAppStorage = options.webAppStorage;
    },
  });

  server.connect(socket);
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'run',
        data: {
          requestId: 'request-1',
          graphId: 'graph-1',
          inputs: {},
          contextValues: {},
          projectPath: null,
          frozenNodeOutputs: transportFrozenNodeOutputs,
          returnWhenGraphOutputsReady: true,
          webAppStorage: { analysis: { summary: 'Browser-local overview' } },
        },
      }),
    ),
  );

  await waitFor(() => {
    assert.deepEqual(receivedFrozenNodeOutputs, frozenNodeOutputs);
    assert.equal(receivedProjectPath, undefined);
    assert.equal(receivedReturnWhenGraphOutputsReady, true);
    assert.deepEqual(receivedWebAppStorage, { analysis: { summary: 'Browser-local overview' } });
  });

  socket.close();
});

function makeNestedCircularExpressionProject(): Project {
  const mainGraphId = 'main' as GraphId;
  const subgraph1Id = 'subgraph1' as GraphId;
  const subgraph2Id = 'subgraph2' as GraphId;

  return {
    graphs: {
      [mainGraphId]: makeSubgraphCallerGraph(mainGraphId, subgraph1Id, 'main'),
      [subgraph1Id]: makeSubgraphCallerGraph(subgraph1Id, subgraph2Id, 'subgraph1'),
      [subgraph2Id]: makeCircularExpressionGraph(subgraph2Id),
    },
    metadata: {
      description: '',
      id: 'debugger-circular-project' as ProjectId,
      mainGraphId,
      title: 'Debugger Circular Project',
    },
    plugins: [],
  };
}

function makeNestedCaughtExpressionErrorProject(): Project {
  const mainGraphId = 'main-error' as GraphId;
  const subgraph1Id = 'subgraph1-error' as GraphId;
  const subgraph2Id = 'subgraph2-error' as GraphId;
  const mainSubgraphNode = makeSubgraphNode('main-error-subgraph', subgraph1Id);
  const mainOutputNode = makeGraphOutputNode('main-error-output', 'result', 'string');
  const nestedSubgraphNode = makeSubgraphNode('subgraph1-error-subgraph', subgraph2Id, true);
  const nestedOutputNode = makeGraphOutputNode('subgraph1-error-output', 'result', 'string');

  return {
    graphs: {
      [mainGraphId]: {
        connections: [connect(mainSubgraphNode.id, 'result', mainOutputNode.id, 'value')],
        metadata: {
          description: '',
          id: mainGraphId,
          name: mainGraphId,
        },
        nodes: [mainSubgraphNode, mainOutputNode],
      },
      [subgraph1Id]: {
        connections: [connect(nestedSubgraphNode.id, 'error', nestedOutputNode.id, 'value')],
        metadata: {
          description: '',
          id: subgraph1Id,
          name: subgraph1Id,
        },
        nodes: [nestedSubgraphNode, nestedOutputNode],
      },
      [subgraph2Id]: makeFailingExpressionGraph(subgraph2Id),
    },
    metadata: {
      description: '',
      id: 'debugger-caught-error-project' as ProjectId,
      mainGraphId,
      title: 'Debugger Caught Error Project',
    },
    plugins: [],
  };
}

function makeNestedRaceLoserProject(): Project {
  const mainGraphId = 'main-race' as GraphId;
  const raceGraphId = 'subgraph-race' as GraphId;
  const slowChildGraphId = 'subgraph-race-slow-child' as GraphId;
  const mainSubgraphNode = makeSubgraphNode('main-race-subgraph', raceGraphId);
  const mainOutputNode = makeGraphOutputNode('main-race-output', 'result', 'any');
  const slowSubgraphNode = makeSubgraphNode('subgraph-race-slow-subgraph', slowChildGraphId);
  const slowDirectExpressionNode = makeExpressionNode(
    'subgraph-race-slow-expression',
    'await new Promise((resolve) => setTimeout(() => resolve("slow direct"), 50))',
  );
  const fastExpressionNode = makeExpressionNode('subgraph-race-fast-expression', '"fast"');
  const raceNode: ChartNode = {
    data: {},
    id: 'subgraph-race-inputs' as NodeId,
    title: 'Race Inputs',
    type: 'raceInputs',
    visualData: { width: 260, x: 300, y: 0 },
  };
  const raceOutputNode = makeGraphOutputNode('subgraph-race-output', 'result', 'any');

  return {
    graphs: {
      [mainGraphId]: {
        connections: [connect(mainSubgraphNode.id, 'result', mainOutputNode.id, 'value')],
        metadata: {
          description: '',
          id: mainGraphId,
          name: mainGraphId,
        },
        nodes: [mainSubgraphNode, mainOutputNode],
      },
      [raceGraphId]: {
        connections: [
          connect(slowSubgraphNode.id, 'result', raceNode.id, 'input1'),
          connect(slowDirectExpressionNode.id, 'output', raceNode.id, 'input2'),
          connect(fastExpressionNode.id, 'output', raceNode.id, 'input3'),
          connect(raceNode.id, 'result', raceOutputNode.id, 'value'),
        ],
        metadata: {
          description: '',
          id: raceGraphId,
          name: raceGraphId,
        },
        nodes: [slowSubgraphNode, slowDirectExpressionNode, fastExpressionNode, raceNode, raceOutputNode],
      },
      [slowChildGraphId]: makeSlowExpressionGraph(slowChildGraphId),
    },
    metadata: {
      description: '',
      id: 'debugger-race-loser-project' as ProjectId,
      mainGraphId,
      title: 'Debugger Race Loser Project',
    },
    plugins: [],
  };
}

function makeSuccessfulAbortLeafSubgraphProject(): Project {
  const mainGraphId = 'main-successful-abort' as GraphId;
  const leafGraphId = 'successful-abort-leaf' as GraphId;
  const leafSubgraphNode = makeSubgraphNode('successful-abort-leaf-subgraph', leafGraphId);
  const abortTriggerNode = makeExpressionNode('successful-abort-trigger-expression', '"abort"');
  const delayNode = makeDelayNode('successful-abort-delay', 10);
  const abortNode = makeAbortGraphNode('successful-abort-node');
  const parentOutputNode = makeGraphOutputNode('successful-abort-parent-output', 'result', 'any');

  return {
    graphs: {
      [mainGraphId]: {
        connections: [
          connect(leafSubgraphNode.id, 'result', parentOutputNode.id, 'value'),
          connect(abortTriggerNode.id, 'output', delayNode.id, 'input1'),
          connect(delayNode.id, 'output1', abortNode.id, 'data'),
        ],
        metadata: {
          description: '',
          id: mainGraphId,
          name: mainGraphId,
        },
        nodes: [leafSubgraphNode, abortTriggerNode, delayNode, abortNode, parentOutputNode],
      },
      [leafGraphId]: makeSuccessfulAbortSlowLeafGraph(leafGraphId),
    },
    metadata: {
      description: '',
      id: 'debugger-successful-abort-project' as ProjectId,
      mainGraphId,
      title: 'Debugger Successful Abort Project',
    },
    plugins: [],
  };
}

function makeSubgraphCallerGraph(graphId: GraphId, calledGraphId: GraphId, prefix: string): NodeGraph {
  const subgraphNode = makeSubgraphNode(`${prefix}-subgraph`, calledGraphId);
  const outputNode = makeGraphOutputNode(`${prefix}-output`, 'result', 'any');

  return {
    connections: [connect(subgraphNode.id, 'result', outputNode.id, 'value')],
    metadata: {
      description: '',
      id: graphId,
      name: graphId,
    },
    nodes: [subgraphNode, outputNode],
  };
}

function makeSuccessfulAbortSlowLeafGraph(graphId: GraphId): NodeGraph {
  const slowExpressionNode = makeExpressionNode(
    'successful-abort-leaf-expression',
    'await new Promise((resolve) => setTimeout(() => resolve("slow leaf"), 50))',
  );
  const outputNode = makeGraphOutputNode('successful-abort-leaf-output', 'result', 'any');

  return {
    connections: [connect(slowExpressionNode.id, 'output', outputNode.id, 'value')],
    metadata: {
      description: '',
      id: graphId,
      name: graphId,
    },
    nodes: [slowExpressionNode, outputNode],
  };
}

function makeSlowExpressionGraph(graphId: GraphId): NodeGraph {
  const slowExpressionNode = makeExpressionNode(
    'subgraph-race-slow-child-expression',
    'await new Promise((resolve) => setTimeout(() => resolve("slow child"), 50))',
  );
  const outputNode = makeGraphOutputNode('subgraph-race-slow-child-output', 'result', 'any');

  return {
    connections: [connect(slowExpressionNode.id, 'output', outputNode.id, 'value')],
    metadata: {
      description: '',
      id: graphId,
      name: graphId,
    },
    nodes: [slowExpressionNode, outputNode],
  };
}

function makeFailingExpressionGraph(graphId: GraphId): NodeGraph {
  const failingExpressionNode = makeExpressionNode(
    'subgraph2-failing-expression',
    '(() => { throw new Error("nested expression failed"); })()',
  );
  const outputNode = makeGraphOutputNode('subgraph2-failing-output', 'result', 'any');

  return {
    connections: [connect(failingExpressionNode.id, 'output', outputNode.id, 'value')],
    metadata: {
      description: '',
      id: graphId,
      name: graphId,
    },
    nodes: [failingExpressionNode, outputNode],
  };
}

function makeCircularExpressionGraph(graphId: GraphId): NodeGraph {
  const circularExpressionNode = makeExpressionNode(
    'subgraph2-circular-expression',
    '(() => { const value = {}; value.self = value; return value; })()',
  );
  const downstreamExpressionNode = makeExpressionNode('subgraph2-downstream-expression', '{{input}} === {{input}}');
  const outputNode = makeGraphOutputNode('subgraph2-output', 'result', 'any');

  return {
    connections: [
      connect(circularExpressionNode.id, 'output', downstreamExpressionNode.id, 'input'),
      connect(downstreamExpressionNode.id, 'output', outputNode.id, 'value'),
    ],
    metadata: {
      description: '',
      id: graphId,
      name: graphId,
    },
    nodes: [circularExpressionNode, downstreamExpressionNode, outputNode],
  };
}

function makeExpressionNode(id: string, expression: string): ChartNode {
  return {
    data: {
      expression,
    },
    id: id as NodeId,
    title: 'Expression',
    type: 'expression',
    visualData: { width: 260, x: 0, y: 0 },
  };
}

function makeSubgraphNode(id: string, graphId: GraphId, useErrorOutput = false): ChartNode {
  return {
    data: {
      graphId,
      useAsGraphPartialOutput: false,
      useErrorOutput,
    },
    id: id as NodeId,
    title: 'Subgraph',
    type: 'subGraph',
    visualData: { width: 300, x: 0, y: 0 },
  };
}

function makeDelayNode(id: string, delay: number): ChartNode {
  return {
    data: {
      delay,
    },
    id: id as NodeId,
    title: 'Delay',
    type: 'delay',
    visualData: { width: 175, x: 0, y: 0 },
  };
}

function makeAbortGraphNode(id: string): ChartNode {
  return {
    data: {
      errorMessage: '',
      successfully: true,
    },
    id: id as NodeId,
    title: 'Abort Graph',
    type: 'abortGraph',
    visualData: { width: 200, x: 0, y: 0 },
  };
}

function makeGraphOutputNode(id: string, outputId: string, dataType: DataType): ChartNode {
  return {
    data: {
      dataType,
      id: outputId,
    },
    id: id as NodeId,
    title: 'Graph Output',
    type: 'graphOutput',
    visualData: { width: 240, x: 400, y: 0 },
  };
}

function connect(outputNodeId: NodeId, outputId: string, inputNodeId: NodeId, inputId: string): NodeConnection {
  return {
    inputId: inputId as PortId,
    inputNodeId,
    outputId: outputId as PortId,
    outputNodeId,
  };
}

describe('startDebuggerServer heartbeat', () => {
  it('exports centralized heartbeat defaults', () => {
    assert.equal(DEBUGGER_HEARTBEAT_INTERVAL_MS, 30_000);
    assert.equal(DEBUGGER_HEARTBEAT_TIMEOUT_MS, 10_000);
  });

  it('sends websocket pings and keeps responsive clients connected', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();

    startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 50,
    });

    server.connect(socket);

    await waitFor(() => assert.equal(socket.pingCount, 1));
    socket.emit('pong');
    await waitFor(() => assert.equal(socket.pingCount, 2));

    assert.equal(socket.terminated, false);
    socket.close();
    const pingCountAfterClose = socket.pingCount;
    await wait(25);
    assert.equal(socket.pingCount, pingCountAfterClose);
  });

  it('terminates clients that do not answer heartbeat pings', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();

    startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 15,
    });

    server.connect(socket);

    await waitFor(() => assert.equal(socket.pingCount, 1));
    await waitFor(() => assert.equal(socket.terminated, true));
  });

  it('keeps clients connected when outbound debugger traffic proves activity during a heartbeat wait', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 30,
    });

    server.connect(socket);

    await waitFor(() => assert.equal(socket.pingCount, 1));
    debuggerServer.broadcast(fakeProcessor(), 'trace', 'activity');
    await wait(45);

    assert.equal(socket.terminated, false);
    socket.close();
  });

  it('keeps clients connected when a graph run emits debugger traffic during a heartbeat wait', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 30,
    });
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger: debuggerServer,
    });

    server.connect(socket);

    await waitFor(() => assert.equal(socket.pingCount, 1));
    await processor.run();
    await wait(45);

    assert.equal(socket.terminated, false);
    socket.close();
  });

  it('keeps clients connected when inbound debugger traffic proves activity during a heartbeat wait', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();

    startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 30,
    });

    server.connect(socket);

    await waitFor(() => assert.equal(socket.pingCount, 1));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'pause', data: null })));
    await wait(45);

    assert.equal(socket.terminated, false);
    socket.close();
  });

  it('can disable heartbeat when a host owns websocket liveness itself', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();

    startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });

    server.connect(socket);
    await wait(25);

    assert.equal(socket.pingCount, 0);
    assert.equal(socket.terminated, false);
    socket.close();
  });
});

describe('startDebuggerServer broadcast', () => {
  it('keeps connection-time debugger messages best-effort when the websocket send throws', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const errors: Error[] = [];
    socket.sendThrowError = new Error('synthetic handshake send failure');
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      allowGraphUpload: true,
      heartbeatIntervalMs: 0,
    });
    debuggerServer.on('error', (error) => {
      errors.push(error);
    });

    assert.doesNotThrow(() => {
      server.connect(socket);
    });

    assert.equal(socket.terminated, true);
    await waitFor(() => assert.equal(errors.length, 1));
  });

  it('keeps broadcasts best-effort when one debugger client send throws', async () => {
    const server = new FakeWebSocketServer();
    const failingSocket = new FakeWebSocket();
    const healthySocket = new FakeWebSocket();
    const errors: Error[] = [];
    failingSocket.sendThrowError = new Error('synthetic send failure');
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    debuggerServer.on('error', (error) => {
      errors.push(error);
    });

    server.connect(failingSocket);
    server.connect(healthySocket);

    assert.doesNotThrow(() => {
      debuggerServer.broadcast(fakeProcessor(), 'trace', 'hello');
    });

    assert.equal(failingSocket.terminated, true);
    assert.equal(healthySocket.terminated, false);
    assert.equal(healthySocket.sentMessages.length, 1);
    assert.equal(JSON.parse(healthySocket.sentMessages[0]!).message, 'trace');
    await waitFor(() => assert.equal(errors.length, 1));
  });

  it('terminates only the failed debugger client when send reports an error', async () => {
    const server = new FakeWebSocketServer();
    const failingSocket = new FakeWebSocket();
    const healthySocket = new FakeWebSocket();
    const errors: Error[] = [];
    failingSocket.sendCallbackError = new Error('synthetic stale socket');
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    debuggerServer.on('error', (error) => {
      errors.push(error);
    });

    server.connect(failingSocket);
    server.connect(healthySocket);
    debuggerServer.broadcast(fakeProcessor(), 'trace', 'hello');

    assert.equal(failingSocket.terminated, true);
    assert.equal(healthySocket.terminated, false);
    assert.equal(healthySocket.sentMessages.length, 1);
    await waitFor(() => assert.equal(errors.length, 1));
  });

  it('sends lifecycle messages with circular payload branches instead of dropping them', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const errors: Error[] = [];
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const circular: Record<string, unknown> = {};
    circular.bigint = 1n;
    circular.self = circular;
    circular.undefinedValue = undefined;
    debuggerServer.on('error', (error) => {
      errors.push(error);
    });

    server.connect(socket);

    assert.doesNotThrow(() => {
      debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
        execution: makeExecution(),
        node: { id: 'expression-1', type: 'expression' },
        outputs: {
          output: {
            type: 'any',
            value: circular,
          },
        },
        processId: 'process-1',
      });
    });

    assert.equal(socket.terminated, false);
    assert.equal(errors.length, 0);

    const nodeFinish = decodeDebuggerTransportSentinels(getSentDebuggerMessage(socket, 'nodeFinish'));
    assert.equal(nodeFinish.data.node.id, 'expression-1');
    assert.equal(nodeFinish.data.outputs.output.value.bigint, '[Unserializable bigint: 1]');
    assert.equal(nodeFinish.data.outputs.output.value.self, '[Unserializable value: circular reference]');
    assert.equal(nodeFinish.data.outputs.output.value.undefinedValue, undefined);
  });

  it('optimized debugger serializer preserves JSON-safe payload shape', () => {
    const payload = {
      data: {
        execution: makeExecution(),
        node: { id: 'node-1', title: 'Node 1', type: 'text' },
        outputs: {
          output: {
            type: 'object',
            value: {
              array: [1, 'two', true, null],
              nested: { ok: true },
            },
          },
        },
        processId: 'process-1',
      },
      message: 'nodeFinish',
      requestId: 'request-1',
    };

    assert.deepEqual(JSON.parse(stringifyDebuggerPayloadForTransport(payload)), payload);
  });

  it('falls back to a warning lifecycle payload if safe serialization itself fails', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const errors: Error[] = [];
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    debuggerServer.on('error', (error) => {
      errors.push(error);
    });

    server.connect(socket);

    const originalStringify = JSON.stringify;
    let shouldThrow = true;
    JSON.stringify = ((
      value: unknown,
      replacer?: Parameters<typeof JSON.stringify>[1],
      space?: Parameters<typeof JSON.stringify>[2],
    ) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('synthetic serializer failure');
      }

      return originalStringify(value, replacer, space);
    }) as typeof JSON.stringify;

    try {
      debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
        execution: makeExecution(),
        node: { id: 'expression-1', type: 'expression' },
        outputs: {
          output: {
            type: 'any',
            value: {
              ok: true,
            },
          },
        },
        processId: 'process-1',
      });
    } finally {
      JSON.stringify = originalStringify;
    }

    const nodeFinish = getSentDebuggerMessage(socket, 'nodeFinish');
    assert.equal(nodeFinish.data.node.id, 'expression-1');
    assert.equal(nodeFinish.data.outputs[WarningsPort].type, 'string[]');
    assert.match(nodeFinish.data.outputs[WarningsPort].value[0], /could not serialize/);
    await waitFor(() => assert.equal(errors.length, 1));
  });

  it('keeps the early graph-output boundary when its original payload cannot be serialized', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    server.connect(socket);

    const originalStringify = JSON.stringify;
    let shouldThrow = true;
    JSON.stringify = ((
      value: unknown,
      replacer?: Parameters<typeof JSON.stringify>[1],
      space?: Parameters<typeof JSON.stringify>[2],
    ) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('synthetic early-output serializer failure');
      }

      return originalStringify(value, replacer, space);
    }) as typeof JSON.stringify;

    try {
      debuggerServer.broadcast(fakeProcessor(), 'graphOutputsReady', {
        execution: makeExecution(),
        graph: { metadata: { id: 'graph-1' } },
        outputs: { result: { type: 'string', value: 'ready' } },
      });
    } finally {
      JSON.stringify = originalStringify;
    }

    const outputsReady = getSentDebuggerMessage(socket, 'graphOutputsReady');
    assert.equal(outputsReady.data.outputs[WarningsPort].type, 'string[]');
    assert.match(outputsReady.data.outputs[WarningsPort].value[0], /could not serialize/);
  });

  it('sends downstream events whose inputs include non-JSON-safe values', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeStart', {
      execution: makeExecution(),
      inputs: {
        input: {
          type: 'any',
          value: circular,
        },
      },
      node: { id: 'downstream-expression', type: 'expression' },
      processId: 'process-2',
    });

    const nodeStart = getSentDebuggerMessage(socket, 'nodeStart');
    assert.equal(nodeStart.data.node.id, 'downstream-expression');
    assert.equal(nodeStart.data.inputs.input.value.self, '[Unserializable value: circular reference]');
  });

  it('honors JSON-compatible toJSON values in debugger payloads', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value: {
            ignored: 'original value',
            toJSON: () => ({ serialized: true }),
          },
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = getSentDebuggerMessage(socket, 'nodeFinish');
    assert.deepEqual(nodeFinish.data.outputs.value.value, { serialized: true });
  });

  it('sanitizes throwing accessor values without dropping lifecycle events', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const value = {};
    Object.defineProperty(value, 'computed', {
      enumerable: true,
      get() {
        throw new Error('synthetic getter failure');
      },
    });

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value,
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = getSentDebuggerMessage(socket, 'nodeFinish');
    assert.equal(nodeFinish.data.outputs.value.value.computed, '[Unserializable property: synthetic getter failure]');
  });

  it('keeps branch placeholders when thrown accessor reasons cannot be stringified', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const value = {};
    Object.defineProperty(value, 'computed', {
      enumerable: true,
      get() {
        throw {
          toString() {
            throw new Error('synthetic reason formatter failure');
          },
        };
      },
    });

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value,
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = getSentDebuggerMessage(socket, 'nodeFinish');
    assert.equal(nodeFinish.data.outputs.value.value.computed, '[Unserializable property: unavailable reason]');
  });

  it('preserves legacy debugger display shape for boxed primitive objects', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const boxedNumber = Object.assign(new Number(5), { label: 'number' });
    const boxedString = Object.assign(new String('abc'), { label: 'string' });

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value: {
            boxedBigInt: Object(1n),
            boxedBoolean: new Boolean(false),
            boxedNumber,
            boxedString,
          },
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = getSentDebuggerMessage(socket, 'nodeFinish');
    assert.deepEqual(nodeFinish.data.outputs.value.value.boxedBigInt, {});
    assert.deepEqual(nodeFinish.data.outputs.value.value.boxedBoolean, {});
    assert.deepEqual(nodeFinish.data.outputs.value.value.boxedNumber, { label: 'number' });
    assert.deepEqual(nodeFinish.data.outputs.value.value.boxedString, {
      0: 'a',
      1: 'b',
      2: 'c',
      label: 'string',
    });
  });

  it('preserves explicit undefined and replaces non-JSON primitives in debugger payloads', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value: {
            bigint: 1n,
            fn: function namedFunction() {},
            infinity: Infinity,
            nan: NaN,
            symbol: Symbol('debugger-test'),
            undefinedValue: undefined,
          },
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = decodeDebuggerTransportSentinels(getSentDebuggerMessage(socket, 'nodeFinish'));
    const outputValue = nodeFinish.data.outputs.value.value;
    assert.equal(outputValue.undefinedValue, undefined);
    assert.equal(outputValue.bigint, '[Unserializable bigint: 1]');
    assert.equal(outputValue.fn, '[Unserializable function: namedFunction]');
    assert.equal(outputValue.infinity, '[Unserializable number: Infinity]');
    assert.equal(outputValue.nan, '[Unserializable number: NaN]');
    assert.equal(outputValue.symbol, '[Unserializable symbol: Symbol(debugger-test)]');
  });

  it('preserves user values that match debugger sentinel envelopes', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const sentinelShapedUserValue = {
      __rivetDebuggerTransportSentinel: {
        type: 'undefined',
        version: 1,
      },
    };

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value: sentinelShapedUserValue,
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = decodeDebuggerTransportSentinels(getSentDebuggerMessage(socket, 'nodeFinish'));
    assert.deepEqual(nodeFinish.data.outputs.value.value, sentinelShapedUserValue);
  });

  it('preserves user values that match debugger escaped-sentinel envelopes', () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const sentinelShapedUserValue = {
      __rivetDebuggerTransportSentinel: {
        type: 'escaped-sentinel',
        value: undefined,
        version: 1,
      },
    };

    server.connect(socket);

    debuggerServer.broadcast(fakeProcessor(), 'nodeFinish', {
      execution: makeExecution(),
      node: { id: 'expression-1', type: 'expression' },
      outputs: {
        value: {
          type: 'any',
          value: sentinelShapedUserValue,
        },
      },
      processId: 'process-1',
    });

    const nodeFinish = decodeDebuggerTransportSentinels(getSentDebuggerMessage(socket, 'nodeFinish'));
    assert.deepEqual(nodeFinish.data.outputs.value.value, sentinelShapedUserValue);
  });

  it('does not fail graph execution when debugger event sends fail', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    socket.sendThrowError = new Error('synthetic send failure');
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });

    server.connect(socket);

    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger: debuggerServer,
    });

    await assert.doesNotReject(() => processor.run());
    assert.equal(socket.terminated, true);
  });

  it('keeps nested subgraph debugger event streams complete when an expression returns a circular value', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const fixture = makeNestedCircularExpressionProject();

    server.connect(socket);

    const processor = createProcessor(fixture, {
      graph: 'main',
      remoteDebugger: debuggerServer,
    });

    await processor.run();

    const nodeStartMessages = getSentDebuggerMessages(socket, 'nodeStart');
    const nodeFinishMessages = getSentDebuggerMessages(socket, 'nodeFinish');
    assert.ok(
      nodeFinishMessages.some((message) => message.data.node.id === 'subgraph2-circular-expression'),
      'circular expression nodeFinish should be sent',
    );
    assert.ok(
      nodeStartMessages.some((message) => message.data.node.id === 'subgraph2-downstream-expression'),
      'downstream nodeStart should be sent even when its input includes the circular value',
    );
    assert.ok(
      nodeFinishMessages.some((message) => message.data.node.id === 'subgraph2-downstream-expression'),
      'downstream nodeFinish should be sent',
    );

    const circularFinish = nodeFinishMessages.find(
      (message) => message.data.node.id === 'subgraph2-circular-expression',
    )!;
    assert.equal(circularFinish.data.outputs.output.value.self, '[Unserializable value: circular reference]');
  });

  it('sends nested nodeError events before done when a subgraph catches the graph error', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const fixture = makeNestedCaughtExpressionErrorProject();

    server.connect(socket);

    const processor = createProcessor(fixture, {
      graph: 'main-error',
      remoteDebugger: debuggerServer,
    });

    const outputs = await processor.run();

    assert.equal(outputs['result' as PortId]?.type, 'string');
    assert.match(String(outputs['result' as PortId]?.value), /subgraph2-failing-expression/);

    const messages = socket.sentMessages.map((message) => JSON.parse(message));
    const failingNodeErrorIndex = messages.findIndex(
      (message) => message.message === 'nodeError' && message.data.node.id === 'subgraph2-failing-expression',
    );
    const doneIndex = messages.findIndex((message) => message.message === 'done');

    assert.notEqual(failingNodeErrorIndex, -1, 'nested expression nodeError should be sent');
    assert.notEqual(doneIndex, -1, 'successful root done should be sent');
    assert.ok(failingNodeErrorIndex < doneIndex, 'nested expression nodeError should arrive before done');

    const nodeError = messages[failingNodeErrorIndex]!;
    assert.equal(nodeError.data.execution.graphId, 'subgraph2-error');
    assert.match(nodeError.data.error, /nested expression failed/);
  });

  it('sends late race-loser exclusions from nested subgraphs before done', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const fixture = makeNestedRaceLoserProject();

    server.connect(socket);

    const processor = createProcessor(fixture, {
      graph: 'main-race',
      remoteDebugger: debuggerServer,
    });

    const outputs = await processor.run();

    assert.deepEqual(outputs['result' as PortId], { type: 'any', value: 'fast' });

    const messages = socket.sentMessages.map((message) => JSON.parse(message));
    const doneIndex = messages.findIndex((message) => message.message === 'done');
    const nodeExcludedIndexesById = new Map<string, number>();

    messages.forEach((message, index) => {
      if (message.message === 'nodeExcluded') {
        nodeExcludedIndexesById.set(message.data.node.id, index);
      }
    });

    assert.notEqual(doneIndex, -1, 'successful root done should be sent');

    for (const nodeId of [
      'subgraph-race-slow-child-expression',
      'subgraph-race-slow-subgraph',
      'subgraph-race-slow-expression',
    ]) {
      const nodeErrorCount = messages.filter(
        (message) => message.message === 'nodeError' && message.data.node.id === nodeId,
      ).length;
      const nodeExcludedCount = messages.filter(
        (message) => message.message === 'nodeExcluded' && message.data.node.id === nodeId,
      ).length;
      const nodeExcludedIndex = nodeExcludedIndexesById.get(nodeId);
      assert.equal(nodeErrorCount, 0, `${nodeId} should not be sent as a nodeError`);
      assert.notEqual(nodeExcludedIndex, undefined, `${nodeId} nodeExcluded should be sent`);
      assert.equal(nodeExcludedCount, 1, `${nodeId} nodeExcluded should be sent once`);
      assert.ok(nodeExcludedIndex! < doneIndex, `${nodeId} nodeExcluded should arrive before done`);
    }
  });

  it('sends late finishes for active leaf subgraphs after successful abort without queuing dependents', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const fixture = makeSuccessfulAbortLeafSubgraphProject();

    server.connect(socket);

    const processor = createProcessor(fixture, {
      graph: 'main-successful-abort',
      remoteDebugger: debuggerServer,
    });

    await processor.run();

    const messages = socket.sentMessages.map((message) => JSON.parse(message));
    const doneIndex = messages.findIndex((message) => message.message === 'done');
    const nodeFinishIndexesById = new Map<string, number>();

    messages.forEach((message, index) => {
      if (message.message === 'nodeFinish') {
        nodeFinishIndexesById.set(message.data.node.id, index);
      }
    });

    assert.notEqual(doneIndex, -1, 'successful root done should be sent');

    for (const nodeId of ['successful-abort-leaf-expression', 'successful-abort-leaf-subgraph']) {
      const nodeErrorCount = messages.filter(
        (message) => message.message === 'nodeError' && message.data.node.id === nodeId,
      ).length;
      const nodeExcludedCount = messages.filter(
        (message) => message.message === 'nodeExcluded' && message.data.node.id === nodeId,
      ).length;
      const nodeFinishIndex = nodeFinishIndexesById.get(nodeId);
      assert.equal(nodeErrorCount, 0, `${nodeId} should not be sent as a nodeError`);
      assert.equal(nodeExcludedCount, 0, `${nodeId} should not be sent as nodeExcluded after it produced outputs`);
      assert.notEqual(nodeFinishIndex, undefined, `${nodeId} nodeFinish should be sent`);
      assert.ok(nodeFinishIndex! < doneIndex, `${nodeId} nodeFinish should arrive before done`);
    }

    const outputTerminalCount = messages.filter(
      (message) =>
        (message.message === 'nodeFinish' || message.message === 'nodeError' || message.message === 'nodeExcluded') &&
        message.data.node.id === 'successful-abort-leaf-output',
    ).length;
    assert.equal(outputTerminalCount, 0, 'late successful-abort finishes should not queue dependents');
  });

  it('forwards node error duration metadata to debugger clients', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const fixture = makeThrowingCodeProject();

    server.connect(socket);

    const processor = createProcessor(fixture.project, {
      graph: fixture.graphId,
      remoteDebugger: debuggerServer,
      captureNodeTimings: true,
    });

    await assert.rejects(() => processor.run(), /failed to process due to errors in nodes/);

    const nodeErrorMessage = getSentDebuggerMessage(socket, 'nodeError');
    assert.equal(nodeErrorMessage?.data.node.id, 'throwing-code');
    assert.equal(typeof nodeErrorMessage?.data.durationMs, 'number');
    assert.ok(nodeErrorMessage.data.durationMs >= 0);
  });

  it('removes processor event listeners on detach and keeps detach idempotent', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
    });

    server.connect(socket);
    debuggerServer.attach(processor.processor);
    debuggerServer.detach(processor.processor);
    debuggerServer.detach(processor.processor);

    await processor.run();

    assert.equal(socket.sentMessages.length, 0);
  });

  it('automatically detaches processors after graph execution finishes', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const processorCounts: number[] = [];
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
      getProcessorsForClient: (_client, processors) => {
        processorCounts.push(processors.length);
        return processors;
      },
    });

    server.connect(socket);

    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger: debuggerServer,
    });

    await processor.run();
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'pause', data: null })));

    await waitFor(() => assert.equal(processorCounts.at(-1), 0));
  });

  it('passes processor-routing callbacks a snapshot of attached processors', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const processorCounts: number[] = [];
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
      getProcessorsForClient: (_client, processors) => {
        processorCounts.push(processors.length);
        processors.pop();
        return [];
      },
    });

    server.connect(socket);
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
    });
    debuggerServer.attach(processor.processor);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'pause', data: null })));
    await waitFor(() => assert.equal(processorCounts.length, 1));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'pause', data: null })));
    await waitFor(() => assert.equal(processorCounts.length, 2));

    assert.deepEqual(processorCounts, [1, 1]);
    debuggerServer.detach(processor.processor);
  });

  it('routes request-scoped control messages only to matching processors', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const pauseCalls: string[] = [];
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });
    const makeControllableProcessor = (id: string) =>
      ({
        id,
        on: () => () => {},
        pause: () => {
          pauseCalls.push(id);
        },
      }) as unknown as GraphProcessor;
    const processorA = makeControllableProcessor('processor-a');
    const processorB = makeControllableProcessor('processor-b');

    server.connect(socket);
    debuggerServer.attach(processorA, 'request-a' as RemoteRunRequestId);
    debuggerServer.attach(processorB, 'request-b' as RemoteRunRequestId);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'pause', data: { requestId: 'request-b' } })));

    await waitFor(() => assert.deepEqual(pauseCalls, ['processor-b']));

    debuggerServer.detach(processorA);
    debuggerServer.detach(processorB);
    socket.close();
  });

  it('keeps uploaded project and static data state scoped to each debugger client', async () => {
    const server = new FakeWebSocketServer();
    const socketA = new FakeWebSocket();
    const socketB = new FakeWebSocket();
    const states = new WeakMap<WebSocket, DebuggerClientState>();
    const getState = (client: WebSocket) => {
      let state = states.get(client);
      if (!state) {
        state = { uploadedProject: undefined, settings: undefined };
        states.set(client, state);
      }
      return state;
    };

    startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
      allowGraphUpload: true,
      getClientDebuggerState: getState,
    });

    server.connect(socketA);
    server.connect(socketB);

    const projectA = makeUploadedProject('project-a', 'Project A');
    const projectB = makeUploadedProject('project-b', 'Project B');
    const settingsA = { editorVersion: 'a' } as unknown as Settings;
    const settingsB = { editorVersion: 'b' } as unknown as Settings;

    socketA.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'set-dynamic-data', data: { project: projectA, settings: settingsA } })),
    );
    socketB.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'set-dynamic-data', data: { project: projectB, settings: settingsB } })),
    );

    await waitFor(() => {
      assert.equal(getState(socketA as unknown as WebSocket).uploadedProject?.metadata.id, 'project-a');
      assert.equal(getState(socketB as unknown as WebSocket).uploadedProject?.metadata.id, 'project-b');
    });
    assert.deepEqual(getState(socketA as unknown as WebSocket).settings, settingsA);
    assert.deepEqual(getState(socketB as unknown as WebSocket).settings, settingsB);

    socketA.emit('message', Buffer.from('set-static-data:data-a:value-a'));
    await waitFor(() => {
      assert.equal(getState(socketA as unknown as WebSocket).uploadedProject?.data?.['data-a' as DataId], 'value-a');
    });
    assert.equal(getState(socketB as unknown as WebSocket).uploadedProject?.data?.['data-a' as DataId], undefined);

    socketA.close();
    socketB.close();
  });

  it('routes dataset requests and responses through the matching client provider', async () => {
    const server = new FakeWebSocketServer();
    const socketA = new FakeWebSocket();
    const socketB = new FakeWebSocket();
    const providers = new WeakMap<WebSocket, DebuggerDatasetProvider>();
    const getProvider = (client: WebSocket) => {
      let provider = providers.get(client);
      if (!provider) {
        provider = new DebuggerDatasetProvider();
        providers.set(client, provider);
      }
      return provider;
    };

    startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
      getDatasetProviderForClient: getProvider,
    });

    server.connect(socketA);
    server.connect(socketB);

    const promiseA = getProvider(socketA as unknown as WebSocket).getDatasetData('dataset-a' as DatasetId);
    await waitFor(() => assert.equal(socketA.sentMessages.length, 1));
    assert.equal(socketB.sentMessages.length, 0);

    const requestA = JSON.parse(socketA.sentMessages[0]!) as {
      data: { requestId: string };
      message: string;
    };
    assert.equal(requestA.message, 'datasets:get-data');

    let resolvedA = false;
    promiseA.then(() => {
      resolvedA = true;
    });

    socketB.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'datasets:response',
          data: { requestId: requestA.data.requestId, payload: { id: 'wrong-client' } },
        }),
      ),
    );
    await wait(10);
    assert.equal(resolvedA, false);

    socketA.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'datasets:response',
          data: { requestId: requestA.data.requestId, payload: { id: 'right-client' } },
        }),
      ),
    );

    assert.deepEqual(await promiseA, { id: 'right-client' });
    socketA.close();
    socketB.close();
  });

  it('reattaches createProcessor remote debugger listeners for repeated runs', async () => {
    const server = new FakeWebSocketServer();
    const socket = new FakeWebSocket();
    const debuggerServer = startDebuggerServer({
      server: server as unknown as WebSocketServer,
      heartbeatIntervalMs: 0,
    });

    server.connect(socket);

    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger: debuggerServer,
    });

    await processor.run();
    const messagesAfterFirstRun = socket.sentMessages.length;
    await processor.run();

    assert.ok(messagesAfterFirstRun > 0);
    assert.ok(socket.sentMessages.length > messagesAfterFirstRun);
  });
});
