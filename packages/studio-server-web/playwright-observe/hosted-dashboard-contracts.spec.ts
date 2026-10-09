import { expect, test, type Locator } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('editor startup feedback stays in the editor area, not the project tree', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'editor-loading', revision: 0 },
        folders: [],
        projects: [
          {
            id: 'loading-fixture',
            name: 'Loading fixture',
            fileName: 'loading-fixture.rivet-project',
            relativePath: 'loading-fixture.rivet-project',
            absolutePath: '/workflows/loading-fixture.rivet-project',
            updatedAt: '2026-10-08T00:00:00.000Z',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          },
        ],
      },
    }),
  );
  let releaseEditor!: () => void;
  const editorGate = new Promise<void>((resolve) => {
    releaseEditor = resolve;
  });
  await page.route(
    (url) => url.searchParams.has('editor'),
    async (route) => {
      await editorGate;
      await route.continue();
    },
  );
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    const tree = page.locator('.workflow-library-panel .body');
    const row = tree.getByRole('button', { name: 'Loading fixture', exact: true });
    await expect(row).toBeVisible();
    await expect(row).toBeDisabled();
    await expect(row).toHaveAttribute('title', 'loading-fixture.rivet-project');
    await expect(tree).not.toContainText('Loading editor');
    await expect(page.locator('.dashboard-main .dashboard-app-loading')).toBeVisible();
    releaseEditor();
    await waitForDashboardReady(page);
    await expect(row).toBeEnabled();
    await expect(tree).not.toContainText('Loading editor');
    await expect(page.locator('.dashboard-main .dashboard-app-loading')).toBeHidden();
  } finally {
    releaseEditor();
  }
});

test('hosted dialogs render the shared theme and project health uses the metadata identity', async ({ page }) => {
  const project = {
    id: 'catalog-row-id',
    projectMetadataId: 'metadata-project-id',
    revisionId: 'draft-1',
    name: 'Dashboard contract fixture',
    fileName: 'fixture.rivet-project',
    relativePath: 'fixture.rivet-project',
    absolutePath: '/workflows/fixture.rivet-project',
    updatedAt: '2026-10-05T00:00:00.000Z',
    stats: { graphCount: 1, totalNodeCount: 0, webAppCount: 0 },
    settings: {
      status: 'unpublished_changes',
      publicationVersion: '1',
      endpointName: 'fixture',
      lastPublishedAt: '2026-10-04T00:00:00.000Z',
      publishedWebApps: [],
    },
  };
  const now = Date.now();
  const healthRequests: string[] = [];
  const entry = (key: string, state: 'open' | 'half-open') => ({
    identity: {
      key,
      projectId: project.projectMetadataId,
      profileNodeId: null,
      profileName: key,
      provider: 'openai',
      model: 'fixture-model',
      configurationFingerprint: `sha256:${key}`,
    },
    state,
    failureCount: 3,
    openUntil: now + 60_000,
    halfOpenLeaseUntil: now + 60_000,
    updatedAt: now,
    contributingRuns:
      state === 'open'
        ? [
            {
              occurredAt: now,
              contributionCount: 1,
              triggeredSuspension: true,
              availability: 'available',
              recordingId: 'contributing-run',
            },
          ]
        : [],
  });
  // No live API, credentials or internet are needed for this appearance/wiring
  // smoke. Unknown API reads fail explicitly rather than reaching an ambient VM.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      let json: unknown;
      switch (url.pathname) {
        case '/api/workflows/tree':
          json = { root: '/workflows', sync: { epoch: 'contracts', revision: 0 }, folders: [], projects: [project] };
          break;
        case '/api/workflows/projects/web-apps':
          json = {
            project,
            projectId: project.projectMetadataId,
            draftRevisionId: project.revisionId,
            publicationVersion: '1',
            hasMainGraph: true,
            webApps: [],
          };
          break;
        case '/api/workflows/projects/published-versions':
          json = {
            project,
            projectId: project.projectMetadataId,
            draftRevisionId: project.revisionId,
            publicationVersion: '1',
            versions: [],
          };
          break;
        case '/api/workflows/llm-profile-health/admin':
          healthRequests.push(url.searchParams.get('projectId') ?? '');
          json = [entry('Suspended profile', 'open'), entry('Recovering profile', 'half-open')];
          break;
        case '/api/workflows/recordings/workflows':
          json = { workflows: [], totals: { totalRuns: 0, failedRuns: 0, suspiciousRuns: 0 } };
          break;
        case '/api/workflows/recordings/runs':
          json = { workflowId: '', page: 1, pageSize: 20, totalRuns: 0, statusFilter: 'all', runs: [] };
          break;
        case '/api/workflows/run-statistics/targets':
          json = { surface: 'endpoint', targets: [] };
          break;
        case '/api/app-settings/local-upgrade/setup':
          json = { eligible: false };
          break;
        default:
          await route.fulfill({ status: 503, json: { error: 'Unavailable in this isolated UI fixture' } });
          return;
      }
      await route.fulfill({ json });
    },
  );
  await mockHostedEditorBootstrap(page);
  // Assert font registration, not the availability of Google's font CDN in CI.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('body')).toHaveCount(1);
  const fonts = await editor
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) =>
      links.flatMap((link) => new URL((link as HTMLLinkElement).href).searchParams.getAll('family')),
    );
  for (const family of ['Roboto', 'Roboto Mono']) {
    expect(
      fonts.some((value) => value.split(':')[0] === family),
      `${family} is registered in the editor document`,
    ).toBe(true);
  }

  let theme: { background: string; color: string; overlay: string; blur: string } | undefined;
  const checkTheme = async (testId: string) => {
    const dialog = page.getByTestId(testId);
    const blanket = page.getByTestId(`${testId}--blanket`);
    await expect(dialog).toBeVisible();
    await expect(blanket).toBeVisible();
    const actual = {
      ...(await dialog.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      }))),
      ...(await blanket.evaluate((element) => ({
        overlay: getComputedStyle(element).backgroundColor,
        blur: getComputedStyle(element).backdropFilter,
      }))),
    };
    if (theme) expect(actual, testId).toEqual(theme);
    else {
      expect(actual.background).toBe('rgb(31, 31, 34)');
      expect(actual.overlay).toBe('rgba(0, 0, 0, 0.56)');
      expect(actual.blur).toBe('blur(2px)');
      theme = actual;
    }
    await expect(page.getByTestId(`${testId}--body`)).toHaveCSS('padding', '0px');
    return dialog;
  };
  const close = async (dialog: Locator) => {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  for (const [label, id] of [
    ['Settings', 'app-settings-modal'],
    ['Run recordings', 'run-recordings-modal'],
    ['Run statistics', 'run-statistics-modal'],
    ['Published', 'published-items-modal'],
  ]) {
    await page.locator('.panel-bottom-actions').getByRole('button', { name: label, exact: true }).click();
    await close(await checkTheme(id!));
  }
  const row = page.locator('.project-row', { hasText: project.name });
  await row.click();
  await page.locator('.active-project-more-button').click();
  const settings = await checkTheme('workflow-project-settings-modal');
  await expect(settings.getByRole('tab')).toHaveText([
    'Endpoint',
    'Web apps',
    'LLM profile suspension',
    'Classifier profile suspension',
    'Published version history',
    'Danger zone',
  ]);
  await settings.getByRole('tab', { name: 'LLM profile suspension' }).click();
  const suspended = settings.locator('.project-settings-llm-health-row-suspended');
  const recovering = settings.locator('.project-settings-llm-health-row-recovery');
  await expect(suspended).toContainText('Suspended profile');
  await expect(suspended).toContainText('suspended until');
  await expect(suspended.getByRole('button', { name: 'Open contributing run recording' })).toBeVisible();
  await expect(recovering).toContainText('recovery attempt in progress');
  await expect(recovering).toContainText('This suspension predates recording links');
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => healthRequests.length).toBeGreaterThanOrEqual(2);
  expect(new Set(healthRequests)).toEqual(new Set([project.projectMetadataId]));
  await settings.getByRole('tab', { name: 'Endpoint', exact: true }).click();
  await settings.getByRole('tab', { name: 'Published version history' }).click();
  await expect(settings.getByRole('tabpanel', { name: 'Published version history' })).toContainText(
    'No published versions',
  );
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await settings.getByRole('tab', { name: 'Danger zone' }).click();
  await expect(settings.getByRole('button', { name: 'Delete project' })).toBeDisabled();
  await expect(settings).toContainText('permanent and cannot be undone');
  const dangerHelp = settings.locator('.project-settings-danger-section .project-settings-help').first();
  await expect(dangerHelp).toHaveCSS('font-size', '14px');
  await expect(dangerHelp).toHaveCSS('line-height', '21px');
  await page.setViewportSize({ width: 390, height: 844 });
  const tablist = settings.getByRole('tablist');
  expect(await tablist.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(settings.getByRole('tab', { name: 'Published version history' })).toBeVisible();
  await close(settings);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
  await close(await checkTheme('workflow-project-version-modal'));
});
