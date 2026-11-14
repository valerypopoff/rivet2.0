import {
  CodeNodeImpl,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  TextNodeImpl,
  StartBackgroundBranchNodeImpl,
  SetStoredValueNodeImpl,
  type GraphId,
  type Project,
  type ProjectId,
  type PortId,
  type UiGraphId,
  type UiComponentId,
} from '@valerypopoff/rivet2-node';

/** Generated local projects only; no credentials, provider or remote IO nodes. */
export function isolationFixture(code?: string, nodes = 1, graphId = 'isolation-main' as GraphId): Project {
  const uiGraphId = `${graphId}-ui` as UiGraphId;
  const input = GraphInputNodeImpl.create();
  input.data.id = 'input';
  input.data.dataType = 'any';
  const output = GraphOutputNodeImpl.create();
  output.data.id = 'output';
  output.data.dataType = 'any';
  const graph: Project['graphs'][GraphId] = {
    metadata: { id: graphId, name: 'Isolation fixture', description: '' },
    nodes: [input],
    connections: [],
  };
  let source = input.id;
  let port = 'data';
  if (code === undefined) {
    const text = TextNodeImpl.create();
    text.data.text = 'no-Code fixture';
    graph.nodes.push(text);
    source = text.id;
    port = 'output';
  } else {
    for (let index = 0; index < nodes; index++) {
      const node = CodeNodeImpl.create();
      node.data.code = code;
      node.data.inputNames = ['input'];
      node.data.outputNames = ['result'];
      graph.nodes.push(node);
      graph.connections.push({
        outputNodeId: source,
        outputId: port as PortId,
        inputNodeId: node.id,
        inputId: 'input' as PortId,
      });
      source = node.id;
      port = 'result';
    }
  }
  graph.nodes.push(output);
  graph.connections.push({
    outputNodeId: source,
    outputId: port as PortId,
    inputNodeId: output.id,
    inputId: 'value' as PortId,
  });
  return {
    metadata: {
      id: 'isolation-fixture' as ProjectId,
      title: 'Isolation fixture',
      description: '',
      mainGraphId: graphId,
    },
    graphs: { [graphId]: graph },
    uiGraphs: {
      [uiGraphId]: {
        id: uiGraphId,
        name: 'Isolation UI fixture',
        components: [
          {
            id: 'run' as UiComponentId,
            type: 'button',
            label: 'Run',
            action: {
              type: 'runGraph',
              graphId,
              inputs: { input: { type: 'state', key: 'input' } },
              outputKey: 'output',
              outputStateKey: 'result',
            },
          },
        ],
      },
    },
  };
}

export const IDENTITY_CODE = 'return { result: { type: "any", value: inputs.input.value } };';

/** Route the output of an identity fixture through the actual host-store node. */
export function addIsolationStoredValue(project: Project, graphId: GraphId): void {
  const graph = project.graphs[graphId]!;
  const output = graph.nodes.find((node) => node.type === 'graphOutput')!;
  const store = SetStoredValueNodeImpl.create();
  store.data.key = 'fixture';
  store.data.dataType = 'any';
  graph.connections.find((connection) => connection.inputNodeId === output.id)!.inputNodeId = store.id;
  graph.nodes.push(store);
  graph.connections.push({
    outputNodeId: store.id,
    outputId: 'saved-value' as PortId,
    inputNodeId: output.id,
    inputId: 'value' as PortId,
  });
}

/** Attach real managed background work to a generated input/output fixture. */
export function addIsolationTail(project: Project, graphId: GraphId, code: string): void {
  const graph = project.graphs[graphId]!;
  const gate = StartBackgroundBranchNodeImpl.create();
  const tail = CodeNodeImpl.create();
  tail.data.inputNames = ['input'];
  tail.data.outputNames = ['result'];
  tail.data.code = code;
  graph.nodes.push(gate, tail);
  graph.connections.push(
    { outputNodeId: graph.nodes[0]!.id, outputId: 'data' as PortId, inputNodeId: gate.id, inputId: 'input1' as PortId },
    { outputNodeId: gate.id, outputId: 'output1' as PortId, inputNodeId: tail.id, inputId: 'input' as PortId },
  );
}
