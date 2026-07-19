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
