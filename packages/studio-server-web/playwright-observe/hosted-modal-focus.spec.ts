import { expect, test, type Page } from '@playwright/test';
import { mockHostedEditorBootstrap, openHostedDashboardFixture } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { serializeProject } from '@valerypopoff/rivet2-core';

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
  await page.route('**/api/projects/load', async (route) => {
    const project = await page.evaluate(() => JSON.parse(localStorage.getItem('project')!).projectState);
    await route.fulfill({ json: { contents: serializeProject(project), datasetsContents: null, revisionId: null } });
  });
  await openHostedDashboardFixture(page);
  // Open through the real dashboard bridge rather than relying on legacy recovery state.
  await page.locator('.project-row', { hasText: 'Focus fixture' }).dblclick();
  await expect(
    page.frameLocator('iframe.dashboard-editor-frame').locator('.node[data-nodeid="text-output"]'),
  ).toBeVisible({ timeout: 60_000 });
  return writes;
}

test('reloading an editor with an open menu releases its dashboard listeners', async ({ page }) => {
  await setupFocusFixture(page);
  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame')!.contentWindow! as Window &
      typeof globalThis;
    const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const sync = () => {
      document.documentElement.dataset.editorMenuListeners = String(
        [...active.values()].reduce((sum, listeners) => sum + listeners.size, 0),
      );
    };
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = ((type, listener, options) => {
      if (listener instanceof frameWindow.Function && ['pointerdown', 'click', 'contextmenu'].includes(type)) {
        const listeners = active.get(type) ?? new Set();
        listeners.add(listener);
        active.set(type, listeners);
        sync();
      }
      add(type, listener, options);
    }) as Document['addEventListener'];
    document.removeEventListener = ((type, listener, options) => {
      if (listener) active.get(type)?.delete(listener);
      sync();
      remove(type, listener, options);
    }) as Document['removeEventListener'];
    sync();
  });
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor.locator('.node-canvas').click({ button: 'right', position: { x: 600, y: 300 } });
  await expect(editor.locator('.context-menu-search input:visible')).toBeVisible();
  const listeners = page.locator('html');
  await expect(listeners).toHaveAttribute('data-editor-menu-listeners', '3');
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame.parentFrame() === page.mainFrame()),
    page
      .locator('iframe.dashboard-editor-frame')
      .evaluate((frame: HTMLIFrameElement) => frame.contentWindow!.location.reload()),
  ]);
  await expect(listeners).toHaveAttribute('data-editor-menu-listeners', '0', { timeout: 2_000 });
});

test('alternating cross-surface right clicks preserve the new menu and the next control click', async ({ page }) => {
  const writes = await setupFocusFixture(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvas = editor.locator('.node-canvas');
  const node = editor.locator('.node[data-nodeid="text-output"]');
  const search = editor.locator('.context-menu-search input:visible');
  const nodeEditor = editor.locator('.node-editor-width-resize-handle');

  for (const [rowSelector, name] of [
    ['.project-row', 'Focus fixture'],
    ['.folder-row', 'Focus folder'],
  ] as const) {
    const row = page.locator(rowSelector, { hasText: name });
    const menu = page.getByRole('menu', { name: `Actions for ${name}` });
    await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await canvas.click({ button: 'right', position: { x: 600, y: 300 } });
    await expect(menu).toHaveCount(0);
    await expect(search).toBeVisible();
    await search.fill('Text');

    // One physical right click closes the old menu and opens the other one.
    await row.click({ button: 'right' });
    await expect(search).not.toBeVisible();
    await expect(menu).toBeVisible();

    // Hover alone must not dismiss, and the first control click must still act.
    await node.hover();
    await expect(menu).toBeVisible();
    await node.locator('.edit-button').click();
    await expect(menu).toHaveCount(0);
    await expect(nodeEditor).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nodeEditor).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});

for (const target of ['editor', 'dashboard'] as const) {
  test(`keyboard activation in ${target} dismisses the other surface's context menu`, async ({ page }) => {
    const writes = await setupFocusFixture(page);
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const menu =
      target === 'editor'
        ? page.getByRole('menu', { name: 'Actions for Focus fixture' })
        : editor.locator('.context-menu-search input:visible');
    if (target === 'editor') {
      await page.locator('.project-row', { hasText: 'Focus fixture' }).click({ button: 'right' });
    } else {
      await editor.locator('.node-canvas').click({ button: 'right', position: { x: 600, y: 300 } });
    }
    await expect(menu).toBeVisible();
    const control =
      target === 'editor'
        ? editor.getByRole('button', { name: 'Project settings', exact: true })
        : page.locator('.active-project-more-button');
    await control.focus();
    await expect(menu).toBeVisible(); // Focus/Tab alone is not an outside click.
    await control.press('Enter');
    const modal =
      target === 'editor'
        ? editor.getByTestId('project-settings-modal')
        : page.getByRole('button', { name: 'Close project settings' });
    await expect(modal).toBeVisible();
    await expect(menu).not.toBeVisible({ timeout: 2_000 });
    expect(writes).toEqual([]);
  });
}

for (const kind of ['project', 'folder'] as const) {
  test(`${kind} context menu dismisses on editor input without consuming the click`, async ({ page }) => {
    const writes = await setupFocusFixture(page);
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const row =
      kind === 'project'
        ? page.locator('.project-row', { hasText: 'Focus fixture' })
        : page.locator('.folder-row', { hasText: 'Focus folder' });
    const menu = page.getByRole('menu', {
      name: `Actions for ${kind === 'project' ? 'Focus fixture' : 'Focus folder'}`,
    });
    await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await editor.getByRole('button', { name: 'Project settings', exact: true }).click();
    await expect(menu).toHaveCount(0);
    const settings = editor.getByTestId('project-settings-modal');
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close modal', exact: true }).click();

    // Touch/pen and keyboard context-menu events use the same outside surface.
    for (const pointerType of ['touch', 'pen']) {
      await row.click({ button: 'right' });
      await expect(menu).toBeVisible();
      await editor.locator('body').dispatchEvent('pointerdown', { pointerType, pointerId: 7, isPrimary: true });
      await expect(menu).toHaveCount(0);
    }
    await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await editor.locator('body').dispatchEvent('contextmenu');
    await expect(menu).toHaveCount(0);

    // Own menu-item clicks still run once and preserve inline rename focus.
    await row.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: `Rename ${kind}` }).click();
    const rename = page.getByRole('textbox', {
      name: `Rename ${kind === 'project' ? 'Focus fixture' : 'Focus folder'}`,
    });
    await expect(rename).toBeFocused();
    await rename.fill('unchanged until committed');
    await expect(rename).toBeFocused();
    await rename.press('Escape');
    expect(writes).toEqual([]);
  });
}

test('editor context menus dismiss into dashboard input without stealing focus or closing dialogs', async ({
  page,
}) => {
  const writes = await setupFocusFixture(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position: { x: 600, y: 300 } });
  const search = editor.locator('.context-menu-search input:visible');
  await expect(search).toBeVisible();
  await search.fill('Text');
  await expect(search).toBeFocused();
  await expect(search).toBeVisible();
  // A real dashboard control still receives the original click.
  await page.locator('.project-row', { hasText: 'Focus fixture' }).click({ button: 'right' });
  await expect(search).not.toBeVisible();
  await page.getByRole('menuitem', { name: 'Rename project' }).click();
  const rename = page.getByRole('textbox', { name: 'Rename Focus fixture' });
  await rename.fill('dashboard typing');
  await expect(rename).toBeFocused();
  await rename.press('Escape');

  const graph = editor.getByRole('button', { name: 'Main Graph', exact: true });
  await graph.click({ button: 'right' });
  const graphMenu = editor.locator('.graph-item-context-menu');
  await expect(graphMenu).toBeVisible();
  await page.locator('.active-project-more-button').click();
  await expect(graphMenu).toHaveCount(0);
  const endpoint = page.getByRole('textbox', { name: 'Workflow endpoint path' });
  await endpoint.fill('still-focused');
  await expect(endpoint).toBeFocused();
  await page.getByRole('button', { name: 'Close project settings' }).click();

  // Cross-surface dismissal is menu-only: an editor dialog stays open.
  await editor.getByRole('button', { name: 'Project settings', exact: true }).click();
  const settings = editor.getByTestId('project-settings-modal');
  await expect(settings).toBeVisible();
  await page.locator('.project-row', { hasText: 'Focus fixture' }).click({ button: 'right' });
  const dashboardMenu = page.getByRole('menu', { name: 'Actions for Focus fixture' });
  await expect(dashboardMenu).toBeVisible();
  await settings.getByRole('button', { name: 'General', exact: true }).click();
  await expect(dashboardMenu).toHaveCount(0);
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Close modal', exact: true }).click();
  expect(writes).toEqual([]);
});

for (const kind of ['project', 'folder'] as const) {
  test(`${kind} context menu owns pointer hover and clicks over the sidebar splitter`, async ({ page }) => {
    const writes = await setupFocusFixture(page);
    const sidebar = page.locator('.dashboard-sidebar');
    const resizer = page.getByRole('separator', { name: 'Resize folders pane' });
    const before = (await sidebar.boundingBox())!.width;
    const edge = (await resizer.boundingBox())!;
    const row =
      kind === 'project'
        ? page.locator('.project-row', { hasText: 'Focus fixture' })
        : page.getByRole('button', { name: 'Expand Focus folder', exact: true });
    const bounds = (await row.boundingBox())!;
    await row.click({ button: 'right', position: { x: bounds.width - 30, y: bounds.height / 2 } });
    const menu = page.getByRole('menu', { name: `Actions for Focus ${kind === 'project' ? 'fixture' : 'folder'}` });
    await expect(menu).toBeVisible();
    const rename = menu.getByRole('menuitem', { name: `Rename ${kind}`, exact: true });
    const item = (await rename.boundingBox())!;
    const point = { x: edge.x + edge.width / 2, y: item.y + item.height / 2 };
    expect(point.x).toBeGreaterThan(item.x);
    expect(point.x).toBeLessThan(item.x + item.width);
    await page.mouse.move(point.x, point.y);
    await expect
      .poll(() =>
        page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[role="menuitem"]')), point),
      )
      .toBe(true);
    expect(await resizer.evaluate((element) => element.matches(':hover'))).toBe(false);
    await page.mouse.click(point.x, point.y);
    await expect(menu).toHaveCount(0);
    await expect(
      page.getByRole('textbox', { name: `Rename Focus ${kind === 'project' ? 'fixture' : 'folder'}` }),
    ).toBeFocused();
    await expect(sidebar).not.toHaveClass(/dashboard-sidebar-resizing/);
    expect((await sidebar.boundingBox())!.width).toBe(before);
    await page.keyboard.press('Escape');
    await page.mouse.move(point.x, 48);
    await page.mouse.down();
    await page.mouse.move(360, 48, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(360);
    expect(writes).toEqual([]);
  });
}

test('modal backdrops block sidebar resize in both documents and cancel an existing drag', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const writes = await setupFocusFixture(page);
  const sidebar = page.locator('.dashboard-sidebar');
  const resizer = page.getByRole('separator', { name: 'Resize folders pane' });
  const width = async () => Math.round((await sidebar.boundingBox())!.width);
  const drag = async (destination: number) => {
    const box = (await resizer.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, 48);
    await page.mouse.down();
    await page.mouse.move(destination, 48, { steps: 4 });
  };
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
  await drag(340);
  await page.mouse.up();
  await expect.poll(width).toBe(340);

  // A modal opening while a drag owns the pointer cancels it without flushing a queued move.
  await drag(360);
  await expect(sidebar).toHaveClass(/dashboard-sidebar-resizing/);
  await expect.poll(width).toBe(360);
  await page
    .locator('.panel-bottom-actions')
    .getByRole('button', { name: 'Settings', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  const settings = page.getByTestId('app-settings-modal');
  await expect(settings).toBeVisible();
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await expect(sidebar).not.toHaveClass(/dashboard-sidebar-resizing/);
  await page.mouse.move(480, 48, { steps: 4 });
  await page.mouse.up();
  expect(await width()).toBe(360);
  await expect(resizer).toHaveCSS('pointer-events', 'none');
  // Exercise event guards too, independently of CSS hit testing (including touch/pen).
  for (const type of ['mousedown', 'pointerdown']) {
    await resizer.dispatchEvent(type, { button: 0, clientX: 470, pointerType: 'pen', isPrimary: true, pointerId: 19 });
    await expect(sidebar).not.toHaveClass(/dashboard-sidebar-resizing/);
    expect(await width()).toBe(360);
  }
  await settings.getByRole('button', { name: 'Close app settings', exact: true }).click();
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const node = editor.locator('.node[data-nodeid="text-output"]');
  await editor.locator('.run-button button').first().click();
  await expect(node).toHaveClass(/success/);
  await node.locator('.node-output').hover();
  await node.locator('.expand-button').click();
  const output = editor.getByTestId('fullscreen-output-modal');
  await expect(output).toBeVisible();
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await resizer.dispatchEvent('mousedown', { button: 0, clientX: 480 });
  await expect(sidebar).not.toHaveClass(/dashboard-sidebar-resizing/);
  expect(await width()).toBe(360);
  const outputWidth = (await output.boundingBox())!.width;
  const outputHandle = output.getByRole('separator', { name: 'Resize fullscreen output modal from the left edge' });
  const handleBox = (await outputHandle.boundingBox())!;
  await page.mouse.move(handleBox.x + 12, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 82, handleBox.y + handleBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await output.boundingBox())!.width).toBeLessThan(outputWidth - 40);
  expect(await width()).toBe(360);

  // Closing one of two stacked modals must not unlock the separator.
  await editor
    .getByRole('button', { name: 'Project settings', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  const projectSettings = editor.getByTestId('project-settings-modal');
  await expect(projectSettings).toBeVisible();
  await projectSettings.getByRole('button', { name: 'Close modal', exact: true }).click();
  await expect(output).toBeVisible();
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await output.press('Escape');
  await expect(output).toHaveCount(0);
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');

  // Retained hidden dialogs and non-modal popovers do not lock the sidebar.
  await editor.locator('body').evaluate((body) => {
    const popup = document.createElement('section');
    popup.dataset.testid = 'resize-guard-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'false');
    popup.textContent = 'Non-modal popup';
    body.append(popup);
  });
  const popup = editor.getByTestId('resize-guard-popup');
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
  await popup.evaluate((element) => element.setAttribute('aria-modal', 'true'));
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await popup.evaluate((element: HTMLElement) => {
    element.hidden = true;
  });
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
  await popup.evaluate((element: HTMLElement) => {
    element.hidden = false;
  });
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await popup.evaluate((element) => element.remove());
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
  await drag(320);
  await page.mouse.up();
  await expect.poll(width).toBe(320);
  expect(pageErrors, 'blocked pointer events never attempt capture or throw').toEqual([]);
  expect(writes).toEqual([]);
});

test('a native modeless dialog does not block sidebar resize', async ({ page }) => {
  await setupFocusFixture(page);
  const resizer = page.getByRole('separator', { name: 'Resize folders pane' });
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.dataset.testid = 'native-resize-dialog';
    dialog.textContent = 'Modeless native dialog';
    document.body.append(dialog);
    dialog.show();
  });
  await expect(resizer).toHaveAttribute('aria-disabled', 'false', { timeout: 2_000 });
  const dialog = page.getByTestId('native-resize-dialog');
  await dialog.evaluate((element: HTMLDialogElement) => {
    element.close();
    element.showModal();
  });
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await dialog.evaluate((element: HTMLDialogElement) => element.close());
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
});

test('an editor modal locks resize only while its iframe is visible', async ({ page }) => {
  await setupFocusFixture(page);
  const resizer = page.getByRole('separator', { name: 'Resize folders pane' });
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor.getByRole('button', { name: 'Project settings', exact: true }).click();
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  const iframe = page.locator('iframe.dashboard-editor-frame');
  await iframe.evaluate((element) => element.classList.add('dashboard-editor-frame-hidden'));
  await expect(resizer).toHaveAttribute('aria-disabled', 'false', { timeout: 2_000 });
  await iframe.evaluate((element) => element.classList.remove('dashboard-editor-frame-hidden'));
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  await editor.getByTestId('project-settings-modal').getByRole('button', { name: 'Close modal', exact: true }).click();
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
});

test('losing touch pointer capture ends the sidebar drag', async ({ page }) => {
  await setupFocusFixture(page);
  const sidebar = page.locator('.dashboard-sidebar');
  const resizer = page.getByRole('separator', { name: 'Resize folders pane' });
  const box = (await resizer.boundingBox())!;
  await resizer.evaluate((element) =>
    element.addEventListener('gotpointercapture', (event) => {
      (element as HTMLElement).dataset.pointerId = String((event as PointerEvent).pointerId);
    }),
  );
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x + 8, y: 48, id: 1 }],
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 340, y: 48, id: 1 }] });
    await expect(sidebar).toHaveClass(/dashboard-sidebar-resizing/);
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(340);
    await resizer.evaluate((element) =>
      element.releasePointerCapture(Number((element as HTMLElement).dataset.pointerId)),
    );
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 430, y: 48, id: 1 }] });
    await expect(sidebar).not.toHaveClass(/dashboard-sidebar-resizing/, { timeout: 2_000 });
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(340);
  } finally {
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await client.detach();
  }
});

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
