import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { NodeGraph, Project } from '../../src/index.js';
import {
  deserializeGraph,
  deserializeProject,
  serializeGraph,
  serializeProject,
} from '../../src/utils/serialization/serialization.js';
import { prepareSerializedInput } from '../../src/utils/serialization/serializationInput.js';
import { projectV2Deserializer } from '../../src/utils/serialization/serialization_v2.js';
import { graphV3Serializer } from '../../src/utils/serialization/serialization_v3.js';
import { projectV4Deserializer } from '../../src/utils/serialization/serialization_v4.js';
import { detectSerializationVersion, validateProject } from '../../src/utils/serialization/serializationUtils.js';
import {
  serializeConnection,
  deserializeConnection,
  parseVisualData,
  packVisualDataV3,
  packVisualDataV4,
} from '../../src/utils/serialization/serializationHelpers.js';

const baseGraph: NodeGraph = {
  metadata: {
    id: 'graph-1',
    name: 'Main Graph',
    description: 'Test graph',
  },
  nodes: [
    {
      id: 'node-1',
      type: 'graphInput',
      title: 'Input',
      visualData: {
        x: 10,
        y: 20,
        width: 140,
        zIndex: 1,
      },
      data: {},
      variants: [],
    },
  ],
  connections: [],
};

const baseProject: Project = {
  metadata: {
    id: 'project-1',
    title: 'Serialization Test',
    description: 'Project fixture',
  },
  graphs: {
    'graph-1': baseGraph,
  },
  plugins: [],
  references: [],
};

const v1Project = JSON.stringify(baseProject);

const v2Project = `version: 2
data:
  metadata:
    id: project-1
    title: Serialization Test
    description: Project fixture
  graphs:
    graph-1:
      metadata:
        id: graph-1
        name: Main Graph
        description: Test graph
      nodes:
        - id: node-1
          type: graphInput
          title: Input
          visualData:
            x: 10
            y: 20
            width: 140
            zIndex: 1
          data: {}
          variants: []
      connections: []
`;

const v3Project = `version: 3
data:
  metadata:
    id: project-1
    title: Serialization Test
    description: Project fixture
  graphs:
    graph-1:
      metadata:
        id: graph-1
        name: Main Graph
        description: Test graph
      nodes:
        node-1:
          id: node-1
          type: graphInput
          title: Input
          visualData: 10/20/140/1
          outgoingConnections: []
`;

const v1Graph = JSON.stringify(baseGraph);

const v2Graph = `version: 2
data:
  metadata:
    id: graph-1
    name: Main Graph
    description: Test graph
  nodes:
    - id: node-1
      type: graphInput
      title: Input
      visualData:
        x: 10
        y: 20
        width: 140
        zIndex: 1
      data: {}
      variants: []
  connections: []
`;

const v3Graph = `version: 3
data:
  metadata:
    id: graph-1
    name: Main Graph
    description: Test graph
  nodes:
    node-1:
      id: node-1
      type: graphInput
      title: Input
      visualData: 10/20/140/1
      outgoingConnections: []
`;

const v4Graph = `version: 4
data:
  metadata:
    id: graph-1
    name: Main Graph
    description: Test graph
  nodes:
    "[node-1]:graphInput \\"Input\\"":
      visualData: 10/20/140/1//
`;

const v4GraphJson = JSON.stringify({
  version: 4,
  data: {
    metadata: {
      id: 'graph-1',
      name: 'Main Graph',
      description: 'Test graph',
    },
    nodes: {
      '[node-1]:graphInput "Input"': {
        visualData: '10/20/140/1//',
      },
    },
  },
});

const v4SplitGraphWithoutConcurrency = `version: 4
data:
  metadata:
    id: graph-1
    name: Main Graph
    description: Test graph
  nodes:
    "[node-1]:text \\"Text\\"":
      visualData: 10/20/140/1//
      isSplitRun: true
      splitRunMax: 7
      data:
        text: hello
`;

describe('serialization compatibility', () => {
  it('detects legacy and current serialization versions explicitly', () => {
    assert.equal(detectSerializationVersion(v1Project), 1);
    assert.equal(detectSerializationVersion(v2Project), 2);
    assert.equal(detectSerializationVersion(v3Project), 3);
    assert.equal(detectSerializationVersion(v4Graph), 4);
  });

  it('prepares versioned YAML once while preserving legacy fallback inputs', () => {
    const preparedV4 = prepareSerializedInput(v4Graph);
    const preparedV1 = prepareSerializedInput(v1Project);
    const preparedYamlWithoutVersion = prepareSerializedInput('metadata:\n  id: legacy-yaml');
    const preparedUnsupportedVersion = prepareSerializedInput('version: 5\ndata: {}');

    assert.equal(preparedV4.version, 4);
    assert.equal(typeof preparedV4.deserializerInput, 'object');
    assert.notEqual(preparedV4.deserializerInput, v4Graph);

    assert.equal(preparedV1.version, 1);
    assert.equal(preparedV1.deserializerInput, v1Project);

    assert.equal(preparedYamlWithoutVersion.version, 1);
    assert.equal(preparedYamlWithoutVersion.deserializerInput, 'metadata:\n  id: legacy-yaml');

    assert.equal(preparedUnsupportedVersion.version, 1);
    assert.equal(preparedUnsupportedVersion.deserializerInput, 'version: 5\ndata: {}');
  });

  it('deserializes project formats v1 through v4', () => {
    const [projectV1] = deserializeProject(v1Project);
    const [projectV2] = deserializeProject(v2Project);
    const [projectV3] = deserializeProject(v3Project);
    const [projectV4, attachedDataV4] = deserializeProject(
      serializeProject(baseProject, { pluginState: { enabled: true } }) as string,
    );

    assert.equal(projectV1.metadata.title, baseProject.metadata.title);
    assert.equal(projectV2.metadata.title, baseProject.metadata.title);
    assert.equal(projectV3.metadata.title, baseProject.metadata.title);
    assert.equal(projectV4.metadata.title, baseProject.metadata.title);
    assert.deepEqual(attachedDataV4, { pluginState: { enabled: true } });
  });

  it('deserializes graph formats v1 through v4', () => {
    const graph1 = deserializeGraph(v1Graph);
    const graph2 = deserializeGraph(v2Graph);
    const graph3 = deserializeGraph(v3Graph);
    const graph4 = deserializeGraph(v4Graph);

    for (const graph of [graph1, graph2, graph3, graph4]) {
      assert.equal(graph.metadata?.id, 'graph-1');
      assert.equal(graph.nodes[0]?.id, 'node-1');
      assert.equal(graph.nodes[0]?.title, 'Input');
      assert.equal(graph.connections.length, 0);
    }
  });

  it('deserializes versioned JSON envelopes through the prepared input path', () => {
    assert.equal(detectSerializationVersion(v4GraphJson), 4);

    const graph = deserializeGraph(v4GraphJson);

    assert.equal(graph.metadata?.id, 'graph-1');
    assert.equal(graph.nodes[0]?.id, 'node-1');
    assert.equal(graph.nodes[0]?.title, 'Input');
    assert.equal(graph.connections.length, 0);
  });

  it('does not accept parsed arrays as versioned envelopes', () => {
    assert.throws(() => projectV2Deserializer([]), /Project v2 deserializer requires a string/);
    assert.throws(() => projectV4Deserializer([]), /Project v4 deserializer requires a string/);
  });

  it('serializes V3 graphs with a V3 envelope', () => {
    const serialized = graphV3Serializer(baseGraph) as string;

    assert.equal(detectSerializationVersion(serialized), 3);
  });

  it('deserializes older split-run nodes without per-node concurrency', () => {
    const graph = deserializeGraph(v4SplitGraphWithoutConcurrency);
    const node = graph.nodes[0]!;

    assert.equal(node.isSplitRun, true);
    assert.equal(node.splitRunMax, 7);
    assert.equal(node.splitRunConcurrency, undefined);
  });

  it('round-trips project through V4 serialize/deserialize', () => {
    const projectWithConnections: Project = {
      metadata: {
        id: 'project-rt',
        title: 'Round Trip Test',
        description: 'Tests round-trip fidelity',
      },
      graphs: {
        'graph-rt': {
          metadata: { id: 'graph-rt', name: 'RT Graph', description: '' },
          nodes: [
            {
              id: 'n1',
              type: 'text',
              title: 'Text Node',
              isSplitRun: true,
              splitRunMax: 7,
              splitRunConcurrency: 3,
              visualData: { x: 100, y: 200, width: 300, zIndex: 5, color: { border: '#ff0000', bg: '#00ff00' } },
              data: { text: 'hello' },
              variants: [],
            },
            {
              id: 'n2',
              type: 'prompt',
              title: 'Prompt Node',
              visualData: { x: 400, y: 500 },
              data: {},
              variants: [],
            },
          ],
          connections: [{ outputNodeId: 'n1', outputId: 'output', inputNodeId: 'n2', inputId: 'input' }],
        },
      },
      plugins: [],
      references: [],
    };

    const attachedData = { custom: { key: 'value' } };
    const serialized = serializeProject(projectWithConnections, attachedData) as string;
    const [deserialized, deserializedAttached] = deserializeProject(serialized);

    assert.equal(deserialized.metadata.id, 'project-rt');
    assert.equal(deserialized.metadata.title, 'Round Trip Test');
    assert.deepEqual(deserializedAttached, attachedData);

    const graph = deserialized.graphs['graph-rt']!;
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.connections.length, 1);

    const n1 = graph.nodes.find((n) => n.id === 'n1')!;
    assert.equal(n1.visualData.x, 100);
    assert.equal(n1.isSplitRun, true);
    assert.equal(n1.splitRunMax, 7);
    assert.equal(n1.splitRunConcurrency, 3);
    assert.equal(n1.visualData.color?.border, '#ff0000');
    assert.equal(n1.visualData.color?.bg, '#00ff00');
    assert.deepEqual(n1.data, { text: 'hello' });

    const conn = graph.connections[0]!;
    assert.equal(conn.outputNodeId, 'n1');
    assert.equal(conn.inputNodeId, 'n2');
  });

  it('round-trips Subgraph manual port order fields through V4 project serialization', () => {
    const project: Project = {
      metadata: {
        id: 'project-subgraph-order',
        title: 'Subgraph Order Test',
        description: '',
      },
      graphs: {
        'main-graph': {
          metadata: { id: 'main-graph', name: 'Main Graph', description: '' },
          nodes: [
            {
              id: 'subgraph-node',
              type: 'subGraph',
              title: 'Subgraph',
              visualData: { x: 0, y: 0 },
              data: {
                graphId: 'child-graph',
                inputPortOrder: ['second', 'first'],
                outputPortOrder: ['result-b', 'result-a'],
              },
              variants: [],
            },
          ],
          connections: [],
        },
        'child-graph': {
          metadata: { id: 'child-graph', name: 'Child Graph', description: '' },
          nodes: [],
          connections: [],
        },
      },
      plugins: [],
      references: [],
    };

    const [deserialized] = deserializeProject(serializeProject(project) as string);
    const subgraph = deserialized.graphs['main-graph']!.nodes[0]!;

    assert.deepEqual((subgraph.data as Record<string, unknown>).inputPortOrder, ['second', 'first']);
    assert.deepEqual((subgraph.data as Record<string, unknown>).outputPortOrder, ['result-b', 'result-a']);
  });

  it('round-trips library nodes through V4 project serialization', () => {
    const project: Project = {
      metadata: {
        id: 'project-node-prefabs',
        title: 'Node Prefab Test',
        description: '',
      },
      graphs: {
        'main-graph': {
          metadata: { id: 'main-graph', name: 'Main Graph', description: '' },
          nodes: [
            {
              id: 'instance-node',
              type: 'nodePrefabInstance',
              title: 'Linked Text',
              visualData: { x: 100, y: 200, width: 260 },
              data: { prefabId: 'prefab-text' },
            },
          ],
          connections: [],
        },
      },
      nodePrefabs: {
        'prefab-text': {
          id: 'prefab-text' as any,
          sourceNode: {
            id: 'source-node',
            type: 'text',
            title: 'Shared Text',
            visualData: { x: 0, y: 0, width: 240 },
            data: { text: 'hello from library' },
          },
        },
      },
      plugins: [],
      references: [],
    };

    const [deserialized] = deserializeProject(serializeProject(project) as string);

    assert.equal(deserialized.nodePrefabs?.['prefab-text']?.sourceNode.title, 'Shared Text');
    assert.deepEqual(deserialized.nodePrefabs?.['prefab-text']?.sourceNode.data, { text: 'hello from library' });
    assert.equal(deserialized.graphs['main-graph']?.nodes[0]?.type, 'nodePrefabInstance');
    assert.deepEqual(deserialized.graphs['main-graph']?.nodes[0]?.data, { prefabId: 'prefab-text' });
  });

  it('round-trips UI graphs through V4 project serialization', () => {
    const project: Project = {
      metadata: {
        id: 'project-ui-graphs',
        title: 'UI Graph Test',
        description: '',
      },
      graphs: {
        'main-graph': {
          metadata: { id: 'main-graph', name: 'Main Graph', description: '' },
          nodes: [],
          connections: [],
        },
      },
      uiGraphs: {
        'ui-graph-1': {
          id: 'ui-graph-1' as any,
          name: 'Simple web app',
          description: 'A tiny UI',
          components: [
            {
              id: 'ui-component-1' as any,
              type: 'button',
              label: 'Run',
              action: {
                type: 'runGraph',
                graphId: 'main-graph' as any,
                inputs: {
                  input: { type: 'state', key: 'prompt' },
                },
                outputKey: 'graphOutput',
                outputStateKey: 'result',
              },
            },
            {
              id: 'ui-component-2' as any,
              type: 'gap',
              size: 'large',
            },
          ],
        },
      },
      plugins: [],
      references: [],
    };

    const [deserialized] = deserializeProject(serializeProject(project) as string);

    assert.equal(deserialized.uiGraphs?.['ui-graph-1']?.name, 'Simple web app');
    assert.deepEqual(
      deserialized.uiGraphs?.['ui-graph-1']?.components[0],
      project.uiGraphs?.['ui-graph-1']?.components[0],
    );
    assert.deepEqual(
      deserialized.uiGraphs?.['ui-graph-1']?.components[1],
      project.uiGraphs?.['ui-graph-1']?.components[1],
    );
  });

  it('repairs missing and duplicate UI component IDs from legacy V4 projects', () => {
    const serializedLegacyProject = JSON.stringify({
      version: 4,
      data: {
        metadata: {
          id: 'project-legacy-ui',
          title: 'Legacy UI project',
          description: '',
        },
        graphs: {},
        uiGraphs: {
          'legacy-ui': {
            id: 'legacy-ui',
            name: 'Legacy app',
            components: [
              { type: 'text', text: 'Missing ID' },
              { id: 'shared-id', type: 'text', text: 'First shared ID' },
              { id: 'shared-id', type: 'text', text: 'Duplicate shared ID' },
            ],
          },
        },
      },
    });

    const [project] = deserializeProject(serializedLegacyProject);
    const components = project.uiGraphs?.['legacy-ui' as any]?.components ?? [];

    assert.deepEqual(
      components.map((component) => component.id),
      ['legacy-ui-component-1', 'shared-id', 'legacy-ui-component-3'],
    );
    assert.equal(new Set(components.map((component) => component.id)).size, components.length);
    assert.equal(validateProject(project).valid, true);
  });

  it('reports invalid UI component IDs before migration', () => {
    const result = validateProject({
      metadata: { id: 'project-invalid-ui', title: 'Invalid UI project' },
      graphs: {},
      uiGraphs: {
        'invalid-ui': {
          id: 'invalid-ui',
          name: 'Invalid app',
          components: [
            { id: 'same', type: 'text' },
            { id: 'same', type: 'text' },
          ],
        },
      },
    });

    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /duplicate id/);
  });

  it('deserializes old-style Subgraph nodes without manual port order fields', () => {
    const graph: NodeGraph = {
      metadata: { id: 'g-old-subgraph', name: 'Old Subgraph', description: '' },
      nodes: [
        {
          id: 'subgraph-node',
          type: 'subGraph',
          title: 'Subgraph',
          visualData: { x: 0, y: 0 },
          data: {
            graphId: 'child-graph',
          },
          variants: [],
        },
      ],
      connections: [],
    };

    const deserialized = deserializeGraph(serializeGraph(graph));
    const subgraph = deserialized.nodes[0]!;

    assert.equal((subgraph.data as Record<string, unknown>).inputPortOrder, undefined);
    assert.equal((subgraph.data as Record<string, unknown>).outputPortOrder, undefined);
  });

  it('round-trips graph through V4 serialize/deserialize', () => {
    const graph: NodeGraph = {
      metadata: { id: 'g1', name: 'Test', description: '' },
      nodes: [
        { id: 'a', type: 'text', title: 'A', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
        {
          id: 'b',
          type: 'text',
          title: 'B',
          visualData: { x: 1, y: 1, width: 200, zIndex: 3 },
          data: {},
          variants: [],
        },
      ],
      connections: [{ outputNodeId: 'a', outputId: 'out', inputNodeId: 'b', inputId: 'in' }],
    };

    const serialized = serializeGraph(graph) as string;
    const deserialized = deserializeGraph(serialized);

    assert.equal(deserialized.nodes.length, 2);
    assert.equal(deserialized.connections.length, 1);
    assert.equal(deserialized.connections[0]!.outputNodeId, 'a');
    assert.equal(deserialized.connections[0]!.inputNodeId, 'b');
  });

  it('round-trips V4 graphs with empty node titles', () => {
    const graph: NodeGraph = {
      metadata: { id: 'g-empty-title', name: 'Test', description: '' },
      nodes: [
        { id: 'a', type: 'text', title: 'Named', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
        { id: 'b', type: 'text', title: '', visualData: { x: 1, y: 1 }, data: {}, variants: [] },
      ],
      connections: [{ outputNodeId: 'a', outputId: 'out', inputNodeId: 'b', inputId: 'in' }],
    };

    const serialized = serializeGraph(graph) as string;
    const deserialized = deserializeGraph(serialized);

    assert.equal(deserialized.nodes.find((node) => node.id === 'b')?.title, '');
    assert.equal(deserialized.connections.length, 1);
    assert.equal(deserialized.connections[0]!.inputNodeId, 'b');
  });

  it('renames only default Code node titles when deserializing', () => {
    const graph: NodeGraph = {
      metadata: { id: 'g-code-rename', name: 'Code Rename', description: '' },
      nodes: [
        { id: 'legacy-default', type: 'code', title: 'Code', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
        {
          id: 'legacy-custom',
          type: 'code',
          title: 'Custom legacy title',
          visualData: { x: 1, y: 1 },
          data: {},
          variants: [],
        },
        {
          id: 'current-default',
          type: 'codeNew',
          title: 'Code new',
          visualData: { x: 2, y: 2 },
          data: {},
          variants: [],
        },
        {
          id: 'current-custom',
          type: 'codeNew',
          title: 'Custom current title',
          visualData: { x: 3, y: 3 },
          data: {},
          variants: [],
        },
      ],
      connections: [],
    };

    const deserialized = deserializeGraph(serializeGraph(graph));

    assert.equal(deserialized.nodes.find((node) => node.id === 'legacy-default')?.title, 'Code (legacy)');
    assert.equal(deserialized.nodes.find((node) => node.id === 'legacy-custom')?.title, 'Custom legacy title');
    assert.equal(deserialized.nodes.find((node) => node.id === 'current-default')?.title, 'Code');
    assert.equal(deserialized.nodes.find((node) => node.id === 'current-custom')?.title, 'Custom current title');
  });
});

describe('serialization helpers', () => {
  it('serializeConnection and deserializeConnection round-trip', () => {
    const nodes = [
      { id: 'n1', type: 'text', title: 'Source', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
      { id: 'n2', type: 'text', title: 'Target Node', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
    ] as any[];

    const connection = { outputNodeId: 'n1', outputId: 'out', inputNodeId: 'n2', inputId: 'in' } as any;
    const serialized = serializeConnection(connection, nodes);
    assert.equal(serialized, 'out->"Target Node" n2/in');

    const deserialized = deserializeConnection(serialized, 'n1' as any);
    assert.equal(deserialized.outputId, 'out');
    assert.equal(deserialized.outputNodeId, 'n1');
    assert.equal(deserialized.inputId, 'in');
    assert.equal(deserialized.inputNodeId, 'n2');
  });

  it('serializeConnection and deserializeConnection support empty target titles', () => {
    const nodes = [
      { id: 'n1', type: 'text', title: 'Source', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
      { id: 'n2', type: 'text', title: '', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
    ] as any[];

    const connection = { outputNodeId: 'n1', outputId: 'out', inputNodeId: 'n2', inputId: 'in' } as any;
    const serialized = serializeConnection(connection, nodes);
    assert.equal(serialized, 'out->"" n2/in');

    const deserialized = deserializeConnection(serialized, 'n1' as any);
    assert.equal(deserialized.outputNodeId, 'n1');
    assert.equal(deserialized.inputNodeId, 'n2');
    assert.equal(deserialized.inputId, 'in');
  });

  it('serializeConnection stores optional bend points without changing older endpoint parsing', () => {
    const nodes = [
      { id: 'n1', type: 'text', title: 'Source', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
      { id: 'n2', type: 'text', title: 'Target Node', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
    ] as any[];

    const connection = {
      outputNodeId: 'n1',
      outputId: 'out',
      inputNodeId: 'n2',
      inputId: 'in',
      bendPoint: { x: 123.5, y: -42 },
    } as any;

    const serialized = serializeConnection(connection, nodes);
    assert.equal(serialized, 'out->"Target Node __rivet_bend:123.5,-42" n2/in');

    const olderParserMatch = serialized.match(/(.+)->"(.*)"\s+(.+)\/(.+)/);
    assert.equal(olderParserMatch?.[1], 'out');
    assert.equal(olderParserMatch?.[3], 'n2');
    assert.equal(olderParserMatch?.[4], 'in');

    const deserialized = deserializeConnection(serialized, 'n1' as any);
    assert.deepEqual(deserialized, {
      outputId: 'out',
      outputNodeId: 'n1',
      inputId: 'in',
      inputNodeId: 'n2',
      bendPoint: { x: 123.5, y: -42 },
    });
  });

  it('serializeConnection does not parse target-title marker text as a bend point', () => {
    const nodes = [
      { id: 'n1', type: 'text', title: 'Source', visualData: { x: 0, y: 0 }, data: {}, variants: [] },
      {
        id: 'n2',
        type: 'text',
        title: 'Target Node __rivet_bend:123,456',
        visualData: { x: 0, y: 0 },
        data: {},
        variants: [],
      },
    ] as any[];

    const connection = { outputNodeId: 'n1', outputId: 'out', inputNodeId: 'n2', inputId: 'in' } as any;
    const serialized = serializeConnection(connection, nodes);
    assert.equal(serialized, 'out->"Target Node __rivet bend:123,456" n2/in');

    const deserialized = deserializeConnection(serialized, 'n1' as any);
    assert.equal(deserialized.bendPoint, undefined);
  });

  it('parseVisualData handles V3 format (4 parts)', () => {
    const result = parseVisualData('10/20/300/5');
    assert.equal(result.x, 10);
    assert.equal(result.y, 20);
    assert.equal(result.width, 300);
    assert.equal(result.zIndex, 5);
    assert.equal(result.borderColor, undefined);
    assert.equal(result.bgColor, undefined);
  });

  it('parseVisualData handles V4 format with colors (6 parts)', () => {
    const result = parseVisualData('10/20/null/null/#ff0000/#00ff00');
    assert.equal(result.x, 10);
    assert.equal(result.y, 20);
    assert.equal(result.width, undefined);
    assert.equal(result.zIndex, undefined);
    assert.equal(result.borderColor, '#ff0000');
    assert.equal(result.bgColor, '#00ff00');
  });

  it('parseVisualData handles V4 format with empty colors', () => {
    const result = parseVisualData('10/20/140/1//');
    assert.equal(result.x, 10);
    assert.equal(result.width, 140);
    assert.equal(result.borderColor, undefined);
    assert.equal(result.bgColor, undefined);
  });

  it('packVisualDataV3 packs correctly', () => {
    const node = { visualData: { x: 5, y: 10, width: 200, zIndex: 3 } } as any;
    assert.equal(packVisualDataV3(node), '5/10/200/3');
  });

  it('packVisualDataV4 packs with color fields', () => {
    const node = {
      visualData: { x: 5, y: 10, width: undefined, zIndex: undefined, color: { border: 'red', bg: 'blue' } },
    } as any;
    assert.equal(packVisualDataV4(node), '5/10/null/null/red/blue');
  });
});
