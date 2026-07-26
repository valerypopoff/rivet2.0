import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphBuilderSessionViewState } from './sessionController.js';
import { isGraphBuilderSessionWorking, selectGraphBuilderSessionState } from './sessionPresentation.js';

const legacyState: GraphBuilderSessionViewState = {
  status: 'editing',
  sessionId: 'legacy',
  policyAttempts: 1,
  progress: 'Editing',
};
const planBState: GraphBuilderSessionViewState = {
  status: 'awaiting-user',
  sessionId: 'plan-b',
  question: 'Clarify',
  resumeToken: 'resume',
  expiresAt: 1,
};

test('modal presentation selects only the implementation latched for the session', () => {
  const states = { legacy: legacyState, planB: planBState };

  assert.equal(selectGraphBuilderSessionState('legacy', states), legacyState);
  assert.equal(selectGraphBuilderSessionState('plan-b', states), planBState);
  assert.equal(selectGraphBuilderSessionState(undefined, states), undefined);
});

test('only generation phases are presented as cancelable work', () => {
  for (const status of ['gathering-context', 'editing', 'repairing'] as const) {
    assert.equal(
      isGraphBuilderSessionWorking({
        status,
        sessionId: status,
        policyAttempts: 0,
        progress: status,
      }),
      true,
    );
  }

  assert.equal(isGraphBuilderSessionWorking(planBState), false);
  assert.equal(
    isGraphBuilderSessionWorking({
      status: 'ready-for-preview',
      sessionId: 'preview',
      preview: {
        summary: 'Preview',
        draftRevision: 1,
        delta: {
          graphId: 'graph',
          addedNodes: [],
          updatedNodes: [],
          removedNodes: [],
          addedConnections: [],
          removedConnections: [],
        },
        diagnostics: [],
      },
    }),
    false,
  );
  assert.equal(isGraphBuilderSessionWorking(undefined), false);
});
