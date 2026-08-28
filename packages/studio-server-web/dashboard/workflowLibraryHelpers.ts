import type { WorkflowFolderItem, WorkflowProjectItem } from './types';

export const ROOT_DROP_TARGET = '__root__';

export type DraggedWorkflowItem = {
  itemType: 'folder' | 'project';
  absolutePath: string;
  relativePath: string;
  parentRelativePath: string;
};

export const normalizeWorkflowPath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

export const flattenFolders = (items: WorkflowFolderItem[]): WorkflowFolderItem[] =>
  items.flatMap((folder) => [folder, ...flattenFolders(folder.folders ?? [])]);

export const flattenProjects = (items: WorkflowFolderItem[]): WorkflowProjectItem[] =>
  items.flatMap((folder) => [...folder.projects, ...flattenProjects(folder.folders ?? [])]);

export const collectFolderIds = (items: WorkflowFolderItem[]): string[] =>
  items.flatMap((folder) => [folder.id, ...collectFolderIds(folder.folders ?? [])]);

export const countProjectsInFolder = (folder: WorkflowFolderItem): number =>
  folder.projects.length + (folder.folders ?? []).reduce((count, childFolder) => count + countProjectsInFolder(childFolder), 0);

export const getParentRelativePath = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
};
