import type { ProjectId, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';

export type PendingUiGraphComponentDeletion = {
  componentIds: readonly UiComponentId[];
  projectId: ProjectId;
  uiGraphId: UiGraphId;
};

export function getCurrentUiGraphComponentDeletionIds(
  pendingDeletion: PendingUiGraphComponentDeletion | undefined,
  projectId: ProjectId,
  uiGraph: UiGraph | undefined,
): UiComponentId[] {
  if (
    pendingDeletion == null ||
    uiGraph == null ||
    pendingDeletion.projectId !== projectId ||
    pendingDeletion.uiGraphId !== uiGraph.id
  ) {
    return [];
  }

  const existingComponentIds = new Set(uiGraph.components.map((component) => component.id));
  return [...new Set(pendingDeletion.componentIds)].filter((componentId) => existingComponentIds.has(componentId));
}
