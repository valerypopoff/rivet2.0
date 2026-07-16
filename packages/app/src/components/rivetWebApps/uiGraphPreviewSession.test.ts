import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import { clearUiGraphPreviewSessions, getUiGraphPreviewInteractionController } from './uiGraphPreviewSession.js';

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
