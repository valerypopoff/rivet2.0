import type { WorkflowFolderItem, WorkflowProjectItem } from './types';
import { getParentRelativePath, normalizeWorkflowPath } from './workflowLibraryHelpers';

export const remapExpandedFolderIds = (
  expandedFolders: Record<string, boolean>,
  fromRelativePath: string,
  toRelativePath: string,
): Record<string, boolean> => {
  const normalizedFromPath = normalizeWorkflowPath(fromRelativePath);
  const normalizedToPath = normalizeWorkflowPath(toRelativePath);

  if (normalizedFromPath === normalizedToPath) {
    return expandedFolders;
  }

  let changed = false;
  const nextExpandedFolders: Record<string, boolean> = {};

  for (const [folderId, isExpanded] of Object.entries(expandedFolders)) {
    const normalizedFolderId = normalizeWorkflowPath(folderId);

    if (
      normalizedFolderId === normalizedFromPath ||
      normalizedFolderId.startsWith(`${normalizedFromPath}/`)
    ) {
      const suffix = normalizedFolderId.slice(normalizedFromPath.length);
      nextExpandedFolders[`${normalizedToPath}${suffix}`] = isExpanded;
      changed = true;
      continue;
    }

    nextExpandedFolders[folderId] = isExpanded;
  }

  return changed ? nextExpandedFolders : expandedFolders;
};

export const rewriteWorkflowPathPrefix = (value: string, fromPath: string, toPath: string): string => {
  const normalizedValue = normalizeWorkflowPath(value);
  const normalizedFromPath = normalizeWorkflowPath(fromPath);
  const normalizedToPath = normalizeWorkflowPath(toPath);

  if (normalizedValue === normalizedFromPath) {
    return normalizedToPath;
  }

  if (normalizedValue.startsWith(`${normalizedFromPath}/`)) {
    return `${normalizedToPath}${normalizedValue.slice(normalizedFromPath.length)}`;
  }

  return value;
};

export const rewriteProjectForFolderMove = (
  project: WorkflowProjectItem,
  sourceFolder: WorkflowFolderItem,
  destinationFolder: WorkflowFolderItem,
): WorkflowProjectItem => ({
  ...project,
  relativePath: rewriteWorkflowPathPrefix(project.relativePath, sourceFolder.relativePath, destinationFolder.relativePath),
  absolutePath: rewriteWorkflowPathPrefix(project.absolutePath, sourceFolder.absolutePath, destinationFolder.absolutePath),
});

export const rewriteFolderTreeForFolderMove = (
  folder: WorkflowFolderItem,
  sourceFolder: WorkflowFolderItem,
  destinationFolder: WorkflowFolderItem,
): WorkflowFolderItem => {
  const nextFolders = folder.folders.map((childFolder) =>
    rewriteFolderTreeForFolderMove(childFolder, sourceFolder, destinationFolder));
  const nextProjects = folder.projects.map((project) =>
    rewriteProjectForFolderMove(project, sourceFolder, destinationFolder));
  const normalizedFolderPath = normalizeWorkflowPath(folder.relativePath);
  const normalizedSourcePath = normalizeWorkflowPath(sourceFolder.relativePath);
  const isMovedFolder = normalizedFolderPath === normalizedSourcePath ||
    normalizedFolderPath.startsWith(`${normalizedSourcePath}/`);

  if (!isMovedFolder) {
    return {
      ...folder,
      folders: nextFolders,
      projects: nextProjects,
    };
  }

  const isMovedRoot = normalizedFolderPath === normalizedSourcePath;

  return {
    ...folder,
    id: rewriteWorkflowPathPrefix(folder.id, sourceFolder.relativePath, destinationFolder.relativePath),
    name: isMovedRoot ? destinationFolder.name : folder.name,
    relativePath: rewriteWorkflowPathPrefix(folder.relativePath, sourceFolder.relativePath, destinationFolder.relativePath),
    absolutePath: rewriteWorkflowPathPrefix(folder.absolutePath, sourceFolder.absolutePath, destinationFolder.absolutePath),
    updatedAt: isMovedRoot ? destinationFolder.updatedAt : folder.updatedAt,
    folders: nextFolders,
    projects: nextProjects,
  };
};

export const detachFolderFromTree = (
  folders: WorkflowFolderItem[],
  sourceRelativePath: string,
): {
  folders: WorkflowFolderItem[];
  removedFolder: WorkflowFolderItem | null;
} => {
  const normalizedSourcePath = normalizeWorkflowPath(sourceRelativePath);
  let removedFolder: WorkflowFolderItem | null = null;
  let changed = false;

  const nextFolders: WorkflowFolderItem[] = [];

  for (const folder of folders) {
    if (normalizeWorkflowPath(folder.relativePath) === normalizedSourcePath) {
      removedFolder = folder;
      changed = true;
      continue;
    }

    const detachedChildren = detachFolderFromTree(folder.folders, sourceRelativePath);
    if (detachedChildren.removedFolder) {
      removedFolder = detachedChildren.removedFolder;
      changed = true;
      nextFolders.push({
        ...folder,
        folders: detachedChildren.folders,
      });
      continue;
    }

    nextFolders.push(folder);
  }

  return {
    folders: changed ? nextFolders : folders,
    removedFolder,
  };
};

export const insertFolderIntoTree = (
  folders: WorkflowFolderItem[],
  parentRelativePath: string,
  folderToInsert: WorkflowFolderItem,
): {
  folders: WorkflowFolderItem[];
  inserted: boolean;
} => {
  const normalizedParentPath = normalizeWorkflowPath(parentRelativePath);

  if (!normalizedParentPath) {
    return {
      folders: [...folders, folderToInsert],
      inserted: true,
    };
  }

  let inserted = false;
  const nextFolders = folders.map((folder) => {
    if (normalizeWorkflowPath(folder.relativePath) === normalizedParentPath) {
      inserted = true;
      return {
        ...folder,
        folders: [...folder.folders, folderToInsert],
      };
    }

    const insertedChildren = insertFolderIntoTree(folder.folders, parentRelativePath, folderToInsert);
    if (!insertedChildren.inserted) {
      return folder;
    }

    inserted = true;
    return {
      ...folder,
      folders: insertedChildren.folders,
    };
  });

  return {
    folders: inserted ? nextFolders : folders,
    inserted,
  };
};

export const applyFolderMoveToTree = (
  folders: WorkflowFolderItem[],
  rootProjects: WorkflowProjectItem[],
  sourceFolder: WorkflowFolderItem,
  destinationFolder: WorkflowFolderItem,
): {
  folders: WorkflowFolderItem[];
  rootProjects: WorkflowProjectItem[];
} => {
  const rewrittenInPlace = {
    folders: folders.map((folder) => rewriteFolderTreeForFolderMove(folder, sourceFolder, destinationFolder)),
    rootProjects: rootProjects.map((project) => rewriteProjectForFolderMove(project, sourceFolder, destinationFolder)),
  };
  const sourceParentRelativePath = getParentRelativePath(sourceFolder.relativePath);
  const destinationParentRelativePath = getParentRelativePath(destinationFolder.relativePath);

  if (normalizeWorkflowPath(sourceParentRelativePath) === normalizeWorkflowPath(destinationParentRelativePath)) {
    return rewrittenInPlace;
  }

  const detached = detachFolderFromTree(folders, sourceFolder.relativePath);
  if (!detached.removedFolder) {
    return rewrittenInPlace;
  }

  const movedFolder = rewriteFolderTreeForFolderMove(detached.removedFolder, sourceFolder, destinationFolder);
  const inserted = insertFolderIntoTree(detached.folders, destinationParentRelativePath, movedFolder);
  if (!inserted.inserted) {
    return rewrittenInPlace;
  }

  return {
    folders: inserted.folders,
    rootProjects,
  };
};

const replaceProjectInFolders = (
  folders: WorkflowFolderItem[],
  sourceProject: WorkflowProjectItem,
  destinationProject: WorkflowProjectItem,
): WorkflowFolderItem[] => {
  let changed = false;

  const nextFolders = folders.map((folder) => {
    let folderChanged = false;
    const nextProjects = folder.projects.map((project) => {
      if (project.absolutePath !== sourceProject.absolutePath) {
        return project;
      }

      folderChanged = true;
      return destinationProject;
    });
    const nextChildFolders = replaceProjectInFolders(folder.folders, sourceProject, destinationProject);
    if (nextChildFolders !== folder.folders) {
      folderChanged = true;
    }

    if (!folderChanged) {
      return folder;
    }

    changed = true;
    return {
      ...folder,
      folders: nextChildFolders,
      projects: nextProjects,
    };
  });

  return changed ? nextFolders : folders;
};

export const applyProjectMoveToTree = (
  folders: WorkflowFolderItem[],
  rootProjects: WorkflowProjectItem[],
  sourceProject: WorkflowProjectItem,
  destinationProject: WorkflowProjectItem,
): {
  folders: WorkflowFolderItem[];
  rootProjects: WorkflowProjectItem[];
} => {
  const nextRootProjects = rootProjects.map((project) =>
    project.absolutePath === sourceProject.absolutePath ? destinationProject : project);
  const rootChanged = nextRootProjects.some((project, index) => project !== rootProjects[index]);

  return {
    folders: replaceProjectInFolders(folders, sourceProject, destinationProject),
    rootProjects: rootChanged ? nextRootProjects : rootProjects,
  };
};
