import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import { getCurrentUiGraphComponentDeletionId, type PendingUiGraphComponentDeletion } from './componentDeletion.js';

const projectId = 'project' as ProjectId;
const uiGraphId = 'web-app' as UiGraphId;
const componentId = 'component' as UiComponentId;
const uiGraph = {
  components: [{ id: componentId }],
  id: uiGraphId,
} as UiGraph;

const pendingDeletion: PendingUiGraphComponentDeletion = { componentId, projectId, uiGraphId };

test('current component deletion resolves only for its originating project and web app', () => {
  assert.equal(getCurrentUiGraphComponentDeletionId(pendingDeletion, projectId, uiGraph), componentId);
  assert.equal(getCurrentUiGraphComponentDeletionId(pendingDeletion, 'other-project' as ProjectId, uiGraph), undefined);
  assert.equal(
    getCurrentUiGraphComponentDeletionId(
      { ...pendingDeletion, uiGraphId: 'other-web-app' as UiGraphId },
      projectId,
      uiGraph,
    ),
    undefined,
  );
});

test('current component deletion closes safely when the target component no longer exists', () => {
  assert.equal(
    getCurrentUiGraphComponentDeletionId(pendingDeletion, projectId, { ...uiGraph, components: [] } as UiGraph),
    undefined,
  );
});
