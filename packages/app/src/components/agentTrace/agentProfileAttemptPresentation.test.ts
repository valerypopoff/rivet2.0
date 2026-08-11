import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentLLMProfileAttemptTrace, NodeId, ProcessId } from '@valerypopoff/rivet2-core';
import { buildAgentProfileAttemptInspectorRows } from './agentProfileAttemptPresentation.js';

const baseAttempt = {
  roundIndex: 0,
  profileIndex: 0,
  nodeId: 'chat' as NodeId,
  processId: 'chat-process' as ProcessId,
  provider: 'custom',
  customProviderApi: 'responses',
  model: 'fast-provider',
} satisfies Pick<
  AgentLLMProfileAttemptTrace,
  'roundIndex' | 'profileIndex' | 'nodeId' | 'processId' | 'provider' | 'customProviderApi' | 'model'
>;

test('presents circuit skips, fail-open decisions, and timeout failures for Response Inspector', () => {
  const rows = buildAgentProfileAttemptInspectorRows([
    {
      ...baseAttempt,
      eventId: 'open-gate',
      stage: 'health-gate',
      outcome: 'skipped',
      healthState: 'open',
      healthDisposition: 'deny',
    },
    {
      ...baseAttempt,
      eventId: 'store-fail-open',
      stage: 'health-gate',
      outcome: 'failure',
      healthDisposition: 'fail-open',
      error: 'Health store unavailable',
    },
    {
      ...baseAttempt,
      eventId: 'first-output-timeout',
      stage: 'request',
      outcome: 'failure',
      timeoutKind: 'first-output',
    },
  ]);

  assert.deepEqual(rows, [
    {
      eventId: 'open-gate',
      providerAndModel: 'Custom Responses / fast-provider',
      context: 'circuit gate / skipped while circuit is open / profile 1 / round 1',
    },
    {
      eventId: 'store-fail-open',
      providerAndModel: 'Custom Responses / fast-provider',
      context: 'circuit gate / health store failed open; profile request continued / profile 1 / round 1',
      error: 'Health store unavailable',
    },
    {
      eventId: 'first-output-timeout',
      providerAndModel: 'Custom Responses / fast-provider',
      context: 'request / first output timed out / profile 1 / round 1',
    },
  ]);
});
