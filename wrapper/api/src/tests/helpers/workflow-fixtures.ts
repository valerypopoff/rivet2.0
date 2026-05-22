import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createWorkflowTestRoots(prefix: string): Promise<{
  tempRoot: string;
  workflowsRoot: string;
  recordingsRoot: string;
  appDataRoot: string;
  runtimeLibrariesRoot: string;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workflowsRoot = path.join(tempRoot, 'workflows');
  const recordingsRoot = path.join(tempRoot, 'workflow-recordings');
  const appDataRoot = path.join(tempRoot, 'app-data');
  const runtimeLibrariesRoot = path.join(tempRoot, 'runtime-libraries');

  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot, runtimeLibrariesRoot });

  return {
    tempRoot,
    workflowsRoot,
    recordingsRoot,
    appDataRoot,
    runtimeLibrariesRoot,
  };
}

export async function resetWorkflowTestRoots(roots: {
  workflowsRoot: string;
  recordingsRoot?: string;
  appDataRoot: string;
  runtimeLibrariesRoot?: string;
}) {
  const directories = [
    roots.workflowsRoot,
    ...(roots.recordingsRoot ? [roots.recordingsRoot] : []),
    roots.appDataRoot,
    ...(roots.runtimeLibrariesRoot ? [roots.runtimeLibrariesRoot] : []),
  ];

  for (const dirPath of directories) {
    await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.mkdir(dirPath, { recursive: true });
  }
}

type CreatedWorkflowProjectItem = {
  relativePath: string;
};

type WorkflowProjectMutations<TCreated extends CreatedWorkflowProjectItem> = {
  createWorkflowProjectItem(parentRelativePath: string, name: string): Promise<TCreated>;
  publishWorkflowProjectItem(relativePath: string, options: { endpointName: string }): Promise<unknown>;
};

export function createRootPublishedProjectFactory<TCreated extends CreatedWorkflowProjectItem>(
  workflowMutations: WorkflowProjectMutations<TCreated>,
) {
  return async function createRootPublishedProject(name: string, endpointName: string): Promise<TCreated> {
    const created = await workflowMutations.createWorkflowProjectItem('', name);
    await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
      endpointName,
    });
    return created;
  };
}
