import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

type EditorRoot = Page | FrameLocator;

async function getEditorRoot(page: Page): Promise<EditorRoot> {
  const editorFrame = page.locator('iframe.dashboard-editor-frame');

  const timeoutAt = Date.now() + 20_000;
  while (Date.now() < timeoutAt) {
    if ((await editorFrame.count()) > 0) {
      return page.frameLocator('iframe.dashboard-editor-frame');
    }

    if (await page.locator('.node-canvas').first().isVisible().catch(() => false)) {
      return page;
    }

    await page.waitForTimeout(100);
  }

  throw new Error('Hosted editor did not mount in iframe or direct mode.');
}

function projectTab(editorRoot: EditorRoot, name: string) {
  return editorRoot.getByText(name, { exact: true }).first();
}

async function verifyHostedSaveShortcut(
  page: Page,
  options: {
    platform: 'MacIntel' | 'Win32';
    shortcut: 'Control+S' | 'Meta+S';
    suffix: string;
  },
) {
  const projectId = `save-title-project-${options.suffix}`;
  const graphId = `save-title-graph-${options.suffix}`;
  const editorTitle = `Editor Settings Name ${options.suffix}`;
  const fileTreeTitle = `File Tree Name ${options.suffix}`;
  const projectPath = `/workflows/${fileTreeTitle}.rivet-project`;
  let saveRequestCount = 0;

  await page.route('**/api/projects/save', async (route) => {
    saveRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        path: projectPath,
        revisionId: null,
        project: null,
        created: false,
      }),
    });
  });

  await seedHostedEditorProject(page, {
    graphId,
    loaded: true,
    projectId,
    projectPath,
    title: editorTitle,
  });

  await page.addInitScript((platform) => {
    Object.defineProperty(Navigator.prototype, 'platform', {
      configurable: true,
      get: () => platform,
    });
  }, options.platform);

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);

  const editorRoot = await getEditorRoot(page);
  const tab = projectTab(editorRoot, editorTitle);
  await expect(tab).toBeVisible();
  const canvas = editorRoot.locator('.node-canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();
  await canvas.press(options.shortcut);

  await expect.poll(() => saveRequestCount).toBe(1);
  await expect(projectTab(editorRoot, fileTreeTitle)).toBeVisible();
  await expect(canvas).toBeVisible();
}

test('hosted editor project tabs show only the project title', async ({ page }) => {
  const projectId = 'tab-label-project';
  const graphId = 'tab-label-graph';
  const projectTitle = 'Tab Label Project';

  await seedHostedEditorProject(page, {
    graphId,
    projectId,
    projectPath: `/workflows/${projectTitle}.rivet-project`,
    title: projectTitle,
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);

  const editorRoot = await getEditorRoot(page);
  const tab = projectTab(editorRoot, projectTitle);
  await expect(tab).toBeVisible();
  await expect(tab).not.toContainText('.rivet-project');
});

test('hosted editor owns the Windows save shortcut', async ({ page }) => {
  await verifyHostedSaveShortcut(page, {
    platform: 'Win32',
    shortcut: 'Control+S',
    suffix: 'windows',
  });
});

test('hosted editor owns the macOS save shortcut', async ({ page }) => {
  await verifyHostedSaveShortcut(page, {
    platform: 'MacIntel',
    shortcut: 'Meta+S',
    suffix: 'macos',
  });
});
