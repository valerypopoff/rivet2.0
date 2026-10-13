import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';

async function openRestoreWorkspace(page: Page, url = '/?restore-legacy-backup') {
  await page.goto(url);
  await authenticateIfNeeded(page);
}

// Match the real router boundary, not a suffix that also accepts /api/api/legacy-restore.
const isRestoreRoute = (url: URL) =>
  url.pathname === '/api/legacy-restore' || url.pathname.startsWith('/api/legacy-restore/');

test('a stalled status read times out and resumes polling without user intervention', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  let reads = 0;
  await page.route(isRestoreRoute, async (route) => {
    if (++reads === 1) return; // No response; exercise the panel's actual native fetch deadline.
    await route.fulfill({ json: { available: true, operation: null } });
  });
  await openRestoreWorkspace(page);
  await expect(page.getByRole('alert')).toHaveText('Restore status timed out. Reconnecting…', { timeout: 15000 });
  await expect(page.getByLabel('Legacy backup archive')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a timed-out confirmation reconnects to accepted work without automatically resending it', async ({ page }) => {
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => timeout(ms === 60_000 ? 100 : ms);
  });
  await mockHostedEditorBootstrap(page);
  let starts = 0;
  await page.route(isRestoreRoute, async (route) => {
    if (route.request().url().endsWith('/start')) {
      starts++;
      return;
    }
    await route.fulfill({
      json: {
        available: true,
        operation: {
          id: '11111111-1111-4111-8111-111111111111',
          phase: starts ? 'importing' : 'awaiting-confirmation',
          destructive: !!starts,
          archiveDigest: 'a'.repeat(64),
          message: starts ? 'Importing accepted backup.' : 'Ready to confirm.',
        },
      },
    });
  });
  await openRestoreWorkspace(page);
  await page.getByLabel('Restore confirmation').fill('RESTORE LEGACY BACKUP');
  await page.getByRole('button', { name: 'Restore legacy backup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('It may already be accepted', { timeout: 5000 });
  await expect(page.getByText('Importing accepted backup.')).toBeVisible({ timeout: 5000 });
  expect(starts).toBe(1);
  await expect(page.getByRole('button', { name: 'Restore legacy backup', exact: true })).toHaveCount(0);
});

test('legacy restore uploads binary data, requires exact confirmation and reconnects to progress', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/config', (route) => route.fulfill({ json: { legacyRestoreEpoch: 'initial' } }));
  let operation: Record<string, unknown> | null = null;
  let started = false;
  let reads = 0;
  await page.route(isRestoreRoute, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/upload')) {
      expect(route.request().headers()['content-type']).toBe('application/gzip');
      expect(route.request().headers()['x-rivet-migration-intent']).toBe('1');
      expect(route.request().headers()['x-rivet-workspace-epoch']).toBe('initial');
      operation = {
        id: '11111111-1111-4111-8111-111111111111',
        phase: 'awaiting-confirmation',
        destructive: false,
        archiveDigest: 'a'.repeat(64),
        message: 'Backup validated. Confirm replacement.',
        projects: 2,
        recordings: 3,
        backupCreatedAt: '2026-10-08T00:07:11.887Z',
      };
    } else if (url.pathname.endsWith('/start')) {
      expect(route.request().postDataJSON()).toEqual({
        id: operation!.id,
        archiveDigest: 'a'.repeat(64),
        confirmation: 'RESTORE LEGACY BACKUP',
      });
      started = true;
      operation = {
        ...operation,
        phase: 'importing',
        destructive: true,
        message: 'Importing legacy application data.',
      };
    } else if (started && ++reads > 2)
      operation = { ...operation, phase: 'completed', message: 'Legacy backup restored and verified.' };
    await route.fulfill({ json: { available: true, operation } });
  });
  await openRestoreWorkspace(page);
  await expect(page.getByRole('heading', { name: 'Restore legacy backup' })).toBeVisible();
  await page
    .getByLabel('Legacy backup archive')
    .setInputFiles({ name: 'backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('fixture') });
  const restore = page.getByRole('button', { name: 'Restore legacy backup', exact: true });
  await expect(restore).toBeDisabled();
  await page.getByLabel('Restore confirmation').fill('RESTORE');
  await expect(restore).toBeDisabled();
  await page.getByLabel('Restore confirmation').fill('RESTORE LEGACY BACKUP');
  await restore.click();
  await expect(page.getByRole('button', { name: 'Cancel restore' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Legacy backup restored and verified.')).toBeVisible({ timeout: 15000 });
});

test('a late status read cannot discard a newer upload result', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  let reads = 0;
  let uploaded = false;
  let delayed: import('@playwright/test').Route | undefined;
  const operation = {
    id: '11111111-1111-4111-8111-111111111111',
    phase: 'awaiting-confirmation',
    destructive: false,
    archiveDigest: 'a'.repeat(64),
    message: 'Backup validated. Confirm replacement.',
  };
  await page.route(isRestoreRoute, async (route) => {
    if (route.request().url().endsWith('/upload')) {
      uploaded = true;
      await route.fulfill({ json: { available: true, operation } });
      return;
    }
    if (++reads === 2) {
      delayed = route;
      return;
    }
    await route.fulfill({ json: { available: true, operation: uploaded ? operation : null } });
  });
  await openRestoreWorkspace(page);
  await expect(page.getByLabel('Legacy backup archive')).toBeVisible();
  await expect.poll(() => !!delayed).toBe(true);
  await page
    .getByLabel('Legacy backup archive')
    .setInputFiles({ name: 'backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('fixture') });
  await expect(page.getByLabel('Restore confirmation')).toBeVisible();
  await delayed!.fulfill({ json: { available: true, operation: null } });
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Restore confirmation')).toBeVisible();
  await expect(page.getByLabel('Legacy backup archive')).toHaveCount(0);
});

test('restore uploads report gateway HTML failures without exposing body or parser errors', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  await page.route(isRestoreRoute, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/upload')) {
      return route.fulfill({ status: 500, contentType: 'text/html', body: '<html>private gateway diagnostic</html>' });
    }
    return route.fulfill({ json: { available: true, operation: null } });
  });
  await openRestoreWorkspace(page);
  await page.getByLabel('Legacy backup archive').setInputFiles({
    name: 'backup.tar.gz',
    mimeType: 'application/gzip',
    buffer: Buffer.from('fixture'),
  });
  await expect(page.getByRole('alert')).toHaveText(
    'Restore request was rejected by the gateway (HTTP 500). Check the gateway upload limit and server logs before retrying.',
  );
  await expect(page.getByRole('button', { name: 'Restore legacy backup', exact: true })).toHaveCount(0);
});

test('destructive failure offers retry without cancellation or a new archive', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  let retry = false;
  await page.route(isRestoreRoute, async (route) => {
    if (route.request().url().endsWith('/retry')) {
      expect(route.request().postDataJSON()).toEqual({ id: '11111111-1111-4111-8111-111111111111' });
      retry = true;
    }
    await route.fulfill({
      json: {
        available: true,
        operation: {
          id: '11111111-1111-4111-8111-111111111111',
          phase: retry ? 'importing' : 'failed',
          destructive: true,
          message: retry ? 'Resuming restore.' : 'Restore stopped safely.',
        },
      },
    });
  });
  await openRestoreWorkspace(page);
  await expect(page.getByRole('button', { name: 'Retry restore' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Proceed anyway', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel restore' })).toHaveCount(0);
  await expect(page.getByLabel('Legacy backup archive')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry restore' }).click();
  await expect(page.getByText('Resuming restore.')).toBeVisible();
});

test('Proceed anyway accepts an explicit integrity override and still requires destructive confirmation', async ({
  page,
}) => {
  await mockHostedEditorBootstrap(page);
  let proceeded = false;
  let starts = 0;
  let overrideRequests = 0;
  const id = '11111111-1111-4111-8111-111111111111';
  await page.route(isRestoreRoute, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/proceed-anyway')) {
      expect(route.request().postDataJSON()).toEqual({ id, archiveDigest: 'a'.repeat(64) });
      expect(route.request().headers()['x-rivet-migration-intent']).toBe('1');
      overrideRequests++;
      proceeded = true;
    }
    if (path.endsWith('/start')) starts++;
    await route.fulfill({
      json: {
        available: true,
        operation: {
          id,
          phase: proceeded ? 'awaiting-confirmation' : 'failed',
          destructive: false,
          archiveDigest: 'a'.repeat(64),
          canProceedAnyway: !proceeded,
          integrityOverridden: proceeded,
          recordings: 0,
          message: proceeded ? 'Modified backup prepared.' : 'Backup validation failed.',
        },
      },
    });
  });
  await openRestoreWorkspace(page);
  const proceed = page.getByRole('button', { name: 'Proceed anyway', exact: true });
  await expect(proceed).toBeVisible();
  await proceed.click();
  await expect(proceed).toHaveCount(0);
  await expect(
    page.getByText('Original backup integrity checks were bypassed. Missing recordings will not be restored.'),
  ).toBeVisible();
  const restore = page.getByRole('button', { name: 'Restore legacy backup', exact: true });
  await expect(restore).toBeDisabled();
  expect(overrideRequests).toBe(1);
  expect(starts).toBe(0);
  await page.reload();
  await expect(restore).toBeDisabled();
  await page.getByLabel('Restore confirmation').fill('RESTORE LEGACY BACKUP');
  await expect(restore).toBeEnabled();
});

test('validation can be cancelled without starting replacement', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  let phase = 'validating';
  await page.route(isRestoreRoute, async (route) => {
    if (route.request().url().endsWith('/cancel')) phase = 'cancelled';
    await route.fulfill({
      json: {
        available: true,
        operation: {
          id: '11111111-1111-4111-8111-111111111111',
          phase,
          destructive: false,
          message: phase === 'cancelled' ? 'Restore cancelled.' : 'Validating backup.',
        },
      },
    });
  });
  await openRestoreWorkspace(page);
  await page.getByRole('button', { name: 'Cancel restore' }).click();
  await expect(page.getByText('Restore cancelled.')).toBeVisible();
  await expect(page.getByLabel('Legacy backup archive')).toBeVisible();
});

test('opening the normal UI during maintenance automatically reconnects to restore recovery', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: { legacyRestoreEpoch: '11111111-1111-4111-8111-111111111111', legacyRestoreMaintenance: true },
    }),
  );
  await page.route(isRestoreRoute, (route) =>
    route.fulfill({
      json: {
        available: true,
        operation: {
          id: '11111111-1111-4111-8111-111111111111',
          phase: 'failed',
          destructive: true,
          message: 'Restore stopped safely.',
        },
      },
    }),
  );
  await openRestoreWorkspace(page, '/');
  await expect(page.getByRole('heading', { name: 'Restore legacy backup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry restore' })).toBeVisible();
  await expect(page.getByLabel('Legacy backup archive')).toHaveCount(0);
});

test('a lost start acknowledgement still reconnects to server-owned restore progress', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  let accepted = false;
  await page.route(isRestoreRoute, async (route) => {
    if (route.request().url().endsWith('/start')) {
      accepted = true;
      await route.abort('connectionfailed');
      return;
    }
    await route.fulfill({
      json: {
        available: true,
        operation: {
          id: '11111111-1111-4111-8111-111111111111',
          phase: accepted ? 'importing' : 'awaiting-confirmation',
          destructive: accepted,
          archiveDigest: 'a'.repeat(64),
          message: accepted ? 'Importing legacy application data.' : 'Backup validated. Confirm replacement.',
        },
      },
    });
  });
  await openRestoreWorkspace(page);
  await page.getByLabel('Restore confirmation').fill('RESTORE LEGACY BACKUP');
  // The same panel can live in Settings, without the recovery query parameter.
  await page.evaluate(() => window.history.replaceState(null, '', '/'));
  await page.getByRole('button', { name: 'Restore legacy backup', exact: true }).click();
  await expect(page).toHaveURL(/restore-legacy-backup/, { timeout: 15000 });
  await expect(page.getByText('Importing legacy application data.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel restore' })).toHaveCount(0);
});
