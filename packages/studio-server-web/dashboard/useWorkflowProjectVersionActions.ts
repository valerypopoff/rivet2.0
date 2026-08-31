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
  refresh,
  uploadingFolderPath,
}: {
  closeProjectContextMenu: () => void;
  onCompareOpenProjectWith: (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => void;
  openedWorkflowProject: WorkflowProjectItem | null;
  openedWorkflowProjectRef: MutableRefObject<WorkflowProjectItem | null>;
  projectContextMenuProject: WorkflowProjectItem | null;
  refresh: (showLoading?: boolean) => Promise<unknown>;
  uploadingFolderPath: string | null;
}) {
  const [projectModalState, setProjectModalState] = useState<WorkflowProjectModalState | null>(null);
  const [downloadState, setDownloadState] = useState<WorkflowActionState>(idleActionState);
  const [duplicateState, setDuplicateState] = useState<WorkflowActionState>(idleActionState);
  const [compareState, setCompareState] = useState<WorkflowActionState>(idleActionState);
  const downloadingProjectPath = downloadState.projectPath;
  const duplicatingProjectPath = duplicateState.projectPath;
  const comparingProjectPath = compareState.projectPath;

  const closeProjectModal = useCallback(() => {
    if (!downloadState.version && !duplicateState.version && !compareState.version) {
      setProjectModalState(null);
    }
  }, [compareState.version, downloadState.version, duplicateState.version]);

  const startDuplicateProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    options?: { closeModal?: boolean },
  ) => {
    setDuplicateState({ projectPath: project.relativePath, version });
    try {
      await duplicateWorkflowProjectVersion(project.relativePath, version);
      if (options?.closeModal) {
        setProjectModalState(null);
      }
      try {
        await refresh(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Project duplicated, but failed to refresh the tree');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to duplicate project');
    } finally {
      setDuplicateState((current) => (
        current.projectPath === project.relativePath && current.version === version ? idleActionState : current
      ));
    }
  }, [refresh]);

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

  const startDownloadProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    options?: { closeModal?: boolean },
  ) => {
    setDownloadState({ projectPath: project.relativePath, version });
    try {
      await downloadWorkflowProject(project.relativePath, version);
      if (options?.closeModal) {
        setProjectModalState(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to download project');
    } finally {
      setDownloadState((current) => (
        current.projectPath === project.relativePath && current.version === version ? idleActionState : current
      ));
    }
  }, []);

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

  const startCompareProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    options?: { closeModal?: boolean },
  ) => {
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
        !latestOpenedProject ||
        normalizeWorkflowPath(latestOpenedProject.absolutePath) !== normalizeWorkflowPath(openedProjectAtStart.absolutePath)
      ) {
        return;
      }
      onCompareOpenProjectWith(comparePath, referencePath, { referenceLabel, currentLabel });
      if (options?.closeModal) {
        setProjectModalState(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load compare reference');
    } finally {
      setCompareState((current) => (
        current.projectPath === project.relativePath && current.version === version ? idleActionState : current
      ));
    }
  }, [onCompareOpenProjectWith, openedWorkflowProjectRef]);

  const canCompareWithProject = useCallback((project: WorkflowProjectItem): boolean => Boolean(
    openedWorkflowProject &&
    normalizeWorkflowPath(openedWorkflowProject.absolutePath) !== normalizeWorkflowPath(project.absolutePath)
  ), [openedWorkflowProject]);
  const canCompareOpenedProjectToPublishedVersion = useCallback((project: WorkflowProjectItem): boolean => Boolean(
    openedWorkflowProject &&
    project.settings.status === 'unpublished_changes' &&
    normalizeWorkflowPath(openedWorkflowProject.absolutePath) === normalizeWorkflowPath(project.absolutePath)
  ), [openedWorkflowProject]);

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
      toast.error(error instanceof Error ? error.message : 'Failed to load the current published version');
    } finally {
      setCompareState((current) => (
        current.projectPath === project.relativePath && current.version === 'published' ? idleActionState : current
      ));
    }
  }, [
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
  const projectModalActiveVersion = projectModalProject == null
    ? null
    : projectModalMode === 'download'
      ? downloadingProjectPath === projectModalProject.relativePath ? downloadState.version : null
      : projectModalMode === 'duplicate'
        ? duplicatingProjectPath === projectModalProject.relativePath ? duplicateState.version : null
        : comparingProjectPath === projectModalProject.relativePath ? compareState.version : null;

  const selectProjectModalVersion = useCallback((version: WorkflowProjectDownloadVersion) => {
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
  }, [
    projectModalMode,
    projectModalProject,
    startCompareProject,
    startDownloadProject,
    startDuplicateProject,
  ]);

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
