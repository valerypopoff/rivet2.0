import { expect, test, type Page, type Route } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

type MockWorkflowFolderItem = {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  folders: MockWorkflowFolderItem[];
  projects: MockWorkflowProjectItem[];
};

type MockWorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: {
    status: 'unpublished';
    endpointName: string;
    lastPublishedAt: null;
    publishedWebApps: [];
  };
};

function createProjectFixture(folderName: string, projectName: string): MockWorkflowProjectItem {
  const fileName = `${projectName}.rivet-project`;

  return {
    id: `${folderName}/${fileName}`,
    name: projectName,
    fileName,
    relativePath: `${folderName}/${fileName}`,
    absolutePath: `/managed/workflows/${folderName}/${fileName}`,
    updatedAt: '2026-05-07T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };
}

function createFolderFixture(name: string, projectName?: string): MockWorkflowFolderItem {
  return {
    id: name,
    name,
    relativePath: name,
    absolutePath: `/managed/workflows/${name}`,
    updatedAt: '2026-05-07T10:00:00.000Z',
    folders: [],
    projects: projectName ? [createProjectFixture(name, projectName)] : [],
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installFolderRenameRoutes(page: Page, state: {
  folderName: string;
  projectName?: string;
  renameBlocker?: Promise<void>;
  renameError?: string;
  renameRequests: Array<{ relativePath?: string; newName?: string }>;
}): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await fulfillJson(route, {
      root: '/managed/workflows',
      folders: [createFolderFixture(state.folderName, state.projectName)],
      projects: [],
    });
  });

  await page.route('**/api/workflows/folders', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({
        status: 405,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unexpected workflow folder request' }),
      });
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath?: string;
      newName?: string;
    };
    state.renameRequests.push(requestBody);
    const previousFolderName = state.folderName;

    if (state.renameBlocker) {
      await state.renameBlocker;
    }

    if (state.renameError) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: state.renameError }),
      });
      return;
    }

    state.folderName = requestBody.newName ?? state.folderName;

    await fulfillJson(route, {
      folder: createFolderFixture(state.folderName, state.projectName),
      movedProjectPaths: state.projectName ? [
        {
          fromAbsolutePath: `/managed/workflows/${previousFolderName}/${state.projectName}.rivet-project`,
          toAbsolutePath: `/managed/workflows/${state.folderName}/${state.projectName}.rivet-project`,
        },
      ] : [],
    });
  });
}

async function startFolderRename(page: Page, folderName: string) {
  await page.locator('.folder-row', { hasText: folderName }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename folder' }).click();
  const renameInput = page.getByRole('textbox', { name: `Rename ${folderName}` });
  await expect(renameInput).toBeVisible();
  return renameInput;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

test.describe('Workflow folder inline rename', () => {
  test('saves with Enter and cancels with Escape or click-away', async ({ page }) => {
    const renameBlocker = createDeferred();
    const state = {
      folderName: 'codex-inline-folder',
      renameBlocker: renameBlocker.promise,
      renameRequests: [] as Array<{ relativePath?: string; newName?: string }>,
    };
    await installFolderRenameRoutes(page, state);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const originalFolder = page.locator('.folder-row', { hasText: state.folderName });
    await expect(originalFolder).toBeVisible();

    let renameInput = await startFolderRename(page, state.folderName);
    await renameInput.fill('codex-inline-escape');
    await renameInput.press('Escape');
    await expect(page.getByRole('textbox', { name: `Rename ${state.folderName}` })).toHaveCount(0);
    expect(state.renameRequests).toHaveLength(0);

    renameInput = await startFolderRename(page, state.folderName);
    await renameInput.fill('codex-inline-click-away');
    await page.locator('.workflow-library-panel .active-project-slot').click();
    await expect(page.getByRole('textbox', { name: `Rename ${state.folderName}` })).toHaveCount(0);
    expect(state.renameRequests).toHaveLength(0);

    renameInput = await startFolderRename(page, state.folderName);
    await renameInput.fill('codex-inline-renamed');
    await renameInput.press('Enter');

    const savingRow = page.locator('.folder-row.renaming', { hasText: state.folderName });
    await expect(page.getByRole('textbox', { name: `Rename ${state.folderName}` })).toHaveCount(0);
    await expect(savingRow).toHaveAttribute('aria-busy', 'true');
    await expect(savingRow.locator('.folder-rename-spinner')).toBeVisible();

    renameBlocker.resolve();
    await expect(page.locator('.folder-row', { hasText: 'codex-inline-renamed' })).toBeVisible();
    expect(state.renameRequests).toEqual([
      {
        relativePath: 'codex-inline-folder',
        newName: 'codex-inline-renamed',
      },
    ]);
  });

  test('does not reopen a collapsed folder after retargeting an active project path', async ({ page }) => {
    const renameBlocker = createDeferred();
    const state = {
      folderName: 'codex-inline-closed',
      projectName: 'codex-inline-active-project',
      renameBlocker: renameBlocker.promise,
      renameRequests: [] as Array<{ relativePath?: string; newName?: string }>,
    };
    await installFolderRenameRoutes(page, state);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    let folderRow = page.locator('.folder-row', { hasText: state.folderName });
    await folderRow.click();
    await expect(folderRow).toHaveAttribute('aria-expanded', 'true');

    await page.locator('.project-row', { hasText: state.projectName }).click();
    await folderRow.click();
    await expect(folderRow).toHaveAttribute('aria-expanded', 'false');

    const renameInput = await startFolderRename(page, state.folderName);
    await renameInput.fill('codex-inline-closed-renamed');
    await renameInput.press('Enter');
    await expect(page.locator('.folder-row.renaming', { hasText: state.folderName }).locator('.folder-rename-spinner')).toBeVisible();

    renameBlocker.resolve();

    folderRow = page.locator('.folder-row', { hasText: 'codex-inline-closed-renamed' });
    await expect(folderRow).toBeVisible();
    await expect(folderRow).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.project-row', { hasText: state.projectName })).toHaveCount(0);
    expect(state.renameRequests).toEqual([
      {
        relativePath: 'codex-inline-closed',
        newName: 'codex-inline-closed-renamed',
      },
    ]);
  });

  test('keeps the row in saving state until the API rejects the rename', async ({ page }) => {
    const renameBlocker = createDeferred();
    const state = {
      folderName: 'codex-inline-conflict',
      renameBlocker: renameBlocker.promise,
      renameError: 'Folder already exists: codex-inline-taken',
      renameRequests: [] as Array<{ relativePath?: string; newName?: string }>,
    };
    await installFolderRenameRoutes(page, state);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const renameInput = await startFolderRename(page, state.folderName);
    await renameInput.fill('codex-inline-taken');
    await renameInput.press('Enter');

    const savingRow = page.locator('.folder-row.renaming', { hasText: state.folderName });
    await expect(page.getByRole('textbox', { name: `Rename ${state.folderName}` })).toHaveCount(0);
    await expect(savingRow.locator('.folder-rename-spinner')).toBeVisible();

    renameBlocker.resolve();
    await expect(page.locator('.Toastify__toast')).toContainText('Folder already exists: codex-inline-taken');
    await expect(page.locator('.folder-row.renaming')).toHaveCount(0);
    await expect(page.locator('.folder-row', { hasText: state.folderName })).toBeVisible();
    expect(state.renameRequests).toEqual([
      {
        relativePath: 'codex-inline-conflict',
        newName: 'codex-inline-taken',
      },
    ]);
  });
});
