import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import {
  authenticateIfNeeded,
  mockHostedEditorBootstrap,
  waitForDashboardReady,
  waitForFocusTag,
} from './helpers/hostedEditorObserve';
import { seedHostedEditorProject, type SeedHostedEditorProjectOptions } from './helpers/hostedEditorStorage';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const graphSearchInputSelector = '.search input[placeholder="Search..."]';

async function openSeededEditorProject(
  page: Page,
  idPrefix: string,
  title: string,
  extraGraphs: SeedHostedEditorProjectOptions['extraGraphs'] = [],
): Promise<FrameLocator> {
  await seedHostedEditorProject(page, {
    graphId: `${idPrefix}-graph`,
    loaded: true,
    projectId: `${idPrefix}-project`,
    projectPath: `/workflows/${title}.rivet-project`,
    title,
    extraGraphs,
  });

  // Editor-only assertions must not depend on, or write to, an ambient API.
  // Match root API paths, not Vite's /@fs/.../api/... source imports.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: 'Isolated search fixture' } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        folders: [],
        projects: [
          {
            id: `${idPrefix}-project`,
            projectMetadataId: `${idPrefix}-project`,
            name: title,
            fileName: `${title}.rivet-project`,
            relativePath: `${title}.rivet-project`,
            absolutePath: `/workflows/${title}.rivet-project`,
            updatedAt: '2026-10-28T00:00:00Z',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          },
        ],
        sync: { epoch: idPrefix, revision: 0 },
      },
    }),
  );

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const frameLocator = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frameLocator.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  return frameLocator;
}

function visibleGraphSearchInput(frameLocator: FrameLocator) {
  return frameLocator.locator(`${graphSearchInputSelector}:visible`);
}

test('dashboard-focused Ctrl+F opens Rivet search instead of browser find', async ({ page }) => {
  const frameLocator = await openSeededEditorProject(page, 'search-shortcut', 'Search Shortcut Project');

  const collapseButton = page.getByRole('button', { name: 'Collapse folders pane' });
  await collapseButton.focus();
  await waitForFocusTag(page, 'BUTTON', 'dashboard shortcut source');

  await page.keyboard.press(`${shortcutModifier}+F`);
  const graphSearchInput = visibleGraphSearchInput(frameLocator);
  await expect(graphSearchInput).toBeVisible();
  await expect(graphSearchInput).toBeFocused();

  await graphSearchInput.press('Escape');
  await expect(graphSearchInput).toBeHidden();
});

test('iframe-focused Ctrl+F opens Rivet search instead of browser find', async ({ page }) => {
  const frameLocator = await openSeededEditorProject(page, 'iframe-search-shortcut', 'Iframe Search Shortcut Project');
  const canvas = frameLocator.locator('.node-canvas');

  await canvas.click();
  await page.keyboard.press(`${shortcutModifier}+F`);

  const graphSearchInput = visibleGraphSearchInput(frameLocator);
  await expect(graphSearchInput).toBeVisible();
  await expect(graphSearchInput).toBeFocused();
});

test('graph folder toggles preserve search while ordinary outside clicks and explicit dismissal still work', async ({
  page,
}) => {
  const editor = await openSeededEditorProject(page, 'folder-search', 'Folder Search Project', [
    { id: 'folder-search-child', name: 'Group/Nested/Child' },
    { id: 'folder-search-other', name: 'Other/Sibling' },
  ]);
  const folder = (path: string) =>
    editor.locator(`.graph-item[data-contextmenutype="graph-folder"][data-folderpath="${path}"] .graph-item-select`);
  const child = editor.locator('.graph-item[data-graphid="folder-search-child"]');
  const search = visibleGraphSearchInput(editor);
  await editor.locator('.node-canvas').click();
  await page.keyboard.press(`${shortcutModifier}+F`);
  await search.fill('Child');
  const result = editor.locator('.search-result-graph-name');
  await expect(result).toHaveText('Group/Nested/Child');
  await folder('Group').locator('svg').first().click();
  await expect(child).toBeHidden();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue('Child');
  await expect(result).toHaveText('Group/Nested/Child');
  await folder('Group').locator('.graph-item-name-text').click();
  await expect(child).toBeVisible();
  await folder('Group/Nested').click();
  await expect(child).toBeHidden();
  await expect(search).toBeVisible();
  await folder('Group/Nested').click();
  await expect(child).toBeVisible();
  await folder('Group').click({ modifiers: [shortcutModifier] });
  await expect(editor.locator('.graph-item[data-graphid="folder-search-other"]')).toBeHidden();
  await expect(search).toHaveValue('Child');
  await folder('Group').click({ modifiers: [shortcutModifier] });
  await expect(child).toBeVisible();
  await expect(search).toBeVisible();
  await expect(editor.locator('.graph-item.selected[data-graphid="folder-search-graph"]')).toBeVisible();
  await page.keyboard.press(`${shortcutModifier}+F`);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('Child');
  await expect(result).toHaveText('Group/Nested/Child');

  await child.locator('.graph-item-select').click();
  await expect(search).toBeHidden();
  await page.keyboard.press(`${shortcutModifier}+F`);
  await expect(search).toHaveValue('Child');
  await editor.locator('.node-canvas').click({ position: { x: 300, y: 400 } });
  await expect(search).toBeHidden();
  await page.keyboard.press(`${shortcutModifier}+F`);
  await search.press('Escape');
  await expect(search).toBeHidden();
  await page.keyboard.press(`${shortcutModifier}+F`);
  await expect(search).toHaveValue('Child');
  await editor.locator('.search .stopSearching').click();
  await expect(search).toBeHidden();
  await page.keyboard.press(`${shortcutModifier}+F`);
  await expect(search).toHaveValue('');
});

test('iframe-focused physical find shortcut works when event.key is not f', async ({ page }) => {
  const frameLocator = await openSeededEditorProject(
    page,
    'localized-search-shortcut',
    'Localized Search Shortcut Project',
  );

  const prevented = await frameLocator.locator('body').evaluate(() => {
    const decoySearch = document.createElement('div');
    decoySearch.className = 'search';
    decoySearch.hidden = true;

    const decoyInput = document.createElement('input');
    decoyInput.placeholder = 'Search...';
    decoySearch.append(decoyInput);
    document.body.append(decoySearch);
    const isMac = navigator.platform.toLowerCase().includes('mac');

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyF',
      ctrlKey: !isMac,
      key: 'x',
      metaKey: isMac,
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(prevented).toBe(true);
  const graphSearchInput = visibleGraphSearchInput(frameLocator);
  await expect(graphSearchInput).toBeVisible();
  await expect(graphSearchInput).toBeFocused();
});

test('iframe-focused Ctrl+F does not steal focus from editor text inputs', async ({ page }) => {
  const frameLocator = await openSeededEditorProject(
    page,
    'editable-search-shortcut',
    'Editable Search Shortcut Project',
  );

  const prevented = await frameLocator.locator('body').evaluate(() => {
    const editorInput = document.createElement('input');
    editorInput.type = 'text';
    editorInput.value = 'editable field';
    document.body.append(editorInput);
    editorInput.focus();
    const isMac = navigator.platform.toLowerCase().includes('mac');

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyF',
      ctrlKey: !isMac,
      key: 'f',
      metaKey: isMac,
    });
    editorInput.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(prevented).toBe(false);
  await expect(frameLocator.locator(graphSearchInputSelector)).toBeHidden();
});
