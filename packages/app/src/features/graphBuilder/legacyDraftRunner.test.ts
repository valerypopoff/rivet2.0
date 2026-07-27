import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type ExternalFunctionProcessContext,
  type GraphId,
  type NodeId,
  type PortId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import type { GraphBuilderAuthoringProject } from '../../domain/graphBuilder/index.js';
import { createGraphBuilderAuthoringCatalog } from './authoringCatalog.js';
import {
  runLegacyGraphBuilderDraft,
  type LegacyGraphBuilderAgentExecutor,
  type RunLegacyGraphBuilderDraftOptions,
} from './legacyDraftRunner.js';

const graphId = 'legacy-graph' as GraphId;
const baseProject: GraphBuilderAuthoringProject = {
  metadata: {
    id: 'legacy-project' as ProjectId,
    title: 'Legacy test',
    description: '',
  },
  graphs: {
    [graphId]: {
      metadata: {
        id: graphId,
        name: 'Main',
        description: '',
      },
      nodes: [],
      connections: [],
    },
  },
  plugins: [],
};

test('legacy draft runner keeps mutations private and returns a revisioned preview', async () => {
  const original = cloneDeep(baseProject);
  const progress: number[] = [];
  let mutationResult: unknown;

  const result = await runLegacyGraphBuilderDraft(
    options(
      async ({ externalFunctions, onUserEvent }) => {
        mutationResult = await externalFunctions.createNode!({} as ExternalFunctionProcessContext, 'Text node');
        onUserEvent.finalMessage?.({ type: 'string', value: 'Prepared the requested graph.' });
      },
      {
        onProgress: (event) => {
          if (event.type === 'draft-changed') {
            progress.push(event.draftRevision);
          }
        },
      },
    ),
  );

  assert.deepEqual(baseProject, original, 'the captured editor project must remain unchanged');
  assert.equal(result.status, 'ready-for-preview');
  assert.equal(result.draft.graphs[graphId]?.nodes.length, 1);
  assert.equal(result.preview.delta.graphDeltas[0]?.addedNodeCount, 1);
  assert.deepEqual(progress, [1]);
  assert.deepEqual(mutationResult, {
    type: 'object',
    value: {
      draftRevision: 1,
      result: result.draft.graphs[graphId]?.nodes[0]?.id,
    },
  });
});

test('legacy draft runner cancellation discards its private work', async () => {
  const controller = new AbortController();
  const original = cloneDeep(baseProject);

  const result = await runLegacyGraphBuilderDraft(
    options(
      async ({ externalFunctions }) => {
        await externalFunctions.createNode!({} as ExternalFunctionProcessContext, 'Text');
        controller.abort('test cancellation');
      },
      { abortSignal: controller.signal },
    ),
  );

  assert.deepEqual(baseProject, original);
  assert.deepEqual(result, { status: 'canceled' });
});

test('legacy draft runner does not invoke the agent when cancellation already won', async () => {
  const controller = new AbortController();
  controller.abort('canceled before legacy execution');
  let agentInvocations = 0;

  const result = await runLegacyGraphBuilderDraft(
    options(
      async () => {
        agentInvocations += 1;
      },
      { abortSignal: controller.signal },
    ),
  );

  assert.deepEqual(result, { status: 'canceled' });
  assert.equal(agentInvocations, 0);
});

test('legacy cancellation settles promptly when the agent ignores abort and observes its late rejection', async () => {
  const controller = new AbortController();
  let rejectAgent!: (error: Error) => void;
  let markAgentStarted!: () => void;
  const agentStarted = new Promise<void>((resolve) => {
    markAgentStarted = resolve;
  });
  const ignoredAgent = new Promise<void>((_resolve, reject) => {
    rejectAgent = reject;
  });

  const running = runLegacyGraphBuilderDraft(
    options(
      () => {
        markAgentStarted();
        return ignoredAgent;
      },
      { abortSignal: controller.signal },
    ),
  );
  await agentStarted;
  controller.abort('cancel an abort-ignoring legacy agent');

  assert.deepEqual(await running, { status: 'canceled' });
  rejectAgent(new Error('late ignored-agent failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('legacy draft runner reports a completed policy with no mutations as no-change', async () => {
  const result = await runLegacyGraphBuilderDraft(
    options(async ({ onUserEvent }) => {
      onUserEvent.finalMessage?.({ type: 'string', value: 'The graph already satisfies the request.' });
    }),
  );

  assert.deepEqual(result, {
    status: 'no-change',
    draftRevision: 0,
    summary: 'The graph already satisfies the request.',
  });
});

test('legacy draft runner rejects processor completion without the final protocol event', async () => {
  await assert.rejects(
    runLegacyGraphBuilderDraft(options(async () => {})),
    /stopped before reporting a completed result/,
  );
});

test('legacy draft runner propagates agent failures without changing the base project', async () => {
  const original = cloneDeep(baseProject);
  await assert.rejects(
    runLegacyGraphBuilderDraft(
      options(async ({ externalFunctions }) => {
        await externalFunctions.createNode!({} as ExternalFunctionProcessContext, 'Text');
        throw new Error('synthetic provider failure');
      }),
    ),
    /synthetic provider failure/,
  );
  assert.deepEqual(baseProject, original);
});

test('legacy production layout terminates for a source-reachable cycle and preserves existing positions', async () => {
  const sourceId = 'source' as NodeId;
  const leftCycleId = 'left-cycle' as NodeId;
  const rightCycleId = 'right-cycle' as NodeId;
  const cyclicProject = cloneDeep(baseProject);
  const cyclicGraph = cyclicProject.graphs[graphId]!;
  cyclicGraph.nodes = [textNode(sourceId, 10, 20), textNode(leftCycleId, 310, 120), textNode(rightCycleId, 610, 220)];
  cyclicGraph.connections = [
    {
      outputNodeId: sourceId,
      outputId: 'output' as PortId,
      inputNodeId: leftCycleId,
      inputId: 'input' as PortId,
    },
    {
      outputNodeId: leftCycleId,
      outputId: 'output' as PortId,
      inputNodeId: rightCycleId,
      inputId: 'input' as PortId,
    },
    {
      outputNodeId: rightCycleId,
      outputId: 'output' as PortId,
      inputNodeId: leftCycleId,
      inputId: 'input' as PortId,
    },
  ];
  const originalPositions = Object.fromEntries(
    cyclicGraph.nodes.map((node) => [node.id, { x: node.visualData.x, y: node.visualData.y }]),
  );

  const result = await runLegacyGraphBuilderDraft(
    options(
      async ({ externalFunctions, onUserEvent }) => {
        await externalFunctions.createNode!({} as ExternalFunctionProcessContext, 'Text');
        onUserEvent.finalMessage?.({ type: 'string', value: 'Added a text node.' });
      },
      { baseProject: cyclicProject },
    ),
  );

  assert.equal(result.status, 'ready-for-preview');
  if (result.status !== 'ready-for-preview') {
    return;
  }
  const resultGraph = result.draft.graphs[graphId]!;
  for (const nodeId of [sourceId, leftCycleId, rightCycleId]) {
    const node = resultGraph.nodes.find((candidate) => candidate.id === nodeId)!;
    assert.deepEqual(
      { x: node.visualData.x, y: node.visualData.y },
      originalPositions[nodeId],
      `existing node ${nodeId} must retain its position`,
    );
  }
  assert.equal(resultGraph.nodes.length, 4);
});

test('legacy settings-only edits do not relayout the graph', async () => {
  const nodeId = 'existing-text' as NodeId;
  const editProject = cloneDeep(baseProject);
  editProject.graphs[graphId]!.nodes = [textNode(nodeId, 123, 456)];

  const result = await runLegacyGraphBuilderDraft(
    options(
      async ({ externalFunctions, onUserEvent }) => {
        await externalFunctions.editNode!({} as ExternalFunctionProcessContext, nodeId, 'text', 'after');
        onUserEvent.finalMessage?.({ type: 'string', value: 'Updated the text.' });
      },
      { baseProject: editProject },
    ),
  );

  assert.equal(result.status, 'ready-for-preview');
  if (result.status !== 'ready-for-preview') {
    return;
  }
  const editedNode = result.draft.graphs[graphId]!.nodes.find((node) => node.id === nodeId)!;
  assert.deepEqual({ x: editedNode.visualData.x, y: editedNode.visualData.y }, { x: 123, y: 456 });
  assert.equal((editedNode.data as { text?: string }).text, 'after');
});

function textNode(id: NodeId, x: number, y: number) {
  return {
    id,
    type: 'text',
    title: 'Text',
    visualData: { x, y },
    data: { text: 'before' },
  };
}

function options(
  executeAgent: LegacyGraphBuilderAgentExecutor,
  overrides: Partial<RunLegacyGraphBuilderDraftOptions> = {},
): RunLegacyGraphBuilderDraftOptions {
  const registry = createBuiltInRegistry();
  const project = cloneDeep(overrides.baseProject ?? baseProject);
  return {
    abortSignal: new AbortController().signal,
    activeGraphId: graphId,
    catalog: createGraphBuilderAuthoringCatalog({
      registry,
      project,
      referencedProjects: {},
    }),
    executeAgent,
    referencedProjects: {},
    registry,
    request: 'Create a text node.',
    ...overrides,
    baseProject: project,
  };
}
