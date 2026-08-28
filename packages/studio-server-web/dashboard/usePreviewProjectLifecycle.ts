import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { RivetWorkspaceHost } from '../../app/src/host';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

export type PreviewWorkflowProject = {
  path: string;
  projectId: ProjectId;
};

type ProjectDirtyState = Record<ProjectId, boolean | undefined>;

type PreviewProjectLifecycleOptions = {
  currentProjectId: ProjectId | undefined;
  executorTargetType: string | undefined;
  graphRunning: boolean;
  projectDataUnsavedChanges: ProjectDirtyState;
  projectUnsavedChanges: ProjectDirtyState;
  workspaceHost: RivetWorkspaceHost;
};

export function usePreviewProjectLifecycle({
  currentProjectId,
  executorTargetType,
  graphRunning,
  projectDataUnsavedChanges,
  projectUnsavedChanges,
  workspaceHost,
}: PreviewProjectLifecycleOptions) {
  const [previewProject, setPreviewProject] = useState<PreviewWorkflowProject | null>(null);
  const previewProjectRef = useRef<PreviewWorkflowProject | null>(previewProject);
  const projectUnsavedChangesRef = useRef(projectUnsavedChanges);
  const projectDataUnsavedChangesRef = useRef(projectDataUnsavedChanges);
  const workspaceRef = useRef(workspaceHost);

  previewProjectRef.current = previewProject;
  projectUnsavedChangesRef.current = projectUnsavedChanges;
  projectDataUnsavedChangesRef.current = projectDataUnsavedChanges;
  workspaceRef.current = workspaceHost;

  const rememberPreviewProject = useCallback((project: PreviewWorkflowProject) => {
    previewProjectRef.current = project;
    setPreviewProject(project);
  }, []);

  const clearPreviewProject = useCallback((expectedProject?: PreviewWorkflowProject | null) => {
    if (
      expectedProject &&
      previewProjectRef.current &&
      previewProjectRef.current.projectId !== expectedProject.projectId
    ) {
      return;
    }

    previewProjectRef.current = null;
    setPreviewProject((currentPreview) => {
      if (expectedProject && currentPreview && currentPreview.projectId !== expectedProject.projectId) {
        return currentPreview;
      }

      return null;
    });
  }, []);

  const promotePreviewProject = useCallback((expectedProject?: PreviewWorkflowProject | null) => {
    const currentPreview = previewProjectRef.current;
    if (expectedProject && currentPreview && currentPreview.projectId !== expectedProject.projectId) {
      return;
    }

    const promotedProject = expectedProject ?? currentPreview;
    clearPreviewProject(expectedProject ?? undefined);
    if (!promotedProject) {
      return;
    }

    void workspaceRef.current
      .setProjectTabUiState(promotedProject.projectId, { preview: false })
      .then((updated) => {
        if (!updated) {
          console.warn('Promoted preview project was no longer open:', promotedProject.path);
        }
      })
      .catch((error) => {
        console.error('Failed to promote preview project tab:', error);
      });
  }, [clearPreviewProject]);

  const previewProjectIsSafelyReplaceable = useCallback((project: PreviewWorkflowProject): boolean => (
    projectUnsavedChangesRef.current[project.projectId] === false &&
    projectDataUnsavedChangesRef.current[project.projectId] === false
  ), []);

  const promotePreviewProjectByPath = useCallback((path: string | null | undefined) => {
    const preview = previewProjectRef.current;
    if (!preview || !path || normalizeWorkflowPath(preview.path) !== normalizeWorkflowPath(path)) {
      return;
    }

    promotePreviewProject(preview);
  }, [promotePreviewProject]);

  const promotePreviewProjectById = useCallback((projectId: ProjectId) => {
    const preview = previewProjectRef.current;
    if (!preview || preview.projectId !== projectId) {
      return;
    }

    promotePreviewProject(preview);
  }, [promotePreviewProject]);

  const clearPreviewProjectByPath = useCallback((path: string | null | undefined) => {
    const preview = previewProjectRef.current;
    if (!preview || !path || normalizeWorkflowPath(preview.path) !== normalizeWorkflowPath(path)) {
      return;
    }

    clearPreviewProject(preview);
  }, [clearPreviewProject]);

  useEffect(() => {
    if (!previewProject) {
      return;
    }

    if (
      projectUnsavedChanges[previewProject.projectId] === true ||
      projectDataUnsavedChanges[previewProject.projectId] === true
    ) {
      promotePreviewProject(previewProject);
    }
  }, [previewProject, projectUnsavedChanges, projectDataUnsavedChanges, promotePreviewProject]);

  useEffect(() => {
    if (graphRunning && previewProject?.projectId === currentProjectId) {
      promotePreviewProject(previewProject);
    }
  }, [currentProjectId, graphRunning, previewProject, promotePreviewProject]);

  useEffect(() => {
    if (executorTargetType === 'external-debugger' && previewProject?.projectId === currentProjectId) {
      promotePreviewProject(previewProject);
    }
  }, [currentProjectId, executorTargetType, previewProject, promotePreviewProject]);

  return useMemo(() => ({
    clearPreviewProject,
    clearPreviewProjectByPath,
    previewProjectIsSafelyReplaceable,
    previewProjectRef,
    promotePreviewProject,
    promotePreviewProjectById,
    promotePreviewProjectByPath,
    rememberPreviewProject,
  }), [
    clearPreviewProject,
    clearPreviewProjectByPath,
    previewProjectIsSafelyReplaceable,
    promotePreviewProject,
    promotePreviewProjectById,
    promotePreviewProjectByPath,
    rememberPreviewProject,
  ]);
}
