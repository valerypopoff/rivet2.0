import { expect, test, type Page } from '@playwright/test';
import type { WorkflowProjectItem, WorkflowProjectStatus } from '../../shared/workflow-types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const STATUS_DOT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgb(187, 187, 187)',
  published: 'rgb(126, 226, 148)',
  unpublished_changes: 'rgb(255, 215, 106)',
};

const ACTIVE_PROJECT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgba(255, 255, 255, 0.07)',
  published: 'rgba(126, 226, 148, 0.12)',
  unpublished_changes: 'rgba(255, 215, 106, 0.12)',
};

function createStatusProject(status: WorkflowProjectStatus): WorkflowProjectItem {
  const name = `codex-collapsed-dot-${status}`;

  return {
    id: name,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-05-15T10:00:00.000Z',
    settings: {
      status,
      endpointName: `${name}-endpoint`,
      lastPublishedAt: status === 'unpublished' ? null : '2026-05-15T09:00:00.000Z',
    },
  };
}

async function installStatusDotTreeRoute(page: Page, projects: WorkflowProjectItem[]): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        root: '/managed/workflows',
        folders: [],
        projects,
      }),
    });
  });
}

async function dispatchProjectOpenedFromEditorFrame(page: Page, path: string): Promise<void> {
  await page.evaluate((projectPath) => {
    const editorFrame = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'project-opened', path: projectPath },
      origin: window.location.origin,
      source: editorFrame?.contentWindow ?? null,
    }));
  }, path);
}

test.describe('Workflow library layout', () => {
  test('collapses from the full header row into a clickable narrow rail', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(Math.round(headerBox!.height)).toBe(37);
    await expect(header).toHaveCSS('border-bottom-width', '0px');

    const collapseButton = page.getByRole('button', { name: 'Collapse folders pane' });
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(collapseButton).toBeVisible();
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    await expect(collapseButton.locator('path').last()).toHaveAttribute('d', 'M5.25 4.75v6.5');

    const collapseButtonBox = await collapseButton.boundingBox();
    const titleBox = await title.boundingBox();
    expect(collapseButtonBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(collapseButtonBox!.x).toBeLessThan(titleBox!.x);

    const bottomActions = page.locator('.workflow-library-panel .panel-bottom-actions');
    await expect(bottomActions).toHaveCSS('padding-bottom', '24px');

    await page.getByRole('button', { name: 'About' }).click();
    const aboutModal = page.locator('[data-testid="about-modal"]');
    await expect(aboutModal).toBeVisible();
    await expect(aboutModal).toContainText('Rivet Studio Server');
    await expect(aboutModal).toContainText('Version');
    await expect(aboutModal).toContainText(/Version\s*\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    await page.getByRole('button', { name: 'Close about' }).click();
    await expect(aboutModal).toHaveCount(0);

    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const expandButton = page.getByRole('button', { name: 'Expand folders pane' });
    await expect(expandButton).toBeVisible();
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(expandButton.locator('path')).toHaveAttribute('d', 'M6 4.5 9.5 8 6 11.5');
    await expect(header).toHaveCount(1);
    await expect(title).toHaveCount(1);
    await expect(header).toBeHidden();
    await expect(title).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show main panel' })).toHaveCount(0);

    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    const sidebarBox = await sidebar.boundingBox();
    const expandButtonBox = await expandButton.boundingBox();
    const expandIconBox = await expandButton.locator('svg').boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(expandButtonBox).not.toBeNull();
    expect(expandIconBox).not.toBeNull();
    expect(Math.round(expandButtonBox!.width)).toBe(Math.round(sidebarBox!.width));
    expect(Math.round(expandButtonBox!.height)).toBe(Math.round(sidebarBox!.height));
    expect(Math.abs((expandIconBox!.y + expandIconBox!.height / 2) - (sidebarBox!.y + sidebarBox!.height / 2))).toBeLessThan(2);

    await page.mouse.click(sidebarBox!.x + sidebarBox!.width / 2, sidebarBox!.y + sidebarBox!.height - 20);

    const titleVisibilityDuringExpand = await title.evaluate((element) => window.getComputedStyle(element).visibility);
    expect(titleVisibilityDuringExpand).toBe('hidden');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
    await expect(page.getByRole('button', { name: 'Collapse folders pane' })).toBeVisible();
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Rivet Projects');
  });

  test('resizes with a wider drag target and folds while dragging below half the minimum width', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const resizer = page.locator('.dashboard-sidebar-resizer');
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(resizer).toBeVisible();

    const resizerBox = await resizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    expect(Math.round(resizerBox!.width)).toBeGreaterThanOrEqual(14);

    const dragY = resizerBox!.y + 48;
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2, dragY);
    await page.mouse.down();

    await page.mouse.move(90, dragY, { steps: 4 });
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    await expect(title).toBeHidden();

    await page.mouse.move(280, dragY, { steps: 6 });
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
    await page.mouse.up();

    await expect(title).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
  });

  test('shows the opened project status as a collapsed rail dot', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    await installStatusDotTreeRoute(page, projects);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await expect(page.getByRole('button', { name: projects[0].name, exact: true })).toBeEnabled({ timeout: 180_000 });

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();

    await dispatchProjectOpenedFromEditorFrame(page, projects[0].absolutePath);
    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const statusDot = page.locator('.workflow-library-panel .collapsed-strip-status-dot');
    await expect(statusDot).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    const sidebarBox = await sidebar.boundingBox();
    const statusDotBox = await statusDot.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(statusDotBox).not.toBeNull();
    expect(Math.round(statusDotBox!.width)).toBe(12);
    expect(Math.round(statusDotBox!.height)).toBe(12);
    expect(Math.abs((statusDotBox!.x + statusDotBox!.width / 2) - (sidebarBox!.x + sidebarBox!.width / 2))).toBeLessThan(2);
    expect(Math.abs((statusDotBox!.y + statusDotBox!.height / 2) - (sidebarBox!.y + 18.5))).toBeLessThan(2);

    for (const project of projects) {
      await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);
      await expect(statusDot).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(statusDot).toHaveCSS('background-color', STATUS_DOT_BACKGROUND[project.settings.status]);
    }
  });

  test('tints the active project summary by publication status', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    await installStatusDotTreeRoute(page, projects);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');

    for (const project of projects) {
      await page.getByRole('button', { name: project.name, exact: true }).click();
      await expect(activeProjectSection).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND[project.settings.status]);
    }
  });
});
