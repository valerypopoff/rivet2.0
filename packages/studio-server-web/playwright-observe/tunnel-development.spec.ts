import { expect, test } from '@playwright/test';
import { serializeProject, PromptNodeImpl, type Project } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

async function prepare(page: import('@playwright/test').Page) {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', folders: [], projects: [], sync: { epoch: 'tunnel-test', revision: 0 } },
    }),
  );
  await page.addInitScript(() => {
    const Native = window.EventSource;
    class BuildEvents {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      constructor() {
        (window as any).__failDevelopmentConnection = () => this.onerror?.();
        (window as any).__sendDevelopmentBuild = (phase: string, generation: string | null, error = null) =>
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ phase, generation, error, session: 'browser-test' }),
            }),
          );
      }
      close() {}
    }
    window.EventSource = new Proxy(Native, {
      construct(target, args) {
        return args[0] === '/__rivet_dev/events' ? new BuildEvents() : Reflect.construct(target, args);
      },
    });
  });
  // Authenticate through the existing gate before tests intercept editor modules.
  // Do not disable authentication or confuse a sign-in page with a bootstrap failure.
  await page.goto('/');
  await authenticateIfNeeded(page);
}

async function waitForCheckpointedEditor(page: import('@playwright/test').Page) {
  // editor-ready precedes some startup recovery effects. Wait through the real
  // handshake instead of sleeping or assuming that a mounted editor is quiet.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const target = document.querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')?.contentWindow;
              if (!target) {
                resolve(false);
                return;
              }
              const requestId = `probe-${crypto.randomUUID()}`;
              const finish = (ready: boolean) => {
                clearTimeout(timer);
                window.removeEventListener('message', response);
                target.postMessage({ type: 'cancel-development-refresh', requestId }, window.location.origin);
                resolve(ready);
              };
              const response = (event: MessageEvent) => {
                if (
                  event.source === target &&
                  event.data?.type === 'development-refresh-prepared' &&
                  event.data.requestId === requestId
                )
                  finish(event.data.ready === true);
              };
              const timer = setTimeout(() => finish(false), 3_000);
              window.addEventListener('message', response);
              target.postMessage({ type: 'prepare-development-refresh', requestId }, window.location.origin);
            }),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test('nested editor import failure presents retry, not an endless loading spinner', async ({ page }) => {
  await prepare(page);
  await page.route(/HostedEditorApp(?:\.tsx|-[^/]+\.js)/, (route) => route.abort('failed'));
  await page.goto('/');
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.getByRole('heading', { name: 'Rivet could not finish loading' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator('.dashboard-app-loading')).toBeHidden();
  await expect(editor.getByRole('button', { name: 'Retry loading' })).toBeVisible();
});

test('entry module failure presents Retry before any editor JavaScript loads, then recovers', async ({ page }) => {
  await prepare(page);
  let fail = true;
  await page.route('**/*', async (route) => {
    if (
      !fail ||
      route.request().resourceType() !== 'document' ||
      !new URL(route.request().url()).searchParams.has('editor')
    )
      return route.fallback();
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /(<script\b[^>]*type="module"[^>]*src=")[^"]+/g,
      '$1/__missing_entry.js',
    );
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.getByRole('heading', { name: 'Rivet could not finish loading' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator('.dashboard-app-loading')).toBeHidden();
  fail = false;
  await editor.getByRole('button', { name: 'Retry loading' }).click();
  await waitForDashboardReady(page);
  await expect
    .poll(async () => {
      // Live Vite may reload after discovering a new optimized dependency.
      // Reacquire the current document; navigation is not a bootstrap failure.
      const frame = page.frames().find((frame) => frame.url().includes('?editor'));
      if (!frame) return undefined;
      try {
        return await frame.evaluate(() => window.__rivetEditorBootstrapState);
      } catch (error) {
        if (error instanceof Error && /Execution context was destroyed|Frame was detached/.test(error.message))
          return undefined;
        throw error;
      }
    })
    .toBe('ready');
});

test('runtime errors and late module resource failures do not replace a working editor', async ({ page }) => {
  await prepare(page);
  await seedProjects(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'A' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible();
  const frame = page.frames().find((item) => item.url().includes('?editor'))!;
  await frame.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'Unrelated fixture runtime error' }));
    const script = document.createElement('script');
    script.type = 'module';
    document.body.append(script);
    script.dispatchEvent(new Event('error'));
    script.remove();
  });
  expect(await frame.evaluate(() => window.__rivetEditorBootstrapState)).toBe('ready');
  await expect(
    page.frameLocator('iframe.dashboard-editor-frame').getByRole('heading', { name: 'Rivet could not finish loading' }),
  ).toHaveCount(0);
  await expect(page.locator('.dashboard-app-loading')).toBeHidden();
  await expect(editor.locator('.node-canvas')).toBeVisible();
});

test('connection failure before the first status is visible and reconnect never forces refresh', async ({ page }) => {
  await prepare(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.evaluate(() => (window as any).__failDevelopmentConnection());
  await expect(
    page.getByText('Build connection interrupted. Reconnecting; the current frontend remains available.'),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__sendDevelopmentBuild(
      'ready',
      document.querySelector<HTMLMetaElement>('meta[name="rivet-dev-generation"]')!.content,
    ),
  );
  await expect(page.locator('.development-update')).toBeHidden();
});

for (const blocker of ['blurred form', 'pending rename', 'alert dialog'] as const) {
  test(`${blocker} prevents bundle refresh without losing dashboard work`, async ({ page }) => {
    await prepare(page);
    await page.goto('/');
    await waitForDashboardReady(page);
    await waitForCheckpointedEditor(page);
    const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
    await page.evaluate((kind) => {
      const element = document.createElement(kind === 'blurred form' ? 'form' : 'div');
      element.id = 'pending-dashboard-work';
      if (kind === 'pending rename') element.setAttribute('aria-busy', 'true');
      if (kind === 'alert dialog') element.setAttribute('role', 'alertdialog');
      const input = document.createElement('input');
      input.value = 'Unsubmitted dashboard edit';
      element.append(input);
      document.body.append(element);
      input.focus();
      input.blur();
      (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID());
    }, blocker);
    await expect(
      page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Refresh when safe' }).click();
    await expect(page.locator('#pending-dashboard-work input')).toHaveValue('Unsubmitted dashboard edit');
    await expect(page.locator('meta[name="rivet-dev-generation"]')).toHaveAttribute('content', generation!);
  });
}

test('bundle mode loads the real editor, reports build errors, and refreshes a quiet checkpointed workspace', async ({
  page,
}) => {
  await prepare(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin === new URL(page.url() || 'http://localhost').origin)
      requests.push(request.url());
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await waitForCheckpointedEditor(page);
  const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
  expect(generation, 'Run this spec against the tunnel bundle server').toBeTruthy();
  await expect(page.locator('iframe')).toHaveAttribute('src', `/?editor&devBuild=${generation}`);
  expect(requests.filter((url) => /\.tsx(?:\?|$)|\/@vite\//.test(url))).toHaveLength(0);
  console.log(`[tunnel-browser] ${requests.length} same-origin requests for dashboard + editor`);
  await page.evaluate(() =>
    (window as any).__sendDevelopmentBuild(
      'building',
      document.querySelector<HTMLMetaElement>('meta[name="rivet-dev-generation"]')!.content,
    ),
  );
  await expect(page.getByText('Building frontend… You can keep working.')).toBeVisible();
  await page.evaluate(() =>
    (window as any).__sendDevelopmentBuild('failed', null, 'Test compiler error. Previous bundle retained.'),
  );
  await expect(page.getByText('Test compiler error. Previous bundle retained.')).toBeVisible();
  const navigated = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 15_000,
  });
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await navigated;
  await waitForDashboardReady(page);
});

test('cancelled navigation expires refresh permission and restores editing', async ({ page }) => {
  await prepare(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  await waitForCheckpointedEditor(page);
  const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
  // Browsers require user activation before presenting a beforeunload prompt.
  await page.locator('.dashboard-empty-state-message').click();
  await page.evaluate(() => {
    window.addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = '';
    });
  });
  const dialog = page.waitForEvent('dialog');
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  const prompt = await dialog;
  expect(prompt.type()).toBe('beforeunload');
  await prompt.dismiss();
  await expect(page.locator('.development-update-shield')).toHaveCount(0, { timeout: 12_000 });
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('html')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Refresh when safe' })).toBeEnabled();
  await expect(page.locator('meta[name="rivet-dev-generation"]')).toHaveAttribute('content', generation!);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Input after cancelled refresh');
    document.body.append(input);
  });
  const input = page.getByRole('textbox', { name: 'Input after cancelled refresh' });
  await input.click();
  await input.pressSequentially('Editing still works');
  await expect(input).toHaveValue('Editing still works');
});

test('a dashboard form appearing during checkpointing cancels refresh', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    // Registered before React: model an asynchronous dashboard dialog opening
    // after editor preparation, but before the parent's final navigation check.
    window.addEventListener('message', (event) => {
      if (
        !(window as any).__testLateDashboardForm ||
        event.data?.type !== 'development-refresh-prepared' ||
        !event.data.ready
      )
        return;
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'Pending dashboard form';
      document.body.append(dialog);
    });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await waitForCheckpointedEditor(page);
  await page.evaluate(() => {
    (window as any).__testLateDashboardForm = true;
  });
  const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await expect(page.getByRole('dialog')).toHaveText('Pending dashboard form');
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
  await expect(page.locator('meta[name="rivet-dev-generation"]')).toHaveAttribute('content', generation!);
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('html')).not.toHaveAttribute('inert', '');
});

test('connection loss during refresh preparation revokes permission and unlocks the editor', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if ((window as any).__disconnectDuringRefresh && event.data?.type === 'development-refresh-prepared') {
        (window as any).__disconnectDuringRefresh = false;
        (window as any).__failDevelopmentConnection();
      }
    });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await waitForCheckpointedEditor(page);
  const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
  await page.evaluate(() => {
    (window as any).__disconnectDuringRefresh = true;
    (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID());
  });
  await expect(
    page.getByText('Build connection interrupted. Reconnecting; the current frontend remains available.'),
  ).toBeVisible();
  await expect(page.locator('meta[name="rivet-dev-generation"]')).toHaveAttribute('content', generation!);
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('html')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.development-update-shield')).toHaveCount(0);
});

async function seedProjects(page: import('@playwright/test').Page, runDelay = false) {
  const projects = ['A', 'B'].map((title) => ({
    id: `tunnel-${title}`,
    name: title,
    fileName: `${title}.rivet-project`,
    relativePath: `${title}.rivet-project`,
    absolutePath: `/workflows/${title}.rivet-project`,
    updatedAt: '2026-10-03T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  }));
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({ json: { root: '/workflows', folders: [], projects, sync: { epoch: 'tunnel-tabs', revision: 0 } } }),
  );
  await page.route('**/api/projects/load', (route) => {
    const title = route.request().postDataJSON().path.includes('/A.') ? 'A' : 'B';
    const project = {
      metadata: { id: `tunnel-${title}`, title, description: '', mainGraphId: 'main' },
      plugins: [],
      graphs: {
        main: {
          metadata: { id: 'main', name: 'Main Graph', description: '' },
          connections: [],
          nodes: runDelay
            ? [
                {
                  type: 'delay',
                  id: 'delay',
                  title: 'Delay',
                  data: { delay: 60_000 },
                  visualData: { x: 80, y: 100, width: 320 },
                },
              ]
            : [{ ...PromptNodeImpl.create(), id: 'prompt', visualData: { x: 80, y: 100, width: 320 } }],
        },
      },
    };
    return route.fulfill({
      json: { contents: serializeProject(project as unknown as Project), datasetsContents: null, revisionId: 'test' },
    });
  });
}

test('pending storage save blocks refresh until its acknowledgement, then preserves open tabs', async ({ page }) => {
  await prepare(page);
  await seedProjects(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saves = 0;
  await page.route('**/api/projects/save', async (route) => {
    saves++;
    await gate;
    await route.fulfill({ json: { path: route.request().postDataJSON().path, revisionId: 'saved-test' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'A' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node[data-nodeid="prompt"]')).toBeVisible({ timeout: 120_000 });
  await waitForCheckpointedEditor(page);
  // Save a clean project: dirty state alone must not be the reason refresh stops.
  await page.evaluate(() =>
    document
      .querySelector<HTMLIFrameElement>('iframe')!
      .contentWindow!.postMessage({ type: 'save-project' }, window.location.origin),
  );
  await expect.poll(() => saves).toBe(1);
  const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
  await expect(page.locator('meta[name="rivet-dev-generation"]')).toHaveAttribute('content', generation!);
  release();
  await waitForCheckpointedEditor(page);
  const navigation = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() });
  await page.getByRole('button', { name: 'Refresh when safe' }).click();
  await navigation;
  await waitForDashboardReady(page);
  await expect(
    page.frameLocator('iframe.dashboard-editor-frame').locator('.projects-container .project').filter({ hasText: 'A' }),
  ).toHaveClass(/active/);
});

test('running workflow blocks bundle refresh without aborting execution', async ({ page }) => {
  await prepare(page);
  await seedProjects(page, true);
  await page.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
  );
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'A' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node[data-nodeid="delay"]')).toBeVisible({ timeout: 120_000 });
  await waitForCheckpointedEditor(page);
  await editor.locator('.run-button button').first().click();
  await expect(editor.locator('.run-button.running')).toBeVisible();
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
  await expect(editor.locator('.run-button.running')).toBeVisible();
  await expect(editor.locator('html')).not.toHaveAttribute('inert', '');
  await editor.locator('.run-button.running button').first().click();
  await expect(editor.locator('.run-button.running')).toHaveCount(0);
});

test('backend outage preserves dirty edits; retry save permits safe bundle refresh', async ({ page }) => {
  await prepare(page);
  await seedProjects(page);
  let unavailable = true;
  let saves = 0;
  await page.route('**/api/projects/save', async (route) => {
    saves++;
    if (unavailable) return route.fulfill({ status: 503, json: { error: 'Fixture backend temporarily unavailable' } });
    return route.fulfill({ json: { path: route.request().postDataJSON().path, revisionId: 'retry-saved' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'A' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const title = editor.locator('.node[data-nodeid="prompt"] .node-title');
  await expect(title).toBeVisible({ timeout: 120_000 });
  const box = (await title.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const save = page.locator('.active-project-save-button');
  await expect(save).toBeVisible();
  await save.click();
  await expect.poll(() => saves).toBe(1);
  await expect(save).toBeEnabled();
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
  await expect(editor.locator('.projects-container .project').filter({ hasText: 'A' })).toHaveClass(/unsaved/);
  unavailable = false;
  await save.click();
  await expect.poll(() => saves).toBe(2);
  await expect(save).toHaveCount(0);
  await waitForCheckpointedEditor(page);
  const navigation = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() });
  await page.getByRole('button', { name: 'Refresh when safe' }).click();
  await navigation;
  await waitForDashboardReady(page);
  await expect(
    page.frameLocator('iframe.dashboard-editor-frame').locator('.projects-container .project').filter({ hasText: 'A' }),
  ).toHaveClass(/active/);
});

test('a live canvas drag prevents bundle refresh before its edit is committed', async ({ page }) => {
  await prepare(page);
  await seedProjects(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'A' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const title = editor.locator('.node[data-nodeid="prompt"] .node-title');
  await expect(title).toBeVisible({ timeout: 120_000 });
  await waitForCheckpointedEditor(page);
  const generation = await page.locator('meta[name="rivet-dev-generation"]').getAttribute('content');
  const box = (await title.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(box.x + 100, box.y + box.height / 2 + 40, { steps: 5 });
    await expect(editor.locator('.node-canvas')).toHaveClass(/dragging-node/);
    await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
    await expect(
      page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
    ).toBeVisible();
    await expect(page.locator('meta[name="rivet-dev-generation"]')).toHaveAttribute('content', generation!);
    await expect(editor.locator('html')).not.toHaveAttribute('inert', '');
  } finally {
    await page.mouse.up();
  }
  await expect(editor.locator('.projects-container .project').filter({ hasText: 'A' })).toHaveClass(/unsaved/);
});

test('inactive dirty tabs prevent refresh; current workspace remains editable', async ({ page }) => {
  await prepare(page);
  await seedProjects(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'A' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.getByText('Main Graph', { exact: true }).first()).toBeVisible({ timeout: 120_000 });
  // A normal node edit dirties A; opening B must not conceal that dirty tab.
  await editor.locator('.node[data-nodeid="prompt"] .edit-button').dispatchEvent('click');
  const input = editor.locator('.monaco-editor textarea').first();
  await input.focus();
  await input.press('Control+A');
  await input.pressSequentially('Unsaved A text');
  await page.locator('.project-row', { hasText: 'B' }).dblclick();
  await expect(editor.locator('.projects-container .project:not(.opening)', { hasText: 'B' })).toHaveClass(
    /\bactive\b/,
  );
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
  await expect(editor.locator('html')).not.toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Refresh when safe' }).click();
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
});

test('checkpoint transaction abort forbids refresh and releases the input lock', async ({ page }) => {
  await prepare(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  await waitForCheckpointedEditor(page);
  const frame = page.frames().find((item) => item.url().includes('?editor'))!;
  await frame.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args);
      if (args[1] === 'readwrite')
        queueMicrotask(() => {
          try {
            tx.abort();
          } catch {}
        });
      return tx;
    } as typeof transaction;
  });
  const before = page.url();
  await page.evaluate(() => (window as any).__sendDevelopmentBuild('ready', crypto.randomUUID()));
  await expect(
    page.getByText('Frontend update ready. Save changes and finish running work before refreshing.'),
  ).toBeVisible();
  expect(page.url()).toBe(before);
  expect(await frame.evaluate(() => document.documentElement.inert)).toBe(false);
});
