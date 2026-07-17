import type { ProjectId, UiGraph, UiGraphId, UiGraphInteractionController } from '@valerypopoff/rivet2-core';
import { createUiGraphInteractionController } from '@valerypopoff/rivet2-core';

const sessionsByProjectId = new Map<ProjectId, Map<UiGraphId, UiGraphInteractionController>>();

export function getUiGraphPreviewInteractionController(
  projectId: ProjectId,
  uiGraph: UiGraph,
): UiGraphInteractionController {
  let sessions = sessionsByProjectId.get(projectId);
  if (!sessions) {
    sessions = new Map();
    sessionsByProjectId.set(projectId, sessions);
  }

  let controller = sessions.get(uiGraph.id);
  if (!controller) {
    controller = createUiGraphInteractionController(uiGraph);
    sessions.set(uiGraph.id, controller);
  }

  return controller;
}

/** Aborts and removes one editor-only preview session, for example when its UI graph is deleted. */
export function clearUiGraphPreviewSession(projectId: ProjectId, uiGraphId: UiGraphId): void {
  const sessions = sessionsByProjectId.get(projectId);
  const controller = sessions?.get(uiGraphId);
  if (!sessions || !controller) {
    return;
  }

  controller.abortActions();
  sessions.delete(uiGraphId);
  if (sessions.size === 0) {
    sessionsByProjectId.delete(projectId);
  }
}

export function clearUiGraphPreviewSessions(projectId: ProjectId): void {
  const sessions = sessionsByProjectId.get(projectId);
  if (!sessions) {
    return;
  }

  for (const controller of sessions.values()) {
    controller.abortActions();
  }
  sessionsByProjectId.delete(projectId);
}
