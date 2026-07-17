import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import {
  clearUiGraphPreviewSession,
  clearUiGraphPreviewSessions,
  getUiGraphPreviewInteractionController,
} from './uiGraphPreviewSession.js';

test('editor preview sessions preserve state for an open project and graph', () => {
  const projectId = 'preview-project' as ProjectId;
  const uiGraph = {
    components: [{ id: 'input' as UiComponentId, label: 'Input', stateKey: 'value', type: 'input' as const }],
    id: 'preview-graph' as UiGraphId,
    name: 'Preview',
  } satisfies UiGraph;

  const firstController = getUiGraphPreviewInteractionController(projectId, uiGraph);
  firstController.updateState('value', 'remember me');
  const secondController = getUiGraphPreviewInteractionController(projectId, uiGraph);

  assert.equal(secondController, firstController);
  assert.equal(secondController.getSnapshot().state.value, 'remember me');

  clearUiGraphPreviewSessions(projectId);
  const reopenedController = getUiGraphPreviewInteractionController(projectId, uiGraph);
  assert.notEqual(reopenedController, firstController);
  assert.equal(reopenedController.getSnapshot().state.value, '');

  clearUiGraphPreviewSessions(projectId);
});

test('clearing one editor preview aborts only that UI graph action', async () => {
  const projectId = 'preview-project-actions' as ProjectId;
  const firstUiGraph = makeActionUiGraph('first-preview');
  const secondUiGraph = makeActionUiGraph('second-preview');
  const firstController = getUiGraphPreviewInteractionController(projectId, firstUiGraph);
  const secondController = getUiGraphPreviewInteractionController(projectId, secondUiGraph);
  const firstRun = deferred();
  const secondRun = deferred();
  let firstSignal: AbortSignal | undefined;
  let secondSignal: AbortSignal | undefined;

  const firstAction = firstUiGraph.components[0];
  const secondAction = secondUiGraph.components[0];
  if (firstAction?.type !== 'button' || secondAction?.type !== 'button') {
    throw new Error('Expected button actions in the test UI graphs.');
  }
  const firstActionPromise = firstController.runAction(firstAction, ({ signal }) => {
    firstSignal = signal;
    return firstRun.promise;
  });
  const secondActionPromise = secondController.runAction(secondAction, ({ signal }) => {
    secondSignal = signal;
    return secondRun.promise;
  });

  clearUiGraphPreviewSession(projectId, firstUiGraph.id);

  assert.equal(firstSignal?.aborted, true);
  assert.equal(secondSignal?.aborted, false);
  assert.notEqual(getUiGraphPreviewInteractionController(projectId, firstUiGraph), firstController);
  assert.equal(getUiGraphPreviewInteractionController(projectId, secondUiGraph), secondController);

  firstRun.resolve();
  secondRun.resolve();
  await Promise.all([firstActionPromise, secondActionPromise]);
  clearUiGraphPreviewSessions(projectId);
});

function makeActionUiGraph(id: string): UiGraph {
  return {
    components: [
      {
        action: { type: 'runGraph' },
        id: 'run' as UiComponentId,
        label: 'Run',
        type: 'button',
      },
    ],
    id: id as UiGraphId,
    name: id,
  };
}

function deferred(): { promise: Promise<{ statePatch?: Record<string, unknown> }>; resolve(): void } {
  let resolvePromise!: () => void;
  return {
    promise: new Promise((resolve) => {
      resolvePromise = () => resolve({});
    }),
    resolve: () => resolvePromise(),
  };
}
