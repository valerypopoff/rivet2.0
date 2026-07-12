import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChartNode,
  GraphId,
  NodeId,
  NodePrefabId,
  Project,
  UiComponentId,
  UiGraphId,
} from '@valerypopoff/rivet2-core';
import { NODE_LIBRARY_GRAPH_SEARCH_ID } from './graphSearch.js';
import { buildProjectSearchItems } from './projectSearchItems.js';

const node = (id: string, type = 'text', title = id): ChartNode =>
  ({
    id: id as NodeId,
    type,
    title,
    description: '',
    data: { text: title },
    visualData: { x: 0, y: 0 },
  }) as ChartNode;

test('buildProjectSearchItems indexes graph nodes and library nodes', () => {
  const graphId = 'main-graph' as GraphId;
  const prefabId = 'prefab-shared-text' as NodePrefabId;
  const items = buildProjectSearchItems(
    {
      graphs: {
        [graphId]: {
          metadata: { id: graphId, name: 'Main graph', description: '' },
          nodes: [node('graph-node', 'text', 'Graph text')],
          connections: [],
        },
      },
      nodePrefabs: {
        [prefabId]: {
          id: prefabId,
          sourceNode: node('source-node', 'text', 'Shared source text'),
        },
      },
      uiGraphs: {
        ['ui-app' as UiGraphId]: {
          id: 'ui-app' as UiGraphId,
          name: 'Prompt reviewer',
          description: 'Checks prompts with a workflow',
          components: [
            {
              id: 'input' as UiComponentId,
              type: 'input',
              label: 'Prompt',
              placeholder: 'Paste text',
              stateKey: 'prompt',
            },
            {
              id: 'run' as UiComponentId,
              type: 'button',
              label: 'Run review',
              action: {
                type: 'runGraph',
                graphId,
                inputMappings: [{ inputKey: 'reviewInput', stateKey: 'prompt' }],
                outputs: [{ outputKey: 'reviewOutput', stateKey: 'result' }],
              },
            },
            {
              id: 'spacing' as UiComponentId,
              size: 'large',
              type: 'gap',
            },
          ],
        },
      },
    },
    (item) => (item.type === 'text' ? 'Text' : item.type),
  );

  assert.deepEqual(
    items.map((item) => ({
      id: item.id,
      containerGraph: item.type === 'node' ? item.containerGraph : undefined,
      nodeType: item.nodeType,
      type: item.type,
    })),
    [
      { id: 'graph-node', containerGraph: graphId, nodeType: 'Text', type: 'node' },
      { id: 'source-node', containerGraph: NODE_LIBRARY_GRAPH_SEARCH_ID, nodeType: 'Text', type: 'node' },
      { id: 'ui-app', containerGraph: undefined, nodeType: 'Web app', type: 'uiGraph' },
    ],
  );
  assert.match(items.find((item) => item.id === 'ui-app')?.joinedData ?? '', /reviewInput/);
  assert.match(items.find((item) => item.id === 'ui-app')?.joinedData ?? '', /reviewOutput/);
  assert.match(items.find((item) => item.id === 'ui-app')?.joinedData ?? '', /large/);
});

test('buildProjectSearchItems ignores malformed graph entries without metadata ids', () => {
  const project = {
    graphs: {
      malformed: {
        metadata: { name: 'Imported graph' },
        nodes: [node('graph-node')],
        connections: [],
      },
    },
    nodePrefabs: {},
  } as unknown as Pick<Project, 'graphs' | 'nodePrefabs'>;

  const items = buildProjectSearchItems(project, () => 'Text');

  assert.deepEqual(items, []);
});
