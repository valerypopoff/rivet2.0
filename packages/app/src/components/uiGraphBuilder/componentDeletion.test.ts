import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import { getCurrentUiGraphComponentDeletionIds, type PendingUiGraphComponentDeletion } from './componentDeletion.js';

const projectId = 'project' as ProjectId;
const uiGraphId = 'web-app' as UiGraphId;
const componentId = 'component' as UiComponentId;
const uiGraph = {
  components: [{ id: componentId }],
  id: uiGraphId,
} as UiGraph;

const pendingDeletion: PendingUiGraphComponentDeletion = { componentIds: [componentId], projectId, uiGraphId };

test('current component deletion resolves only for its originating project and web app', () => {
  assert.deepEqual(getCurrentUiGraphComponentDeletionIds(pendingDeletion, projectId, uiGraph), [componentId]);
  assert.deepEqual(getCurrentUiGraphComponentDeletionIds(pendingDeletion, 'other-project' as ProjectId, uiGraph), []);
  assert.deepEqual(
    getCurrentUiGraphComponentDeletionIds(
      { ...pendingDeletion, uiGraphId: 'other-web-app' as UiGraphId },
      projectId,
      uiGraph,
    ),
    [],
  );
});

test('current component deletion keeps only unique targets that still exist', () => {
  assert.deepEqual(
    getCurrentUiGraphComponentDeletionIds(
      { ...pendingDeletion, componentIds: [componentId, componentId, 'missing' as UiComponentId] },
      projectId,
      uiGraph,
    ),
    [componentId],
  );
});
