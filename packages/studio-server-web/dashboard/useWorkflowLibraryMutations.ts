import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
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
import { flattenFolders } from './workflowLibraryHelpers';
import {
  applyFolderMoveToTree,
  applyProjectMoveToTree,
  remapExpandedFolderIds,
  rewriteWorkflowPathPrefix,
} from './workflowTreeOps';

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
    rewriteWorkflowPathPrefix(childFolder.id, sourceRelativePath, destinationRelativePath));
}

async function pickWorkflowProjectFile(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] = await (window as Window & {
        showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<Array<{ getFile: () => Promise<File> }>>;
      }).showOpenFilePicker?.({ multiple: false }) ?? [];
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
  activePath,
  applyProjectPathMoves,
  folders,
  onOpenProject,
  reconcileTree,
  refresh,
  rootProjects,
  setExpandedFolders,
  setFolders,
  setRootProjects,
  suppressAncestorExpansion,
}: {
  activePath: string;
  applyProjectPathMoves: (moves: WorkflowProjectPathMove[]) => Promise<void>;
  folders: WorkflowFolderItem[];
  onOpenProject: (path: string, options?: WorkflowProjectOpenOptions) => void;
  reconcileTree: (message: string) => void;
  refresh: (showLoading?: boolean) => Promise<void>;
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

  const clearInlineEditing = useCallback(() => {
    setEditingFolderId(null);
    setEditingProjectPath(null);
  }, []);

  const createFolder = useCallback(async () => {
    const name = normalizePromptValue(prompt('New folder name:'));
    if (!name) {
      return;
    }
    try {
      const folder = await createWorkflowFolder(name);
      setExpandedFolders((previous) => ({ ...previous, [folder.id]: true }));
      await refresh(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create folder');
    }
  }, [refresh, setExpandedFolders]);

  const startFolderRename = useCallback((folder: WorkflowFolderItem) => {
    setEditingProjectPath(null);
    setEditingFolderId(folder.id);
  }, []);
  const cancelFolderRename = useCallback((folder: WorkflowFolderItem) => {
    setEditingFolderId((current) => current === folder.id ? null : current);
  }, []);
  const submitFolderRename = useCallback(async (folder: WorkflowFolderItem, rawName: string) => {
    const newName = normalizePromptValue(rawName);
    if (!newName || newName === folder.name) {
      setEditingFolderId(null);
      return;
    }

    setEditingFolderId(null);
    setRenamingFolderId(folder.id);
    try {
      const result = await renameWorkflowFolder(folder.relativePath, newName);
      if (result.movedProjectPaths.some((move) => move.fromAbsolutePath === activePath)) {
        suppressAncestorExpansion(getRenamedFolderIds(folder, folder.relativePath, result.folder.relativePath));
      }
      const nextTree = applyFolderMoveToTree(folders, rootProjects, folder, result.folder);
      setFolders(nextTree.folders);
      setRootProjects(nextTree.rootProjects);
      setExpandedFolders((previous) =>
        remapExpandedFolderIds(previous, folder.relativePath, result.folder.relativePath));
      await applyProjectPathMoves(result.movedProjectPaths);
      reconcileTree('Folder renamed, but failed to refresh the tree');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rename folder');
    } finally {
      setRenamingFolderId((current) => current === folder.id ? null : current);
    }
  }, [
    activePath,
    applyProjectPathMoves,
    folders,
    reconcileTree,
    rootProjects,
    setExpandedFolders,
    setFolders,
    setRootProjects,
    suppressAncestorExpansion,
  ]);

  const startProjectRename = useCallback((project: WorkflowProjectItem) => {
    setEditingFolderId(null);
    setEditingProjectPath(project.absolutePath);
  }, []);
  const cancelProjectRename = useCallback((project: WorkflowProjectItem) => {
    setEditingProjectPath((current) => current === project.absolutePath ? null : current);
  }, []);
  const submitProjectRename = useCallback(async (project: WorkflowProjectItem, rawName: string) => {
    const newName = normalizePromptValue(rawName);
    if (!newName || newName === project.name) {
      setEditingProjectPath(null);
      return;
    }

    setEditingProjectPath(null);
    setRenamingProjectPath(project.absolutePath);
    try {
      const result = await renameWorkflowProject(project.relativePath, newName);
      const nextTree = applyProjectMoveToTree(folders, rootProjects, project, result.project);
      setFolders(nextTree.folders);
      setRootProjects(nextTree.rootProjects);
      await applyProjectPathMoves(result.movedProjectPaths);
      reconcileTree('Project renamed, but failed to refresh the tree');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rename project');
    } finally {
      setRenamingProjectPath((current) => current === project.absolutePath ? null : current);
    }
  }, [applyProjectPathMoves, folders, reconcileTree, rootProjects, setFolders, setRootProjects]);

  const addProject = useCallback(async (folder: WorkflowFolderItem) => {
    const name = normalizePromptValue(prompt(`New Rivet project name in folder "${folder.name}":`));
    if (!name) {
      return;
    }
    try {
      const project = await createWorkflowProject(folder.relativePath, name);
      setExpandedFolders((previous) => ({ ...previous, [folder.id]: true }));
      await refresh(false);
      onOpenProject(project.absolutePath, { title: project.name });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create project');
    }
  }, [onOpenProject, refresh, setExpandedFolders]);

  const deleteFolder = useCallback(async (folder: WorkflowFolderItem) => {
    if (!window.confirm(`Delete empty folder "${folder.name}"?`)) {
      return;
    }
    try {
      await deleteWorkflowFolder(folder.relativePath);
      await refresh(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete folder');
    }
  }, [refresh]);

  const uploadProject = useCallback(async (folder: WorkflowFolderItem) => {
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
      await uploadWorkflowProject(folder.relativePath, selectedFile.name, await selectedFile.text());
      await refresh(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload project');
    } finally {
      setUploadingFolderPath((current) => current === folder.relativePath ? null : current);
    }
  }, [refresh]);

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
    uploadProject,
    uploadingFolderPath,
  };
}
