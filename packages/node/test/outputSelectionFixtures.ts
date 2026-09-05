import type { ChartNode, GraphId, NodeConnection, NodeId, PortId, Project, ProjectId } from '../src/index.js';

/** Both child branches share a source, exercising pruning beyond initial terminal selection. */
export function makeUnusedOutputProject(skipUnusedOutputs: boolean, unusedBranchLength = 40) {
  const graphId = 'output-selection-main' as GraphId;
  const childGraphId = 'output-selection-child' as GraphId;
  const childNodes: ChartNode[] = [
    node('text', 'shared-source', { text: 'shared' }),
    node('text', 'wanted-text', { text: '{{input}} wanted' }),
    node('graphOutput', 'wanted-output', { id: 'wanted', dataType: 'string' }),
    node('graphOutput', 'unused-output', { id: 'unused', dataType: 'string' }),
  ];
  const childConnections = [
    connection('shared-source', 'output', 'wanted-text', 'input'),
    connection('wanted-text', 'output', 'wanted-output', 'value'),
  ];
  let previousNodeId = 'shared-source';
  for (let index = 0; index < unusedBranchLength; index++) {
    const id = `unused-text-${index}`;
    childNodes.push(node('text', id, { text: '{{input}} unused' }));
    childConnections.push(connection(previousNodeId, 'output', id, 'input'));
    previousNodeId = id;
  }
  childConnections.push(connection(previousNodeId, 'output', 'unused-output', 'value'));
  const project: Project = {
    metadata: {
      id: 'output-selection-project' as ProjectId,
      title: 'Output selection',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Output selection' },
        nodes: [
          node('subGraph', 'subgraph', { graphId: childGraphId, skipUnusedOutputs }),
          node('graphOutput', 'result-output', { id: 'result', dataType: 'string' }),
        ],
        connections: [connection('subgraph', 'wanted', 'result-output', 'value')],
      },
      [childGraphId]: {
        metadata: { id: childGraphId, name: 'Output selection child' },
        nodes: childNodes,
        connections: childConnections,
      },
    },
    plugins: [],
  };

  return {
    project,
    graphId,
    childGraphId,
    // Three demanded child nodes and two parent nodes execute with selection enabled.
    expectedNodeStarts: skipUnusedOutputs ? 5 : unusedBranchLength + 6,
  };
}

/** Every child output is demanded, so selection adds overhead without eliminating any execution. */
export function makeSharedOutputProject(skipUnusedOutputs: boolean) {
  const fixture = makeUnusedOutputProject(skipUnusedOutputs, 0);
  const main = fixture.project.graphs[fixture.graphId]!;
  main.nodes.push(node('graphOutput', 'other-output', { id: 'other', dataType: 'string' }));
  main.connections.push(connection('subgraph', 'unused', 'other-output', 'value'));
  fixture.expectedNodeStarts = 7;
  return fixture;
}

/** Models an expensive unused operation with a local timer and no network or provider calls. */
export function makeDelayedUnusedOutputProject(skipUnusedOutputs: boolean, delayMs: number) {
  const fixture = makeUnusedOutputProject(skipUnusedOutputs, 0);
  const child = fixture.project.graphs[fixture.childGraphId]!;
  child.nodes.push(node('delay', 'unused-delay', { delay: delayMs }));
  child.connections = child.connections.filter((value) => value.inputNodeId !== 'unused-output');
  child.connections.push(
    connection('shared-source', 'output', 'unused-delay', 'input1'),
    connection('unused-delay', 'output1', 'unused-output', 'value'),
  );
  fixture.expectedNodeStarts = skipUnusedOutputs ? 5 : 7;
  return fixture;
}

function node(type: string, id: string, data: Record<string, unknown>): ChartNode {
  return { type, id: id as NodeId, title: id, data, visualData: { x: 0, y: 0 } };
}

function connection(from: string, outputId: string, to: string, inputId: string): NodeConnection {
  return {
    outputNodeId: from as NodeId,
    outputId: outputId as PortId,
    inputNodeId: to as NodeId,
    inputId: inputId as PortId,
  };
}
