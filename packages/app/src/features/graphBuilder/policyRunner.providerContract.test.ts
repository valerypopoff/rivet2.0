import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type Project, type ProjectId, resolveProcessSettings } from '@valerypopoff/rivet2-core';
import { GRAPH_BUILDER_PROTOCOL_VERSION, type GraphBuilderDecision } from '../../domain/graphBuilder/index.js';
import {
  createGraphBuilderPolicyRunner,
  GRAPH_BUILDER_POLICY_VERSION,
  type GraphBuilderPolicyAssistModel,
} from './policyRunner.js';
import { createGraphBuilderPolicyTestProject } from './policyRunnerTestFixture.js';
import type { GraphBuilderPolicyTurn } from './sessionController.js';

const inputTokens = 12;
const outputTokens = 5;
const forbiddenHeaderName = 'x-rivet-policy-header-canary';
const forbiddenHeaderValue = 'RIVET_SYNTHETIC_HIDDEN_POLICY_HEADER';

type ProviderFixture = {
  provider: GraphBuilderPolicyAssistModel['provider'];
  model: string;
  secret: string;
  runtimeSettings: ReturnType<typeof resolveProcessSettings>;
  expectedUrl: string;
  assertAuthentication(headers: Headers, secret: string): void;
  assertRequestBody(body: Record<string, unknown>): void;
  response(decisionText: string): unknown;
};

function loadPolicyProject(): Promise<Project> {
  return Promise.resolve(createGraphBuilderPolicyTestProject());
}

function policyTurn(provider: string): GraphBuilderPolicyTurn {
  return {
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    policyVersion: GRAPH_BUILDER_POLICY_VERSION,
    sessionId: `session-${provider}`,
    turnId: `turn-${provider}`,
    attemptId: `attempt-${provider}`,
    phase: 'editing',
    userRequest: `Return a ready decision through the ${provider} wire protocol.`,
    draftRevision: 0,
    projection: {
      protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
      projectId: 'provider-contract-project' as ProjectId,
      graphId: 'provider-contract-graph' as GraphId,
      draftRevision: 0,
      nodes: [],
      connections: [],
      diagnostics: [],
    },
    workspace: {
      version: 1,
      activeDocumentPath: 'graphs/provider-contract-graph.yaml',
      delta: { graphDeltas: [] },
      documents: [],
      activeDocument: {
        path: 'graphs/provider-contract-graph.yaml',
        digest: 'digest',
        startOffset: 0,
        endOffset: 11,
        totalLength: 11,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        content: 'version: 1\n',
        truncated: false,
      },
    },
    transcript: [],
    contextResults: [],
    diagnostics: [],
    remainingBudget: {
      policyAttempts: 4,
      repairAttempts: 2,
      milliseconds: 30_000,
      inputTokens: 100_000,
      outputTokens: 20_000,
      costUsd: 10,
    },
    contextMode: 'full',
  };
}

function readyDecision(provider: string): GraphBuilderDecision {
  return {
    type: 'ready',
    summary: `${provider} provider contract completed`,
  };
}

const fixtures: readonly ProviderFixture[] = [
  {
    provider: 'openai',
    model: 'graph-builder-openai-contract-model',
    secret: 'RIVET_SYNTHETIC_OPENAI_POLICY_KEY',
    runtimeSettings: resolveProcessSettings({
      openAiApiKey: 'RIVET_SYNTHETIC_OPENAI_POLICY_KEY',
    }),
    expectedUrl: 'https://api.openai.com/v1/responses',
    assertAuthentication(headers, secret) {
      assert.equal(headers.get('authorization'), `Bearer ${secret}`);
    },
    assertRequestBody(body) {
      const text = body.text as { format?: { type?: unknown } } | undefined;
      assert.notEqual(text?.format?.type, 'json_schema');
      assert.equal(JSON.stringify(body).includes('graph_builder_decision'), false);
    },
    response(decisionText) {
      return {
        id: 'resp_graph_builder_contract',
        created_at: 1_700_000_000,
        model: 'graph-builder-openai-contract-model',
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: 'msg_graph_builder_contract',
            content: [
              {
                type: 'output_text',
                text: decisionText,
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      };
    },
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    secret: 'RIVET_SYNTHETIC_ANTHROPIC_POLICY_KEY',
    runtimeSettings: resolveProcessSettings({
      anthropicApiKey: 'RIVET_SYNTHETIC_ANTHROPIC_POLICY_KEY',
    }),
    expectedUrl: 'https://api.anthropic.com/v1/messages',
    assertAuthentication(headers, secret) {
      assert.equal(headers.get('x-api-key'), secret);
    },
    assertRequestBody(body) {
      const outputConfig = body.output_config as { format?: { type?: unknown } } | undefined;
      assert.notEqual(outputConfig?.format?.type, 'json_schema');
      assert.equal(JSON.stringify(body).includes('graph_builder_decision'), false);
    },
    response(decisionText) {
      return {
        type: 'message',
        id: 'msg_graph_builder_contract',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: decisionText }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      };
    },
  },
  {
    provider: 'google',
    model: 'graph-builder-google-contract-model',
    secret: 'RIVET_SYNTHETIC_GOOGLE_POLICY_KEY',
    runtimeSettings: resolveProcessSettings({
      googleApiKey: 'RIVET_SYNTHETIC_GOOGLE_POLICY_KEY',
    }),
    expectedUrl:
      'https://generativelanguage.googleapis.com/v1beta/models/graph-builder-google-contract-model:generateContent',
    assertAuthentication(headers, secret) {
      assert.equal(headers.get('x-goog-api-key'), secret);
    },
    assertRequestBody(body) {
      const generationConfig = body.generationConfig as
        | { responseMimeType?: unknown; responseSchema?: unknown }
        | undefined;
      assert.notEqual(generationConfig?.responseMimeType, 'application/json');
      assert.equal(generationConfig?.responseSchema, undefined);
      assert.equal(JSON.stringify(body).includes('graph_builder_decision'), false);
    },
    response(decisionText) {
      return {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: decisionText }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: inputTokens + outputTokens,
        },
      };
    },
  },
  {
    provider: 'custom',
    model: 'graph-builder-custom-contract-model',
    secret: 'RIVET_SYNTHETIC_CUSTOM_POLICY_KEY',
    runtimeSettings: resolveProcessSettings({
      customAiApiKey: 'RIVET_SYNTHETIC_CUSTOM_POLICY_KEY',
    }),
    expectedUrl: 'https://custom-policy.example.test/v1/chat/completions',
    assertAuthentication(headers, secret) {
      assert.equal(headers.get('authorization'), `Bearer ${secret}`);
    },
    assertRequestBody(body) {
      assert.equal('response_format' in body, false);
    },
    response(decisionText) {
      return {
        id: 'chatcmpl_graph_builder_contract',
        created: 1_700_000_000,
        model: 'graph-builder-custom-contract-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: decisionText,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };
    },
  },
];

test('real policy execution round-trips every supported provider wire contract', async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.provider, async () => {
      const originalFetch = globalThis.fetch;
      let requestCount = 0;
      let requestBody: Record<string, unknown> | undefined;
      const expectedDecision = readyDecision(fixture.provider);
      const decisionText = JSON.stringify(expectedDecision);

      globalThis.fetch = async (input, init) => {
        requestCount += 1;
        const request = input instanceof Request ? input.clone() : new Request(input, init);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, fixture.expectedUrl);
        fixture.assertAuthentication(request.headers, fixture.secret);
        assert.equal(request.headers.has(forbiddenHeaderName), false);

        const parsedBody: unknown = JSON.parse(await request.text());
        assert.ok(parsedBody != null && typeof parsedBody === 'object' && !Array.isArray(parsedBody));
        requestBody = parsedBody as Record<string, unknown>;
        fixture.assertRequestBody(requestBody);
        assert.equal(JSON.stringify(requestBody).includes(fixture.secret), false);
        assert.match(JSON.stringify(requestBody), new RegExp(`through the ${fixture.provider} wire protocol`));

        return Response.json(fixture.response(decisionText));
      };

      try {
        const runner = createGraphBuilderPolicyRunner({ loadPolicyProject });
        const result = await runner.execute(policyTurn(fixture.provider), {
          assistModel: {
            displayName: `${fixture.provider} contract`,
            provider: fixture.provider,
            model: fixture.model,
            ...(fixture.provider === 'custom'
              ? {
                  customProviderBaseURL: 'https://custom-policy.example.test/v1',
                }
              : {}),
          },
          runtimeSettings: {
            ...fixture.runtimeSettings,
            chatNodeHeaders: {
              [forbiddenHeaderName]: forbiddenHeaderValue,
            },
          },
          abortSignal: new AbortController().signal,
        });

        assert.equal(requestCount, 1);
        assert.ok(requestBody);
        assert.deepEqual(result.decision, expectedDecision);
        assert.deepEqual(result.usage, {
          inputTokens,
          outputTokens,
          completeness: 'partial',
        });
        assert.equal(JSON.stringify(result).includes(fixture.secret), false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
