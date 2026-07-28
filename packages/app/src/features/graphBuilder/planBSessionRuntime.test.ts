import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NodeRegistration,
  registerBuiltInNodes,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import * as YAML from 'yaml';
import {
  GRAPH_BUILDER_PROTOCOL_VERSION,
  type GraphBuilderAuthoringProject,
  type GraphBuilderDecision,
} from '../../domain/graphBuilder/index.js';
import type { GraphBuilderBaseIdentity } from './identity.js';
import { createPlanBGraphBuilderSessionRuntime } from './planBSessionRuntime.js';
import type { GraphBuilderPolicyExecutionResult, GraphBuilderPolicyTurn } from './sessionController.js';

const activeGraphId = 'analysis' as GraphId;
const projectId = 'book-agent' as ProjectId;

function instantiateNode(
  registry: NodeRegistration<any, any>,
  type: string,
  id: string,
  title: string,
  x: number,
  y: number,
  data: Record<string, unknown>,
): ChartNode {
  const created = registry.createDynamic(type);
  return {
    ...created,
    id: id as NodeId,
    title,
    visualData: { ...created.visualData, x, y },
    data: { ...(created.data as Record<string, unknown>), ...data },
  };
}

function createProject(registry: NodeRegistration<any, any>): GraphBuilderAuthoringProject {
  return {
    metadata: {
      id: projectId,
      title: 'Book agent',
      description: '',
      mainGraphId: activeGraphId,
    },
    graphs: {
      [activeGraphId]: {
        metadata: { id: activeGraphId, name: 'Generate complete book analysis' },
        nodes: [
          instantiateNode(registry, 'graphInput', 'book-content', 'Book content', 0, 0, {
            id: 'bookContent',
            dataType: 'string',
          }),
          instantiateNode(registry, 'graphInput', 'chapters', 'Chapters', 0, 160, {
            id: 'chapters',
            dataType: 'object[]',
          }),
          instantiateNode(registry, 'graphInput', 'book-id', 'Book ID', 0, 320, {
            id: 'bookId',
            dataType: 'string',
          }),
          instantiateNode(registry, 'graphInput', 'source-version', 'Source version', 0, 480, {
            id: 'sourceVersion',
            dataType: 'string',
          }),
          instantiateNode(registry, 'codeNew', 'stage-one', 'Generate analysis prompt', 360, 0, {
            code: 'return {{bookContent}};',
            apiKey: 'host-owned-secret-value',
          }),
          instantiateNode(registry, 'text', 'old-prompt', 'Old one-shot prompt', 680, 0, {
            text: 'Analyze all of this at once:\n{{bookContent}}',
          }),
          instantiateNode(registry, 'llmChatV2', 'old-llm', 'Old one-shot analysis', 1_000, 0, {}),
          instantiateNode(registry, 'graphOutput', 'analysis-output', 'Analysis', 1_320, 0, {
            id: 'analysis',
            dataType: 'any',
          }),
        ],
        connections: [],
      },
    },
  };
}

function baseIdentity(): GraphBuilderBaseIdentity {
  return {
    activeGraphId,
    editorRevision: 1,
    policyConfigFingerprint: 'policy-config',
    projectCanonicalIdentity: 'project-canonical',
    projectFingerprint: 'project-fingerprint',
    projectId,
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    referencedProjectsCanonicalIdentity: '{}',
    referencedProjectsFingerprint: 'referenced-fingerprint',
    registryContractCanonicalIdentity: 'registry-canonical',
    registryContractFingerprint: 'registry-fingerprint',
    validationRulesVersion: '1',
  };
}

function policyResult(turn: GraphBuilderPolicyTurn, decision: GraphBuilderDecision): GraphBuilderPolicyExecutionResult {
  return {
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    policyVersion: turn.policyVersion,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    attemptId: turn.attemptId,
    decision,
    usage: { completeness: 'unavailable' },
  };
}

function cloneTemplate(
  templates: Array<{ authoringChoiceId: string; node: ChartNode; status: string }>,
  authoringChoiceId: string,
  id: string,
  title: string,
  x: number,
  y: number,
  data: Record<string, unknown>,
): ChartNode {
  const match = templates.find(
    (template) => template.authoringChoiceId === authoringChoiceId && template.status === 'ok',
  );
  assert.ok(match, `expected canonical template ${authoringChoiceId}`);
  const node = structuredClone(match.node);
  return {
    ...node,
    id: id as NodeId,
    title,
    visualData: { ...node.visualData, x, y },
    data: { ...(node.data as Record<string, unknown>), ...structuredClone(data) },
  };
}

function connection(outputNodeId: string, outputId: string, inputNodeId: string, inputId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}

test('Plan B reads the full private YAML, uses canonical templates, and accepts a broad parallel multi-stage replacement', async () => {
  const registry = registerBuiltInNodes(new NodeRegistration());
  const project = createProject(registry);
  const observedTurns: GraphBuilderPolicyTurn[] = [];
  let committedDraft: GraphBuilderAuthoringProject | undefined;

  const runtime = createPlanBGraphBuilderSessionRuntime({
    activeGraphId,
    authoringProject: project,
    base: baseIdentity(),
    commit: ({ draft, draftRevision, summary }) => {
      committedDraft = draft;
      return {
        status: 'committed',
        commitId: 'commit',
        draftRevision,
        summary,
      };
    },
    executePolicy: async (turn) => {
      observedTurns.push(structuredClone(turn));
      assert.doesNotMatch(JSON.stringify(turn), /host-owned-secret-value/u);

      if (turn.draftRevision === 0 && turn.contextResults.length === 0) {
        assert.equal(turn.phase, 'gathering-context');
        assert.match(turn.workspace.activeDocument.content, /return \{\{bookContent\}\};/u);
        assert.match(turn.workspace.activeDocument.content, /Analyze all of this at once/u);
        assert.match(turn.workspace.activeDocument.content, /\$graphBuilderSecret: host-secret:/u);
        return policyResult(turn, {
          type: 'request-context',
          requests: [
            {
              type: 'read-virtual-document',
              path: turn.workspace.activeDocumentPath,
              startLine: 1,
              lineCount: 2_000,
            },
            {
              type: 'get-node-templates',
              authoringChoiceIds: [
                'registered:graphInput',
                'registered:codeNew',
                'registered:text',
                'registered:llmChatV2',
              ],
            },
          ],
        });
      }

      if (turn.draftRevision === 0) {
        assert.equal(turn.contextResults.length, 2);
        const documentResult = turn.contextResults[0]!;
        const templateResult = turn.contextResults[1]!;
        assert.equal(documentResult.status, 'ok');
        assert.equal(templateResult.status, 'ok');
        assert.ok(documentResult.status === 'ok' && templateResult.status === 'ok');
        const documentPayload = documentResult.payload as unknown as {
          contents: string;
          path: string;
        };
        const templates = (
          templateResult.payload as unknown as {
            templates: Array<{
              authoringChoiceId: string;
              node: ChartNode;
              status: string;
            }>;
          }
        ).templates;
        assert.deepEqual(
          templates.map(({ authoringChoiceId, status }) => ({ authoringChoiceId, status })),
          [
            { authoringChoiceId: 'registered:graphInput', status: 'ok' },
            { authoringChoiceId: 'registered:codeNew', status: 'ok' },
            { authoringChoiceId: 'registered:text', status: 'ok' },
            { authoringChoiceId: 'registered:llmChatV2', status: 'ok' },
          ],
        );

        const document = YAML.parse(documentPayload.contents) as {
          version: number;
          graph: GraphBuilderAuthoringProject['graphs'][GraphId];
        };
        const existingById = new Map(document.graph.nodes.map((node) => [node.id, node]));
        const stageOne = existingById.get('stage-one' as NodeId)!;
        stageOne.title = 'Build basic facts and whole-book prompt';
        stageOne.visualData = { ...stageOne.visualData, x: 360, y: 0 };
        stageOne.data = {
          ...(stageOne.data as Record<string, unknown>),
          code: [
            'const bookContent = {{bookContent}};',
            'const basicFacts = {{basicFacts}};',
            'return JSON.stringify({',
            '  basicFacts,',
            '  requested: ["wholeBookSummary", "themes", "analysisNotes"],',
            '  bookContent,',
            '});',
          ].join('\n'),
        };

        const basicFactsInput = cloneTemplate(
          templates,
          'registered:graphInput',
          'basic-facts',
          'Basic facts',
          0,
          640,
          {
            id: 'basicFacts',
            dataType: 'object',
            useDefaultValueInput: false,
          },
        );
        const stageOneLlm = cloneTemplate(
          templates,
          'registered:llmChatV2',
          'stage-one-llm',
          'Generate basic analysis',
          680,
          0,
          {},
        );
        const characterPrompt = cloneTemplate(
          templates,
          'registered:text',
          'character-prompt',
          'Build character prompt',
          1_000,
          0,
          {
            text: [
              'Using this whole-book analysis:',
              '{{summary}}',
              'Generate mainCharacters and secondaryCharacters.',
            ].join('\n'),
          },
        );
        const timelinePrompt = cloneTemplate(
          templates,
          'registered:text',
          'timeline-prompt',
          'Build timeline prompt',
          1_000,
          260,
          {
            text: [
              'Using this whole-book analysis:',
              '{{summary}}',
              'And these characters:',
              '{{characters}}',
              'Generate the timeline.',
            ].join('\n'),
          },
        );
        const chaptersPrompt = cloneTemplate(
          templates,
          'registered:text',
          'chapters-prompt',
          'Build chapter summaries prompt',
          1_000,
          520,
          {
            text: [
              'Using this whole-book analysis:',
              '{{summary}}',
              'And these characters:',
              '{{characters}}',
              'Summarize every chapter in the manifest.',
            ].join('\n'),
          },
        );
        const characterLlm = cloneTemplate(
          templates,
          'registered:llmChatV2',
          'character-llm',
          'Generate characters',
          1_340,
          0,
          {},
        );
        const timelineLlm = cloneTemplate(
          templates,
          'registered:llmChatV2',
          'timeline-llm',
          'Generate timeline',
          1_340,
          260,
          {},
        );
        const chaptersLlm = cloneTemplate(
          templates,
          'registered:llmChatV2',
          'chapters-llm',
          'Generate chapter summaries',
          1_340,
          520,
          {},
        );
        const merge = cloneTemplate(
          templates,
          'registered:codeNew',
          'merge-analysis',
          'Merge complete analysis',
          1_680,
          260,
          {
            code: [
              'return {',
              '  basicFacts: {{basicFacts}},',
              '  wholeBookOverview: {{wholeBookOverview}},',
              '  mainCharacters: {{characters}},',
              '  timeline: {{timeline}},',
              '  chapterSummaries: {{chapterSummaries}},',
              '};',
            ].join('\n'),
          },
        );

        document.graph.nodes = [
          existingById.get('book-content' as NodeId)!,
          existingById.get('chapters' as NodeId)!,
          existingById.get('book-id' as NodeId)!,
          existingById.get('source-version' as NodeId)!,
          basicFactsInput,
          stageOne,
          stageOneLlm,
          characterPrompt,
          timelinePrompt,
          chaptersPrompt,
          characterLlm,
          timelineLlm,
          chaptersLlm,
          merge,
          existingById.get('analysis-output' as NodeId)!,
        ];
        document.graph.connections = [
          connection('book-content', 'data', 'stage-one', 'bookContent'),
          connection('basic-facts', 'data', 'stage-one', 'basicFacts'),
          connection('stage-one', 'output', 'stage-one-llm', 'prompt'),
          connection('stage-one-llm', 'response', 'character-prompt', 'summary'),
          connection('stage-one-llm', 'response', 'timeline-prompt', 'summary'),
          connection('stage-one-llm', 'response', 'chapters-prompt', 'summary'),
          connection('character-prompt', 'output', 'character-llm', 'prompt'),
          connection('character-llm', 'response', 'timeline-prompt', 'characters'),
          connection('character-llm', 'response', 'chapters-prompt', 'characters'),
          connection('timeline-prompt', 'output', 'timeline-llm', 'prompt'),
          connection('chapters-prompt', 'output', 'chapters-llm', 'prompt'),
          connection('basic-facts', 'data', 'merge-analysis', 'basicFacts'),
          connection('stage-one-llm', 'response', 'merge-analysis', 'wholeBookOverview'),
          connection('character-llm', 'response', 'merge-analysis', 'characters'),
          connection('timeline-llm', 'response', 'merge-analysis', 'timeline'),
          connection('chapters-llm', 'response', 'merge-analysis', 'chapterSummaries'),
          connection('merge-analysis', 'output', 'analysis-output', 'value'),
        ];

        return policyResult(turn, {
          type: 'replace-document',
          baseRevision: turn.draftRevision,
          path: documentPayload.path,
          content: YAML.stringify(document, { lineWidth: 0 }),
          summary: 'Split complete book analysis into parallel multi-stage generation.',
        });
      }

      assert.equal(turn.draftRevision, 1);
      assert.equal(turn.phase, 'reviewing');
      assert.equal(turn.contextResults.length, 0);
      assert.ok(turn.projection.delta);
      assert.ok(turn.projection.delta.addedNodes.length >= 8);
      assert.ok(turn.projection.delta.addedConnections.length >= 16);
      assert.equal(turn.workspace.delta.graphDeltas.length, 1);
      assert.ok(turn.workspace.delta.graphDeltas[0]!.addedNodes.length >= 8);
      assert.ok(turn.workspace.delta.graphDeltas[0]!.addedConnections.length >= 16);
      assert.match(turn.workspace.activeDocument.content, /Generate chapter summaries/u);
      assert.match(turn.workspace.activeDocument.content, /mainCharacters: \{\{characters\}\}/u);
      return policyResult(turn, {
        type: 'ready',
        summary: 'Split complete book analysis into parallel multi-stage generation.',
      });
    },
    policyVersion: 'test-policy',
    referencedProjects: {},
    registry,
    request: 'Rebuild complete book analysis as several stages with timeline and chapter summaries in parallel.',
    sessionId: 'virtual-yaml-integration',
    verifyIdentity: () => ({ matches: true, currentFingerprint: 'project-fingerprint' }),
  });

  await runtime.controller.start();
  const previewState = runtime.controller.getState();
  assert.equal(
    previewState.status,
    'ready-for-preview',
    JSON.stringify({
      previewState,
      turns: observedTurns.map((turn) => ({
        diagnostics: turn.diagnostics,
        draftRevision: turn.draftRevision,
        phase: turn.phase,
        transcript: turn.transcript,
      })),
    }),
  );
  if (previewState.status !== 'ready-for-preview') {
    return;
  }
  assert.equal(previewState.preview.draftRevision, 1);
  assert.equal(previewState.preview.delta.graphDeltas.length, 1);
  assert.ok(previewState.preview.delta.graphDeltas[0]!.addedNodes.length >= 8);
  assert.ok(previewState.preview.delta.graphDeltas[0]!.addedConnections.length >= 16);

  const draft = runtime.getDraft();
  const graph = draft.graphs[activeGraphId]!;
  assert.equal(graph.nodes.find((node) => node.id === ('basic-facts' as NodeId))?.type, 'graphInput');
  assert.equal(
    (graph.nodes.find((node) => node.id === ('stage-one' as NodeId))!.data as Record<string, unknown>).apiKey,
    'host-owned-secret-value',
  );
  assert.equal(
    graph.nodes.some((node) => node.id === ('old-prompt' as NodeId)),
    false,
  );
  assert.equal(
    graph.nodes.some((node) => node.id === ('old-llm' as NodeId)),
    false,
  );
  assert.ok(
    graph.connections.some(
      (candidate) =>
        candidate.outputNodeId === ('character-llm' as NodeId) &&
        candidate.inputNodeId === ('timeline-prompt' as NodeId),
    ),
  );
  assert.ok(
    graph.connections.some(
      (candidate) =>
        candidate.outputNodeId === ('character-llm' as NodeId) &&
        candidate.inputNodeId === ('chapters-prompt' as NodeId),
    ),
  );
  assert.doesNotMatch(JSON.stringify(observedTurns), /host-owned-secret-value/u);

  await runtime.controller.apply();
  assert.equal(runtime.controller.getState().status, 'committed');
  assert.deepEqual(committedDraft, draft);
});
