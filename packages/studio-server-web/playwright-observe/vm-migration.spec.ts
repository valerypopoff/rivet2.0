import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.beforeEach(async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/fixture/workflows',
        sync: { epoch: 'migration-fixture', revision: 0 },
        folders: [],
        projects: [],
      },
    }),
  );
  await page.route('**/?editor', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
    }),
  );
});

for (const sqlite of [false, true]) {
  test(`${sqlite ? 'SQLite' : 'Legacy'} UI migration requires a tested destination, a quiet source and an offline target`, async ({
    page,
  }) => {
    let maintenance = false;
    let drained = !sqlite;
    let phase: string | null = null;
    let precopyCompleted = false;
    let databaseTestRequests = 0;
    let objectStorageTestRequests = 0;
    let runRequests = 0;
    let reviewRequests = 0;
    let reviewComplete = false;
    let releaseDatabaseTest!: () => void;
    const databaseTestBarrier = new Promise<void>((resolve) => {
      releaseDatabaseTest = resolve;
    });
    let closedGateBucket: string | null = null;
    await page.route('**/api/app-settings/vm-migration**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();
      if (pathname.endsWith('/inventory') && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            projects: 2,
            folders: 1,
            recordingBundles: 3,
            publishedEndpoints: 1,
            publishedWebApps: 1,
            publishedVersions: 2,
            savedSettingsDomains: 4,
            sourceDatabaseAuthority: sqlite
              ? 'Selected live SQLite generation and immutable local artifacts'
              : 'Local workflow files and SQLite operational databases',
            codeNodes: 1,
            fileNodes: 0,
            warnings: ['One Code node needs a manual portability review.'],
          }),
        });
        return;
      }
      if (pathname.endsWith('/test-database') && method === 'POST') {
        databaseTestRequests += 1;
        if (databaseTestRequests === 1) await databaseTestBarrier;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      if (pathname.endsWith('/test-object-storage') && method === 'POST') {
        objectStorageTestRequests += 1;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      if (pathname.endsWith('/maintenance') && method === 'POST') maintenance = true;
      if (pathname.endsWith('/maintenance') && method === 'DELETE') {
        closedGateBucket = (route.request().postDataJSON() as { bucket: string }).bucket;
        maintenance = false;
        phase = 'invalidated';
      }
      if (pathname.endsWith('/precopy') && method === 'POST') {
        phase = 'precopy_complete';
        precopyCompleted = true;
      }
      if (pathname.endsWith('/run') && method === 'POST') {
        runRequests += 1;
        phase = 'verified';
      }
      if (pathname.endsWith('/deployment-review') && method === 'POST') {
        reviewRequests += 1;
        phase = 'verifying';
      }
      if (reviewComplete && method === 'GET') phase = 'verified';
      await route.fulfill({
        status: method === 'POST' && pathname.endsWith('/run') ? 202 : 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          sourceKind: sqlite ? 'sqlite' : 'legacy',
          precopyAvailable: !sqlite,
          maintenance: maintenance ? { enteredAt: '2026-09-27T00:00:00.000Z' } : null,
          drain: maintenance ? { ready: drained, blockers: drained ? [] : ['editor graph runs'] } : null,
          job: phase
            ? {
                id: 'fixture',
                phase,
                startedAt: '2026-09-27T00:00:01.000Z',
                finishedAt: '2026-09-27T00:00:02.000Z',
                message: null,
                precopyCompleted,
                deploymentReview: reviewComplete
                  ? {
                      reviewedAt: '2026-09-27T00:00:03.000Z',
                      sourceManifestHash: 'a'.repeat(64),
                    }
                  : undefined,
                report:
                  phase === 'verified'
                    ? {
                        projects: 2,
                        folders: 1,
                        recordings: 3,
                        publishedEndpoints: 1,
                        publishedWebApps: 1,
                        evaluationAndHealthRows: 5,
                        runtimeLibraryPackages: 2,
                        appSettingsDomains: 4,
                        checked: ['Recording metadata and replay artifact bytes'],
                      }
                    : undefined,
              }
            : null,
        }),
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('app-settings-modal');
    await modal.getByRole('tab', { name: 'Migration' }).click();
    const panel = modal.getByRole('tabpanel', { name: 'VM to managed migration' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Enter maintenance mode' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Copy and verify all data' })).toBeDisabled();
    await panel.getByRole('button', { name: 'Inspect source' }).click();
    await expect(panel.getByText(/2 projects, 1 folder, 3 recording bundles, 4 saved settings domains/)).toBeVisible();
    await expect(panel.getByText('One Code node needs a manual portability review.')).toBeVisible();

    await panel.getByLabel('Bucket').fill('destination-bucket');
    await panel.getByLabel('Signing region').fill('ru-central1');
    await panel.getByLabel('Access key ID').fill('key-id');
    await panel.getByLabel('Secret access key').fill('secret');
    await panel.getByLabel('Connection string').fill('postgresql://user:password@localhost:5432/rivet');
    await panel.getByLabel('Destination settings encryption key').fill('destination-key');
    await panel.getByRole('button', { name: 'Test S3' }).click();
    await expect(panel.getByText('S3 read, write and delete checks passed.')).toBeVisible();
    if (!sqlite) await expect(panel.getByRole('button', { name: 'Pre-copy content' })).toBeDisabled();
    else await expect(panel.getByRole('button', { name: 'Pre-copy content' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Test PostgreSQL' }).click();
    await expect(panel.getByLabel('Connection string')).toBeDisabled();
    await expect(panel.getByLabel('Bucket')).toBeDisabled();
    await expect(panel.getByLabel('I confirm the destination API and execution pods are stopped.')).toBeDisabled();
    releaseDatabaseTest();
    await expect(panel.getByText('PostgreSQL DDL, read and write checks passed.')).toBeVisible();
    await expect(panel.getByLabel('Bucket')).toBeEnabled();
    expect(databaseTestRequests).toBe(1);
    expect(objectStorageTestRequests).toBe(1);

    await expect(panel.getByRole('button', { name: 'Enter maintenance mode' })).toBeDisabled();
    await panel.getByLabel('I confirm the destination API and execution pods are stopped.').check();
    await panel.getByLabel('I checked runtime-library OS, architecture, Node ABI and image compatibility.').check();
    if (!sqlite) {
      await panel.getByRole('button', { name: 'Pre-copy content' }).click();
      await expect(panel.getByText('Content pre-copy complete.')).toBeVisible();
      await panel.getByLabel('Bucket').fill('destination-bucket-2');
      await expect(panel.getByRole('button', { name: 'Enter maintenance mode' })).toBeDisabled();
      await panel.getByRole('button', { name: 'Test S3' }).click();
      await panel.getByRole('button', { name: 'Pre-copy content' }).click();
      expect(objectStorageTestRequests).toBe(2);
    }
    await panel.getByRole('button', { name: 'Enter maintenance mode' }).click();
    if (sqlite) {
      await expect(
        panel.getByText('Source database authority: Selected live SQLite generation and immutable local artifacts.'),
      ).toBeVisible();
      await expect(panel.getByText(/Waiting for: editor graph runs/)).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Copy and verify all data' })).toBeDisabled();
      drained = true;
    }
    await expect(panel.getByText(/Source is quiet/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy and verify all data' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Copy and verify all data' }).click();
    await expect(panel.getByText('Migration verified.')).toBeVisible();
    await expect(panel.getByText(/Verified 2 projects, 1 folder, 3 recordings/)).toBeVisible();
    await expect(panel.getByText('Recording metadata and replay artifact bytes')).toBeVisible();
    expect(runRequests).toBe(1);
    const review = panel.getByRole('region', { name: 'Migration deployment review' });
    const reviewButton = review.getByRole('button', { name: 'Run final comparison and record review' });
    await expect(reviewButton).toBeDisabled();
    await panel.getByLabel('I checked runtime-library OS, architecture, Node ABI and image compatibility.').check();
    for (const label of [
      'I verified recoverable VM and destination backups.',
      'I checked the exact Kubernetes images, PostgreSQL, S3 location, encryption key, routes and secrets.',
      'On an isolated clone, private endpoint, web app, recording replay and input search, Subgraph, Evaluation and runtime-library checks passed.',
      'I reviewed VM file paths, plugins, Code nodes and external integrations.',
      'I understand rollback after Kubernetes accepts writes needs a coordinated restore or reverse migration.',
    ])
      await review.getByLabel(label).check();
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();
    await expect(panel.getByText('Migration verifying.')).toBeVisible();
    await expect(panel.getByLabel('Bucket')).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Leave maintenance mode' })).toHaveCount(0);
    reviewComplete = true;
    await expect(review.getByText(/Final comparison and operator review recorded/)).toBeVisible();
    expect(reviewRequests).toBe(1);
    await panel.getByLabel('I understand resuming this VM invalidates the copied destination.').check();
    await panel.getByRole('button', { name: 'Leave maintenance mode' }).click();
    await expect(panel.getByText('Restart the backend before serving runs again.')).toBeVisible();
    expect(closedGateBucket).toBe(sqlite ? 'destination-bucket' : 'destination-bucket-2');
  });
}

test('migration action refresh supersedes an older status poll', async ({ page }) => {
  let reads = 0;
  let releaseOldPoll!: () => void;
  let notifyPollStarted!: () => void;
  const oldPoll = new Promise<void>((resolve) => {
    releaseOldPoll = resolve;
  });
  const pollStarted = new Promise<void>((resolve) => {
    notifyPollStarted = resolve;
  });
  const staleReason = 'Stale unavailable response';
  await page.route('**/api/app-settings/vm-migration**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/inventory')) {
      await route.fulfill({
        json: {
          projects: 0,
          folders: 0,
          recordingBundles: 0,
          publishedEndpoints: 0,
          publishedWebApps: 0,
          publishedVersions: 0,
          savedSettingsDomains: 0,
          sourceDatabaseAuthority: 'Fixture SQLite',
          codeNodes: 0,
          fileNodes: 0,
          warnings: [],
        },
      });
      return;
    }
    const read = ++reads;
    if (read === 2) {
      notifyPollStarted();
      await oldPoll;
    }
    await route.fulfill({
      json: {
        available: read !== 2,
        unavailableReason: read === 2 ? staleReason : null,
        sourceKind: 'sqlite',
        precopyAvailable: false,
        maintenance: null,
        drain: null,
        job: null,
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('tab', { name: 'Migration' }).click();
  const panel = modal.getByRole('tabpanel', { name: 'VM to managed migration' });
  const inspect = panel.getByRole('button', { name: 'Inspect source' });
  await expect(inspect).toBeEnabled();
  await pollStarted;
  await inspect.click();
  await expect(panel.getByText('Source database authority: Fixture SQLite.')).toBeVisible();
  await expect(inspect).toBeEnabled();
  const staleResponse = page.waitForResponse(
    async (response) =>
      response.url().endsWith('/vm-migration') && (await response.json()).unavailableReason === staleReason,
  );
  releaseOldPoll();
  await staleResponse;
  // The subsequent refresh remains available; the late unavailable reply must
  // not remove the controls or replace the current action's status.
  await expect(inspect).toBeEnabled();
  await inspect.click();
  await expect(panel.getByText(staleReason)).toHaveCount(0);
});

test('migration settings do not show credential controls to an unauthorized session', async ({ page }) => {
  await page.route('**/api/app-settings/vm-migration', async (route) => {
    await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('tab', { name: 'Migration' }).click();
  const panel = modal.getByRole('tabpanel', { name: 'VM to managed migration' });
  await expect(panel.getByText('Migration is unavailable to this session.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Inspect source' })).toHaveCount(0);
  await expect(panel.getByLabel('Secret access key')).toHaveCount(0);
});

test('migration settings explain a SQLite source restriction without requesting environment enablement', async ({
  page,
}) => {
  const reason = 'Finish the local SQLite metadata upgrade and restart before using Migration.';
  await page.route('**/api/app-settings/vm-migration', (route) =>
    route.fulfill({
      json: { available: false, unavailableReason: reason, maintenance: null, drain: null, job: null },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('tab', { name: 'Migration' }).click();
  const panel = modal.getByRole('tabpanel', { name: 'VM to managed migration' });
  await expect(panel.getByText(reason, { exact: true })).toBeVisible();
  await expect(panel.getByText(/migration enablement/)).toHaveCount(0);
  await expect(panel.getByLabel('Secret access key')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Inspect source' })).toHaveCount(0);
});
