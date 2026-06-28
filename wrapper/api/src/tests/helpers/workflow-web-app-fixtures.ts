import assert from 'node:assert/strict';
import type { GraphId, NodeGraph, Project, UiGraphId } from '@valerypopoff/rivet2-node';

export const WEB_APP_TEST_UI_GRAPH_ID = 'ui-graph' as UiGraphId;
export const WEB_APP_TEST_ACTION_COMPONENT_ID = 'run-button';

type RivetProjectLoader = {
  loadProjectFromString(contents: string): Project;
};

type RivetProjectSerializer = {
  serializeProject(project: Project): unknown;
};

export function createWebAppProject(
  rivetNode: RivetProjectLoader,
  blankProjectContents: string,
  appName: string,
): Project {
  return createWebAppProjectWithUiGraphs(rivetNode, blankProjectContents, [[
    WEB_APP_TEST_UI_GRAPH_ID,
    appName,
  ]]);
}

export function createWebAppProjectWithUiGraphs(
  rivetNode: RivetProjectLoader,
  blankProjectContents: string,
  uiGraphs: Array<[string | UiGraphId, string]>,
): Project {
  const project = rivetNode.loadProjectFromString(blankProjectContents);
  const graphId = project.metadata.mainGraphId as GraphId;
  const graph: NodeGraph = {
    metadata: {
      description: '',
      id: graphId,
      name: 'Main Graph',
    },
    nodes: [
      {
        type: 'graphInput',
        title: 'Input',
        id: 'input-node',
        visualData: { x: 0, y: 0, width: 300 },
        data: {
          id: 'input',
          dataType: 'string',
        },
      } as never,
      {
        type: 'graphOutput',
        title: 'Output',
        id: 'output-node',
        visualData: { x: 360, y: 0, width: 300 },
        data: {
          id: 'value',
          dataType: 'string',
        },
      } as never,
    ],
    connections: [
      {
        outputNodeId: 'input-node',
        outputId: 'data',
        inputNodeId: 'output-node',
        inputId: 'value',
      } as never,
    ],
  };

  project.graphs[graphId] = graph;
  project.uiGraphs = Object.fromEntries(uiGraphs.map(([uiGraphId, appName]) => [
    uiGraphId as UiGraphId,
    {
      id: uiGraphId as UiGraphId,
      name: appName,
      components: [
        {
          id: WEB_APP_TEST_ACTION_COMPONENT_ID as never,
          type: 'button',
          label: 'Run',
          action: {
            type: 'runGraph',
            graphId,
            inputs: {
              input: { type: 'state', key: 'prompt' },
            },
            outputKey: 'value',
            outputStateKey: 'result',
          },
        },
      ],
    },
  ])) as Project['uiGraphs'];

  return project;
}

export function serializeWebAppProject(rivetNode: RivetProjectSerializer, project: Project): string {
  const serializedProject = rivetNode.serializeProject(project);
  if (typeof serializedProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }

  return serializedProject;
}

export function extractWebAppRevisionKey(html: string): string {
  const match = html.match(/"revisionKey":"([^"]+)"/);
  assert.ok(match?.[1], 'web app HTML should embed a revision key');
  return match[1];
}
