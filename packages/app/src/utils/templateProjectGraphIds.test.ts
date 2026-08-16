import assert from 'node:assert/strict';
import test from 'node:test';
import { type ChartNode, type GraphId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { remapTemplateProjectGraphIds } from './templateProjectGraphIds.js';

function makeNode(type: string, data: Record<string, unknown>, options: { variants?: unknown[] } = {}): ChartNode {
  return {
    id: `${type}-node` as any,
    type,
    title: type,
    visualData: { x: 0, y: 0 },
    data,
    variants: options.variants as any,
  };
}

test('remapTemplateProjectGraphIds updates same-project graph ids across supported nodes', () => {
  const graphIdMapping = {
    main: 'main-copy',
    sub: 'sub-copy',
    loop: 'loop-copy',
    cron: 'cron-copy',
    delegate: 'delegate-copy',
    fallback: 'fallback-copy',
    tool: 'tool-copy',
    message: 'message-copy',
    eval: 'eval-copy',
  } as Record<GraphId, GraphId>;

  const project: Pick<Project, 'metadata' | 'graphs'> = {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Template',
      description: '',
      mainGraphId: 'main' as GraphId,
    },
    graphs: {
      ['main-copy' as GraphId]: {
        metadata: {
          id: 'main-copy' as GraphId,
          name: 'Main',
          description: '',
        },
        connections: [],
        nodes: [
          makeNode('subGraph', { graphId: 'sub' as GraphId }),
          makeNode('graphReference', { graphId: 'sub' as GraphId }, {
            variants: [{ id: 'alt', data: { graphId: 'loop' as GraphId } }],
          }),
          makeNode('loopUntil', { targetGraph: 'loop' as GraphId }),
          makeNode('cron', { targetGraph: 'cron' as GraphId }),
          makeNode('delegateFunctionCall', {
            handlers: [{ key: 'weather', value: 'delegate' as GraphId }],
            unknownHandler: 'fallback' as GraphId,
          }),
          makeNode('openaiRunThread', {
            toolCallHandlers: [{ key: 'search', value: 'tool' as GraphId }],
            onMessageCreationSubgraphId: 'message' as GraphId,
          }),
          makeNode('referencedGraphAlias', {
            projectId: 'external-project' as ProjectId,
            graphId: 'external-graph' as GraphId,
          }),
        ],
      },
    },
  };

  remapTemplateProjectGraphIds(project, graphIdMapping);

  const nodes = project.graphs['main-copy' as GraphId]!.nodes;

  assert.equal(project.metadata.mainGraphId, 'main-copy');
  assert.equal((nodes[0]!.data as any).graphId, 'sub-copy');
  assert.equal((nodes[1]!.data as any).graphId, 'sub-copy');
  assert.equal((nodes[1]!.variants?.[0] as any)?.data.graphId, 'loop-copy');
  assert.equal((nodes[2]!.data as any).targetGraph, 'loop-copy');
  assert.equal((nodes[3]!.data as any).targetGraph, 'cron-copy');
  assert.equal((nodes[4]!.data as any).handlers[0].value, 'delegate-copy');
  assert.equal((nodes[4]!.data as any).unknownHandler, 'fallback-copy');
  assert.equal((nodes[5]!.data as any).toolCallHandlers[0].value, 'tool-copy');
  assert.equal((nodes[5]!.data as any).onMessageCreationSubgraphId, 'message-copy');
  assert.equal((nodes[6]!.data as any).graphId, 'external-graph');
});
