import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'react-toastify';

import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectOpenOptions,
  WorkflowProjectPathMove,
} from './types';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  renameWorkflowFolder,
  renameWorkflowProject,
  uploadWorkflowProject,
} from './workflowApi';
import { flattenFolders, flattenProjects } from './workflowLibraryHelpers';
import { useWorkflowLibraryActionLifetime } from './useWorkflowLibraryActionLifetime';
import {
  namespaceIdentity,
  isRecoveredMutationResult,
  MutationOutcomeUnknownError,
} from './workflowNamespaceMutations';
import {
  reconcileNamespaceMove,
  requiresFreshNamespaceTree,
  type LibraryMutationCompletion,
} from './workflowNamespaceReconciliation';
import { remapExpandedFolderIds, rewriteWorkflowPathPrefix } from './workflowTreeOps';

function normalizePromptValue(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function getRenamedFolderIds(
  folder: WorkflowFolderItem,
  sourceRelativePath: string,
  destinationRelativePath: string,
): string[] {
  return flattenFolders([folder]).map((childFolder) =>
    rewriteWorkflowPathPrefix(childFolder.id, sourceRelativePath, destinationRelativePath),
  );
}

async function pickWorkflowProjectFile(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] =
        (await (
          window as Window & {
            showOpenFilePicker?: (
              options?: Record<string, unknown>,
            ) => Promise<Array<{ getFile: () => Promise<File> }>>;
          }
        ).showOpenFilePicker?.({ multiple: false })) ?? [];
      return fileHandle ? fileHandle.getFile() : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }
      throw error;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.rivet-project';
    input.style.display = 'none';

    let settled = false;
    let focusTimerId: number | null = null;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (focusTimerId != null) {
        window.clearTimeout(focusTimerId);
      }
      window.removeEventListener('focus', handleWindowFocus, true);
      input.remove();
      resolve(file);
    };
    const handleWindowFocus = () => {
      focusTimerId = window.setTimeout(() => finish(input.files?.[0] ?? null), 300);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    window.addEventListener('focus', handleWindowFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

export function useWorkflowLibraryMutations({
  namespaceMutations = false,
  activePath,
  applyProjectPathMoves,
  folders,
  onOpenProject,
  reconcileTree,
  rootProjects,
  setExpandedFolders,
  setFolders,
  setRootProjects,
  suppressAncestorExpansion,
}: {
  namespaceMutations?: boolean;
  activePath: string;
  applyProjectPathMoves: (moves: WorkflowProjectPathMove[]) => Promise<void>;
  folders: WorkflowFolderItem[];
  onOpenProject: (path: string, options?: WorkflowProjectOpenOptions) => void;
  reconcileTree: LibraryMutationCompletion;
  rootProjects: WorkflowProjectItem[];
  setExpandedFolders: Dispatch<SetStateAction<Record<string, boolean>>>;
  setFolders: Dispatch<SetStateAction<WorkflowFolderItem[]>>;
  setRootProjects: Dispatch<SetStateAction<WorkflowProjectItem[]>>;
  suppressAncestorExpansion: (folderIds: string[]) => void;
}) {
  const [uploadingFolderPath, setUploadingFolderPath] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [editingProjectPath, setEditingProjectPath] = useState<string | null>(null);
  const [renamingProjectPath, setRenamingProjectPath] = useState<string | null>(null);
  const [treeMutationCount, setTreeMutationCount] = useState(0);
  const folderRenameSource = useRef<WorkflowFolderItem | null>(null);
  const projectRenameSource = useRef<WorkflowProjectItem | null>(null);
  const captureAction = useWorkflowLibraryActionLifetime(activePath);

  const runTreeMutation = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setTreeMutationCount((current) => current + 1);
      try {
        return await operation();
      } catch (error) {
        if (error instanceof MutationOutcomeUnknownError) reconcileTree(error.message);
        throw error;
      } finally {
        setTreeMutationCount((current) => Math.max(0, current - 1));
      }
    },
    [reconcileTree],
  );

  const clearInlineEditing = useCallback(() => {
    folderRenameSource.current = null;
    projectRenameSource.current = null;
    setEditingFolderId(null);
    setEditingProjectPath(null);
  }, []);

  const createFolder = useCallback(
    async (parent?: WorkflowFolderItem) => {
      const isCurrent = captureAction();
      const name = normalizePromptValue(
        prompt(parent ? `New folder name in folder "${parent.name}":` : 'New folder name:'),
      );
      if (!name) {
        return;
      }
      try {
        const folder = await runTreeMutation(() =>
          createWorkflowFolder(
            name,
            parent?.relativePath,
            parent?.namespaceId ?? (namespaceMutations && !parent ? null : undefined),
          ),
        );
        reconcileTree('Folder created, but library synchronization is pending.', (tree) => {
          if (!isCurrent() || !tree) return;
          const folders = flattenFolders(tree.folders);
          const current = folders.find((item) =>
            folder.namespaceId ? item.namespaceId === folder.namespaceId : item.id === folder.id,
          );
          if (!current) return;
          const ancestors = folders.filter(
            (item) =>
              current.relativePath === item.relativePath || current.relativePath.startsWith(`${item.relativePath}/`),
          );
          setExpandedFolders((previous) => ({
            ...previous,
            ...Object.fromEntries(ancestors.map((item) => [item.id, true])),
          }));
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to create folder');
      }
    },
    [captureAction, namespaceMutations, reconcileTree, runTreeMutation, setExpandedFolders],
  );

  const startFolderRename = useCallback((folder: WorkflowFolderItem) => {
    folderRenameSource.current = folder;
    projectRenameSource.current = null;
    setEditingProjectPath(null);
    setEditingFolderId(folder.id);
  }, []);
  const cancelFolderRename = useCallback((folder: WorkflowFolderItem) => {
    folderRenameSource.current = null;
    setEditingFolderId((current) => (current === folder.id ? null : current));
  }, []);
  const submitFolderRename = useCallback(
    async (renderedFolder: WorkflowFolderItem, rawName: string) => {
      const isCurrent = captureAction();
      const folder = folderRenameSource.current ?? renderedFolder;
      folderRenameSource.current = null;
      const newName = normalizePromptValue(rawName);
      if (!newName || newName === folder.name) {
        setEditingFolderId(null);
        return;
      }

      setEditingFolderId(null);
      setRenamingFolderId(folder.id);
      try {
        const result = await runTreeMutation(() =>
          renameWorkflowFolder(folder.relativePath, newName, namespaceIdentity(folder)),
        );
        if (!requiresFreshNamespaceTree(result) && isCurrent()) {
          if (result.movedProjectPaths.some((move) => move.fromAbsolutePath === activePath)) {
            suppressAncestorExpansion(getRenamedFolderIds(folder, folder.relativePath, result.folder.relativePath));
          }
          setExpandedFolders((previous) =>
            remapExpandedFolderIds(previous, folder.relativePath, result.folder.relativePath),
          );
        }
        await reconcileNamespaceMove({
          result,
          sourceFolder: folder,
          folders,
          rootProjects,
          setFolders,
          setRootProjects,
          applyProjectPathMoves,
          reconcileTree,
          afterRead: (tree) => {
            if (!isCurrent() || !tree || !result.folder.namespaceId) return;
            const current = flattenFolders(tree.folders).find((item) => item.namespaceId === result.folder.namespaceId);
            if (current && result.movedProjectPaths.some((move) => move.fromAbsolutePath === activePath))
              suppressAncestorExpansion(getRenamedFolderIds(folder, folder.relativePath, current.relativePath));
          },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to rename folder');
      } finally {
        setRenamingFolderId((current) => (current === folder.id ? null : current));
      }
    },
    [
      activePath,
      applyProjectPathMoves,
      captureAction,
      folders,
      reconcileTree,
      rootProjects,
      runTreeMutation,
      setExpandedFolders,
      setFolders,
      setRootProjects,
      suppressAncestorExpansion,
    ],
  );

  const startProjectRename = useCallback((project: WorkflowProjectItem) => {
    projectRenameSource.current = project;
    folderRenameSource.current = null;
    setEditingFolderId(null);
    setEditingProjectPath(project.absolutePath);
  }, []);
  const cancelProjectRename = useCallback((project: WorkflowProjectItem) => {
    projectRenameSource.current = null;
    setEditingProjectPath((current) => (current === project.absolutePath ? null : current));
  }, []);
  const submitProjectRename = useCallback(
    async (renderedProject: WorkflowProjectItem, rawName: string) => {
      const project = projectRenameSource.current ?? renderedProject;
      projectRenameSource.current = null;
      const newName = normalizePromptValue(rawName);
      if (!newName || newName === project.name) {
        setEditingProjectPath(null);
        return;
      }

      setEditingProjectPath(null);
      setRenamingProjectPath(project.absolutePath);
      try {
        const result = await runTreeMutation(() =>
          renameWorkflowProject(project.relativePath, newName, namespaceIdentity(project)),
        );
        await reconcileNamespaceMove({
          result,
          sourceProject: project,
          folders,
          rootProjects,
          setFolders,
          setRootProjects,
          applyProjectPathMoves,
          reconcileTree,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to rename project');
      } finally {
        setRenamingProjectPath((current) => (current === project.absolutePath ? null : current));
      }
    },
    [applyProjectPathMoves, folders, reconcileTree, rootProjects, runTreeMutation, setFolders, setRootProjects],
  );

  const addProject = useCallback(
    async (folder: WorkflowFolderItem) => {
      const isCurrent = captureAction();
      const name = normalizePromptValue(prompt(`New Rivet project name in folder "${folder.name}":`));
      if (!name) {
        return;
      }
      try {
        const project = await runTreeMutation(() =>
          createWorkflowProject(folder.relativePath, name, folder.namespaceId),
        );
        const recovered = isRecoveredMutationResult(project);
        reconcileTree('Project created, but library synchronization is pending.', (tree) => {
          if (!isCurrent() || recovered || project.namespaceProtocol !== 1 || !tree) return;
          const current = [...tree.projects, ...flattenProjects(tree.folders)].find(
            (item) => item.projectMetadataId === project.projectMetadataId,
          );
          if (!current) return;
          const ancestors = flattenFolders(tree.folders).filter((item) =>
            current.relativePath.startsWith(`${item.relativePath}/`),
          );
          setExpandedFolders((previous) => ({
            ...previous,
            ...Object.fromEntries(ancestors.map((item) => [item.id, true])),
          }));
          onOpenProject(current.absolutePath, { title: current.name, expectedProjectId: current.projectMetadataId });
        });
        if (isCurrent() && !recovered && project.namespaceProtocol !== 1) {
          setExpandedFolders((previous) => ({ ...previous, [folder.id]: true }));
          onOpenProject(project.absolutePath, { title: project.name, expectedProjectId: project.projectMetadataId });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to create project');
      }
    },
    [captureAction, onOpenProject, reconcileTree, runTreeMutation, setExpandedFolders],
  );

  const deleteFolder = useCallback(
    async (folder: WorkflowFolderItem) => {
      if (!window.confirm(`Delete empty folder "${folder.name}"?`)) {
        return;
      }
      try {
        await runTreeMutation(() => deleteWorkflowFolder(folder.relativePath, namespaceIdentity(folder)));
        reconcileTree('Folder deleted, but library synchronization is pending.');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to delete folder');
      }
    },
    [reconcileTree, runTreeMutation],
  );

  const uploadProject = useCallback(
    async (folder: WorkflowFolderItem) => {
      let selectedFile: File | null;
      try {
        selectedFile = await pickWorkflowProjectFile();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to open upload picker');
        return;
      }
      if (!selectedFile) {
        return;
      }
      if (!selectedFile.name.toLowerCase().endsWith('.rivet-project')) {
        toast.error('Choose a .rivet-project file to upload');
        return;
      }

      setUploadingFolderPath(folder.relativePath);
      try {
        const contents = await selectedFile.text();
        await runTreeMutation(() =>
          uploadWorkflowProject(folder.relativePath, selectedFile.name, contents, folder.namespaceId),
        );
        reconcileTree('Project uploaded, but library synchronization is pending.');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to upload project');
      } finally {
        setUploadingFolderPath((current) => (current === folder.relativePath ? null : current));
      }
    },
    [reconcileTree, runTreeMutation],
  );

  return {
    addProject,
    cancelFolderRename,
    cancelProjectRename,
    clearInlineEditing,
    createFolder,
    deleteFolder,
    editingFolderId,
    editingProjectPath,
    renamingFolderId,
    renamingProjectPath,
    startFolderRename,
    startProjectRename,
    submitFolderRename,
    submitProjectRename,
    treeMutationPending: treeMutationCount > 0,
    uploadProject,
    uploadingFolderPath,
  };
}
