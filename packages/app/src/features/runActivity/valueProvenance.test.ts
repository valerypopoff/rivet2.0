import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChartNode,
  GraphId,
  GraphRunId,
  NodeGraph,
  NodeId,
  PortId,
  ProcessId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../../state/dataFlow.js';
import type { RunActivityNodeInvocation, RunActivityRoot } from './runActivityJournal.js';
import { buildValueProvenanceReport } from './valueProvenance.js';

const rootRunId = 'root' as RootRunId;
const graphId = 'graph' as GraphId;
const graphRunId = 'graph-run' as GraphRunId;

test('explains a connected value through the latest compatible producer invocation', () => {
  const source = node('source', 'Source');
  const transform = node('transform', 'Transform');
  const target = node('target', 'Target');
  const graph = graphOf(
    [source, transform, target],
    [connection('source', 'output', 'transform', 'input'), connection('transform', 'output', 'target', 'input')],
  );
  const sourceInvocation = invocation('source-process', 'source', 1, [], ['output']);
  const transformInvocation = invocation('transform-process', 'transform', 2, ['input'], ['output']);
  const targetInvocation = invocation('target-process', 'target', 3, ['input'], []);
  const report = buildValueProvenanceReport({
    graph,
    root: rootOf([sourceInvocation, transformInvocation, targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'source-process': { nodeId: source.id, outputData: { output: 'source value' } },
      'transform-process': {
        nodeId: transform.id,
        inputData: { input: 'source value' },
        outputData: { output: 'mapped value' },
      },
      'target-process': { nodeId: target.id, inputData: { input: 'mapped value' } },
    }),
  });

  assert.equal(report.inputs.length, 1);
  assert.equal(report.inputs[0]?.state, 'connected');
  assert.equal(report.inputs[0]?.valuePreview, 'mapped value');
  assert.equal(report.inputs[0]?.source?.nodeTitle, 'Transform');
  assert.equal(report.inputs[0]?.source?.processId, 'transform-process');
  assert.equal(report.inputs[0]?.source?.inputs?.[0]?.source?.nodeTitle, 'Source');
});

test('uses the latest producer before the consumer when a source node has repeated invocations', () => {
  const source = node('source', 'Source');
  const target = node('target', 'Target');
  const first = invocation('source-first', 'source', 1, [], ['output']);
  const second = invocation('source-second', 'source', 4, [], ['output']);
  const targetInvocation = invocation('target-process', 'target', 5, ['input'], []);
  const report = buildValueProvenanceReport({
    graph: graphOf([source, target], [connection('source', 'output', 'target', 'input')]),
    root: rootOf([first, second, targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'source-first': { nodeId: source.id, outputData: { output: 'old' } },
      'source-second': { nodeId: source.id, outputData: { output: 'new' } },
      'target-process': { nodeId: target.id, inputData: { input: 'new' } },
    }),
  });

  assert.equal(report.inputs[0]?.source?.processId, 'source-second');
});

test('uses the invocation-time wiring snapshot when the graph was changed after the run', () => {
  const recordedSource = node('recorded-source', 'Recorded source');
  const currentSource = node('current-source', 'Current source');
  const target = node('target', 'Target');
  const recordedInvocation = invocation('recorded-process', 'recorded-source', 1, [], ['output']);
  const currentInvocation = invocation('current-process', 'current-source', 2, [], ['output']);
  const targetInvocation = invocation('target-process', 'target', 3, ['input'], []);
  targetInvocation.inputConnections = [connection('recorded-source', 'output', 'target', 'input')];

  const report = buildValueProvenanceReport({
    graph: graphOf(
      [recordedSource, currentSource, target],
      [connection('current-source', 'output', 'target', 'input')],
    ),
    root: rootOf([recordedInvocation, currentInvocation, targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'recorded-process': { nodeId: recordedSource.id, outputData: { output: 'recorded' } },
      'current-process': { nodeId: currentSource.id, outputData: { output: 'current' } },
      'target-process': { nodeId: target.id, inputData: { input: 'recorded' } },
    }),
  });

  assert.equal(report.inputs[0]?.source?.nodeTitle, 'Recorded source');
  assert.equal(report.partialReason, undefined);
});

test('resolves Data Bus channels to their effective provider', () => {
  const source = node('source', 'Source');
  const bus = { ...node('bus', 'Bus'), type: 'dataBus', data: {} } as ChartNode;
  const target = node('target', 'Target');
  const sourceInvocation = invocation('source-process', 'source', 1, [], ['output']);
  const targetInvocation = invocation('target-process', 'target', 2, ['input'], []);
  const report = buildValueProvenanceReport({
    graph: graphOf(
      [source, bus, target],
      [connection('source', 'output', 'bus', 'input1'), connection('bus', 'output1', 'target', 'input')],
    ),
    root: rootOf([sourceInvocation, targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'source-process': { nodeId: source.id, outputData: { output: 'through bus' } },
      'target-process': { nodeId: target.id, inputData: { input: 'through bus' } },
    }),
  });

  assert.equal(report.inputs[0]?.source?.nodeTitle, 'Source');
  assert.equal(report.inputs[0]?.source?.outputPortId, 'output');
});

test('labels unwired values and unavailable producer records without guessing', () => {
  const source = node('source', 'Source');
  const target = node('target', 'Target');
  const targetInvocation = invocation('target-process', 'target', 2, ['configured', 'connected'], []);
  const report = buildValueProvenanceReport({
    graph: graphOf([source, target], [connection('source', 'output', 'target', 'connected')]),
    root: rootOf([targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'target-process': { nodeId: target.id, inputData: { configured: 'local', connected: 'missing producer' } },
    }),
  });

  assert.equal(report.inputs.find((input) => input.inputPortId === 'configured')?.state, 'unconnected');
  assert.equal(
    report.inputs.find((input) => input.inputPortId === 'connected')?.state,
    'source-invocation-unavailable',
  );
});

test('does not preview values from credential-like input ports', () => {
  const target = node('target', 'Target');
  const targetInvocation = invocation('target-process', 'target', 1, ['apiKey'], []);
  const report = buildValueProvenanceReport({
    graph: graphOf([target], []),
    root: rootOf([targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'target-process': { nodeId: target.id, inputData: { apiKey: 'must-not-be-previewed' } },
    }),
  });

  assert.equal(report.inputs[0]?.valuePreview, undefined);
  assert.equal(report.inputs[0]?.valuePreviewRedacted, true);
});

test('does not mistake ordinary author inputs for authentication inputs', () => {
  const target = node('target', 'Target');
  const targetInvocation = invocation('target-process', 'target', 1, ['author'], []);
  const report = buildValueProvenanceReport({
    graph: graphOf([target], []),
    root: rootOf([targetInvocation]),
    target: targetInvocation,
    runDataByNode: runData({
      'target-process': { nodeId: target.id, inputData: { author: 'Octavia Butler' } },
    }),
  });

  assert.equal(report.inputs[0]?.valuePreview, 'Octavia Butler');
  assert.equal(report.inputs[0]?.valuePreviewRedacted, undefined);
});

function node(id: string, title: string): ChartNode {
  return {
    id: id as NodeId,
    type: 'test',
    title,
    visualData: { x: 0, y: 0 },
    data: {},
  };
}

function connection(outputNodeId: string, outputId: string, inputNodeId: string, inputId: string) {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}

function graphOf(nodes: ChartNode[], connections: ReturnType<typeof connection>[]): NodeGraph {
  return { metadata: { id: graphId, name: 'Test graph' }, nodes, connections };
}

function invocation(
  process: string,
  nodeId: string,
  sequence: number,
  inputPortIds: string[],
  outputPortIds: string[],
): RunActivityNodeInvocation {
  return {
    key: `${nodeId}:${process}` as RunActivityNodeInvocation['key'],
    sequence,
    rootRunId,
    graphId,
    graphRunId,
    nodeId: nodeId as NodeId,
    processId: process as ProcessId,
    status: 'completed',
    resultOrigin: 'executed',
    inputPortIds: inputPortIds as PortId[],
    outputPortIds: outputPortIds as PortId[],
    splitOutputPortIds: {},
    splitOutputIndices: [],
    partialOutputCount: 0,
    outputRevision: 1,
    outputsAvailable: true,
    modelCalls: [],
    toolCalls: [],
    modelCallCount: 0,
    toolCallCount: 0,
    omittedModelCallCount: 0,
    omittedToolCallCount: 0,
  };
}

function rootOf(invocations: RunActivityNodeInvocation[]): RunActivityRoot {
  return {
    sequence: 0,
    rootRunId,
    status: 'completed',
    paused: false,
    isPartial: false,
    graphRunsById: {},
    graphRunOrder: [],
    nodeInvocationsByKey: Object.fromEntries(invocations.map((item) => [item.key, item])),
    nodeInvocationOrder: invocations.map((item) => item.key),
    omittedNodeInvocationCount: 0,
    omittedLegacyEventCount: 0,
  };
}

function runData(
  values: Record<string, { nodeId: NodeId; inputData?: Record<string, string>; outputData?: Record<string, string> }>,
): RunDataByNodeId {
  const result: RunDataByNodeId = {};
  for (const [processId, value] of Object.entries(values)) {
    result[value.nodeId] ??= [];
    result[value.nodeId]!.push({
      processId: processId as ProcessId,
      rootRunId,
      graphRunId,
      graphId,
      data: {
        ...(value.inputData
          ? {
              inputData: Object.fromEntries(
                Object.entries(value.inputData).map(([key, entry]) => [key, stored(entry)]),
              ),
            }
          : {}),
        ...(value.outputData
          ? {
              outputData: Object.fromEntries(
                Object.entries(value.outputData).map(([key, entry]) => [key, stored(entry)]),
              ),
            }
          : {}),
      },
    });
  }
  return result;
}

function stored(value: string) {
  return { type: 'string' as const, storage: 'inline' as const, value };
}
