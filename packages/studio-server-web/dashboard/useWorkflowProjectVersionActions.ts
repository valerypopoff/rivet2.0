import { useCallback, useState, type MutableRefObject } from 'react';
import { toast } from 'react-toastify';

import { getWorkflowPublishedVersionPreviewVirtualProjectPath } from '../../studio-server-shared/workflow-types';
import type { ProjectCompareSideLabels } from '../../studio-server-shared/editor-bridge';
import type { WorkflowProjectDownloadVersion, WorkflowProjectItem } from './types';
import {
  downloadWorkflowProject,
  duplicateWorkflowProjectVersion,
  fetchCurrentWorkflowPublishedVersion,
} from './workflowApi';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';
import { MutationOutcomeUnknownError } from './workflowNamespaceMutations';
import { useWorkflowLibraryActionLifetime } from './useWorkflowLibraryActionLifetime';

export type WorkflowProjectModalState = {
  mode: 'download' | 'duplicate' | 'compare';
  project: WorkflowProjectItem;
};

type WorkflowActionState = {
  projectPath: string | null;
  version: WorkflowProjectDownloadVersion | null;
};

const idleActionState: WorkflowActionState = { projectPath: null, version: null };

export function useWorkflowProjectVersionActions({
  closeProjectContextMenu,
  onCompareOpenProjectWith,
  openedWorkflowProject,
  openedWorkflowProjectRef,
  projectContextMenuProject,
  reconcileTree,
  uploadingFolderPath,
}: {
  closeProjectContextMenu: () => void;
  onCompareOpenProjectWith: (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => void;
  openedWorkflowProject: WorkflowProjectItem | null;
  openedWorkflowProjectRef: MutableRefObject<WorkflowProjectItem | null>;
  projectContextMenuProject: WorkflowProjectItem | null;
  reconcileTree: (message: string) => void;
  uploadingFolderPath: string | null;
}) {
  const [projectModalState, setProjectModalState] = useState<WorkflowProjectModalState | null>(null);
  const [downloadState, setDownloadState] = useState<WorkflowActionState>(idleActionState);
  const [duplicateState, setDuplicateState] = useState<WorkflowActionState>(idleActionState);
  const [compareState, setCompareState] = useState<WorkflowActionState>(idleActionState);
  const downloadingProjectPath = downloadState.projectPath;
  const duplicatingProjectPath = duplicateState.projectPath;
  const comparingProjectPath = compareState.projectPath;
  const captureAction = useWorkflowLibraryActionLifetime(
    openedWorkflowProject?.projectMetadataId ?? openedWorkflowProject?.absolutePath,
  );

  const closeProjectModal = useCallback(() => {
    if (!downloadState.version && !duplicateState.version && !compareState.version) {
      setProjectModalState(null);
    }
  }, [compareState.version, downloadState.version, duplicateState.version]);

  const startDuplicateProject = useCallback(
    async (
      project: WorkflowProjectItem,
      version: WorkflowProjectDownloadVersion,
      options?: { closeModal?: boolean },
    ) => {
      const isCurrent = captureAction();
      setDuplicateState({ projectPath: project.relativePath, version });
      try {
        await duplicateWorkflowProjectVersion(project.relativePath, version, project);
        if (options?.closeModal && isCurrent()) {
          setProjectModalState((current) =>
            current?.mode === 'duplicate' && current.project === project ? null : current,
          );
        }
        reconcileTree('Project duplicated, but library synchronization is pending.');
      } catch (error) {
        if (error instanceof MutationOutcomeUnknownError) reconcileTree(error.message);
        if (isCurrent()) toast.error(error instanceof Error ? error.message : 'Failed to duplicate project');
      } finally {
        setDuplicateState((current) =>
          current.projectPath === project.relativePath && current.version === version ? idleActionState : current,
        );
      }
    },
    [captureAction, reconcileTree],
  );

  const handleDuplicateProject = useCallback(() => {
    const project = projectContextMenuProject;
    if (!project || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }
    closeProjectContextMenu();
    if (project.settings.status === 'unpublished_changes') {
      setProjectModalState({ mode: 'duplicate', project });
      return;
    }
    void startDuplicateProject(project, project.settings.status === 'published' ? 'published' : 'live');
  }, [
    closeProjectContextMenu,
    duplicatingProjectPath,
    projectContextMenuProject,
    startDuplicateProject,
    uploadingFolderPath,
  ]);

  const startDownloadProject = useCallback(
    async (
      project: WorkflowProjectItem,
      version: WorkflowProjectDownloadVersion,
      options?: { closeModal?: boolean },
    ) => {
      const isCurrent = captureAction();
      setDownloadState({ projectPath: project.relativePath, version });
      try {
        await downloadWorkflowProject(project.relativePath, version);
        if (options?.closeModal && isCurrent()) {
          setProjectModalState((current) =>
            current?.mode === 'download' && current.project === project ? null : current,
          );
        }
      } catch (error) {
        if (isCurrent()) toast.error(error instanceof Error ? error.message : 'Failed to download project');
      } finally {
        setDownloadState((current) =>
          current.projectPath === project.relativePath && current.version === version ? idleActionState : current,
        );
      }
    },
    [captureAction],
  );

  const handleDownloadProject = useCallback(() => {
    const project = projectContextMenuProject;
    if (!project || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }
    closeProjectContextMenu();
    if (project.settings.status === 'unpublished_changes') {
      setProjectModalState({ mode: 'download', project });
      return;
    }
    void startDownloadProject(project, project.settings.status === 'published' ? 'published' : 'live');
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    projectContextMenuProject,
    startDownloadProject,
    uploadingFolderPath,
  ]);

  const startCompareProject = useCallback(
    async (
      project: WorkflowProjectItem,
      version: WorkflowProjectDownloadVersion,
      options?: { closeModal?: boolean },
    ) => {
      const isCurrent = captureAction();
      const openedProjectAtStart = openedWorkflowProjectRef.current;
      if (
        !openedProjectAtStart ||
        normalizeWorkflowPath(openedProjectAtStart.absolutePath) === normalizeWorkflowPath(project.absolutePath)
      ) {
        return;
      }

      setCompareState({ projectPath: project.relativePath, version });
      try {
        const includeVersionInLabel = project.settings.status === 'unpublished_changes';
        const currentLabel = openedProjectAtStart.name;
        let comparePath = project.absolutePath;
        let referencePath = project.relativePath || project.fileName;
        let referenceLabel = includeVersionInLabel ? `${project.name} (Unpublished changes)` : project.name;
        if (version === 'published') {
          const currentVersion = await fetchCurrentWorkflowPublishedVersion(project.relativePath);
          comparePath = getWorkflowPublishedVersionPreviewVirtualProjectPath(project.relativePath, currentVersion.id);
          referencePath = `Published version of ${project.fileName}`;
          referenceLabel = includeVersionInLabel ? `${project.name} (Published)` : project.name;
        }

        const latestOpenedProject = openedWorkflowProjectRef.current;
        if (
          !isCurrent() ||
          !latestOpenedProject ||
          normalizeWorkflowPath(latestOpenedProject.absolutePath) !==
            normalizeWorkflowPath(openedProjectAtStart.absolutePath)
        ) {
          return;
        }
        onCompareOpenProjectWith(comparePath, referencePath, { referenceLabel, currentLabel });
        if (options?.closeModal) {
          setProjectModalState((current) =>
            current?.mode === 'compare' && current.project === project ? null : current,
          );
        }
      } catch (error) {
        if (isCurrent()) toast.error(error instanceof Error ? error.message : 'Failed to load compare reference');
      } finally {
        setCompareState((current) =>
          current.projectPath === project.relativePath && current.version === version ? idleActionState : current,
        );
      }
    },
    [captureAction, onCompareOpenProjectWith, openedWorkflowProjectRef],
  );

  const canCompareWithProject = useCallback(
    (project: WorkflowProjectItem): boolean =>
      Boolean(
        openedWorkflowProject &&
          normalizeWorkflowPath(openedWorkflowProject.absolutePath) !== normalizeWorkflowPath(project.absolutePath),
      ),
    [openedWorkflowProject],
  );
  const canCompareOpenedProjectToPublishedVersion = useCallback(
    (project: WorkflowProjectItem): boolean =>
      Boolean(
        openedWorkflowProject &&
          project.settings.status === 'unpublished_changes' &&
          normalizeWorkflowPath(openedWorkflowProject.absolutePath) === normalizeWorkflowPath(project.absolutePath),
      ),
    [openedWorkflowProject],
  );

  const handleCompareProjectFromContextMenu = useCallback(() => {
    const project = projectContextMenuProject;
    if (
      !project ||
      !canCompareWithProject(project) ||
      comparingProjectPath ||
      downloadingProjectPath ||
      duplicatingProjectPath ||
      uploadingFolderPath
    ) {
      return;
    }
    closeProjectContextMenu();
    if (project.settings.status === 'unpublished_changes') {
      setProjectModalState({ mode: 'compare', project });
      return;
    }
    void startCompareProject(project, 'live');
  }, [
    canCompareWithProject,
    closeProjectContextMenu,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    projectContextMenuProject,
    startCompareProject,
    uploadingFolderPath,
  ]);

  const handleCompareOpenedProjectToPublishedVersionFromContextMenu = useCallback(async () => {
    const isCurrent = captureAction();
    const project = projectContextMenuProject;
    if (
      !project ||
      !canCompareOpenedProjectToPublishedVersion(project) ||
      comparingProjectPath ||
      downloadingProjectPath ||
      duplicatingProjectPath ||
      uploadingFolderPath
    ) {
      return;
    }
    closeProjectContextMenu();
    setCompareState({ projectPath: project.relativePath, version: 'published' });
    try {
      const currentVersion = await fetchCurrentWorkflowPublishedVersion(project.relativePath);
      const previewPath = getWorkflowPublishedVersionPreviewVirtualProjectPath(project.relativePath, currentVersion.id);
      const latestOpenedProject = openedWorkflowProjectRef.current;
      if (
        !isCurrent() ||
        !latestOpenedProject ||
        latestOpenedProject.settings.status !== 'unpublished_changes' ||
        normalizeWorkflowPath(latestOpenedProject.absolutePath) !== normalizeWorkflowPath(project.absolutePath)
      ) {
        return;
      }
      onCompareOpenProjectWith(previewPath, `Published version of ${project.fileName}`, {
        referenceLabel: 'Published',
        currentLabel: 'Unpublished',
      });
    } catch (error) {
      if (isCurrent())
        toast.error(error instanceof Error ? error.message : 'Failed to load the current published version');
    } finally {
      setCompareState((current) =>
        current.projectPath === project.relativePath && current.version === 'published' ? idleActionState : current,
      );
    }
  }, [
    captureAction,
    canCompareOpenedProjectToPublishedVersion,
    closeProjectContextMenu,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    onCompareOpenProjectWith,
    openedWorkflowProjectRef,
    projectContextMenuProject,
    uploadingFolderPath,
  ]);

  const projectModalProject = projectModalState?.project ?? null;
  const projectModalMode = projectModalState?.mode ?? 'download';
  const projectModalActiveVersion =
    projectModalProject == null
      ? null
      : projectModalMode === 'download'
        ? downloadingProjectPath === projectModalProject.relativePath
          ? downloadState.version
          : null
        : projectModalMode === 'duplicate'
          ? duplicatingProjectPath === projectModalProject.relativePath
            ? duplicateState.version
            : null
          : comparingProjectPath === projectModalProject.relativePath
            ? compareState.version
            : null;

  const selectProjectModalVersion = useCallback(
    (version: WorkflowProjectDownloadVersion) => {
      if (!projectModalProject) {
        return;
      }
      if (projectModalMode === 'download') {
        void startDownloadProject(projectModalProject, version, { closeModal: true });
      } else if (projectModalMode === 'duplicate') {
        void startDuplicateProject(projectModalProject, version, { closeModal: true });
      } else {
        void startCompareProject(projectModalProject, version, { closeModal: true });
      }
    },
    [projectModalMode, projectModalProject, startCompareProject, startDownloadProject, startDuplicateProject],
  );

  return {
    canCompareOpenedProjectToPublishedVersion,
    canCompareWithProject,
    closeProjectModal,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    handleCompareOpenedProjectToPublishedVersionFromContextMenu,
    handleCompareProjectFromContextMenu,
    handleDownloadProject,
    handleDuplicateProject,
    handleProjectModalSelectPublished: () => selectProjectModalVersion('published'),
    handleProjectModalSelectUnpublishedChanges: () => selectProjectModalVersion('live'),
    projectModalActiveVersion,
    projectModalMode,
    projectModalProject,
  };
}
