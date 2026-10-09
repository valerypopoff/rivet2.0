import { expect, test, type Page } from '@playwright/test';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

async function setupFocusFixture(page: Page): Promise<string[]> {
  await seedHostedEditorProject(page, {
    graphId: 'focus-graph',
    loaded: true,
    projectId: 'focus-project',
    projectPath: '/workflows/Focus fixture.rivet-project',
    title: 'Focus fixture',
    graph: {
      nodes: [
        {
          id: 'text-output',
          type: 'text',
          title: 'Focus output',
          data: { text: 'local focus regression output' },
          visualData: { x: 100, y: 120, width: 300 },
        },
      ],
    },
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      'recoil-persist',
      JSON.stringify({
        defaultExecutor: 'browser',
        recordExecutions: false,
      }),
    ),
  );
  await mockHostedEditorBootstrap(page);
  const writes: string[] = [];
  await page.route('**/api/**', (route) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.fallback();
    writes.push(route.request().url());
    return route.abort();
  });
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'focus', revision: 0 },
        folders: [
          {
            id: 'Focus folder',
            name: 'Focus folder',
            relativePath: 'Focus folder',
            absolutePath: '/workflows/Focus folder',
            updatedAt: '2026-10-09T00:00:00Z',
            folders: [],
            projects: [],
          },
        ],
        projects: [
          {
            id: 'Focus fixture.rivet-project',
            projectMetadataId: 'focus-project',
            name: 'Focus fixture',
            fileName: 'Focus fixture.rivet-project',
            relativePath: 'Focus fixture.rivet-project',
            absolutePath: '/workflows/Focus fixture.rivet-project',
            updatedAt: '2026-10-09T00:00:00Z',
            settings: {
              status: 'unpublished',
              endpointName: '',
              publicationVersion: '0',
              lastPublishedAt: null,
              publishedWebApps: [],
            },
          },
        ],
      },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  await expect(
    page.frameLocator('iframe.dashboard-editor-frame').locator('.node[data-nodeid="text-output"]'),
  ).toBeVisible({ timeout: 60_000 });
  return writes;
}

test('editor output modal yields focus to dashboard inputs without losing its own keyboard trap', async ({ page }) => {
  const writes = await setupFocusFixture(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const node = editor.locator('.node[data-nodeid="text-output"]');
  await expect(node).toBeVisible({ timeout: 60_000 });
  await editor.locator('.run-button button').first().click();
  await expect(node).toHaveClass(/success/);
  await node.locator('.node-output').hover();
  await node.locator('.expand-button').click();
  const modal = editor.getByTestId('fullscreen-output-modal');
  await expect(modal).toBeVisible();

  for (const [row, menu, name] of [
    ['.project-row', 'Rename project', 'Focus fixture'],
    ['.folder-row', 'Rename folder', 'Focus folder'],
  ] as const) {
    await page.locator(row, { hasText: name }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: menu }).click();
    const rename = page.getByRole('textbox', { name: `Rename ${name}` });
    await expect(rename).toBeFocused();
    await rename.pressSequentially(' renamed', { delay: 30 });
    await expect(rename).toBeFocused();
    await expect(rename).toHaveValue(' renamed');
    await rename.press('Escape');
    await expect(rename).toHaveCount(0);
    await expect(modal).toBeVisible();
  }

  await page.locator('.active-project-more-button').click();
  const endpoint = page.getByRole('textbox', { name: 'Workflow endpoint path' });
  await endpoint.click();
  await endpoint.pressSequentially('focus-regression', { delay: 30 });
  await expect(endpoint).toBeFocused();
  await expect(endpoint).toHaveValue('focus-regression');
  const settings = page.getByRole('dialog');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.getByRole('button', { name: 'Close project settings' }).click();

  const search = modal.locator('.search-input');
  await search.fill('regression');
  await expect(search).toBeFocused();
  await expect(modal.locator('.search-count')).toHaveText('1 / 1');
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key);
      await expect.poll(() => modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
  }
  // Moving back to the dashboard after re-entering the editor must still work.
  await page.locator('.active-project-more-button').click();
  await endpoint.fill('focus-again');
  await expect(endpoint).toBeFocused();
  await page.getByRole('button', { name: 'Close project settings' }).click();
  await expect(modal).toBeVisible();
  expect(writes, 'focus regression does not mutate the ambient server').toEqual([]);
});

test('closing an unfocused editor dialog does not restore focus away from a dashboard rename', async ({ page }) => {
  const writes = await setupFocusFixture(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor.getByRole('button', { name: 'Project settings', exact: true }).click();
  const settings = editor.getByTestId('project-settings-modal');
  await expect(settings).toBeVisible();
  await page.locator('.project-row', { hasText: 'Focus fixture' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename project' }).click();
  const rename = page.getByRole('textbox', { name: 'Rename Focus fixture' });
  await expect(rename).toBeFocused();
  // Close via state/event rather than clicking into the iframe, modeling a
  // dialog being dismissed while the user is working in the dashboard.
  await settings
    .getByRole('button', { name: 'Close modal', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(settings).toHaveCount(0);
  await expect(rename).toBeFocused();
  await rename.pressSequentially('still typing');
  await expect(rename).toHaveValue('still typing');
  await rename.press('Escape');
  const opener = editor.getByRole('button', { name: 'Project settings', exact: true });
  await opener.click();
  await settings.getByRole('button', { name: 'Close modal', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(writes).toEqual([]);
});

test('foreground editor dialogs keep Find and canvas commands out of background UI', async ({ page }) => {
  const writes = await setupFocusFixture(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const node = editor.locator('.node[data-nodeid="text-output"]');
  await editor.locator('.run-button button').first().click();
  await expect(node).toHaveClass(/success/);
  await node.locator('.node-output').hover();
  await node.locator('.expand-button').click();
  const output = editor.getByTestId('fullscreen-output-modal');
  await expect(output).toBeVisible();
  // Opening another dialog via state leaves output mounted in the background.
  await editor
    .getByRole('button', { name: 'Project settings', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  const settings = editor.getByTestId('project-settings-modal');
  await expect(settings).toBeVisible();
  await settings.evaluate((element) => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Foreground dialog field');
    element.append(input);
  });
  for (const control of [
    settings.getByRole('textbox', { name: 'Foreground dialog field' }),
    settings.getByRole('button', { name: 'General', exact: true }),
  ]) {
    await control.focus();
    for (const shortcut of [
      { key: 'f', code: 'KeyF', modifier: 'ctrlKey' },
      { key: 'f', code: 'KeyF', modifier: 'metaKey' },
      { key: 'z', code: 'KeyZ', modifier: 'ctrlKey' },
      { key: 'z', code: 'KeyZ', modifier: 'metaKey' },
      { key: 'ArrowLeft', code: 'ArrowLeft', modifier: 'altKey' },
    ] as const) {
      const prevented = await control.evaluate((element, shortcut) => {
        const event = new KeyboardEvent('keydown', {
          key: shortcut.key,
          code: shortcut.code,
          [shortcut.modifier]: true,
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }, shortcut);
      expect(prevented, 'dialog keys are not intercepted by background output or canvas').toBe(false);
      await expect(control).toBeFocused();
    }
  }
  await settings.getByRole('button', { name: 'Close modal', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await output.locator('.search-input').focus();
  await page.keyboard.press('Control+f');
  await expect(output.locator('.search-input')).toBeFocused();
  expect(writes).toEqual([]);
});
