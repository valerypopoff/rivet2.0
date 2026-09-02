import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GraphProcessor, globalRivetNodeRegistry } from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

describe('GraphProcessor disabled upstream dependencies', () => {
  it('finishes after excluding a required-input consumer of a disabled node', async () => {
    const disabledSource = {
      id: 'disabled-source',
      type: 'expression',
      title: 'Disabled source',
      disabled: true,
      data: { expression: '({ name: "Ada" })' },
      visualData: { x: 0, y: 0, width: 250 },
    };
    const requiredTarget = {
      id: 'required-target',
      type: 'destructure',
      title: 'Required target',
      data: { paths: ['$.name'], pathPortIds: ['name'] },
      visualData: { x: 300, y: 0, width: 250 },
    };
    const graphOutput = {
      id: 'graph-output',
      type: 'graphOutput',
      title: 'Graph Output',
      data: { id: 'result', dataType: 'string' },
      visualData: { x: 600, y: 0, width: 250 },
    };
    const graph = {
      metadata: { id: 'disabled-upstream-required-input', name: 'Disabled upstream required input', description: '' },
      nodes: [disabledSource, requiredTarget, graphOutput],
      connections: [
        {
          outputNodeId: disabledSource.id,
          outputId: 'output',
          inputNodeId: requiredTarget.id,
          inputId: 'object',
        },
        {
          outputNodeId: requiredTarget.id,
          outputId: 'name',
          inputNodeId: graphOutput.id,
          inputId: 'value',
        },
      ],
    };
    const project = {
      metadata: { id: 'project', title: 'Project', description: '', mainGraphId: graph.metadata.id },
      graphs: { [graph.metadata.id]: graph },
      plugins: [],
    };
    const processor = new GraphProcessor(project as any, graph.metadata.id as any, globalRivetNodeRegistry);
    const excludedNodes: Array<{ nodeId: string; reason: string }> = [];

    processor.on('nodeExcluded', ({ node, reason }) => {
      excludedNodes.push({ nodeId: node.id, reason });
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(excludedNodes, [
      { nodeId: disabledSource.id, reason: 'disabled' },
      { nodeId: requiredTarget.id, reason: 'input is excluded value' },
    ]);
    assert.deepEqual(outputs.result, { type: 'control-flow-excluded', value: undefined });
  });
});
