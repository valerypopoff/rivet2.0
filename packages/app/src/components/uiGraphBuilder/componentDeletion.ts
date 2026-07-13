import type { ProjectId, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';

export type PendingUiGraphComponentDeletion = {
  componentId: UiComponentId;
  projectId: ProjectId;
  uiGraphId: UiGraphId;
};

export function getCurrentUiGraphComponentDeletionId(
  pendingDeletion: PendingUiGraphComponentDeletion | undefined,
  projectId: ProjectId,
  uiGraph: UiGraph | undefined,
): UiComponentId | undefined {
  if (
    pendingDeletion == null ||
    uiGraph == null ||
    pendingDeletion.projectId !== projectId ||
    pendingDeletion.uiGraphId !== uiGraph.id ||
    !uiGraph.components.some((component) => component.id === pendingDeletion.componentId)
  ) {
    return undefined;
  }

  return pendingDeletion.componentId;
}
