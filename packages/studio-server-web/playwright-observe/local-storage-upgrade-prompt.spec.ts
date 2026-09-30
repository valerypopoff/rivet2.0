import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const legacyStatus = {
  available: true,
  runningBackend: 'legacy',
  maintenance: null,
  restartRequired: false,
  transition: { phase: 'legacy', backend: 'legacy' },
};
const readySetup = {
  eligible: true,
  upgradeEnabled: true,
  controlRootConfigured: true,
  encryptionKeyReady: true,
  sqliteSelected: false,
  liveSqlite: false,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade/setup', (route) => route.fulfill({ json: readySetup }));
});

async function openDashboard(page: Page) {
  const statusRead = page.waitForResponse(
    (response) => response.url().endsWith('/api/app-settings/local-upgrade') && response.request().method() === 'GET',
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await statusRead;
}

test('an older eligible VM shows setup instructions before upgrade controls are enabled', async ({ page }) => {
  let setup = { ...readySetup, upgradeEnabled: false, controlRootConfigured: false, encryptionKeyReady: false };
  await page.route('**/api/app-settings/local-upgrade/setup', (route) => route.fulfill({ json: setup }));
  await page.route('**/api/app-settings/local-upgrade', (route) => route.fulfill({ json: legacyStatus }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt.getByRole('heading', { name: 'Prepare the local storage upgrade' })).toBeVisible();
  await expect(prompt).toContainText('RIVET_LOCAL_METADATA_ENCRYPTION_KEY');
  await expect(prompt).toContainText('RIVET_LOCAL_METADATA_CONTROL_ROOT=/data/local-metadata');
  await expect(prompt).toContainText('RIVET_LOCAL_METADATA_UPGRADE_ENABLED=1');
  await expect(prompt).toContainText('not entries in Rivet’s Environment variables Settings tab');
  await expect(prompt).toContainText('restore its original key; never replace it');
  await expect(prompt).toContainText('Never reset or re-provision an existing upgrade');
  await expect(prompt.getByRole('button', { name: 'Review upgrade steps' })).toHaveCount(0);
  await prompt.getByRole('button', { name: 'Postpone' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(prompt.getByRole('heading', { name: 'Prepare the local storage upgrade' })).toBeVisible();

  setup = { ...readySetup };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(prompt.getByRole('heading', { name: 'Local storage upgrade available' })).toBeVisible();
});

test('managed or unsupported deployments do not receive the local setup modal', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade/setup', (route) =>
    route.fulfill({ json: { ...readySetup, eligible: false } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);
});

test('completed SQLite stays quiet if the operator later disables upgrade controls', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade/setup', (route) =>
    route.fulfill({ json: { ...readySetup, upgradeEnabled: false, sqliteSelected: true, liveSqlite: true } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);
});

test('a paused SQLite selection with disabled controls offers recovery, never fresh provisioning', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade/setup', (route) =>
    route.fulfill({ json: { ...readySetup, upgradeEnabled: false, sqliteSelected: true } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt.getByRole('heading', { name: 'Restore paused SQLite upgrade controls' })).toBeVisible();
  await expect(prompt).toContainText('Do not generate a new key, reset the control volume or run provisioning again');
  await expect(prompt).toContainText('RIVET_LOCAL_METADATA_UPGRADE_ENABLED=1');
  await expect(prompt.getByRole('button', { name: 'Review upgrade steps' })).toHaveCount(0);
});

test('the setup modal hides stale instructions during a temporary status failure and recovers', async ({ page }) => {
  let fail = false;
  let reads = 0;
  await page.route('**/api/app-settings/local-upgrade/setup', (route) => {
    reads += 1;
    return fail
      ? route.fulfill({ status: 503, body: '' })
      : route.fulfill({ json: { ...readySetup, upgradeEnabled: false } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt).toBeVisible();
  fail = true;
  await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(prompt).toHaveCount(0);
  fail = false;
  await expect(prompt).toBeVisible({ timeout: 10_000 });
});

test('legacy operators can postpone the storage reminder for one page load or open the guided upgrade', async ({
  page,
}) => {
  await page.route('**/api/app-settings/local-upgrade', (route) => route.fulfill({ json: legacyStatus }));
  await openDashboard(page);

  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Postpone' }).click();
  await expect(prompt).toHaveCount(0);

  await openDashboard(page);
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Review upgrade steps' }).click();
  await expect(prompt).toHaveCount(0);
  const settings = page.getByTestId('app-settings-modal');
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'Local storage upgrade', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('selected SQLite and unauthorized sessions do not receive the legacy reminder', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: { ...legacyStatus, runningBackend: 'sqlite', transition: { phase: 'sqlite-live', backend: 'sqlite' } },
    }),
  );
  await openDashboard(page);
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);

  await page.route('**/api/app-settings/local-upgrade', (route) => route.fulfill({ status: 403, body: '' }));
  await openDashboard(page);
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);
});

test('closing Settings rereads the selected phase before showing recovery guidance', async ({ page }) => {
  let status: Record<string, unknown> | null = null;
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    status ? route.fulfill({ json: status }) : route.fulfill({ status: 403, body: '' }),
  );
  await openDashboard(page);
  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  status = {
    ...legacyStatus,
    maintenance: { enteredAt: '2026-09-29T00:00:00Z' },
    transition: { phase: 'verified', backend: 'legacy', canReturnToLegacy: true },
  };
  await page.getByTestId('app-settings-modal').getByRole('button', { name: 'Close app settings' }).click();
  await expect(prompt.getByRole('heading', { name: 'Storage upgrade in progress' })).toBeVisible();
  await expect(prompt).toContainText('return to the old file-backed mode');
});

test('a temporary status failure retries without waiting for another reload', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/app-settings/local-upgrade', (route) => {
    reads += 1;
    return reads === 1 ? route.fulfill({ status: 503, body: '' }) : route.fulfill({ json: legacyStatus });
  });
  await openDashboard(page);
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toBeVisible({ timeout: 10_000 });
  expect(reads).toBeGreaterThanOrEqual(2);
});

test('a completed return to legacy is an offer even when the old copy job remains in history', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: {
        ...legacyStatus,
        transition: { phase: 'legacy-resumed', backend: 'legacy', canReturnToLegacy: false },
        job: { id: 'old-candidate', phase: 'verified' },
      },
    }),
  );
  await openDashboard(page);
  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt.getByRole('heading', { name: 'Local storage upgrade available' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Postpone' })).toBeVisible();
});

for (const change of ['completed', 'unauthorized'] as const) {
  test(`an open reminder stops offering stale guidance when the status becomes ${change}`, async ({ page }) => {
    let status: Record<string, unknown> | null = legacyStatus;
    await page.route('**/api/app-settings/local-upgrade', (route) =>
      status ? route.fulfill({ json: status }) : route.fulfill({ status: 403, body: '' }),
    );
    await openDashboard(page);
    const prompt = page.getByTestId('local-storage-upgrade-prompt');
    await expect(prompt).toBeVisible();
    status =
      change === 'completed'
        ? {
            ...legacyStatus,
            runningBackend: 'sqlite',
            transition: { phase: 'sqlite-live', backend: 'sqlite', canReturnToLegacy: false },
          }
        : null;
    await expect(prompt).toHaveCount(0, { timeout: 15_000 });
  });
}

test('an initiated upgrade returns on every reload and keeps safe legacy recovery reachable', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: {
        ...legacyStatus,
        runningBackend: 'sqlite',
        maintenance: { enteredAt: '2026-09-29T00:00:00Z' },
        drain: { ready: true, blockers: [] },
        transition: {
          phase: 'sqlite-validation',
          backend: 'sqlite',
          revision: 3,
          generationId: 'candidate-fixture',
          canReturnToLegacy: true,
          validated: false,
        },
        job: { id: 'candidate-fixture', phase: 'verified', message: 'Verified.' },
      },
    }),
  );
  await openDashboard(page);
  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt.getByRole('heading', { name: 'Storage upgrade in progress' })).toBeVisible();
  await expect(prompt).toContainText('return to the old file-backed mode');
  await prompt.getByRole('button', { name: 'Dismiss until next reload' }).click();
  await expect(prompt).toHaveCount(0);

  await openDashboard(page);
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Continue upgrade or recovery' }).click();
  const settings = page.getByTestId('app-settings-modal');
  await expect(settings.getByRole('tab', { name: 'Local storage upgrade', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(settings.getByRole('button', { name: 'Return to legacy while paused' })).toBeEnabled();
});

test('resumption still pending prompts for completion but never offers one-click rollback', async ({ page }) => {
  let paused = true;
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: {
        ...legacyStatus,
        runningBackend: 'sqlite',
        maintenance: paused ? { enteredAt: '2026-09-29T00:00:00Z' } : null,
        drain: paused ? { ready: true, blockers: [] } : null,
        transition: {
          phase: 'sqlite-live',
          backend: 'sqlite',
          revision: 5,
          generationId: 'candidate-fixture',
          canReturnToLegacy: false,
          validated: true,
        },
      },
    }),
  );
  await openDashboard(page);
  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt.getByRole('heading', { name: 'Storage upgrade in progress' })).toBeVisible();
  await expect(prompt).toContainText('closed one-click rollback');
  await prompt.getByRole('button', { name: 'Continue upgrade or recovery' }).click();
  const settings = page.getByTestId('app-settings-modal');
  await expect(settings.getByRole('button', { name: 'Return to legacy while paused' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Resume unchanged legacy' })).toHaveCount(0);

  paused = false;
  await openDashboard(page);
  await expect(prompt).toHaveCount(0);
});

for (const scenario of [
  { name: 'paused legacy', phase: 'legacy', backend: 'legacy', runningBackend: 'legacy', job: null },
  {
    name: 'interrupted copy',
    phase: 'legacy',
    backend: 'legacy',
    runningBackend: 'legacy',
    job: { id: 'failed-fixture', phase: 'interrupted' },
  },
  { name: 'verified copy', phase: 'verified', backend: 'legacy', runningBackend: 'legacy', job: null },
  {
    name: 'legacy recovery',
    phase: 'legacy-validation',
    backend: 'legacy',
    runningBackend: 'legacy',
    job: null,
  },
] as const) {
  test(`${scenario.name} resumes its guidance after a page reload`, async ({ page }) => {
    await page.route('**/api/app-settings/local-upgrade', (route) =>
      route.fulfill({
        json: {
          ...legacyStatus,
          runningBackend: scenario.runningBackend,
          maintenance: { enteredAt: '2026-09-29T00:00:00Z' },
          transition: {
            phase: scenario.phase,
            backend: scenario.backend,
            canReturnToLegacy: scenario.phase === 'verified',
          },
          job: scenario.job,
        },
      }),
    );
    await openDashboard(page);
    const prompt = page.getByTestId('local-storage-upgrade-prompt');
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Dismiss until next reload' }).click();
    await openDashboard(page);
    await expect(prompt).toBeVisible();
  });
}
