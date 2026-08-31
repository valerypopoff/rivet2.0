import { expect, test, type Page, type Route } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

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

function createProjectFixture(name: string): MockWorkflowProjectItem {
  const fileName = `${name}.rivet-project`;

  return {
    id: fileName,
    name,
    fileName,
    relativePath: fileName,
    absolutePath: `/managed/workflows/${fileName}`,
    updatedAt: '2026-05-07T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

async function installProjectRenameRoutes(page: Page, state: {
  projectName: string;
  renameBlocker?: Promise<void>;
  renameError?: string;
  renameRequests: Array<{ relativePath?: string; newName?: string }>;
}): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await fulfillJson(route, {
      root: '/managed/workflows',
      sync: { epoch: 'playwright-fixture', revision: 0 },
      folders: [],
      projects: [createProjectFixture(state.projectName)],
    });
  });

  await page.route('**/api/workflows/projects', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({
        status: 405,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unexpected workflow project request' }),
      });
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath?: string;
      newName?: string;
    };
    state.renameRequests.push(requestBody);
    const previousProjectName = state.projectName;

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

    state.projectName = requestBody.newName ?? state.projectName;

    await fulfillJson(route, {
      project: createProjectFixture(state.projectName),
      movedProjectPaths: [
        {
          fromAbsolutePath: `/managed/workflows/${previousProjectName}.rivet-project`,
          toAbsolutePath: `/managed/workflows/${state.projectName}.rivet-project`,
        },
      ],
    });
  });
}

async function startProjectRename(page: Page, projectName: string) {
  await page.locator('.project-row', { hasText: projectName }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename project' }).click();
  const renameInput = page.getByRole('textbox', { name: `Rename ${projectName}` });
  await expect(renameInput).toBeVisible();
  return renameInput;
}

test.describe('Workflow project inline rename', () => {
  test('starts from F2 or context menu, saves with Enter, keeps the active row, and cancels cleanly', async ({ page }) => {
    const renameBlocker = createDeferred();
    const state = {
      projectName: 'codex-inline-project',
      renameBlocker: renameBlocker.promise,
      renameRequests: [] as Array<{ relativePath?: string; newName?: string }>,
    };
    await installProjectRenameRoutes(page, state);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const originalProject = page.locator('.project-row', { hasText: state.projectName });
    await expect(originalProject).toBeVisible();
    await originalProject.click();
    await expect(originalProject).toHaveClass(/active/);

    let renameInput = page.getByRole('textbox', { name: `Rename ${state.projectName}` });
    await originalProject.press('F2');
    await expect(renameInput).toBeVisible();
    await renameInput.fill('codex-inline-project-f2');
    await renameInput.press('Escape');
    await expect(page.getByRole('textbox', { name: `Rename ${state.projectName}` })).toHaveCount(0);
    expect(state.renameRequests).toHaveLength(0);

    renameInput = await startProjectRename(page, state.projectName);
    await renameInput.fill('codex-inline-project-escape');
    await renameInput.press('Escape');
    await expect(page.getByRole('textbox', { name: `Rename ${state.projectName}` })).toHaveCount(0);
    expect(state.renameRequests).toHaveLength(0);

    renameInput = await startProjectRename(page, state.projectName);
    await renameInput.fill('codex-inline-project-click-away');
    await page.locator('.workflow-library-panel .active-project-slot').click();
    await expect(page.getByRole('textbox', { name: `Rename ${state.projectName}` })).toHaveCount(0);
    expect(state.renameRequests).toHaveLength(0);

    renameInput = await startProjectRename(page, state.projectName);
    await renameInput.fill('codex-inline-project-renamed');
    await renameInput.press('Enter');

    const savingRow = page.locator('.project-row.renaming', { hasText: state.projectName });
    await expect(page.getByRole('textbox', { name: `Rename ${state.projectName}` })).toHaveCount(0);
    await expect(savingRow).toHaveAttribute('aria-busy', 'true');
    await expect(savingRow.locator('.project-rename-spinner')).toBeVisible();

    renameBlocker.resolve();
    const renamedProject = page.locator('.project-row', { hasText: 'codex-inline-project-renamed' });
    await expect(renamedProject).toBeVisible();
    await expect(renamedProject).toHaveClass(/active/);
    expect(state.renameRequests).toEqual([
      {
        relativePath: 'codex-inline-project.rivet-project',
        newName: 'codex-inline-project-renamed',
      },
    ]);
  });

  test('keeps the row in saving state until the API rejects the rename', async ({ page }) => {
    const renameBlocker = createDeferred();
    const state = {
      projectName: 'codex-inline-project-conflict',
      renameBlocker: renameBlocker.promise,
      renameError: 'Project already exists: codex-inline-project-taken.rivet-project',
      renameRequests: [] as Array<{ relativePath?: string; newName?: string }>,
    };
    await installProjectRenameRoutes(page, state);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const renameInput = await startProjectRename(page, state.projectName);
    await renameInput.fill('codex-inline-project-taken');
    await renameInput.press('Enter');

    const savingRow = page.locator('.project-row.renaming', { hasText: state.projectName });
    await expect(page.getByRole('textbox', { name: `Rename ${state.projectName}` })).toHaveCount(0);
    await expect(savingRow.locator('.project-rename-spinner')).toBeVisible();

    renameBlocker.resolve();
    await expect(page.locator('.Toastify__toast')).toContainText('Project already exists: codex-inline-project-taken.rivet-project');
    await expect(page.locator('.project-row.renaming')).toHaveCount(0);
    await expect(page.locator('.project-row', { hasText: state.projectName })).toBeVisible();
    expect(state.renameRequests).toEqual([
      {
        relativePath: 'codex-inline-project-conflict.rivet-project',
        newName: 'codex-inline-project-taken',
      },
    ]);
  });
});
