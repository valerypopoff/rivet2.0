import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { expectStudioModalSizing, expectStackedSettingsLayout } from './helpers/modalSizing';

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
    await expect(fileMenu.getByRole('menuitem')).toHaveText(['Import graph', 'Export graph', 'Rivet settings', 'Help']);
    await expect(fileMenu.getByRole('separator')).toHaveCount(1);
  });

  test('uses the shared Studio Server modal dimensions for Rivet settings', async ({ page }) => {
    await seedFileMenuProject(page, 'settings-modal-width');
    await mockHostedEditorBootstrap(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);

    const { editorFrame, fileMenu } = await openHostedFileMenu(page);
    await fileMenu.getByRole('menuitem', { name: 'Rivet settings', exact: true }).click();

    const modal = editorFrame.getByTestId('settings-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'Rivet settings', exact: true })).toBeVisible();
    await expectStudioModalSizing(modal);
    await expect(modal.getByRole('navigation', { name: 'Settings' })).toBeVisible();
    await page.setViewportSize({ width: 740, height: 1000 });
    await expectStudioModalSizing(modal);
    await expectStackedSettingsLayout(modal);
    await modal.getByRole('button', { name: 'LLM', exact: true }).click();
    const provider = modal.getByRole('combobox').first();
    const selectedLabel = await modal.locator('[class$="-singleValue"]').first().innerText();
    await provider.click();
    // Atlaskit 16's option rows have stable IDs but do not consistently expose
    // option/listbox roles or aria-selected. Cover the actual shipped DOM.
    const options = editorFrame.locator('[id^="react-select-"][id*="-option-"]');
    const selectedOption = options.filter({ hasText: selectedLabel });
    await expect(selectedOption).toHaveCSS('box-shadow', 'none');
    await expect(selectedOption).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const hoveredOption = options.filter({ hasNotText: selectedLabel }).first();
    await hoveredOption.hover();
    await expect(hoveredOption).toHaveCSS('box-shadow', 'none');
    await expect(hoveredOption).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await provider.press('Escape');
    await expect(options).toHaveCount(0);
    await expect(modal).toBeVisible();
  });

  test('uses the shared package loader UI with hosted transport and never replays a failed install', async ({
    page,
  }) => {
    await seedFileMenuProject(page, 'hosted-plugin-provider');
    await mockHostedEditorBootstrap(page);
    const requests: Array<{ path: string; package: string }> = [];
    await page.route('**/api/plugins/*', async (route) => {
      const body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      requests.push({ path, package: body.package });
      if (body.package === 'fixture-failure') {
        await route.fulfill({ status: 503, body: 'Fixture install unavailable' });
      } else if (path.endsWith('/install-package')) {
        await route.fulfill({ json: { success: true, log: 'Fixture installed\n' } });
      } else {
        await route.fulfill({
          json: {
            contents:
              'export default Rivet => ({ id: "fixture-package", name: Rivet.coerceType({type:"number",value:42}, "string") });',
          },
        });
      }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const { editorFrame, fileMenu } = await openHostedFileMenu(page);
    await fileMenu.getByRole('menuitem', { name: 'Rivet settings', exact: true }).click();
    const settings = editorFrame.getByTestId('settings-modal');
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click();
    const add = async (name: string) => {
      await settings
        .locator('.plugin')
        .filter({ hasText: 'Add a plugin from NPM manually' })
        .getByRole('button', { name: 'Add', exact: true })
        .click();
      const modal = editorFrame.getByRole('dialog').filter({ hasText: 'Add NPM Plugin' });
      await modal.getByPlaceholder('Package Name').fill(name);
      await modal.getByRole('button', { name: 'Add', exact: true }).click();
    };
    await add('fixture-package');
    await expect(
      settings
        .locator('.plugin')
        .filter({ hasText: 'fixture-package' })
        .getByRole('button', { name: 'Remove', exact: true }),
    ).toBeVisible();
    expect(requests.some((request) => request.path.endsWith('/load-package-main'))).toBe(true);
    await add('fixture-failure');
    const log = editorFrame.getByRole('dialog').filter({ hasText: 'Installing...' });
    await expect(log).toContainText('Fixture install unavailable');
    await log.getByRole('button', { name: 'Close', exact: true }).click();
    expect(requests.filter((request) => request.package === 'fixture-failure')).toHaveLength(1);
  });

  test('keeps the Plugins catalog identity column compact', async ({ page }) => {
    await seedFileMenuProject(page, 'plugin-catalog-layout');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);

    const { editorFrame, fileMenu } = await openHostedFileMenu(page);
    await fileMenu.getByRole('menuitem', { name: 'Rivet settings', exact: true }).click();

    const modal = editorFrame.getByTestId('settings-modal');
    await modal.getByRole('button', { name: 'Plugins', exact: true }).click();
    const pluginRow = modal.locator('.plugin').first();
    const pluginIcon = pluginRow.locator('.plugin-icon');

    await expect(pluginIcon).toBeVisible();
    await expect(pluginIcon).toHaveCSS('width', '32px');
    await expect(pluginIcon).toHaveCSS('height', '32px');
    await expect(pluginRow).toHaveCSS('grid-template-columns', /32px 120px/);
    await expect(pluginRow).toHaveCSS('column-gap', '12px');
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
