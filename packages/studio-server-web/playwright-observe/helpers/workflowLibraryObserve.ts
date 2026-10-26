import { expect, test, type Page } from '@playwright/test';
import type { WorkflowTreeResponse } from '../../../studio-server-shared/workflow-types';

export type WorkflowFolderItem = {
  relativePath: string;
  name: string;
};

export type WorkflowProjectItem = {
  relativePath: string;
  absolutePath: string;
  name: string;
};

function resolveApiUrl(page: Page, input: string): string {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL?.trim() || page.url() || 'http://127.0.0.1:8080';
  return new URL(input, baseUrl).toString();
}

function normalizeRequestHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function getStorageModeFromEnv(): 'filesystem' | 'managed' {
  const value = process.env.RIVET_STORAGE_MODE ?? 'filesystem';

  return value.trim().toLowerCase() === 'managed' ? 'managed' : 'filesystem';
}

export function requireManagedStorageMode(): void {
  test.skip(getStorageModeFromEnv() !== 'managed', 'Managed workflow-path specs require RIVET_STORAGE_MODE=managed.');
}

export function requireManagedMutationOptIn(): void {
  test.skip(
    getStorageModeFromEnv() === 'managed' && process.env.PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS !== '1',
    'Mutating workflow Playwright specs are blocked against managed storage unless PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1 is set.',
  );
}

export async function apiJson<T>(page: Page, input: string, init?: RequestInit): Promise<T> {
  const response = await page.request.fetch(resolveApiUrl(page, input), {
    method: init?.method,
    headers: normalizeRequestHeaders(init?.headers),
    data: init?.body as string | Buffer | undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok()) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText();
    throw new Error(`${response.status()} ${message}`);
  }

  return body as T;
}

export async function createWorkflowFolder(page: Page, name: string): Promise<WorkflowFolderItem> {
  const response = await apiJson<{ folder: WorkflowFolderItem }>(page, '/api/workflows/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rivet-Namespace-Intent': '1' },
    body: JSON.stringify({
      name,
      ...(getStorageModeFromEnv() === 'managed'
        ? {
            mutation: {
              operationId: crypto.randomUUID(),
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              expectedDestinationId: null,
            },
          }
        : {}),
    }),
  });

  return response.folder;
}

export async function createWorkflowProject(
  page: Page,
  folderRelativePath: string,
  name: string,
): Promise<WorkflowProjectItem> {
  let mutation;
  if (getStorageModeFromEnv() === 'managed') {
    const tree = await apiJson<WorkflowTreeResponse>(page, '/api/workflows/tree');
    const folders = [...tree.folders];
    for (let index = 0; index < folders.length; index++) folders.push(...folders[index]!.folders);
    const expectedDestinationId =
      folderRelativePath === ''
        ? null
        : folders.find((folder) => folder.relativePath === folderRelativePath)?.namespaceId;
    if (expectedDestinationId === undefined) throw new Error('Fixture destination identity is unavailable.');
    mutation = {
      operationId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expectedDestinationId,
    };
  }
  const response = await apiJson<{ project: WorkflowProjectItem }>(page, '/api/workflows/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rivet-Namespace-Intent': '1' },
    body: JSON.stringify({ folderRelativePath, name, ...(mutation ? { mutation } : {}) }),
  });

  return response.project;
}

export async function deleteWorkflowProject(page: Page, relativePath: string): Promise<void> {
  if (getStorageModeFromEnv() === 'managed') return deleteManagedItem(page, 'project', relativePath);
  await apiJson<{ deleted: true }>(page, '/api/workflows/projects', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

export async function unpublishWorkflowProject(page: Page, relativePath: string): Promise<void> {
  const state = await apiJson<{ projectId: string; publicationVersion: string }>(
    page,
    `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(relativePath)}`,
  );
  await apiJson<{ project: WorkflowProjectItem }>(page, '/api/workflows/projects/unpublish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      relativePath,
      preconditions: {
        expectedProjectId: state.projectId,
        expectedPublicationVersion: state.publicationVersion,
      },
    }),
  });
}

export async function cleanupWorkflowProject(page: Page, relativePath: string): Promise<void> {
  await deleteWorkflowProject(page, relativePath).catch(async () => {
    await unpublishWorkflowProject(page, relativePath).catch(() => {});
    await deleteWorkflowProject(page, relativePath).catch(() => {});
  });
}

export async function deleteWorkflowFolder(page: Page, relativePath: string): Promise<void> {
  if (getStorageModeFromEnv() === 'managed') return deleteManagedItem(page, 'folder', relativePath);
  await apiJson<{ deleted: true }>(page, '/api/workflows/folders', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

async function deleteManagedItem(page: Page, itemType: 'project' | 'folder', relativePath: string): Promise<void> {
  const tree = await apiJson<WorkflowTreeResponse>(page, '/api/workflows/tree');
  const folders = [...tree.folders];
  const projects = [...tree.projects];
  for (let index = 0; index < folders.length; index++) {
    folders.push(...folders[index]!.folders);
    projects.push(...folders[index]!.projects);
  }
  const folder = folders.find((item) => item.relativePath === relativePath);
  const project = projects.find((item) => item.relativePath === relativePath);
  if (itemType === 'folder' && folder?.bundleId) {
    await apiJson(page, `/api/workflows/bundles/${folder.bundleId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' },
      body: JSON.stringify({ name: folder.name, relativePath }),
    });
    return;
  }
  const id = itemType === 'folder' ? folder?.namespaceId : project?.projectMetadataId;
  if (!id) throw new Error(`Managed cleanup item is unavailable: ${relativePath}`);
  await apiJson(page, '/api/workflows/namespace/mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rivet-Namespace-Intent': '1' },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      command: { kind: 'delete', itemType, relativePath },
      expectedSource: { id, ...(itemType === 'project' ? { revisionId: project!.revisionId } : {}) },
    }),
  });
}

export async function renameWorkflowFolderInline(page: Page, currentName: string, nextName: string): Promise<void> {
  const folderRow = page.locator('.folder-row', { hasText: currentName });
  await expect(folderRow).toBeVisible({ timeout: 30_000 });

  await folderRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename folder' }).click();

  const renameInput = page.getByRole('textbox', { name: `Rename ${currentName}` });
  await expect(renameInput).toBeVisible({ timeout: 30_000 });
  await renameInput.fill(nextName);
  await renameInput.press('Enter');

  await expect(page.locator('.folder-row', { hasText: nextName })).toBeVisible({ timeout: 30_000 });
}

export async function ensureFolderExpanded(page: Page, folderName: string, projectName?: string): Promise<void> {
  const folderRow = page.locator('.folder-row', { hasText: folderName });
  await expect(folderRow).toBeVisible({ timeout: 30_000 });

  if ((await folderRow.getAttribute('aria-expanded')) !== 'true') {
    await folderRow.click();
  }

  await expect(folderRow).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 });

  if (!projectName) {
    return;
  }

  await expect(page.locator('.project-row', { hasText: projectName })).toBeVisible({ timeout: 30_000 });
}
