import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

async function seedFileMenuProject(page: Page, suffix: string) {
  await seedHostedEditorProject(page, {
    graphId: `file-menu-graph-${suffix}`,
    loaded: true,
    projectId: `file-menu-project-${suffix}`,
    projectPath: `/workflows/File Menu ${suffix}.rivet-project`,
    title: `File Menu ${suffix}`,
  });
}

async function openHostedFileMenu(page: Page) {
  const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
  const menuButton = editorFrame.getByRole('button', { name: 'Menu', exact: true });
  await expect(menuButton).toBeVisible({ timeout: 120_000 });
  await menuButton.click();

  const fileMenu = editorFrame.getByRole('menu');
  await expect(fileMenu).toBeVisible();

  return { editorFrame, fileMenu, menuButton };
}

test.describe('Hosted editor File menu', () => {
  test('shows only graph import/export, settings, and help actions', async ({ page }) => {
    await seedFileMenuProject(page, 'visible-items');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);

    const { fileMenu } = await openHostedFileMenu(page);
    await expect(fileMenu.getByRole('menuitem')).toHaveText([
      'Import graph',
      'Export graph',
      'Rivet settings',
      'Help',
    ]);
    await expect(fileMenu.getByRole('separator')).toHaveCount(1);
  });

  test('does not bind the browser DevTools shortcut to graph import', async ({ page }) => {
    await page.addInitScript(() => {
      const hostedWindow = window as Window & {
        __hostedOpenFilePickerCalls?: number;
        __hostedOpenFilePickerStubInstalled?: boolean;
        showOpenFilePicker?: () => Promise<never>;
      };

      hostedWindow.__hostedOpenFilePickerCalls = 0;
      hostedWindow.__hostedOpenFilePickerStubInstalled = true;
      hostedWindow.showOpenFilePicker = async () => {
        hostedWindow.__hostedOpenFilePickerCalls = (hostedWindow.__hostedOpenFilePickerCalls ?? 0) + 1;
        throw new DOMException('Test picker suppressed', 'AbortError');
      };
    });
    await seedFileMenuProject(page, 'devtools-shortcut');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);

    const { editorFrame, menuButton } = await openHostedFileMenu(page);
    await menuButton.focus();
    await expect
      .poll(() =>
        editorFrame.locator('body').evaluate(() => {
          const hostedWindow = window as Window & { __hostedOpenFilePickerStubInstalled?: boolean };
          return hostedWindow.__hostedOpenFilePickerStubInstalled === true;
        }),
      )
      .toBe(true);

    await page.keyboard.press('Control+Shift+I');

    await expect
      .poll(() =>
        editorFrame.locator('body').evaluate(() => {
          const hostedWindow = window as Window & { __hostedOpenFilePickerCalls?: number };
          return hostedWindow.__hostedOpenFilePickerCalls ?? 0;
        }),
      )
      .toBe(0);
  });
});
