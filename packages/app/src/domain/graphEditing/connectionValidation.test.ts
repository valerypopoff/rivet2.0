import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type Project,
} from '@valerypopoff/rivet2-core';
import { filterValidSubGraphConnections, getAsyncBranchTopologyViolation } from './connectionValidation.js';
import {
  createTestNodeRegistry,
  makeConnection as makeBaseConnection,
  makeGraph,
  makeGraphInputNode,
  makeGraphOutputNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from './testGraphBuilders.js';

const registry = createTestNodeRegistry();
const subGraphId = 'sub-graph' as GraphId;

function makeProjectWithSubGraph(subGraphNodes: ChartNode[]): Project {
  return makeProject([makeGraph(subGraphId, subGraphNodes, [], 'Subgraph')]);
}

function makeConnection(overrides: Partial<NodeConnection> = {}): NodeConnection {
  return makeBaseConnection({
    inputNodeId: 'subgraph' as NodeId,
    inputId: 'input' as PortId,
    ...overrides,
  });
}

function makeStartAsyncBranchNode(nodeId: string, title = 'Start Async Branch'): ChartNode {
  const node = registry.createDynamic('startBackgroundBranch');
  node.id = nodeId as NodeId;
  node.title = title;
  return node;
}

function makeWatchStreamingOutputNode(nodeId: string, title = 'Watch Streaming Output'): ChartNode {
  const node = registry.createDynamic('watchStreamingOutput');
  node.id = nodeId as NodeId;
  node.title = title;
  return node;
}

function makeStopWatchingStreamingOutputNode(nodeId: string): ChartNode {
  const node = registry.createDynamic('stopWatchingStreamingOutput');
  node.id = nodeId as NodeId;
  return node;
}

function makeDataBusNode(nodeId: string): ChartNode {
  const node = registry.createDynamic('dataBus');
  node.id = nodeId as NodeId;
  node.title = 'Shared values';
  return node;
}

test('filterValidSubGraphConnections keeps valid subgraph input connections', () => {
  const sourceNode = makeTextNode('source');
  const subGraphNode = makeSubGraphNode('subgraph');
  const connection = makeConnection();

  const filtered = filterValidSubGraphConnections({
    connections: [connection],
    nodesById: {
      [sourceNode.id]: sourceNode,
      [subGraphNode.id]: subGraphNode,
    },
    project: makeProjectWithSubGraph([makeGraphInputNode('input-node', 'input')]),
    projectNodeRegistry: registry,
    referencedProjects: {},
  });

  assert.deepEqual(filtered, [connection]);
});

test('filterValidSubGraphConnections removes stale subgraph input connections', () => {
  const sourceNode = makeTextNode('source');
  const subGraphNode = makeSubGraphNode('subgraph');
  const connection = makeConnection();

  const filtered = filterValidSubGraphConnections({
    connections: [connection],
    nodesById: {
      [sourceNode.id]: sourceNode,
      [subGraphNode.id]: subGraphNode,
    },
    project: makeProjectWithSubGraph([makeGraphInputNode('input-node', 'renamed')]),
    projectNodeRegistry: registry,
    referencedProjects: {},
  });

  assert.deepEqual(filtered, []);
});

test('filterValidSubGraphConnections removes stale subgraph output connections', () => {
  const subGraphNode = makeSubGraphNode('subgraph');
  const targetNode = makeTextNode('target', '{{value}}');
  const connection = makeConnection({
    outputNodeId: subGraphNode.id,
    outputId: 'output' as PortId,
    inputNodeId: targetNode.id,
    inputId: 'value' as PortId,
  });

  const filtered = filterValidSubGraphConnections({
    connections: [connection],
    nodesById: {
      [subGraphNode.id]: subGraphNode,
      [targetNode.id]: targetNode,
    },
    project: makeProjectWithSubGraph([makeGraphOutputNode('output-node', 'renamed')]),
    projectNodeRegistry: registry,
    referencedProjects: {},
  });

  assert.deepEqual(filtered, []);
});

test('filterValidSubGraphConnections leaves non-subgraph connections untouched', () => {
  const sourceNode = makeTextNode('source');
  const targetNode = makeTextNode('target');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'missing' as PortId,
  });

  const filtered = filterValidSubGraphConnections({
    connections: [connection],
    nodesById: {
      [sourceNode.id]: sourceNode,
      [targetNode.id]: targetNode,
    },
    project: makeProjectWithSubGraph([]),
    projectNodeRegistry: registry,
    referencedProjects: {},
  });

  assert.deepEqual(filtered, [connection]);
});

test('getAsyncBranchTopologyViolation reports a Graph Output reached from an async branch', () => {
  const asyncBranch = makeStartAsyncBranchNode('async', 'Persist status');
  const graphOutput = makeGraphOutputNode('result', 'answer', { title: 'Graph Output' });
  const connection = makeBaseConnection({
    outputNodeId: asyncBranch.id,
    outputId: 'output1' as PortId,
    inputNodeId: graphOutput.id,
    inputId: 'value' as PortId,
  });

  const violation = getAsyncBranchTopologyViolation({
    connections: [connection],
    nodesById: {
      [asyncBranch.id]: asyncBranch,
      [graphOutput.id]: graphOutput,
    },
  });

  assert.deepEqual(violation, {
    kind: 'graphOutput',
    triggerNodeId: asyncBranch.id,
    nodeId: graphOutput.id,
    message:
      'Start Async Branch "Persist status" cannot contain Graph Output node "Graph Output". Async branches are side-effect-only.',
  });
});

test('getAsyncBranchTopologyViolation permits a streaming watch branch without Stop', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');
  const branch = makeTextNode('branch');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: branch.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
    ],
    nodesById: {
      [source.id]: source,
      [watch.id]: watch,
      [branch.id]: branch,
    },
  });

  assert.equal(violation, undefined);
});

test('getAsyncBranchTopologyViolation permits a source-to-Watch draft before downstream nodes exist', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
    ],
    nodesById: {
      [source.id]: source,
      [watch.id]: watch,
    },
  });

  assert.equal(violation, undefined);
});

test('getAsyncBranchTopologyViolation permits a Stop boundary to rejoin normal execution', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');
  const stop = makeStopWatchingStreamingOutputNode('stop');
  const foreground = makeTextNode('foreground');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: stop.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: foreground.id,
        outputId: 'value' as PortId,
        outputNodeId: stop.id,
      }),
    ],
    nodesById: {
      [source.id]: source,
      [watch.id]: watch,
      [stop.id]: stop,
      [foreground.id]: foreground,
    },
  });

  assert.equal(violation, undefined);
});

test('getAsyncBranchTopologyViolation rejects a Stop boundary that reconnects to its own Watch branch', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');
  const branch = makeTextNode('branch', '{{chunk}}{{feedback}}');
  const stop = makeStopWatchingStreamingOutputNode('stop');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'chunk' as PortId,
        inputNodeId: branch.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: stop.id,
        outputId: 'output' as PortId,
        outputNodeId: branch.id,
      }),
      makeBaseConnection({
        inputId: 'feedback' as PortId,
        inputNodeId: branch.id,
        outputId: 'value' as PortId,
        outputNodeId: stop.id,
      }),
    ],
    nodesById: {
      [source.id]: source,
      [watch.id]: watch,
      [branch.id]: branch,
      [stop.id]: stop,
    },
  });

  assert.deepEqual(violation, {
    kind: 'cycle',
    triggerNodeId: watch.id,
    nodeId: stop.id,
    message:
      'Stop Watching Streaming Output "Stop Watching Streaming Output" cannot reconnect to its own Watch Streaming Output branch. ' +
      'Connect it only to ordinary downstream execution.',
  });
});

test('getAsyncBranchTopologyViolation rejects split-run sources and disabled nodes in a streaming watch branch', () => {
  const splitSource = makeTextNode('split-source');
  splitSource.isSplitRun = true;
  const watch = makeWatchStreamingOutputNode('watch');
  const stop = makeStopWatchingStreamingOutputNode('stop');
  const disabledBranch = { ...makeTextNode('disabled-branch'), disabled: true };
  const source = makeTextNode('source');

  const splitSourceViolation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: splitSource.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: stop.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
    ],
    nodesById: {
      [splitSource.id]: splitSource,
      [watch.id]: watch,
      [stop.id]: stop,
    },
  });
  assert.equal(splitSourceViolation?.kind, 'splitRun');

  const disabledBranchViolation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: disabledBranch.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: stop.id,
        outputId: 'value' as PortId,
        outputNodeId: disabledBranch.id,
      }),
    ],
    nodesById: {
      [source.id]: source,
      [watch.id]: watch,
      [disabledBranch.id]: disabledBranch,
      [stop.id]: stop,
    },
  });
  assert.equal(disabledBranchViolation?.kind, 'disabledNode');
});

test('getAsyncBranchTopologyViolation rejects an async trigger inside a streaming watch branch', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');
  const asyncBranch = makeStartAsyncBranchNode('async');
  const stop = makeStopWatchingStreamingOutputNode('stop');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'input1' as PortId,
        inputNodeId: asyncBranch.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
      makeBaseConnection({
        inputId: 'value' as PortId,
        inputNodeId: stop.id,
        outputId: 'output1' as PortId,
        outputNodeId: asyncBranch.id,
      }),
    ],
    nodesById: {
      [source.id]: source,
      [watch.id]: watch,
      [asyncBranch.id]: asyncBranch,
      [stop.id]: stop,
    },
  });

  assert.equal(violation?.kind, 'asyncBranch');
  assert.match(violation?.message ?? '', /cannot contain Start Async Branch/);
});

test('getAsyncBranchTopologyViolation rejects async branches nested through Watch Subgraphs', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');
  const outerSubgraph = makeSubGraphNode('outer-subgraph', 'outer-watch-child');
  const outerInput = makeGraphInputNode('outer-input', 'input');
  const innerSubgraph = makeSubGraphNode('inner-subgraph', 'inner-watch-child');
  const innerInput = makeGraphInputNode('inner-input', 'input');
  const nestedAsyncBranch = makeStartAsyncBranchNode('nested-async', 'Nested Start Async Branch');
  const nestedLeaf = makeTextNode('nested-leaf');
  const rootGraph = makeGraph(
    'root',
    [source, watch, outerSubgraph],
    [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: outerSubgraph.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
    ],
  );
  const outerGraph = makeGraph(
    'outer-watch-child',
    [outerInput, innerSubgraph],
    [
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: innerSubgraph.id,
        outputId: 'data' as PortId,
        outputNodeId: outerInput.id,
      }),
    ],
  );
  const innerGraph = makeGraph(
    'inner-watch-child',
    [innerInput, nestedAsyncBranch, nestedLeaf],
    [
      makeBaseConnection({
        inputId: 'input1' as PortId,
        inputNodeId: nestedAsyncBranch.id,
        outputId: 'data' as PortId,
        outputNodeId: innerInput.id,
      }),
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: nestedLeaf.id,
        outputId: 'output1' as PortId,
        outputNodeId: nestedAsyncBranch.id,
      }),
    ],
  );
  const project = makeProject([rootGraph, outerGraph, innerGraph]);

  const violation = getAsyncBranchTopologyViolation({
    connections: rootGraph.connections,
    nodesById: Object.fromEntries(rootGraph.nodes.map((node) => [node.id, node])),
    project,
  });

  assert.equal(violation?.kind, 'asyncBranch');
  assert.equal(violation?.nodeId, outerSubgraph.id);
  assert.match(violation?.message ?? '', /Nested Start Async Branch.*Watch Streaming Output.*through Subgraph/s);

  const nestedGraphViolation = getAsyncBranchTopologyViolation({
    connections: innerGraph.connections,
    graphId: innerGraph.metadata!.id,
    nodesById: Object.fromEntries(innerGraph.nodes.map((node) => [node.id, node])),
    project,
  });
  assert.equal(nestedGraphViolation?.kind, 'asyncBranch');
  assert.equal(nestedGraphViolation?.nodeId, nestedAsyncBranch.id);
});

test('getAsyncBranchTopologyViolation permits ordinary and disabled Watch Subgraphs', () => {
  const source = makeTextNode('source');
  const watch = makeWatchStreamingOutputNode('watch');
  const ordinarySubgraph = makeSubGraphNode('ordinary-subgraph', 'ordinary-watch-child');
  const disabledSubgraph = makeSubGraphNode('disabled-subgraph', 'disabled-watch-child');
  const unfinishedSubgraph = makeSubGraphNode('unfinished-subgraph', 'unfinished-watch-child');
  const disabledAsyncBranch = makeStartAsyncBranchNode('inert-async');
  const disabledAsyncLeaf = makeTextNode('disabled-async-leaf');
  const unfinishedAsyncBranch = makeStartAsyncBranchNode('unfinished-async');
  disabledAsyncLeaf.disabled = true;
  const rootGraph = makeGraph(
    'root',
    [source, watch, ordinarySubgraph, disabledSubgraph, unfinishedSubgraph],
    [
      makeBaseConnection({
        inputId: 'stream' as PortId,
        inputNodeId: watch.id,
        outputId: 'output' as PortId,
        outputNodeId: source.id,
      }),
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: ordinarySubgraph.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: disabledSubgraph.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: unfinishedSubgraph.id,
        outputId: 'value' as PortId,
        outputNodeId: watch.id,
      }),
    ],
  );
  const ordinaryGraph = makeGraph('ordinary-watch-child', [makeTextNode('ordinary-child')]);
  const disabledGraph = makeGraph(
    'disabled-watch-child',
    [disabledAsyncBranch, disabledAsyncLeaf],
    [
      makeBaseConnection({
        inputId: 'input' as PortId,
        inputNodeId: disabledAsyncLeaf.id,
        outputId: 'output1' as PortId,
        outputNodeId: disabledAsyncBranch.id,
      }),
    ],
  );
  // This trigger has no output connection, hence no branch can be handed to
  // the root async scheduler. It is an ordinary in-progress authoring state.
  const unfinishedGraph = makeGraph('unfinished-watch-child', [unfinishedAsyncBranch]);
  const project = makeProject([rootGraph, ordinaryGraph, disabledGraph, unfinishedGraph]);

  assert.equal(
    getAsyncBranchTopologyViolation({
      connections: rootGraph.connections,
      nodesById: Object.fromEntries(rootGraph.nodes.map((node) => [node.id, node])),
      project,
    }),
    undefined,
  );
});

test('getAsyncBranchTopologyViolation follows the full async subtree', () => {
  const asyncBranch = makeStartAsyncBranchNode('async');
  const sideEffect = makeTextNode('side-effect');
  const graphOutput = makeGraphOutputNode('result', 'answer');
  const existingConnection = makeBaseConnection({
    outputNodeId: sideEffect.id,
    outputId: 'output' as PortId,
    inputNodeId: graphOutput.id,
    inputId: 'value' as PortId,
  });
  const proposedConnection = makeBaseConnection({
    outputNodeId: asyncBranch.id,
    outputId: 'output1' as PortId,
    inputNodeId: sideEffect.id,
    inputId: 'value' as PortId,
  });

  const violation = getAsyncBranchTopologyViolation({
    connections: [existingConnection, proposedConnection],
    nodesById: {
      [asyncBranch.id]: asyncBranch,
      [sideEffect.id]: sideEffect,
      [graphOutput.id]: graphOutput,
    },
  });

  assert.equal(violation?.triggerNodeId, asyncBranch.id);
  assert.equal(violation?.kind, 'graphOutput');
  assert.equal(violation?.nodeId, graphOutput.id);
});

test('getAsyncBranchTopologyViolation follows a shared Data Bus channel into Graph Output', () => {
  const asyncBranch = makeStartAsyncBranchNode('async');
  const dataBus = makeDataBusNode('bus');
  const graphOutput = makeGraphOutputNode('result', 'answer');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        outputNodeId: asyncBranch.id,
        outputId: 'output1' as PortId,
        inputNodeId: dataBus.id,
        inputId: 'input1' as PortId,
      }),
      makeBaseConnection({
        outputNodeId: dataBus.id,
        outputId: 'output1' as PortId,
        inputNodeId: graphOutput.id,
        inputId: 'value' as PortId,
      }),
    ],
    nodesById: {
      [asyncBranch.id]: asyncBranch,
      [dataBus.id]: dataBus,
      [graphOutput.id]: graphOutput,
    },
  });

  assert.equal(violation?.kind, 'graphOutput');
  assert.equal(violation?.nodeId, graphOutput.id);
});

test('getAsyncBranchTopologyViolation does not join independent Data Bus channels', () => {
  const asyncBranch = makeStartAsyncBranchNode('async');
  const foregroundSource = makeTextNode('foreground');
  const dataBus = makeDataBusNode('bus');
  const graphOutput = makeGraphOutputNode('result', 'answer');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        outputNodeId: asyncBranch.id,
        outputId: 'output1' as PortId,
        inputNodeId: dataBus.id,
        inputId: 'input1' as PortId,
      }),
      makeBaseConnection({
        outputNodeId: foregroundSource.id,
        outputId: 'output' as PortId,
        inputNodeId: dataBus.id,
        inputId: 'input2' as PortId,
      }),
      makeBaseConnection({
        outputNodeId: dataBus.id,
        outputId: 'output2' as PortId,
        inputNodeId: graphOutput.id,
        inputId: 'value' as PortId,
      }),
    ],
    nodesById: {
      [asyncBranch.id]: asyncBranch,
      [foregroundSource.id]: foregroundSource,
      [dataBus.id]: dataBus,
      [graphOutput.id]: graphOutput,
    },
  });

  assert.equal(violation, undefined);
});

test('getAsyncBranchTopologyViolation does not use an invalid Data Bus as a raw connection hub', () => {
  const asyncBranch = makeStartAsyncBranchNode('async');
  const foregroundSource = makeTextNode('foreground');
  const dataBus = makeDataBusNode('bus');
  dataBus.disabled = true;
  const graphOutput = makeGraphOutputNode('result', 'answer');

  const violation = getAsyncBranchTopologyViolation({
    connections: [
      makeBaseConnection({
        outputNodeId: asyncBranch.id,
        outputId: 'output1' as PortId,
        inputNodeId: dataBus.id,
        inputId: 'input1' as PortId,
      }),
      makeBaseConnection({
        outputNodeId: foregroundSource.id,
        outputId: 'output' as PortId,
        inputNodeId: dataBus.id,
        inputId: 'input2' as PortId,
      }),
      makeBaseConnection({
        outputNodeId: dataBus.id,
        outputId: 'output2' as PortId,
        inputNodeId: graphOutput.id,
        inputId: 'value' as PortId,
      }),
    ],
    nodesById: {
      [asyncBranch.id]: asyncBranch,
      [foregroundSource.id]: foregroundSource,
      [dataBus.id]: dataBus,
      [graphOutput.id]: graphOutput,
    },
  });

  assert.equal(violation, undefined);
});

test('getAsyncBranchTopologyViolation reports an external input into an async descendant', () => {
  const source = makeTextNode('source');
  const asyncBranch = makeStartAsyncBranchNode('async');
  const asyncChild = makeTextNode('async-child', '{{asyncValue}}{{externalValue}}');
  const externalSource = makeTextNode('external-source');
  const triggerConnection = makeBaseConnection({
    outputNodeId: source.id,
    outputId: 'output' as PortId,
    inputNodeId: asyncBranch.id,
    inputId: 'input1' as PortId,
  });
  const asyncConnection = makeBaseConnection({
    outputNodeId: asyncBranch.id,
    outputId: 'output1' as PortId,
    inputNodeId: asyncChild.id,
    inputId: 'asyncValue' as PortId,
  });
  const externalConnection = makeBaseConnection({
    outputNodeId: externalSource.id,
    outputId: 'output' as PortId,
    inputNodeId: asyncChild.id,
    inputId: 'externalValue' as PortId,
  });

  const violation = getAsyncBranchTopologyViolation({
    connections: [triggerConnection, asyncConnection, externalConnection],
    nodesById: {
      [source.id]: source,
      [asyncBranch.id]: asyncBranch,
      [asyncChild.id]: asyncChild,
      [externalSource.id]: externalSource,
    },
  });

  assert.equal(violation?.kind, 'externalInput');
  assert.equal(violation?.triggerNodeId, asyncBranch.id);
  assert.equal(violation?.nodeId, asyncChild.id);
  assert.equal(violation?.externalNodeId, externalSource.id);
});

test('getAsyncBranchTopologyViolation reports joining an async branch into a foreground node', () => {
  const source = makeTextNode('source');
  const asyncBranch = makeStartAsyncBranchNode('async');
  const foregroundSource = makeTextNode('foreground-source');
  const foregroundNode = makeTextNode('foreground-node', '{{foregroundValue}}{{asyncValue}}');
  const triggerConnection = makeBaseConnection({
    outputNodeId: source.id,
    outputId: 'output' as PortId,
    inputNodeId: asyncBranch.id,
    inputId: 'input1' as PortId,
  });
  const foregroundConnection = makeBaseConnection({
    outputNodeId: foregroundSource.id,
    outputId: 'output' as PortId,
    inputNodeId: foregroundNode.id,
    inputId: 'foregroundValue' as PortId,
  });
  const joinConnection = makeBaseConnection({
    outputNodeId: asyncBranch.id,
    outputId: 'output1' as PortId,
    inputNodeId: foregroundNode.id,
    inputId: 'asyncValue' as PortId,
  });

  const violation = getAsyncBranchTopologyViolation({
    connections: [triggerConnection, foregroundConnection, joinConnection],
    nodesById: {
      [source.id]: source,
      [asyncBranch.id]: asyncBranch,
      [foregroundSource.id]: foregroundSource,
      [foregroundNode.id]: foregroundNode,
    },
  });

  assert.equal(violation?.kind, 'externalInput');
  assert.equal(violation?.nodeId, foregroundNode.id);
  assert.equal(violation?.externalNodeId, foregroundSource.id);
});

test('getAsyncBranchTopologyViolation reports a route from an async descendant back to its trigger', () => {
  const source = makeTextNode('source', '{{feedback}}');
  const asyncBranch = makeStartAsyncBranchNode('async');
  const asyncChild = makeTextNode('async-child', '{{asyncValue}}');
  const triggerConnection = makeBaseConnection({
    outputNodeId: source.id,
    outputId: 'output' as PortId,
    inputNodeId: asyncBranch.id,
    inputId: 'input1' as PortId,
  });
  const asyncConnection = makeBaseConnection({
    outputNodeId: asyncBranch.id,
    outputId: 'output1' as PortId,
    inputNodeId: asyncChild.id,
    inputId: 'asyncValue' as PortId,
  });
  const feedbackConnection = makeBaseConnection({
    outputNodeId: asyncChild.id,
    outputId: 'output' as PortId,
    inputNodeId: source.id,
    inputId: 'feedback' as PortId,
  });

  const violation = getAsyncBranchTopologyViolation({
    connections: [triggerConnection, asyncConnection, feedbackConnection],
    nodesById: {
      [source.id]: source,
      [asyncBranch.id]: asyncBranch,
      [asyncChild.id]: asyncChild,
    },
  });

  assert.equal(violation?.kind, 'cycle');
  assert.equal(violation?.triggerNodeId, asyncBranch.id);
  assert.equal(violation?.nodeId, asyncBranch.id);
});

test('getAsyncBranchTopologyViolation ignores disabled async branches and Graph Outputs', () => {
  const asyncBranch = makeStartAsyncBranchNode('async');
  const graphOutput = makeGraphOutputNode('result', 'answer');
  const connection = makeBaseConnection({
    outputNodeId: asyncBranch.id,
    outputId: 'output1' as PortId,
    inputNodeId: graphOutput.id,
    inputId: 'value' as PortId,
  });

  asyncBranch.disabled = true;
  assert.deepEqual(
    getAsyncBranchTopologyViolation({
      connections: [connection],
      nodesById: {
        [asyncBranch.id]: asyncBranch,
        [graphOutput.id]: graphOutput,
      },
    }),
    undefined,
  );

  asyncBranch.disabled = false;
  graphOutput.disabled = true;
  assert.deepEqual(
    getAsyncBranchTopologyViolation({
      connections: [connection],
      nodesById: {
        [asyncBranch.id]: asyncBranch,
        [graphOutput.id]: graphOutput,
      },
    }),
    undefined,
  );
});
