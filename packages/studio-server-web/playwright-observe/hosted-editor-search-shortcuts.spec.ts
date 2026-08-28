import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady, waitForFocusTag } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const graphSearchInputSelector = '.search input[placeholder="Search..."]';

async function openSeededEditorProject(page: Page, idPrefix: string, title: string): Promise<FrameLocator> {
  await seedHostedEditorProject(page, {
    graphId: `${idPrefix}-graph`,
    loaded: true,
    projectId: `${idPrefix}-project`,
    projectPath: `/workflows/${title}.rivet-project`,
    title,
  });

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

test('iframe-focused physical find shortcut works when event.key is not f', async ({ page }) => {
  const frameLocator = await openSeededEditorProject(page, 'localized-search-shortcut', 'Localized Search Shortcut Project');

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
  const frameLocator = await openSeededEditorProject(page, 'editable-search-shortcut', 'Editable Search Shortcut Project');

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
