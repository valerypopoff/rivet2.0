import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NodeRegistration,
  registerBuiltInNodes,
  type ChartNode,
  type GraphId,
  type NodeId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import type { GraphBuilderAuthoringProject, GraphBuilderReadResult } from '../../domain/graphBuilder/index.js';
import { createGraphBuilderAuthoringCatalog } from './authoringCatalog.js';
import { createAppGraphBuilderAuthoringSemantics } from './authoringSemantics.js';
import { createGraphBuilderReadExecutor } from './readExecutor.js';
import { createVirtualGraphWorkspace, getVirtualGraphDocumentPath } from './virtualGraphWorkspace.js';

const activeGraphId = 'main' as GraphId;

function createNode(type: string, id: string, title: string, data: Record<string, unknown>): ChartNode {
  return {
    id: id as NodeId,
    type,
    title,
    visualData: { x: 0, y: 0, width: 300 },
    data,
  };
}

function createProject(): GraphBuilderAuthoringProject {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Read executor workspace test',
      description: '',
      mainGraphId: activeGraphId,
    },
    graphs: {
      [activeGraphId]: {
        metadata: { id: activeGraphId, name: 'Main' },
        nodes: [
          createNode('codeNew', 'code', 'Build prompt', {
            code: 'const book = {{bookContent}};\nreturn `Analyze: ${book}`;',
            allowFetch: false,
            allowRequire: false,
            allowRivet: false,
            allowProcess: false,
            allowConsole: false,
            apiKey: 'must-never-reach-the-model',
          }),
          createNode('text', 'text', 'Instructions', {
            text: 'Summarize {{bookContent}}\nwithout dropping chapters.',
            normalizeLineEndings: true,
          }),
        ],
        connections: [],
      },
    },
  };
}

function createHarness() {
  const project = createProject();
  const registry = registerBuiltInNodes(new NodeRegistration());
  const catalog = createGraphBuilderAuthoringCatalog({
    registry,
    project,
    referencedProjects: {},
  });
  const semantics = createAppGraphBuilderAuthoringSemantics({
    registry,
    catalog,
    referencedProjects: {},
    mutableBoundaryGraphIds: [activeGraphId],
  });
  const workspace = createVirtualGraphWorkspace({ project });
  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => workspace.getDraft(),
    getDraftRevision: () => workspace.getDraftRevision(),
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
    readVirtualDocument: ({ path, startLine, lineCount, startOffset }) =>
      workspace.readDocument(path, startLine, lineCount, startOffset),
  });

  return { executor, project, workspace };
}

async function execute(
  harness: ReturnType<typeof createHarness>,
  request: Parameters<ReturnType<typeof createGraphBuilderReadExecutor>['execute']>[0],
  requestIndex = 0,
): Promise<GraphBuilderReadResult> {
  return harness.executor.execute(request, {
    requestId: `request-${requestIndex.toString(10)}`,
    requestIndex,
    observedDraftRevision: harness.workspace.getDraftRevision(),
    draft: harness.workspace.getDraft(),
    abortSignal: new AbortController().signal,
  });
}

test('read-virtual-document exposes complete source text through bounded windows without exposing host secrets', async () => {
  const harness = createHarness();
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const result = await execute(harness, {
    type: 'read-virtual-document',
    path,
    startLine: 1,
    lineCount: 2_000,
  });

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') {
    return;
  }
  const payload = result.payload as {
    contents: string;
    draftRevision: number;
    endOffset: number;
    graphId: string;
    lineCount: number;
    path: string;
    startOffset: number;
    startLine: number;
    totalLength: number;
    totalLineCount: number;
    truncated: boolean;
  };
  assert.equal(payload.path, path);
  assert.equal(payload.graphId, activeGraphId);
  assert.equal(payload.draftRevision, 0);
  assert.equal(payload.startLine, 1);
  assert.equal(payload.lineCount, payload.totalLineCount);
  assert.equal(payload.truncated, false);
  assert.match(payload.contents, /const book = \{\{bookContent\}\};/u);
  assert.match(payload.contents, /without dropping chapters/u);
  assert.match(payload.contents, /\$graphBuilderSecret: host-secret:/u);
  assert.doesNotMatch(JSON.stringify(result), /must-never-reach-the-model/u);

  const continuationOffset = payload.contents.indexOf('graph:');
  const continuation = await execute(
    harness,
    {
      type: 'read-virtual-document',
      path,
      startOffset: continuationOffset,
    },
    1,
  );
  assert.equal(continuation.status, 'ok');
  assert.equal(
    continuation.status === 'ok' ? (continuation.payload as { startOffset: number }).startOffset : undefined,
    continuationOffset,
  );

  const unknown = await execute(
    harness,
    {
      type: 'read-virtual-document',
      path: 'graphs/unknown.yaml',
    },
    2,
  );
  assert.deepEqual(unknown.status === 'failed' ? unknown.error : undefined, {
    code: 'unknown-document',
    message: 'Unknown virtual graph document "graphs/unknown.yaml".',
  });
});

test('get-node-templates returns complete canonical Code, LLM Chat, and Text nodes with no secret material', async () => {
  const harness = createHarness();
  const result = await execute(harness, {
    type: 'get-node-templates',
    authoringChoiceIds: ['registered:codeNew', 'registered:llmChatV2', 'registered:text'],
  });

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') {
    return;
  }
  const templates = (result.payload as { templates: Array<Record<string, unknown>> }).templates;
  assert.equal(templates.length, 3);
  assert.deepEqual(
    templates.map((template) => ({
      authoringChoiceId: template.authoringChoiceId,
      status: template.status,
      type: (template.node as ChartNode | undefined)?.type,
      id: (template.node as ChartNode | undefined)?.id,
    })),
    [
      {
        authoringChoiceId: 'registered:codeNew',
        status: 'ok',
        type: 'codeNew',
        id: 'NEW_NODE_1',
      },
      {
        authoringChoiceId: 'registered:llmChatV2',
        status: 'ok',
        type: 'llmChatV2',
        id: 'NEW_NODE_2',
      },
      {
        authoringChoiceId: 'registered:text',
        status: 'ok',
        type: 'text',
        id: 'NEW_NODE_3',
      },
    ],
  );

  const code = templates[0]!.node as ChartNode;
  const llm = templates[1]!.node as ChartNode;
  const text = templates[2]!.node as ChartNode;
  assert.match((code.data as { code: string }).code, /return value;/u);
  assert.equal((llm.data as { provider: string }).provider, 'openai');
  assert.equal((llm.data as { model: string }).model, 'gpt-5');
  assert.equal((text.data as { text: string }).text, '{{input}}');
  assert.doesNotMatch(JSON.stringify(result), /must-never-reach-the-model/u);
  assert.ok(templates.every((template) => typeof template.spec === 'object'));

  const configured = await execute(
    harness,
    {
      type: 'get-node-templates',
      authoringChoiceIds: ['registered:codeNew'],
      authoringSettings: {
        code: 'const summary = {{wholeBookSummary}};\nreturn { summary };',
      },
    },
    1,
  );
  assert.equal(configured.status, 'ok');
  assert.equal(
    configured.status === 'ok'
      ? (
          (configured.payload as unknown as { templates: Array<{ node: ChartNode }> }).templates[0]!.node.data as {
            code: string;
          }
        ).code
      : undefined,
    'const summary = {{wholeBookSummary}};\nreturn { summary };',
  );
});
