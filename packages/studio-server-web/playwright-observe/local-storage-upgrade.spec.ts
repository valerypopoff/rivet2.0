import { expect, test, type Page } from '@playwright/test';
import type { LocalUpgradePreparation } from '../../studio-server-shared/local-upgrade-types';
import { authenticateIfNeeded, waitForDashboardReady, mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';

test.beforeEach(async ({ page }) => {
  // Panel scenarios begin after VM prerequisites. The separate prompt suite
  // exercises missing setup; without this response the dashboard never asks
  // for upgrade status and openLocalUpgrade would wait for the wrong request.
  await page.route('**/api/app-settings/local-upgrade/setup', (route) =>
    route.fulfill({
      json: {
        eligible: true,
        upgradeEnabled: true,
        controlRootConfigured: true,
        encryptionKeyReady: true,
        sqliteSelected: false,
        liveSqlite: false,
      },
    }),
  );
});

async function openSettings(page: Page) {
  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  const promptShown = await prompt.waitFor({ state: 'visible', timeout: 1000 }).then(
    () => true,
    () => false,
  );
  if (promptShown) await prompt.getByRole('button', { name: /^(Postpone|Dismiss until next reload)$/ }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

async function openLocalUpgrade(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  return page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
}

function upgradeStatusFixture({
  phase = 'legacy',
  backend = 'legacy',
  runningBackend = backend,
  pausedAt = null,
  revision = 1,
  validated = false,
  restartRequired = false,
  operation = null,
}: {
  phase?: string;
  backend?: string;
  runningBackend?: string;
  pausedAt?: string | null;
  revision?: number;
  validated?: boolean;
  restartRequired?: boolean;
  operation?: string | null;
} = {}) {
  return {
    available: true,
    operation,
    copyConfigurationReady: true,
    runningBackend,
    maintenance: pausedAt ? { enteredAt: pausedAt } : null,
    drain: pausedAt ? { ready: true, blockers: [] } : null,
    restartRequired,
    transition: {
      revision,
      phase,
      backend,
      generationId: phase === 'legacy' ? null : 'settlement-fixture',
      canReturnToLegacy: phase === 'verified' || phase === 'sqlite-validation',
      validated,
    },
    job: null,
  };
}

const inventoryFixture = {
  source: {},
  inventory: {
    projects: 2,
    folders: 1,
    recordingBundles: 0,
    publishedVersions: 0,
    publishedWebApps: 0,
    warnings: [],
  },
  capacity: { payloadBytes: 1024, requiredBytes: 1024, fits: true },
  backupRequired: 'Restore a separate backup.',
};

test('guided duplicate repair confirms owners, survives interruption and locks legacy resume', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'repair-fixture', revision: 0 }, folders: [], projects: [] },
    }),
  );
  await page.route('**/?editor', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>Paused editor</body></html>' }),
  );
  const oldId = '408e0df7-433e-4ef2-8772-2781d4e6735d';
  const provider = 'trash/provider.rivet-project',
    copy = 'trash/Copy.rivet-project';
  const token = 'a'.repeat(64);
  const analysis = {
    token,
    groups: [
      {
        projectId: oldId,
        projects: [
          { path: copy, published: false },
          { path: provider, published: false },
        ],
        history: [{ id: 'history-1', originalPath: 'old/Copy.rivet-project', suggestedOwner: copy, activeOwner: null }],
        references: ['caller.rivet-project'],
        recordings: 0,
        operationalRows: 0,
      },
    ],
    warnings: [
      'Unresolved library nodes in unrelated.rivet-project; reference discovery is incomplete. Existing references will not be rewritten.',
    ],
  };
  let preparation: LocalUpgradePreparation | null = null;
  let repair: {
    id: string;
    phase: 'applying' | 'complete';
    archiveHash: string;
    changedFiles: number;
    assignments: { path: string; oldId: string; newId: string }[];
  } | null = null;
  let starts = 0;
  let revision = 1;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/preparation')) {
      const body = route.request().postDataJSON();
      starts++;
      if (body.kind === 'repair-inspect') {
        preparation = {
          id: body.id,
          kind: body.kind,
          revision,
          stage: 'inspect',
          phase: 'ready',
          repairAnalysis: analysis,
        };
      } else if (body.kind === 'repair') {
        expect(body.repairChoices.groups[0].keeperPath).toBe(provider);
        expect(body.repairChoices.groups[0].historyOwners['history-1']).toBe(copy);
        expect(body.repairChoices.retainReferences).toBe(true);
        repair = {
          id: '899c427b-5131-4e52-8ee5-126f0420692f',
          phase: 'applying',
          archiveHash: 'b'.repeat(64),
          changedFiles: 3,
          assignments: [{ path: copy, oldId, newId: '43aa7bff-76ca-457d-9ce5-213f30baf9cf' }],
        };
        preparation = {
          id: body.id,
          kind: body.kind,
          revision,
          stage: 'repair',
          phase: 'interrupted',
          error: 'Preparation stopped before retaining a completed result. Review current status and retry explicitly.',
        };
      } else {
        expect(body.kind).toBe('repair-recover');
        repair = { ...repair!, phase: 'complete' };
        preparation = {
          id: body.id,
          kind: body.kind,
          revision,
          stage: 'repair',
          phase: 'ready',
          repairAnalysis: { token: 'c'.repeat(64), groups: [], warnings: [] },
        };
      }
      return route.fulfill({ status: 202, json: preparation });
    }
    return route.fulfill({
      json: {
        ...upgradeStatusFixture({
          revision,
          pausedAt: repair ? '2026-10-08T00:00:00Z' : null,
          operation: preparation?.phase === 'running' ? preparation.stage : null,
        }),
        duplicateRepairAvailable: true,
        repair,
        settingsEncryptionRequired: false,
        preparationJobsAvailable: true,
        preparation,
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Postpone', exact: true }).click();
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);
  await openSettings(page);
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await panel.getByRole('button', { name: 'Inspect conflicting IDs', exact: true }).click();
  await expect(panel.getByText(/Saved owner path: old\/Copy/)).toBeVisible();
  const apply = panel.getByRole('button', { name: 'Pause writes and repair project IDs', exact: true });
  await expect(apply).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Project keeping the original ID', exact: true }).click();
  await panel.getByText(provider, { exact: true }).last().click();
  await panel.getByRole('checkbox', { name: /I confirm publication ownership/ }).check();
  await expect(apply).toBeEnabled();
  // A result hidden by a changed authority revision must not preserve choices
  // or consent when it becomes current again, even with the same content token.
  revision++;
  await expect(panel.getByRole('combobox', { name: 'Project keeping the original ID', exact: true })).toHaveCount(0);
  preparation = { ...preparation!, revision };
  await expect(panel.getByRole('combobox', { name: 'Project keeping the original ID', exact: true })).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: /I confirm publication ownership/ })).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Project keeping the original ID', exact: true }).click();
  await panel.getByText(provider, { exact: true }).last().click();
  await panel.getByRole('checkbox', { name: /I confirm publication ownership/ }).check();
  await expect(apply).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('duplicate-repair-preview.png') });
  await apply.click();
  await expect(panel.getByRole('button', { name: 'Finish interrupted project-ID repair', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: 'Close app settings', exact: true }).click();
  await openSettings(page);
  await modal.getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Finish interrupted project-ID repair', exact: true }).click();
  await expect(panel.getByText(/Project-ID repair completed/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resume legacy with repaired IDs', exact: true })).toBeEnabled();
  await expect(panel.getByRole('link', { name: 'Download verified repair backup' })).toHaveAttribute(
    'href',
    /\/repair\/download\?id=/,
  );
  await expect(panel.getByRole('button', { name: 'Create verified backup', exact: true })).toBeEnabled();
  preparation = { ...preparation!, phase: 'running', stage: 'inspect', repairAnalysis: undefined };
  await expect(panel.getByRole('button', { name: 'Inspect conflicting IDs', exact: true })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(panel.getByRole('button', { name: 'Inspect source', exact: true, includeHidden: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  preparation = {
    ...preparation,
    phase: 'failed',
    error:
      'Local storage preparation failed. Check source integrity and available space; reload status before retrying. Writes may remain paused.',
    failure: { code: 'invalid-data', reason: 'project-parse-failed' },
  };
  await expect(panel.getByText(/Project-ID repair completed/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resume legacy with repaired IDs', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  expect(starts).toBe(3);
});

test('unreadable repair status blocks all storage mutations in the UI', async ({ page }) => {
  test.setTimeout(60_000);
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'repair-fixture', revision: 0 }, folders: [], projects: [] },
    }),
  );
  await page.route('**/?editor', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>Paused editor</body></html>' }),
  );
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: {
        ...upgradeStatusFixture({ pausedAt: '2026-10-08T00:00:00Z' }),
        duplicateRepairAvailable: true,
        repairStatusUnreadable: true,
      },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toContainText('A project-ID repair needs recovery.');
  await expect(page.getByTestId('local-storage-upgrade-prompt')).not.toContainText('resume unchanged legacy');
  await page.getByRole('button', { name: /^(Postpone|Dismiss until next reload)$/ }).click();
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await expect(panel.getByText(/Repair status could not be read/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Inspect conflicting IDs', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeDisabled();
});

test('background preparation survives a gateway error and reopening without repeating inspection or pause', async ({
  page,
}) => {
  let preparation: LocalUpgradePreparation | null = null;
  let pausedAt: string | null = null;
  let starts = 0;
  let legacyCalls = 0;
  let statusReads = 0;
  await page.route('**/api/app-settings/local-upgrade**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/local-upgrade')[1];
    if (suffix === '/setup')
      return route.fulfill({
        json: {
          eligible: true,
          upgradeEnabled: true,
          controlRootConfigured: true,
          encryptionKeyReady: true,
          uiRestartAvailable: true,
          sqliteSelected: false,
          liveSqlite: false,
        },
      });
    if (suffix === '/preparation') {
      starts++;
      const body = route.request().postDataJSON();
      expect(body.kind).toBe('pause-backup');
      preparation = { ...body, phase: 'running', stage: 'inspect' };
      // The job was accepted, but an edge gateway replaced its acknowledgement.
      return route.fulfill({
        status: 524,
        contentType: 'text/html; charset=UTF-8',
        body: '<!DOCTYPE html><html>Gateway timeout</html>',
      });
    }
    if (['/inventory', '/fingerprint', '/pause', '/backup'].includes(suffix!)) legacyCalls++;
    if (suffix === '/action') return route.fulfill({ status: 409, json: { error: 'Owned legacy recovery rejected.' } });
    statusReads++;
    return route.fulfill({
      json: {
        ...upgradeStatusFixture({ pausedAt, operation: preparation?.phase === 'running' ? preparation.stage : null }),
        drain: pausedAt
          ? {
              ready: preparation?.stage !== 'pause',
              blockers: preparation?.stage === 'pause' ? ['editor graph runs'] : [],
            }
          : null,
        uiRestartAvailable: true,
        runtimeReady: true,
        settingsEncryptionRequired: false,
        preparationJobsAvailable: true,
        preparation,
      },
    });
  });
  const panel = await openLocalUpgrade(page);
  const begin = panel.getByRole('button', { name: 'Pause writes and create verified backup', exact: true });
  await begin.click();
  await expect(begin).toHaveAttribute('aria-busy', 'true');
  await expect(panel.getByText('Inspecting source data and checking capacity…', { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('button', { name: 'Close app settings', exact: true }).click();
  await openSettings(page);
  await modal.getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  await expect(begin).toHaveAttribute('aria-busy', 'true');
  expect(starts).toBe(1);
  pausedAt = '2026-10-07T00:00:00Z';
  preparation = { ...preparation!, stage: 'pause' };
  await expect(panel.getByRole('region', { name: 'Source inspection and maintenance' }).getByRole('status')).toHaveText(
    'Waiting for: editor graph runs.',
  );
  await expect(panel.getByRole('button', { name: 'Create verified backup', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  expect(starts).toBe(1);
  preparation = {
    ...preparation!,
    stage: 'backup',
    inventory: {
      ...inventoryFixture,
      inventory: { ...inventoryFixture.inventory, publishedEndpoints: 0 },
      capacity: { ...inventoryFixture.capacity, freeBytes: 4096, maxPayloadBytes: 8192 },
    },
  };
  await expect(
    panel.getByText('Creating the backup archive and checking an isolated restore. Writes remain paused…', {
      exact: true,
    }),
  ).toBeVisible();
  preparation = { ...preparation, phase: 'failed', error: 'Owned preparation failed. Writes remain paused.' };
  await expect(panel.getByRole('alert')).toContainText('Owned preparation failed. Writes remain paused.');
  await panel.getByText('Advanced', { exact: true }).click();
  await expect(panel.getByText(/2 projects, 1 folders/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Create verified backup', exact: true })).toBeEnabled();
  expect(starts).toBe(1);
  expect(legacyCalls).toBe(0);
  await panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true }).click();
  const recoveryError = panel.getByRole('alert').filter({ hasText: 'Owned legacy recovery rejected.' });
  await expect(recoveryError).toBeVisible();
  // The retained preparation still appears in subsequent successful polls.
  const settledReads = statusReads;
  await expect.poll(() => statusReads).toBeGreaterThan(settledReads);
  await expect(recoveryError).toBeVisible();
});

test('a background fingerprint retry clears other operators old proofs and hides obsolete failures', async ({
  page,
}) => {
  const pausedAt = '2026-10-07T00:00:00Z';
  const fingerprint = 'a'.repeat(64);
  let revision = 1;
  let unreadable = false;
  let preparation: LocalUpgradePreparation = {
    id: '42bfd0bf-a606-4af4-a8cd-a0bb94e39c10',
    kind: 'fingerprint',
    revision,
    phase: 'ready',
    stage: 'fingerprint',
    fingerprint: { pausedAt, sourceFingerprint: fingerprint },
  };
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: {
        ...upgradeStatusFixture({
          pausedAt,
          revision,
          operation: preparation.phase === 'running' ? 'fingerprint' : null,
        }),
        preparationJobsAvailable: true,
        preparation: unreadable ? null : preparation,
        preparationStatusUnreadable: unreadable,
        settingsEncryptionRequired: false,
      },
    }),
  );
  const panel = await openLocalUpgrade(page);
  const proof = panel.locator('.local-upgrade-fingerprint');
  await expect(proof).toContainText(fingerprint);
  await panel.getByLabel('Backup reference', { exact: true }).fill('owned-independent-backup');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  const restored = panel.getByLabel('I restored a separate backup of all four source roots.');
  await restored.check();
  const copy = panel.getByRole('button', { name: 'Copy and verify', exact: true });
  await expect(copy).toBeEnabled();
  preparation = {
    ...preparation,
    id: 'a2ae9ad3-cdcc-4e88-9d8b-fdb1cfe343f0',
    phase: 'running',
    fingerprint: undefined,
  };
  await expect(proof).toHaveCount(0);
  await expect(restored).not.toBeChecked();
  preparation = { ...preparation, phase: 'failed', error: 'Owned fingerprint attempt failed.' };
  await expect(panel.getByRole('alert')).toContainText('Owned fingerprint attempt failed.');
  await expect(copy).toBeDisabled();
  await expect(restored).toBeDisabled();
  revision++;
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(copy).toBeDisabled();
  preparation = { ...preparation, revision, phase: 'ready', fingerprint: { pausedAt, sourceFingerprint: fingerprint } };
  await expect(proof).toContainText(fingerprint);
  await restored.check();
  await expect(copy).toBeEnabled();
  unreadable = true;
  await expect(panel.getByRole('alert')).toContainText('Preparation status could not be read.');
  await expect(proof).toHaveCount(0);
  await expect(restored).not.toBeChecked();
  await expect(copy).toBeDisabled();
  unreadable = false;
  await expect(proof).toContainText(fingerprint);
  await expect(restored).not.toBeChecked();
  await expect(copy).toBeDisabled();
});

test('guided migration prepares from UI, consolidates backup and waits for both processes before automatic validation', async ({
  page,
  context,
}) => {
  let prepared = false,
    pausedAt: string | null = null,
    phase = 'legacy',
    revision = 1,
    backend = 'legacy',
    runningBackend = 'legacy';
  let restartRequired = false,
    runtimeReady = true,
    validated = false,
    reconnectFailures = 0;
  let backup: Record<string, unknown> | null = null;
  const calls: string[] = [],
    downloads: string[] = [];
  const id = '42bfd0bf-a606-4af4-a8cd-a0bb94e39c10';
  await page.route('**/api/app-settings/local-upgrade**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/local-upgrade')[1];
    if (endpoint === '/setup')
      return route.fulfill({
        json: {
          eligible: true,
          uiPreparationAvailable: !prepared,
          upgradeEnabled: prepared,
          controlRootConfigured: prepared,
          encryptionKeyReady: prepared,
          sqliteSelected: backend === 'sqlite',
          liveSqlite: phase === 'sqlite-live' && !restartRequired,
        },
      });
    if (endpoint === '/prepare') {
      calls.push('prepare');
      prepared = true;
      return route.fulfill({ status: 202, json: { restarting: true } });
    }
    if (endpoint === '/inventory') {
      calls.push('inspect');
      return route.fulfill({ json: inventoryFixture });
    }
    if (endpoint === '/pause') {
      calls.push('pause');
      pausedAt = '2026-10-04T00:00:00Z';
      return route.fulfill({ status: 204 });
    }
    if (endpoint === '/backup') {
      calls.push('backup');
      backup = {
        id,
        revision,
        pausedAt,
        phase: 'ready',
        sourceFingerprint: 'a'.repeat(64),
        archiveHash: 'b'.repeat(64),
        bytes: 4096,
      };
      return route.fulfill({ status: 202, json: { started: true } });
    }
    if (endpoint === '/copy') {
      calls.push('copy');
      expect(route.request().postDataJSON()).not.toHaveProperty('encryptionKeyBackedUp');
      phase = 'verified';
      revision++;
      return route.fulfill({ status: 202, json: { started: true } });
    }
    if (endpoint === '/action') {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(revision);
      calls.push(body.action);
      if (body.action === 'activate') {
        backend = 'sqlite';
        phase = 'sqlite-validation';
        restartRequired = true;
        revision++;
      } else if (body.action === 'validate') {
        expect(runtimeReady).toBe(true);
        expect(restartRequired).toBe(false);
        validated = true;
        revision++;
      } else if (body.action === 'resume') {
        expect(validated).toBe(true);
        phase = 'sqlite-live';
        pausedAt = null;
        restartRequired = true;
        revision++;
      }
      return route.fulfill({ status: 204 });
    }
    if (endpoint === '/restart') {
      expect(route.request().postDataJSON()).toEqual({ revision });
      calls.push('restart');
      restartRequired = false;
      runningBackend = backend;
      if (phase === 'sqlite-validation') {
        runtimeReady = false;
        reconnectFailures = 1;
      }
      return route.fulfill({ status: 202, json: { restarting: true } });
    }
    if (reconnectFailures > 0) {
      reconnectFailures--;
      return route.fulfill({ status: 503, json: { error: 'restarting' } });
    }
    return route.fulfill({
      json: {
        ...upgradeStatusFixture({ phase, backend, runningBackend, pausedAt, revision, validated, restartRequired }),
        available: prepared,
        settingsEncryptionRequired: false,
        uiRestartAvailable: true,
        runtimeReady,
        backup,
      },
    });
  });
  await context.route('**/api/app-settings/local-upgrade/backup/*?id=*', (route) => {
    const key = new URL(route.request().url()).pathname.endsWith('/key');
    downloads.push(key ? 'key' : 'archive');
    return route.fulfill({
      headers: { 'content-disposition': `attachment; filename="${key ? 'key.txt' : 'backup.tar.gz'}"` },
      body: 'owned-fixture',
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const prompt = page.getByTestId('local-storage-upgrade-prompt');
  await expect(prompt.getByText(/No encryption key, console commands or .env entries/)).toBeVisible();
  await prompt.getByRole('button', { name: 'Review upgrade steps' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await panel.getByRole('button', { name: 'Prepare server for migration' }).click();
  await expect(panel.getByRole('button', { name: 'Pause writes and create verified backup' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Pause writes and create verified backup' }).click();
  await expect.poll(() => calls).toEqual(['prepare', 'inspect', 'pause', 'backup']);
  await expect(panel.getByRole('button', { name: 'Download verified backup' })).toBeEnabled();
  await expect(panel.getByLabel('Backup reference', { exact: true })).not.toBeVisible();
  await expect(panel.getByLabel('Restored backup fingerprint', { exact: true })).not.toBeVisible();
  await panel.getByRole('button', { name: 'Download verified backup' }).click();
  await expect(panel.getByRole('button', { name: 'Download encryption key separately' })).toHaveCount(0);
  await expect.poll(() => downloads).toEqual(['archive']);
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  await panel.getByLabel('I saved the verified backup download securely outside this VM.').check();
  await expect(panel.getByLabel('I backed up the local settings encryption key separately.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Copy and verify', exact: true }).click();
  await panel.getByRole('button', { name: 'Activate SQLite while paused', exact: true }).click();
  await expect.poll(() => calls.filter((c) => c === 'restart').length).toBe(1);
  await expect(panel.getByRole('button', { name: 'Resume writes', exact: true })).toBeDisabled();
  expect(calls.filter((c) => c === 'validate')).toHaveLength(0);
  runtimeReady = true;
  await expect(panel.getByText(/SQLite runtime validation passed/)).toBeVisible();
  await expect.poll(() => calls.filter((c) => c === 'validate').length).toBe(1);
  await panel.getByLabel('I reviewed the selected backend and its write-resumption recovery boundary.').check();
  await panel.getByRole('button', { name: 'Resume writes', exact: true }).click();
  await expect.poll(() => calls.filter((c) => c === 'restart').length).toBe(2);
  await expect(panel.getByText('Running backend: sqlite. Selected phase: sqlite-live.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Return to legacy while paused' })).toHaveCount(0);
});

for (const scenario of [
  { phase: 'failed', evidence: 'matching' },
  { phase: 'interrupted', evidence: 'matching' },
  { phase: 'failed', evidence: 'whitespace' },
  { phase: 'failed', evidence: 'changed-source' },
  { phase: 'failed', evidence: 'changed-backup' },
  { phase: 'interrupted', evidence: 'changed-both' },
  { phase: 'failed', evidence: 'missing' },
]) {
  test(`copy button selects ${scenario.evidence} evidence for a ${scenario.phase} attempt`, async ({ page }) => {
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: { root: '/workflows', sync: { epoch: 'copy-evidence', revision: 0 }, folders: [], projects: [] },
      }),
    );
    await page.route('**/?editor', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body>Paused editor</body></html>' }),
    );
    const fingerprint = 'a'.repeat(64);
    const archiveHash = 'b'.repeat(64);
    const id = '9921c08b-44df-493c-98bd-02b61a5406d5';
    const reference = `browser-backup:${id}:${archiveHash}`;
    const matching = ['matching', 'whitespace'].includes(scenario.evidence);
    let job = {
      id: 'old-copy-attempt',
      phase: scenario.phase,
      sourceFingerprint:
        scenario.evidence === 'missing'
          ? undefined
          : scenario.evidence.includes('source') || scenario.evidence === 'changed-both'
            ? 'c'.repeat(64)
            : fingerprint,
      backupReference:
        scenario.evidence === 'missing'
          ? undefined
          : scenario.evidence.includes('backup') || scenario.evidence === 'changed-both'
            ? 'old-backup-reference'
            : reference,
      message: 'An earlier copy did not finish.',
      stage: 'workflows',
    };
    let payload: Record<string, unknown> | null = null;
    const pausedAt = '2026-10-08T00:00:00Z';
    await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/copy')) {
        payload = route.request().postDataJSON();
        job = {
          ...job,
          id: matching ? job.id : 'fresh-copy-attempt',
          phase: 'copying',
          sourceFingerprint: fingerprint,
          backupReference: reference,
        };
        return route.fulfill({ status: 202, json: { started: true } });
      }
      return route.fulfill({
        json: {
          ...upgradeStatusFixture({ pausedAt, operation: payload ? 'copy' : null }),
          settingsEncryptionRequired: false,
          job,
          backup: {
            id,
            revision: 1,
            pausedAt,
            phase: 'ready',
            sourceFingerprint: fingerprint,
            archiveHash,
            bytes: 4096,
          },
        },
      });
    });
    const panel = await openLocalUpgrade(page);
    await expect(panel.getByLabel('Restored backup fingerprint', { exact: true })).toHaveValue(fingerprint);
    if (scenario.evidence === 'whitespace') {
      if (!(await panel.getByLabel('Backup reference', { exact: true }).isVisible()))
        await panel.getByText('Advanced: independently restored backup evidence', { exact: true }).click();
      await panel.getByLabel('Backup reference', { exact: true }).fill(`  ${reference}  `);
    }
    const copy = panel.getByRole('button', {
      name: matching ? 'Retry copy and verification' : 'Copy and verify',
      exact: true,
    });
    await expect(copy).toBeDisabled();
    if (!matching) await expect(panel.getByText(/Previous copy status:/)).toBeVisible();
    await panel.getByLabel('I saved the verified backup download securely outside this VM.').check();
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect.poll(() => payload).not.toBeNull();
    expect(payload).toEqual({
      revision: 1,
      backupReference: reference,
      backupSourceFingerprint: fingerprint,
      backupRestored: true,
      ...(matching ? { retryJobId: 'old-copy-attempt' } : {}),
    });
    await expect(panel.getByText(/Copy status: copying/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  });
}

test('copy admission conflict reconciles replacement backup and requires a fresh attestation', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'copy-conflict', revision: 0 }, folders: [], projects: [] },
    }),
  );
  await page.route('**/?editor', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>Paused editor</body></html>' }),
  );
  const pausedAt = '2026-10-08T00:00:00Z';
  let backup = {
    id: '9921c08b-44df-493c-98bd-02b61a5406d5',
    revision: 1,
    pausedAt,
    phase: 'ready',
    sourceFingerprint: 'a'.repeat(64),
    archiveHash: 'b'.repeat(64),
    bytes: 4096,
  };
  const reference = () => `browser-backup:${backup.id}:${backup.archiveHash}`;
  let job = {
    id: 'old-copy',
    phase: 'failed',
    sourceFingerprint: backup.sourceFingerprint,
    backupReference: reference(),
  };
  const submissions: Record<string, unknown>[] = [];
  let accepted = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/copy')) {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) {
        backup = { ...backup, id: '42bfd0bf-a606-4af4-a8cd-a0bb94e39c10', archiveHash: 'c'.repeat(64) };
        return route.fulfill({
          status: 409,
          json: { error: 'The browser backup is stale or unverified. Reload status.' },
        });
      }
      accepted = true;
      job = {
        id: 'fresh-copy',
        phase: 'copying',
        sourceFingerprint: backup.sourceFingerprint,
        backupReference: reference(),
      };
      return route.fulfill({ status: 202, json: { started: true } });
    }
    return route.fulfill({
      json: {
        ...upgradeStatusFixture({ pausedAt, operation: accepted ? 'copy' : null }),
        settingsEncryptionRequired: false,
        backup,
        job,
      },
    });
  });
  const panel = await openLocalUpgrade(page);
  const attestation = panel.getByLabel('I saved the verified backup download securely outside this VM.');
  await attestation.check();
  await panel.getByRole('button', { name: 'Retry copy and verification', exact: true }).click();
  await expect(
    panel.getByText('The browser backup is stale or unverified. Reload status.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel('Backup reference', { exact: true })).toHaveValue(reference());
  await expect(attestation).not.toBeChecked();
  const copy = panel.getByRole('button', { name: 'Copy and verify', exact: true });
  await expect(copy).toBeDisabled();
  await expect(panel.getByText(/Previous copy status:/)).toBeVisible();
  await attestation.check();
  await copy.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0].retryJobId).toBe('old-copy');
  expect(submissions[1]).toEqual({
    revision: 1,
    backupReference: reference(),
    backupSourceFingerprint: backup.sourceFingerprint,
    backupRestored: true,
  });
  await expect(panel.getByText(/Copy status: copying/)).toBeVisible();
  await expect(copy).toBeDisabled();
});

test('browser backup survives reload, downloads archive and key separately and requires explicit attestations', async ({
  page,
  context,
}) => {
  const pausedAt = '2026-09-29T00:00:00Z';
  const fingerprint = 'a'.repeat(64);
  const archiveHash = 'b'.repeat(64);
  const id = '42bfd0bf-a606-4af4-a8cd-a0bb94e39c10';
  let backup: Record<string, unknown> | null = null;
  let backupStatusUnreadable = true;
  let operation: string | null = null;
  const downloads: string[] = [];
  let downloadFailure = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/setup')) return route.fallback();
    if (pathname.endsWith('/backup')) {
      expect(route.request().postDataJSON()).toEqual({ revision: 1 });
      backupStatusUnreadable = false;
      operation = 'backup';
      backup = {
        id,
        revision: 1,
        pausedAt,
        phase: 'creating',
        sourceFingerprint: fingerprint,
        archiveHash: null,
        bytes: 0,
      };
      return route.fulfill({ status: 202, json: { started: true } });
    }
    if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    if (pathname.endsWith('/inventory')) return route.fulfill({ json: inventoryFixture });
    return route.fulfill({
      json: { ...upgradeStatusFixture({ pausedAt, operation }), backup, backupStatusUnreadable },
    });
  });
  // Native attachment navigation is a new document, not a page fetch/Blob.
  await context.route('**/api/app-settings/local-upgrade/backup/*?id=*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('id')).toBe(id);
    const key = new URL(route.request().url()).pathname.endsWith('/key');
    downloads.push(key ? 'key' : 'archive');
    if (downloadFailure)
      return route.fulfill({ status: 409, json: { error: 'This backup is not ready. Reload status.' } });
    return route.fulfill({
      headers: {
        'content-disposition': `attachment; filename="${key ? 'key.txt' : 'backup.tar.gz'}"`,
        'cache-control': 'no-store',
      },
      contentType: key ? 'text/plain' : 'application/gzip',
      body: key ? 'test-only-key' : 'test-only-archive',
    });
  });
  let panel = await openLocalUpgrade(page);
  await expect(panel.getByText(/The previous backup status could not be read/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Create verified backup', exact: true }).click();
  await expect(panel.getByText(/The previous backup status could not be read/)).toHaveCount(0);
  await expect(panel.getByText(/Creating the backup archive and checking an isolated restore/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await expect(panel.getByText(/Creating the backup archive and checking an isolated restore/)).toBeVisible();
  operation = null;
  backup = { ...backup, phase: 'ready', archiveHash, bytes: 4096 };
  await expect(panel.getByRole('button', { name: 'Download verified backup', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('Backup reference', { exact: true })).toHaveValue(
    `browser-backup:${id}:${archiveHash}`,
  );
  await expect(panel.getByLabel('Restored backup fingerprint', { exact: true })).toHaveValue(fingerprint);
  const workspaceUrl = page.url();
  await panel.getByRole('button', { name: 'Download verified backup', exact: true }).click();
  await expect.poll(() => downloads).toEqual(['archive']);
  await panel.getByRole('button', { name: 'Download encryption key separately', exact: true }).click();
  await expect.poll(() => downloads).toEqual(['archive', 'key']);
  expect(page.url()).toBe(workspaceUrl);
  downloadFailure = true;
  // Successful attachment navigations can emit a late temporary blank page.
  // Wait for the actual error document, not an earlier download's popup.
  const failurePage = context.waitForEvent('page', {
    predicate: (popup) => popup.url().includes('/local-upgrade/backup/download'),
  });
  await panel.getByRole('button', { name: 'Download verified backup', exact: true }).click();
  const popup = await failurePage;
  await expect(popup.locator('body')).toContainText('This backup is not ready. Reload status.');
  await popup.close();
  expect(page.url()).toBe(workspaceUrl);
  await expect(panel).toBeVisible();
  const saved = panel.getByLabel('I saved the verified backup download securely outside this VM.');
  const keySaved = panel.getByLabel('I backed up the local settings encryption key separately.');
  await expect(saved).not.toBeChecked();
  await expect(keySaved).not.toBeChecked();
  await saved.check();
  await keySaved.check();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeEnabled();
  // A newer job must revoke the old receipt even if fields remain filled.
  operation = 'backup';
  backup = { ...backup, id: 'a2ae9ad3-cdcc-4e88-9d8b-fdb1cfe343f0', phase: 'creating', archiveHash: null };
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  operation = null;
  backup = { ...backup, phase: 'failed' };
  await expect(panel.getByText(/Backup creation or restore verification did not finish/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  backup = null;
  backupStatusUnreadable = true;
  await expect(panel.getByText(/The previous backup status could not be read/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeEnabled();
});

const loadingActions = [
  {
    kind: 'inspect',
    label: 'Inspect source',
    path: '/inventory',
    phase: 'legacy',
    paused: false,
    progress: 'Inspecting source data',
  },
  {
    kind: 'pause',
    label: 'Pause writes and drain',
    path: '/pause',
    phase: 'legacy',
    paused: false,
    progress: 'Pausing new writes',
  },
  {
    kind: 'fingerprint',
    label: 'Read frozen source fingerprint',
    path: '/fingerprint',
    phase: 'legacy',
    paused: true,
    progress: 'Reading the frozen source',
  },
  {
    kind: 'copy',
    label: 'Copy and verify',
    path: '/copy',
    phase: 'legacy',
    paused: true,
    progress: 'Copy and verification are in progress',
  },
  {
    kind: 'activate',
    label: 'Activate SQLite while paused',
    path: '/action',
    phase: 'verified',
    paused: true,
    progress: 'Checking the certified candidate',
  },
  {
    kind: 'validate',
    label: 'Validate selected runtime',
    path: '/action',
    phase: 'sqlite-validation',
    paused: true,
    progress: 'Validating the selected runtime',
  },
  {
    kind: 'return-to-legacy',
    label: 'Return to legacy while paused',
    path: '/action',
    phase: 'sqlite-validation',
    paused: true,
    progress: 'Checking the retained source',
  },
  {
    kind: 'resume',
    label: 'Resume writes',
    path: '/action',
    phase: 'sqlite-validation',
    paused: true,
    progress: 'Recording write resumption',
  },
  {
    kind: 'finish-resume',
    label: 'Finish durable resumption',
    path: '/action',
    phase: 'legacy-resumed',
    paused: true,
    progress: 'Completing durable write resumption',
  },
  {
    kind: 'cancel',
    label: 'Resume unchanged legacy',
    path: '/action',
    phase: 'legacy',
    paused: true,
    progress: 'Restoring legacy operation',
  },
  {
    kind: 'report',
    label: 'Download verification report',
    path: '/report',
    phase: 'verified',
    paused: true,
    progress: 'Preparing the verification report',
  },
] as const;

for (const scenario of loadingActions.filter((item) => item.kind !== 'report')) {
  test(`server-reported ${scenario.label} stays visible and locked for another operator`, async ({ page }) => {
    let operation: string | null = scenario.kind === 'finish-resume' ? 'resume' : scenario.kind;
    await page.route('**/api/app-settings/local-upgrade', (route) =>
      route.fulfill({
        json: upgradeStatusFixture({
          operation,
          phase: scenario.phase,
          backend: scenario.phase.startsWith('sqlite') ? 'sqlite' : 'legacy',
          pausedAt: scenario.paused ? '2026-09-29T00:00:00Z' : null,
        }),
      }),
    );
    const panel = await openLocalUpgrade(page);
    const button = panel.getByRole('button', { name: scenario.label, exact: true });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(
      panel.getByText(
        'A local storage operation is still running on the server. Other actions stay locked until it finishes.',
      ),
    ).toBeVisible();
    await expect(panel.getByRole('status').filter({ hasText: scenario.progress })).toBeVisible();
    await expect(panel.locator('button[aria-busy="true"]')).toHaveCount(1);
    for (const other of await panel.getByRole('button').all()) await expect(other).toBeDisabled();
    operation = null;
    await expect(panel.locator('button[aria-busy="true"]')).toHaveCount(0);
  });
}

test('server activity remains visible even when its action row is unavailable in the selected phase', async ({
  page,
}) => {
  let operation: string | null = 'fingerprint';
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({ json: upgradeStatusFixture({ phase: 'verified', operation, pausedAt: '2026-09-29T00:00:00Z' }) }),
  );
  const panel = await openLocalUpgrade(page);
  await expect(panel.getByRole('button', { name: 'Read frozen source fingerprint', exact: true })).toHaveCount(0);
  await expect(
    panel.getByText(
      'A local storage operation is still running on the server. Other actions stay locked until it finishes.',
    ),
  ).toBeVisible();
  const activate = panel.getByRole('button', { name: 'Activate SQLite while paused', exact: true });
  await expect(activate).toBeDisabled();
  operation = null;
  await expect(activate).toBeEnabled();
});

for (const navigation of ['tab', 'modal'] as const) {
  test(`reopening the upgrade ${navigation} cannot hide an inspection still running on the server`, async ({
    page,
  }) => {
    let operation: string | null = null;
    let releaseInspection: (() => void) | undefined;
    let inspections = 0;
    await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/inventory')) {
        inspections++;
        operation = 'inspect';
        if (inspections === 1)
          await new Promise<void>((resolve) => {
            releaseInspection = resolve;
          });
        operation = null;
        return route.fulfill({ json: inventoryFixture });
      }
      return route.fulfill({ json: upgradeStatusFixture({ operation }) });
    });
    const panel = await openLocalUpgrade(page);
    const inspect = panel.getByRole('button', { name: 'Inspect source', exact: true });
    await inspect.click();
    await expect.poll(() => typeof releaseInspection).toBe('function');
    const modal = page.getByTestId('app-settings-modal');
    if (navigation === 'tab') await modal.getByRole('tab', { name: 'General', exact: true }).click();
    else {
      await modal.getByRole('button', { name: 'Close app settings', exact: true }).click();
      await openSettings(page);
    }
    await modal.getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
    await expect(inspect).toHaveAttribute('aria-busy', 'true');
    await expect(inspect).toBeDisabled();
    expect(inspections).toBe(1);
    releaseInspection!();
    await expect(inspect).toBeEnabled();
    await inspect.click();
    await expect(panel.getByText(/2 projects, 1 folders/)).toBeVisible();
    expect(inspections).toBe(2);
  });
}

test('editing backup evidence or advancing the transition requires fresh backup attestations', async ({ page }) => {
  let revision = 1;
  let restartRequired = false;
  const fingerprint = 'c'.repeat(64);
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/fingerprint'))
      return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    return route.fulfill({
      json: { ...upgradeStatusFixture({ pausedAt: '2026-09-29T00:00:00Z', revision }), restartRequired },
    });
  });
  const panel = await openLocalUpgrade(page);
  const restored = panel.getByLabel('I restored a separate backup of all four source roots.');
  const key = panel.getByLabel('I backed up the local settings encryption key separately.');
  const copy = panel.getByRole('button', { name: 'Copy and verify', exact: true });
  await expect(restored).toBeDisabled();
  await panel.getByRole('button', { name: 'Read frozen source fingerprint', exact: true }).click();
  await panel.getByLabel('Backup reference', { exact: true }).fill('restored-copy-A');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  const certify = async () => {
    await restored.check();
    await key.check();
    await expect(copy).toBeEnabled();
  };
  await certify();
  await panel.getByLabel('Backup reference', { exact: true }).fill('restored-copy-B');
  await expect(restored).not.toBeChecked();
  await expect(key).not.toBeChecked();
  await expect(copy).toBeDisabled();
  await certify();
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill('d'.repeat(64));
  await expect(restored).not.toBeChecked();
  await expect(restored).toBeDisabled();
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  await expect(copy).toBeDisabled();
  await certify();
  revision++;
  restartRequired = true;
  await expect(copy).toBeDisabled();
  await expect(restored).not.toBeChecked();
  await expect(key).not.toBeChecked();
  await restored.check();
  await key.check();
  await expect(copy).toBeDisabled();
  restartRequired = false;
  await expect(copy).toBeEnabled();
});

for (const unavailable of [false, true]) {
  test(`losing operator status through ${unavailable ? 'a disabled feature' : 'an expired session'} clears the write-resumption acknowledgement`, async ({
    page,
  }) => {
    let authorized = true;
    await page.route('**/api/app-settings/local-upgrade', (route) =>
      authorized
        ? route.fulfill({
            json: upgradeStatusFixture({
              phase: 'sqlite-validation',
              backend: 'sqlite',
              pausedAt: '2026-09-29T00:00:00Z',
              validated: true,
            }),
          })
        : unavailable
          ? route.fulfill({ json: { ...upgradeStatusFixture(), available: false, transition: null } })
          : route.fulfill({ status: 403, json: { error: 'Operator session expired.' } }),
    );
    const panel = await openLocalUpgrade(page);
    const acknowledgement = panel.getByLabel(
      'I reviewed the selected backend and its write-resumption recovery boundary.',
    );
    const resume = panel.getByRole('button', { name: 'Resume writes', exact: true });
    await acknowledgement.check();
    await expect(resume).toBeEnabled();
    authorized = false;
    if (unavailable) await expect(panel.getByText(/This feature is disabled by default/)).toBeVisible();
    else await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toBeVisible();
    await expect(resume).toBeDisabled();
    authorized = true;
    await expect(acknowledgement).toBeEnabled();
    await expect(acknowledgement).not.toBeChecked();
    await expect(resume).toBeDisabled();
  });
}

test('a failed post-copy status refresh stays locked and reconnect restores the durable copy progress', async ({
  page,
}) => {
  const fingerprint = 'e'.repeat(64);
  let copied = false,
    failStatus = false,
    complete = false;
  let copyRequests = 0;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    if (pathname.endsWith('/copy')) {
      copied = failStatus = true;
      copyRequests++;
      return route.fulfill({ status: 202, json: { started: true } });
    }
    if (failStatus) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable.' } });
    return route.fulfill({
      json: {
        ...upgradeStatusFixture({
          phase: complete ? 'verified' : 'legacy',
          operation: copied && !complete ? 'copy' : null,
          pausedAt: '2026-09-29T00:00:00Z',
        }),
        job: copied ? { id: 'status-recovery-fixture', phase: complete ? 'verified' : 'copying', message: null } : null,
      },
    });
  });
  const panel = await openLocalUpgrade(page);
  await panel.getByRole('button', { name: 'Read frozen source fingerprint', exact: true }).click();
  await panel.getByLabel('Backup reference', { exact: true }).fill('restored-copy');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  const copy = panel.getByRole('button', { name: 'Copy and verify', exact: true });
  await copy.click();
  await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toBeVisible();
  await expect(copy).toBeDisabled();
  failStatus = false;
  await expect(copy).toHaveAttribute('aria-busy', 'true');
  await expect(copy).toBeDisabled();
  await expect(panel.getByText('Copy status: copying.')).toBeVisible();
  complete = true;
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused', exact: true })).toBeEnabled();
  expect(copyRequests).toBe(1);
});

for (const scenario of loadingActions) {
  test(`${scenario.label} shows only its own spinner and progress while the request is delayed`, async ({
    page,
  }, testInfo) => {
    let phase: string = scenario.phase,
      paused: boolean = scenario.paused,
      drainReady = true,
      restartRequired = false,
      validated = scenario.kind === 'resume',
      failNext = scenario.kind === 'inspect' || scenario.kind === 'report';
    let job: { id: string; phase: string; message: string } | null = null;
    let release: (() => void) | undefined;
    let targetRequests = 0;
    const fingerprint = 'a'.repeat(64);
    await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const basePath = '/api/app-settings/local-upgrade';
      if (pathname === `${basePath}/setup`) return route.fallback();
      if (pathname === basePath)
        return route.fulfill({
          json: {
            available: true,
            copyConfigurationReady: true,
            runningBackend: phase.startsWith('sqlite') ? 'sqlite' : 'legacy',
            maintenance: paused ? { enteredAt: '2026-09-28T00:00:00Z' } : null,
            drain: paused ? { ready: drainReady, blockers: drainReady ? [] : ['active requests'] } : null,
            restartRequired,
            transition: {
              revision: 1,
              phase,
              backend: phase.startsWith('sqlite') ? 'sqlite' : 'legacy',
              generationId: phase === 'legacy' ? null : 'loading-fixture',
              canReturnToLegacy: phase === 'sqlite-validation' || phase === 'verified',
              validated,
            },
            job,
          },
        });
      if (pathname === `${basePath}${scenario.path}`) {
        targetRequests++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (failNext) {
          failNext = false;
          return route.fulfill({ status: 409, json: { error: 'Delayed action failed safely.' } });
        }
      }
      if (pathname.endsWith('/inventory'))
        return route.fulfill({
          json: {
            source: {},
            inventory: {
              projects: 2,
              folders: 1,
              recordingBundles: 3,
              publishedVersions: 2,
              publishedWebApps: 1,
              warnings: [],
            },
            capacity: { payloadBytes: 1024, requiredBytes: 1024, fits: true },
            backupRequired: 'Restore a separate backup.',
          },
        });
      if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: fingerprint } });
      if (pathname.endsWith('/pause')) {
        paused = true;
        drainReady = false;
        return route.fulfill({ status: 204 });
      }
      if (pathname.endsWith('/copy')) {
        job = { id: 'loading-fixture', phase: 'copying', message: 'Copy is running on the server.' };
        return route.fulfill({ status: 202, json: { started: true } });
      }
      if (pathname.endsWith('/report')) return route.fulfill({ json: { generationId: 'loading-fixture', report: {} } });
      if (pathname.endsWith('/action')) {
        const body = route.request().postDataJSON();
        expect(body.action).toBe(scenario.kind === 'finish-resume' ? 'resume' : scenario.kind);
        if (body.action === 'validate') validated = true;
        else {
          restartRequired = true;
          if (body.action === 'activate') phase = 'sqlite-validation';
          if (body.action === 'return-to-legacy') phase = 'legacy-validation';
          if (body.action === 'resume' || body.action === 'cancel') paused = false;
        }
        return route.fulfill({ status: 204 });
      }
      throw new Error('Unexpected loading fixture request.');
    });
    const open = async () => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await openSettings(page);
      await page
        .getByTestId('app-settings-modal')
        .getByRole('tab', { name: 'Local storage upgrade', exact: true })
        .click();
    };
    await open();
    const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
    if (scenario.kind === 'pause') await panel.getByRole('button', { name: 'Inspect source', exact: true }).click();
    if (scenario.kind === 'copy') {
      await panel.getByRole('button', { name: 'Read frozen source fingerprint', exact: true }).click();
      await panel.getByLabel('Backup reference', { exact: true }).fill('restored fixture');
      await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
      await panel.getByLabel('I restored a separate backup of all four source roots.').check();
      await panel.getByLabel('I backed up the local settings encryption key separately.').check();
    }
    if (scenario.kind === 'resume')
      await panel.getByLabel('I reviewed the selected backend and its write-resumption recovery boundary.').check();
    const button = panel.getByRole('button', { name: scenario.label, exact: true });
    const progress = panel.getByRole('status').filter({ hasText: scenario.progress });
    const expectPending = async () => {
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).toBeDisabled();
      const spinner = button.locator('svg');
      await expect(spinner).toBeVisible();
      await expect(spinner).toHaveCSS('opacity', '1');
      await expect(button.locator('svg circle')).toHaveCSS('stroke', 'rgb(255, 255, 255)');
      await expect(progress).toBeVisible();
      await expect(panel.locator('button[aria-busy="true"]')).toHaveCount(1);
      for (const other of await panel.getByRole('button').all()) await expect(other).toBeDisabled();
      await expect.poll(() => typeof release).toBe('function');
    };
    await button.click();
    await expectPending();
    // Disabled native buttons must not dispatch a second request even if clicked again.
    await button.evaluate((element) => (element as HTMLButtonElement).click());
    expect(targetRequests).toBe(1);
    if (scenario.kind === 'inspect') {
      await progress.scrollIntoViewIfNeeded();
      const screenshot = testInfo.outputPath('inspect-source-loading.png');
      await page.screenshot({ path: screenshot });
      await testInfo.attach('Inspect source progress', { path: screenshot, contentType: 'image/png' });
    }
    release!();
    if (scenario.kind === 'inspect' || scenario.kind === 'report') {
      await expect(panel.getByRole('alert')).toContainText('Delayed action failed safely.');
      await expect(button).toHaveAttribute('aria-busy', 'false');
      await expect(progress).toHaveCount(0);
      await expect(button).toBeEnabled();
      release = undefined;
      await button.click();
      await expectPending();
      release!();
    }
    if (scenario.kind === 'copy' || scenario.kind === 'pause') {
      await expect(
        panel.getByText(
          scenario.kind === 'copy'
            ? 'Copy status: copying. Copy is running on the server.'
            : 'Waiting for: active requests.',
        ),
      ).toBeVisible();
      await expect(progress).toBeVisible();
      // The request has returned, but the server-side work is not complete.
      await open();
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(progress).toBeVisible();
      if (scenario.kind === 'copy') {
        phase = 'verified';
        job = { id: 'loading-fixture', phase: 'verified', message: 'Copy finished.' };
      } else drainReady = true;
    }
    await expect(panel.locator('button[aria-busy="true"]')).toHaveCount(0);
    await expect(progress).toHaveCount(0);
    expect(targetRequests).toBe(scenario.kind === 'inspect' || scenario.kind === 'report' ? 2 : 1);
  });
}

test('action settlement keeps controls busy until its fresh status returns and suspends background polls', async ({
  page,
}) => {
  let settling = false;
  let statusRequests = 0;
  let releaseStatus: (() => void) | undefined;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/inventory')) {
      settling = true;
      return route.fulfill({ json: inventoryFixture });
    }
    statusRequests++;
    if (settling)
      await new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
    return route.fulfill({
      json: upgradeStatusFixture({ pausedAt: settling ? '2026-09-28T01:00:00Z' : null }),
    });
  });
  const panel = await openLocalUpgrade(page);
  const inspect = panel.getByRole('button', { name: 'Inspect source', exact: true });
  await expect(inspect).toBeEnabled();
  await page.clock.install();
  const beforeAction = statusRequests;
  await inspect.click();
  await expect.poll(() => typeof releaseStatus).toBe('function');
  await page.clock.runFor(4500);
  expect(statusRequests).toBe(beforeAction + 1);
  await expect(inspect).toHaveAttribute('aria-busy', 'true');
  await expect(panel.getByRole('button', { name: 'Pause writes and drain', exact: true })).toBeDisabled();
  releaseStatus!();
  await expect(inspect).toHaveAttribute('aria-busy', 'false');
  await expect(inspect).toBeDisabled();
  await expect(panel.getByText('Source is quiet. Take and restore your backup before copying.')).toBeVisible();
});

test('a lost pause response is reconciled before controls unlock and its diagnostic is preserved', async ({ page }) => {
  let paused = false;
  let statusRequests = 0;
  let pauseRequests = 0;
  let releaseStatus: (() => void) | undefined;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/inventory')) return route.fulfill({ json: inventoryFixture });
    if (pathname.endsWith('/pause')) {
      paused = true;
      pauseRequests++;
      return route.abort('failed');
    }
    statusRequests++;
    if (paused)
      await new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
    return route.fulfill({ json: upgradeStatusFixture({ pausedAt: paused ? '2026-09-28T01:00:00Z' : null }) });
  });
  const panel = await openLocalUpgrade(page);
  await panel.getByRole('button', { name: 'Inspect source', exact: true }).click();
  const pause = panel.getByRole('button', { name: 'Pause writes and drain', exact: true });
  await expect(pause).toBeEnabled();
  await page.clock.install();
  const beforeAction = statusRequests;
  await pause.click();
  await expect.poll(() => typeof releaseStatus).toBe('function');
  await expect(panel.getByRole('alert')).toContainText('Failed to fetch');
  await page.clock.runFor(4500);
  expect(statusRequests).toBe(beforeAction + 1);
  await expect(pause).toHaveAttribute('aria-busy', 'true');
  await expect(panel.getByRole('button', { name: 'Inspect source', exact: true })).toBeDisabled();
  releaseStatus!();
  await expect(pause).toHaveAttribute('aria-busy', 'false');
  await expect(panel.getByText('Source is quiet. Take and restore your backup before copying.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeEnabled();
  await expect(panel.getByRole('alert')).toContainText('Failed to fetch');
  expect(pauseRequests).toBe(1);
});

test('frozen fingerprints belong to one maintenance session and failed reads invalidate earlier proofs', async ({
  page,
}) => {
  let pausedAt = '2026-09-28T01:00:00Z';
  let failFingerprint = false;
  const fingerprint = 'b'.repeat(64);
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/fingerprint'))
      return failFingerprint
        ? route.fulfill({ status: 409, json: { error: 'Frozen source could not be checked.' } })
        : route.fulfill({ json: { sourceFingerprint: fingerprint } });
    return route.fulfill({ json: upgradeStatusFixture({ pausedAt }) });
  });
  const panel = await openLocalUpgrade(page);
  const read = panel.getByRole('button', { name: 'Read frozen source fingerprint', exact: true });
  const copy = panel.getByRole('button', { name: 'Copy and verify', exact: true });
  await read.click();
  await panel.getByLabel('Backup reference', { exact: true }).fill('restored fixture');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  await expect(copy).toBeEnabled();
  pausedAt = '2026-09-28T02:00:00Z';
  await expect(copy).toBeDisabled();
  await expect(panel.locator('.local-upgrade-fingerprint')).toHaveCount(0);
  await read.click();
  await expect(copy).toBeDisabled();
  await expect(panel.getByLabel('I restored a separate backup of all four source roots.')).not.toBeChecked();
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  await expect(copy).toBeEnabled();
  failFingerprint = true;
  await read.click();
  await expect(panel.getByRole('alert')).toContainText('Frozen source could not be checked.');
  await expect(read).toBeEnabled();
  await expect(copy).toBeDisabled();
  await expect(panel.locator('.local-upgrade-fingerprint')).toHaveCount(0);
});

test('a failed repeat inspection does not leave stale inventory eligible for pausing', async ({ page }) => {
  let failInspection = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/inventory'))
      return failInspection
        ? route.fulfill({ status: 409, json: { error: 'Source inventory needs repair.' } })
        : route.fulfill({ json: inventoryFixture });
    return route.fulfill({ json: upgradeStatusFixture() });
  });
  const panel = await openLocalUpgrade(page);
  const inspect = panel.getByRole('button', { name: 'Inspect source', exact: true });
  const pause = panel.getByRole('button', { name: 'Pause writes and drain', exact: true });
  await inspect.click();
  await expect(pause).toBeEnabled();
  failInspection = true;
  await inspect.click();
  await expect(panel.getByRole('alert')).toContainText('Source inventory needs repair.');
  await expect(inspect).toBeEnabled();
  await expect(pause).toBeDisabled();
  await expect(panel.locator('.local-upgrade-inventory')).toHaveCount(0);
});

test('validation and resumption share runtime readiness and restart completion comes from fresh server status', async ({
  page,
}) => {
  let phase = 'verified';
  let runningBackend = 'legacy';
  let restartRequired = false;
  let validated = true;
  let revision = 1;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/action')) {
      const { action } = route.request().postDataJSON();
      if (action === 'activate') {
        phase = 'sqlite-validation';
        restartRequired = true;
      } else {
        expect(action).toBe('validate');
        validated = true;
      }
      revision++;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: upgradeStatusFixture({
        phase,
        backend: phase === 'verified' ? 'legacy' : 'sqlite',
        runningBackend,
        pausedAt: '2026-09-28T01:00:00Z',
        validated,
        revision,
        restartRequired,
      }),
    });
  });
  const panel = await openLocalUpgrade(page);
  await panel.getByRole('button', { name: 'Activate SQLite while paused', exact: true }).click();
  const validate = panel.getByRole('button', { name: 'Validate selected runtime', exact: true });
  const acknowledgement = panel.getByLabel(
    'I reviewed the selected backend and its write-resumption recovery boundary.',
  );
  const resume = panel.getByRole('button', { name: 'Resume writes', exact: true });
  const success = panel.getByRole('status').filter({ hasText: 'runtime validation passed.' });
  await expect(
    panel.getByRole('status').filter({ hasText: 'Restart the combined API/executor container' }),
  ).toBeVisible();
  await expect(validate).toBeDisabled();
  await expect(acknowledgement).toBeDisabled();
  await expect(resume).toBeDisabled();
  // Even inconsistent status cannot enable validation/resumption for a backend
  // that differs from the selected one.
  restartRequired = false;
  await page.clock.install();
  await page.clock.runFor(2500);
  await expect(
    panel.getByRole('status').filter({ hasText: 'Restart the combined API/executor container' }),
  ).toBeVisible();
  await expect(validate).toBeDisabled();
  await expect(acknowledgement).toBeDisabled();
  await expect(success).toHaveCount(0);
  // A real restart can complete while this panel remains open. Its confirmed
  // server state, not a sticky client restart flag, makes the runtime usable.
  runningBackend = 'sqlite';
  validated = false;
  await page.clock.runFor(2500);
  await expect(validate).toBeEnabled();
  await validate.click();
  await expect(success).toBeVisible();
  await expect(panel.getByText('Source is quiet. Take and restore your backup before copying.')).toHaveCount(0);
  await expect(acknowledgement).toBeEnabled();
  await acknowledgement.check();
  await expect(resume).toBeEnabled();
});

for (const guided of [true, false]) {
  test(`Advanced source controls explain their effects in ${guided ? 'guided' : 'manual'} upgrades`, async ({
    page,
  }) => {
    let paused = false;
    const writes: string[] = [];
    await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST') {
        writes.push(pathname);
        if (pathname.endsWith('/pause')) paused = true;
        return route.fulfill({ status: 204 });
      }
      if (pathname.endsWith('/inventory')) return route.fulfill({ json: inventoryFixture });
      return route.fulfill({
        json: {
          ...upgradeStatusFixture({ pausedAt: paused ? '2026-09-28T00:00:00Z' : null }),
          uiRestartAvailable: guided,
        },
      });
    });
    const panel = await openLocalUpgrade(page);
    const source = panel.getByRole('region', { name: 'Source inspection and maintenance' });
    const advanced = source.locator('details');
    await expect(source.locator('summary')).toHaveText('Advanced');
    await expect(advanced).toHaveJSProperty('open', !guided);
    if (guided) {
      await expect(source.getByRole('button', { name: 'Pause writes and create verified backup' })).toBeEnabled();
      await source.locator('summary').click();
      await expect(source.getByText(/Optional individual controls/)).toBeVisible();
    }
    expect(writes).toEqual([]);
    const inspect = advanced.getByRole('button', { name: 'Inspect source', exact: true });
    const pause = advanced.getByRole('button', { name: 'Pause writes and drain', exact: true });
    await expect(inspect).toHaveAccessibleDescription(
      'Checks source folders, inventory, warnings and disk/memory capacity without changing data or pausing writes.',
    );
    await expect(pause).toHaveAccessibleDescription(
      'Blocks new writes and runs, then waits for active work to finish. Does not create a backup.',
    );
    await expect(pause).toBeDisabled();
    await inspect.click();
    await expect(pause).toBeEnabled();
    expect(writes).toEqual([]);
    await pause.click();
    await expect(pause).toBeDisabled();
    expect(writes).toEqual(['/api/app-settings/local-upgrade/pause']);
  });
}

test('local upgrade actions and backup fields have separate readable rows at desktop and narrow widths', async ({
  page,
}, testInfo) => {
  const fingerprint = 'a'.repeat(64);
  const writes: string[] = [];
  let fingerprintReads = 0;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      writes.push(pathname);
      return route.fulfill({ status: 409, json: { error: 'Layout checks must not change storage state.' } });
    }
    if (pathname.endsWith('/fingerprint')) {
      fingerprintReads++;
      return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    }
    return route.fulfill({
      json: {
        available: true,
        copyConfigurationReady: true,
        runningBackend: 'legacy',
        maintenance: { enteredAt: '2026-09-28T00:00:00Z' },
        drain: { ready: true, blockers: [] },
        restartRequired: false,
        transition: {
          revision: 1,
          phase: 'legacy',
          backend: 'legacy',
          generationId: null,
          canReturnToLegacy: false,
          validated: false,
        },
        job: null,
      },
    });
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await panel.getByRole('button', { name: 'Read frozen source fingerprint' }).click();
  await expect(panel.locator('code')).toHaveText(fingerprint);
  const reference = panel.getByLabel('Backup reference', { exact: true });
  const restored = panel.getByLabel('Restored backup fingerprint', { exact: true });
  await reference.fill(`F:\\Programming\\${'long-restored-backup-folder-'.repeat(8)}`);
  await restored.fill(fingerprint);
  await reference.focus();
  await page.keyboard.press('Tab');
  await expect(restored).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  for (const width of [1100, 800, 600, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel.getByRole('group', { name: 'Create and download a verified backup' })).toBeVisible();
    for (const name of [
      'Source inspection and maintenance',
      'Backup certification and copy',
      'Activation and runtime validation',
      'Write resumption',
      'Recovery and verification report',
    ]) {
      await expect(panel.getByRole('region', { name, exact: true })).toBeVisible();
    }
    const layout = await panel.evaluate((element) => {
      const buttons = [...element.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
      });
      const fields = [...element.querySelectorAll('input:not([type="checkbox"])')].map((input) => {
        const box = input.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, width: box.width };
      });
      const code = element.querySelector('code')!;
      const box = element.getBoundingClientRect();
      return {
        buttons,
        fields,
        left: box.left,
        right: box.right,
        overflow: element.scrollWidth - element.clientWidth,
        fingerprintOverflow: code.scrollWidth - code.clientWidth,
      };
    });
    expect(layout.overflow, `panel must not overflow at ${width}px`).toBeLessThanOrEqual(1);
    expect(layout.fingerprintOverflow, `fingerprint must wrap at ${width}px`).toBeLessThanOrEqual(1);
    for (const [index, button] of layout.buttons.entries()) {
      expect(button.height).toBeGreaterThanOrEqual(30);
      expect(button.left).toBeGreaterThanOrEqual(layout.left);
      expect(button.right).toBeLessThanOrEqual(layout.right + 1);
      if (index > 0) expect(button.top).toBeGreaterThan(layout.buttons[index - 1]!.bottom);
    }
    expect(layout.fields).toHaveLength(2);
    expect(layout.fields[1]!.top).toBeGreaterThan(layout.fields[0]!.bottom);
    expect(layout.fields[0]!.width).toBeGreaterThan(180);
    expect(layout.fields[1]!.width).toBeGreaterThan(180);
    if (width === 800 || width === 360) {
      await reference.scrollIntoViewIfNeeded();
      const screenshot = testInfo.outputPath(`local-upgrade-${width}px.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`Upgrade form at ${width}px`, { path: screenshot, contentType: 'image/png' });
    }
  }
  expect(writes).toHaveLength(0);
  expect(fingerprintReads).toBe(1);
});

test('local storage upgrade requires backup certification and coordinated restart before resuming writes', async ({
  page,
}) => {
  let phase = 'legacy',
    revision = 1,
    backend = 'legacy',
    restartRequired = false,
    paused = false,
    validated = false,
    copyConfigurationReady = false;
  let copyRequests = 0;
  const actions: string[] = [];
  const fingerprint = 'a'.repeat(64);
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') expect(route.request().headers()['x-rivet-migration-intent']).toBe('1');
    if (pathname.endsWith('/inventory'))
      return route.fulfill({
        json: {
          source: {
            workflows: '/workflows',
            recordings: '/recordings',
            appData: '/data/rivet-app',
            runtimeLibraries: '/data/runtime-libraries',
          },
          inventory: {
            projects: 2,
            folders: 1,
            recordingBundles: 3,
            publishedEndpoints: 1,
            publishedVersions: 2,
            publishedWebApps: 1,
            warnings: [],
          },
          capacity: {
            payloadBytes: 1024,
            freeBytes: 100_000_000,
            requiredBytes: 2_000_000,
            maxPayloadBytes: 128_000_000,
            fits: true,
          },
          backupRequired: 'Restore a separate backup and keep the encryption key safe.',
        },
      });
    if (pathname.endsWith('/pause')) {
      paused = true;
      return route.fulfill({ status: 204 });
    }
    if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    if (pathname.endsWith('/copy')) {
      const body = route.request().postDataJSON();
      expect(body.backupSourceFingerprint).toBe(fingerprint);
      expect(body.backupRestored).toBe(true);
      expect(body.encryptionKeyBackedUp).toBe(true);
      expect(body).not.toHaveProperty('encryptionKey');
      copyRequests++;
      if (copyRequests === 1)
        return route.fulfill({
          status: 409,
          json: {
            error: 'Configure the dedicated local encryption key. No copy was started.',
            code: 'local-encryption-key-required',
          },
        });
      phase = 'verified';
      revision++;
      return route.fulfill({ status: 202, json: { started: true } });
    }
    if (pathname.endsWith('/action')) {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(revision);
      actions.push(body.action);
      revision++;
      if (body.action === 'activate') {
        phase = 'sqlite-validation';
        restartRequired = true;
      }
      if (body.action === 'validate') {
        expect(backend).toBe('sqlite');
        validated = true;
      }
      if (body.action === 'resume') {
        expect(validated).toBe(true);
        phase = 'sqlite-live';
        paused = false;
        restartRequired = true;
      }
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        available: true,
        copyConfigurationReady,
        runningBackend: backend,
        maintenance: paused ? { enteredAt: '2026-09-28T00:00:00Z' } : null,
        drain: paused ? { ready: true, blockers: [] } : null,
        restartRequired,
        transition: {
          revision,
          phase,
          backend: phase.startsWith('sqlite') ? 'sqlite' : 'legacy',
          generationId: phase === 'legacy' ? null : 'fixture',
          canReturnToLegacy: ['verified', 'sqlite-validation'].includes(phase),
          validated,
        },
        job: copyRequests ? { id: 'fixture', phase: 'verified', message: 'Copied and exactly verified.' } : null,
      },
    });
  });
  const open = async () => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await openSettings(page);
    await page
      .getByTestId('app-settings-modal')
      .getByRole('tab', { name: 'Local storage upgrade', exact: true })
      .click();
  };
  await open();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  const copy = panel.getByRole('button', { name: 'Copy and verify', exact: true });
  await expect(copy).toBeDisabled();
  await panel.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(panel.getByText(/2 projects, 1 folders, 3 recordings/)).toBeVisible();
  await panel.getByRole('button', { name: 'Pause writes and drain' }).click();
  await panel.getByRole('button', { name: 'Read frozen source fingerprint' }).click();
  await panel.getByLabel('Backup reference', { exact: true }).fill('off-VM restored backup');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill('b'.repeat(64));
  await expect(panel.getByLabel('I restored a separate backup of all four source roots.')).toBeDisabled();
  await expect(panel.getByLabel('I backed up the local settings encryption key separately.')).toBeDisabled();
  await expect(copy).toBeDisabled();
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  await expect(copy).toBeDisabled();
  await expect(panel.getByRole('alert').filter({ hasText: 'Copying is blocked' })).toBeVisible();
  await expect(panel.getByRole('alert')).toContainText('restore its original key; do not generate a replacement');
  await expect(panel.getByRole('button', { name: 'Resume unchanged legacy', exact: true })).toBeEnabled();
  copyConfigurationReady = true;
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(panel.getByRole('alert')).toContainText('No copy was started.');
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeDisabled();
  await copy.click();
  expect(copyRequests).toBe(2);
  await panel.getByRole('button', { name: 'Activate SQLite while paused' }).click();
  await expect(panel.getByRole('button', { name: 'Validate selected runtime' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Return to legacy while paused' })).toBeEnabled();
  backend = 'sqlite';
  restartRequired = false;
  await open();
  await panel.getByRole('button', { name: 'Validate selected runtime' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'SQLite runtime validation passed.' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resume writes', exact: true })).toBeDisabled();
  await panel.getByLabel('I reviewed the selected backend and its write-resumption recovery boundary.').check();
  await panel.getByRole('button', { name: 'Resume writes', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Return to legacy while paused' })).toHaveCount(0);
  expect(actions).toEqual(['activate', 'validate', 'resume']);
});

for (const backend of ['sqlite', 'legacy'] as const) {
  test(`${backend} validation shows progress, failure and durable success without automatically resuming`, async ({
    page,
  }, testInfo) => {
    let generationId = 'validation-fixture',
      revision = 1,
      validated = false,
      authorized = true,
      delayValidation = true,
      validationSucceeds = false;
    let releaseValidation: (() => void) | undefined;
    const actions: string[] = [];
    await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
      if (!authorized) return route.fulfill({ status: 403, json: { error: 'Forbidden' } });
      if (new URL(route.request().url()).pathname.endsWith('/action')) {
        const action = route.request().postDataJSON();
        actions.push(action.action);
        expect(action.action).toBe('validate');
        expect(action.revision).toBe(revision);
        if (delayValidation) {
          await new Promise<void>((resolve) => {
            releaseValidation = resolve;
          });
          delayValidation = false;
        }
        if (!validationSucceeds)
          return route.fulfill({ status: 409, json: { error: 'Selected runtime could not be validated.' } });
        validated = true;
        revision++;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        json: {
          available: true,
          copyConfigurationReady: true,
          runningBackend: backend,
          maintenance: { enteredAt: '2026-09-28T00:00:00Z' },
          drain: { ready: true, blockers: [] },
          restartRequired: false,
          transition: {
            revision,
            phase: `${backend}-validation`,
            backend,
            generationId,
            canReturnToLegacy: backend === 'sqlite',
            validated,
          },
          job: null,
        },
      });
    });
    const open = async () => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await openSettings(page);
      await page
        .getByTestId('app-settings-modal')
        .getByRole('tab', { name: 'Local storage upgrade', exact: true })
        .click();
    };
    await open();
    const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
    const validate = panel.getByRole('button', { name: 'Validate selected runtime', exact: true });
    const resume = panel.getByRole('button', { name: 'Resume writes', exact: true });
    const acknowledgement = panel.getByLabel(
      'I reviewed the selected backend and its write-resumption recovery boundary.',
    );
    const success = panel.getByRole('status').filter({ hasText: 'runtime validation passed.' });
    const failure = panel.getByRole('alert').filter({ hasText: 'Runtime validation failed:' });
    await expect(panel.getByRole('status').filter({ hasText: 'Runtime validation has not passed yet.' })).toBeVisible();
    await validate.click();
    await expect(panel.getByRole('status').filter({ hasText: 'Validating the selected runtime.' })).toBeVisible();
    await expect(validate).toBeDisabled();
    await expect(resume).toBeDisabled();
    await expect.poll(() => typeof releaseValidation).toBe('function');
    releaseValidation!();
    await expect(failure).toContainText('Selected runtime could not be validated.');
    await expect(success).toHaveCount(0);
    await expect(resume).toBeDisabled();
    validationSucceeds = true;
    await validate.click();
    await expect(failure).toHaveCount(0);
    await expect(success).toContainText(
      `${backend === 'sqlite' ? 'SQLite' : 'Legacy'} runtime validation passed. Writes remain paused.`,
    );
    await expect(acknowledgement).not.toBeChecked();
    await expect(resume).toBeDisabled();
    const screenshot = testInfo.outputPath(`${backend}-validation-passed.png`);
    await success.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Visible validation result', { path: screenshot, contentType: 'image/png' });
    await open();
    await expect(success).toBeVisible();
    await expect(acknowledgement).not.toBeChecked();
    await acknowledgement.check();
    await expect(resume).toBeEnabled();
    // A failed revalidation must not display the earlier durable success or
    // preserve a checked acknowledgement that could immediately resume writes.
    validationSucceeds = false;
    await validate.click();
    await expect(failure).toBeVisible();
    await expect(success).toHaveCount(0);
    await expect(acknowledgement).not.toBeChecked();
    await expect(acknowledgement).toBeDisabled();
    await expect(resume).toBeDisabled();
    generationId = 'different-generation';
    revision++;
    validated = false;
    await expect(failure).toHaveCount(0);
    await expect(success).toHaveCount(0);
    await expect(panel.getByRole('status').filter({ hasText: 'Runtime validation has not passed yet.' })).toBeVisible();
    authorized = false;
    await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toBeVisible();
    await expect(success).toHaveCount(0);
    await expect(validate).toBeDisabled();
    expect(actions).toEqual(['validate', 'validate', 'validate']);
  });
}

test('local upgrade controls fail closed when the operator session is unauthorized', async ({ page }) => {
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({ status: 403, json: { error: 'Forbidden' } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  await expect(panel.getByRole('button', { name: 'Copy and verify' })).toBeDisabled();
  await expect(panel.getByLabel('Backup reference', { exact: true })).toHaveCount(0);
});

test('capacity refusal blocks retries while a redacted failed-job report remains downloadable', async ({ page }) => {
  const job = {
    id: 'failed-fixture',
    phase: 'failed',
    sourceFingerprint: 'a'.repeat(64),
    backupReference: 'restored-fixture',
    stage: 'settings',
    message: 'Copy failed safely. Legacy data remains selected.',
    failure: { stage: 'settings', code: 'disk-full' },
  };
  let paused = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/inventory'))
      return route.fulfill({
        json: {
          source: { workflows: '/workflows' },
          inventory: null,
          capacity: {
            payloadBytes: 1024,
            freeBytes: 0,
            requiredBytes: 100,
            maxPayloadBytes: 128_000_000,
            fits: false,
            estimatedWorkingBytes: 67_108_864,
            memoryBudgetBytes: 1,
            measurementComplete: false,
            reasons: ['disk-space', 'memory-headroom'],
          },
          backupRequired: 'Restore a separate backup.',
        },
      });
    if (pathname.endsWith('/pause')) {
      paused = true;
      return route.fulfill({ status: 204 });
    }
    if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: 'a'.repeat(64) } });
    if (pathname.endsWith('/report')) return route.fulfill({ json: { verified: false, job } });
    if (pathname.endsWith('/copy')) throw new Error('Capacity refusal must prevent the browser from starting a retry.');
    return route.fulfill({
      json: {
        available: true,
        runningBackend: 'legacy',
        restartRequired: false,
        maintenance: paused ? { enteredAt: '2026-09-28T00:00:00Z' } : null,
        drain: paused ? { ready: true, blockers: [] } : null,
        transition: {
          revision: 1,
          phase: 'legacy',
          backend: 'legacy',
          generationId: 'older-returned-generation',
          canReturnToLegacy: false,
          validated: false,
        },
        job,
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  await expect(panel.getByText(/Failure: disk-full at settings/)).toBeVisible();
  await panel.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(panel.getByText('Source inventory was not loaded because capacity preflight failed.')).toBeVisible();
  await expect(panel.getByText(/Blocking checks: disk-space, memory-headroom/)).toBeVisible();
  await expect(panel.getByText(/Payload size is a lower bound/)).toBeVisible();
  await panel.getByRole('button', { name: 'Pause writes and drain' }).click();
  await panel.getByRole('button', { name: 'Read frozen source fingerprint' }).click();
  await panel.getByLabel('Backup reference', { exact: true }).fill('restored-fixture');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill('a'.repeat(64));
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  await expect(panel.getByRole('button', { name: 'Retry copy and verification', exact: true })).toBeDisabled();
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download verification report' }).click();
  expect((await download).suggestedFilename()).toBe('rivet-local-upgrade-failed-fixture.json');
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeDisabled();
});

test('older-server synchronous copy capacity refusal remains actionable without implying a failed copy job', async ({
  page,
}) => {
  const message =
    'Local copy capacity preflight failed (disk-space). Available disk: 0 MiB; estimated additional disk required: 64 MiB. Reload source inspection for disk, bundle and memory details. No copy was started.';
  const fingerprint = 'a'.repeat(64);
  let paused = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/inventory')) return route.fulfill({ json: inventoryFixture });
    if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    if (pathname.endsWith('/copy'))
      return route.fulfill({ status: 409, json: { code: 'local-copy-capacity', error: message } });
    if (pathname.endsWith('/pause')) {
      paused = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: upgradeStatusFixture({ pausedAt: paused ? '2026-09-28T00:00:00Z' : null }) });
  });
  const panel = await openLocalUpgrade(page);
  await panel.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await panel.getByRole('button', { name: 'Pause writes and drain' }).click();
  await panel.getByRole('button', { name: 'Read frozen source fingerprint' }).click();
  await panel.getByLabel('Backup reference', { exact: true }).fill('restored-fixture');
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  await panel.getByRole('button', { name: 'Copy and verify', exact: true }).click();
  await expect(panel.getByRole('alert').filter({ hasText: message })).toBeVisible();
  await expect(panel.getByText('Source is quiet. Take and restore your backup before copying.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Download verification report' })).toBeDisabled();
});

test('background copy preparation stays busy after acceptance and shows a specific failed-project diagnostic', async ({
  page,
}) => {
  const fingerprint = 'a'.repeat(64),
    reference = '0123456789abcdef',
    backupReference = 'restored-fixture';
  let paused = false,
    started = false,
    failed = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/inventory')) return route.fulfill({ json: inventoryFixture });
    if (pathname.endsWith('/fingerprint')) return route.fulfill({ json: { sourceFingerprint: fingerprint } });
    if (pathname.endsWith('/project-reference'))
      return route.fulfill({ json: { reference, paths: ['Test/problem.rivet-project'] } });
    if (pathname.endsWith('/pause')) {
      paused = true;
      return route.fulfill({ status: 204 });
    }
    if (pathname.endsWith('/copy')) {
      expect(route.request().postDataJSON()).toMatchObject({
        backupSourceFingerprint: fingerprint,
        backupReference,
        backupRestored: true,
      });
      started = true;
      return route.fulfill({ status: 202, json: { started: true } });
    }
    return route.fulfill({
      json: {
        ...upgradeStatusFixture({
          pausedAt: paused ? '2026-09-28T00:00:00Z' : null,
          operation: started && !failed ? 'copy' : null,
        }),
        job: started
          ? {
              id: 'background-fixture',
              phase: failed ? 'failed' : 'copying',
              sourceFingerprint: fingerprint,
              backupReference,
              stage: failed ? 'workflows' : 'capacity',
              message: 'Legacy source is untouched and writes remain paused.',
              failure: failed
                ? {
                    stage: 'workflows',
                    code: 'invalid-data',
                    reason: 'project-id-duplicate',
                    sourceReference: reference,
                  }
                : null,
            }
          : null,
      },
    });
  });
  const panel = await openLocalUpgrade(page);
  await panel.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await panel.getByRole('button', { name: 'Pause writes and drain' }).click();
  await panel.getByRole('button', { name: 'Read frozen source fingerprint' }).click();
  await panel.getByLabel('Backup reference', { exact: true }).fill(backupReference);
  await panel.getByLabel('Restored backup fingerprint', { exact: true }).fill(fingerprint);
  await panel.getByLabel('I restored a separate backup of all four source roots.').check();
  await panel.getByLabel('I backed up the local settings encryption key separately.').check();
  await panel.getByRole('button', { name: 'Copy and verify', exact: true }).click();
  await expect(panel.getByText(/Copy status: copying. Stage: capacity/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy and verify', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeDisabled();
  failed = true;
  await expect(panel.getByText(/Two source projects have the same project ID/)).toBeVisible();
  await expect(panel.getByText(/Affected project: Test\/problem.rivet-project/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Retry copy and verification', exact: true })).toBeEnabled();
});

test('preparation diagnostics identify the current conflict without relabeling an older failed copy', async ({
  page,
}) => {
  await mockHostedEditorBootstrap(page);
  const preparationReference = '0123456789abcdef',
    copyReference = 'fedcba9876543210';
  const lookups: string[] = [];
  let preparationRevision = 1;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/project-reference')) {
      const reference = url.searchParams.get('reference')!;
      lookups.push(reference);
      return route.fulfill({
        json: {
          reference,
          paths: [reference === preparationReference ? 'New/conflict.rivet-project' : 'Old/copy.rivet-project'],
        },
      });
    }
    return route.fulfill({
      json: {
        ...upgradeStatusFixture(),
        preparationJobsAvailable: true,
        preparation: {
          id: '9c88b867-f67b-4f0d-bf3f-1d9984690d5e',
          kind: 'inspect',
          revision: preparationRevision,
          phase: 'failed',
          stage: 'inspect',
          error: 'Local storage preparation failed.',
          failure: {
            reason: 'publication-route-conflict',
            code: 'invalid-data',
            sourceReference: preparationReference,
          },
        },
        job: {
          id: 'old-copy',
          phase: 'failed',
          stage: 'workflows',
          message: 'Older copy failed.',
          failure: { stage: 'workflows', code: 'invalid-data', sourceReference: copyReference },
        },
      },
    });
  });
  const panel = await openLocalUpgrade(page);
  const failure = panel.getByRole('alert').filter({ hasText: 'Local storage preparation failed.' });
  await expect(failure).toContainText('Projects have conflicting endpoint names or web-app slugs.');
  await expect(failure).toContainText('Affected project: New/conflict.rivet-project.');
  const oldCopy = panel.getByRole('status').filter({ hasText: 'Older copy failed.' });
  await expect(oldCopy).not.toContainText('New/conflict.rivet-project');
  expect(lookups).toEqual([preparationReference]);
  // A preparation from a different authority revision cannot displace current diagnostics.
  preparationRevision = 0;
  await expect(failure).toHaveCount(0);
  await expect(oldCopy).toContainText('Affected project: Old/copy.rivet-project.');
  expect(lookups).toEqual([preparationReference, copyReference]);
  await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeDisabled();
});

test('Settings recovery controls remain reachable when the editor never becomes ready', async ({ page }) => {
  await page.route('**/?editor', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>Paused editor fixture</body></html>' }),
  );
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: { available: false, runningBackend: 'legacy', maintenance: null, transition: null, job: null, drain: null },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await expect(page.locator('.dashboard-main .dashboard-app-loading')).toBeVisible();
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true })).toBeVisible();
});

test('expired operator status locks previously enabled controls and reconnect clears only the connection error', async ({
  page,
}) => {
  let authorized = true;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/inventory'))
      return route.fulfill({ status: 409, json: { error: 'Inspect fixture requires repair.' } });
    if (!authorized) return route.fulfill({ status: 403, json: { error: 'Forbidden' } });
    return route.fulfill({
      json: {
        available: true,
        runningBackend: 'legacy',
        maintenance: null,
        drain: null,
        restartRequired: false,
        transition: {
          revision: 1,
          phase: 'legacy',
          backend: 'legacy',
          generationId: null,
          canReturnToLegacy: false,
          validated: false,
        },
        job: null,
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  const inspect = panel.getByRole('button', { name: 'Inspect source', exact: true });
  await expect(inspect).toBeEnabled();
  await inspect.click();
  await expect(panel.getByRole('alert')).toContainText('Inspect fixture requires repair.');
  authorized = false;
  await expect(inspect).toBeDisabled();
  await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toBeVisible();
  authorized = true;
  await expect(inspect).toBeEnabled();
  await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toHaveCount(0);
  await expect(panel.getByRole('alert')).toContainText('Inspect fixture requires repair.');
});

test('a stalled status poll locks controls and recovery preserves a rejected pause error', async ({ page }) => {
  let stallStatus = false;
  await page.route(/\/api\/app-settings\/local-upgrade(?:$|\/(?!setup(?:$|\?)))/, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/inventory'))
      return route.fulfill({
        json: {
          source: {},
          inventory: {
            projects: 1,
            folders: 0,
            recordingBundles: 0,
            publishedVersions: 0,
            publishedWebApps: 0,
            warnings: [],
          },
          backupRequired: 'Restore a separate backup.',
        },
      });
    if (pathname.endsWith('/pause'))
      return route.fulfill({ status: 403, json: { error: 'Migration request origin does not match this server.' } });
    // Deliberately leave this read unanswered. The browser's request deadline,
    // not a mock network error, must invalidate the last successful status.
    if (stallStatus) return;
    return route.fulfill({
      json: {
        available: true,
        runningBackend: 'legacy',
        maintenance: null,
        drain: null,
        restartRequired: false,
        transition: {
          revision: 1,
          phase: 'legacy',
          backend: 'legacy',
          generationId: null,
          canReturnToLegacy: false,
          validated: false,
        },
        job: null,
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  const inspect = panel.getByRole('button', { name: 'Inspect source', exact: true });
  const pause = panel.getByRole('button', { name: 'Pause writes and drain', exact: true });
  await inspect.click();
  await pause.click();
  const actionError = panel.getByRole('alert').filter({ hasText: 'origin does not match' });
  await expect(actionError).toBeVisible();
  const stalledRequest = page.waitForRequest(
    (request) => request.url().endsWith('/local-upgrade') && request.method() === 'GET',
  );
  stallStatus = true;
  await stalledRequest;
  await expect(inspect).toBeDisabled({ timeout: 15_000 });
  await expect(pause).toBeDisabled();
  await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toBeVisible();
  stallStatus = false;
  await expect(inspect).toBeEnabled();
  await expect(pause).toBeEnabled();
  await expect(panel.getByRole('alert').filter({ hasText: 'controls stay locked' })).toHaveCount(0);
  await expect(actionError).toBeVisible();
});

test('resumption acknowledgement belongs to the currently validated generation and revision', async ({ page }) => {
  let generationId = 'first-generation',
    revision = 1,
    validated = false;
  await page.route('**/api/app-settings/local-upgrade', (route) =>
    route.fulfill({
      json: {
        available: true,
        runningBackend: 'sqlite',
        maintenance: { enteredAt: '2026-09-28T00:00:00Z' },
        drain: { ready: true, blockers: [] },
        restartRequired: false,
        transition: {
          revision,
          phase: 'sqlite-validation',
          backend: 'sqlite',
          generationId,
          canReturnToLegacy: true,
          validated,
        },
        job: null,
      },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await openSettings(page);
  await page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  const acknowledgement = panel.getByLabel(
    'I reviewed the selected backend and its write-resumption recovery boundary.',
  );
  const resume = panel.getByRole('button', { name: 'Resume writes', exact: true });
  await expect(acknowledgement).toBeDisabled();
  await expect(resume).toBeDisabled();
  validated = true;
  revision++;
  await expect(acknowledgement).toBeEnabled();
  await acknowledgement.check();
  await expect(resume).toBeEnabled();
  revision++;
  await expect(acknowledgement).not.toBeChecked();
  await expect(resume).toBeDisabled();
  await acknowledgement.check();
  await expect(resume).toBeEnabled();
  generationId = 'replacement-generation';
  await expect(acknowledgement).not.toBeChecked();
  await expect(resume).toBeDisabled();
  validated = false;
  revision++;
  await expect(acknowledgement).toBeDisabled();
});
