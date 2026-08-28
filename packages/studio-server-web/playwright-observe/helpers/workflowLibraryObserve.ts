import { expect, test, type Page } from '@playwright/test';

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

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

function getStorageModeFromEnv(): 'filesystem' | 'managed' {
  const value = process.env.RIVET_STORAGE_MODE ?? 'filesystem';

  return value.trim().toLowerCase() === 'managed' ? 'managed' : 'filesystem';
}

export function requireManagedStorageMode(): void {
  test.skip(
    getStorageModeFromEnv() !== 'managed',
    'Managed workflow-path specs require RIVET_STORAGE_MODE=managed.',
  );
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  return response.folder;
}

export async function createWorkflowProject(
  page: Page,
  folderRelativePath: string,
  name: string,
): Promise<WorkflowProjectItem> {
  const response = await apiJson<{ project: WorkflowProjectItem }>(page, '/api/workflows/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderRelativePath, name }),
  });

  return response.project;
}

export async function deleteWorkflowProject(page: Page, relativePath: string): Promise<void> {
  await apiJson<{ deleted: true }>(page, '/api/workflows/projects', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

export async function unpublishWorkflowProject(page: Page, relativePath: string): Promise<void> {
  await apiJson<{ project: WorkflowProjectItem }>(page, '/api/workflows/projects/unpublish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

export async function cleanupWorkflowProject(page: Page, relativePath: string): Promise<void> {
  await deleteWorkflowProject(page, relativePath).catch(async () => {
    await unpublishWorkflowProject(page, relativePath).catch(() => {});
    await deleteWorkflowProject(page, relativePath).catch(() => {});
  });
}

export async function deleteWorkflowFolder(page: Page, relativePath: string): Promise<void> {
  await apiJson<{ deleted: true }>(page, '/api/workflows/folders', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

export async function renameWorkflowFolderInline(
  page: Page,
  currentName: string,
  nextName: string,
): Promise<void> {
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
