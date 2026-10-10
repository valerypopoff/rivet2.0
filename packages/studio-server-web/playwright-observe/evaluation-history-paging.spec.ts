import { expect, test } from '@playwright/test';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

for (const scenario of [
  'retryable initial read',
  'superseded initial read',
  'superseded older page',
  'superseded older page failure',
] as const) {
  const supersedeInitialDetails = scenario === 'superseded initial read';
  const supersedeOlderPage = scenario.startsWith('superseded older page');
  test(`Evaluation history pages headers and hydrates only the selected run (${scenario})`, async ({ page }) => {
    await mockHostedEditorBootstrap(page);
    await seedHostedEditorProject(page, {
      graphId: 'main',
      loaded: true,
      projectId: 'history-project',
      projectPath: '/workflows/History.rivet-project',
      title: 'History',
    });
    const suite = {
      id: 'suite',
      name: 'History suite',
      targetGraphId: 'main',
      datasetId: 'dataset',
      inputBindings: [],
      assertions: [],
      evaluators: [],
    };
    await page.route('**/api/workflows/evaluation-runs/library', (route) =>
      route.fulfill({
        json: {
          revision: 1,
          resourceVersions: { suites: { suite: 1 }, datasets: { dataset: 1 } },
          library: {
            version: 1,
            data: { version: 1, suites: [suite], baselines: [] },
            datasets: [{ id: 'dataset', name: 'History dataset', fields: [], cases: [] }],
            migratedLegacyProjectIds: [],
          },
        },
      }),
    );
    const run = (id: string) => ({
      version: 2,
      id,
      projectId: 'history-project',
      suiteId: 'suite',
      suiteName: 'History suite',
      name: id,
      startedAt: '2026-10-08T00:00:00.000Z',
      purpose: 'execution-benchmark',
      executionStatus: 'completed',
      qualityStatus: 'not-evaluated',
      qualityReason: { code: 'execution-benchmark', message: 'Benchmark' },
      accountingStatus: 'complete',
      provenance: {
        projectFingerprint: 'project',
        suiteFingerprint: 'suite',
        datasetFingerprint: 'dataset',
        targetFingerprint: 'target',
        evaluatorFingerprints: {},
        executionMode: 'test',
        accountingComplete: true,
      },
      trials: [],
      thresholdResults: [],
      warnings: [`Detail evidence for ${id}`],
    });
    const header = (id: string) => {
      const { trials, thresholdResults, warnings, provenance, ...summary } = run(id);
      return summary;
    };
    const details: string[] = [];
    let newestAttempts = 0;
    let releaseInitialDetails!: () => void;
    const initialDetails = new Promise<void>((resolve) => (releaseInitialDetails = resolve));
    let olderAttempts = 0;
    let olderPages = 0;
    let releaseOlderPage!: () => void;
    const pendingOlderPage = new Promise<void>((resolve) => (releaseOlderPage = resolve));
    let fullLists = 0;
    await page.route('**/api/workflows/evaluation-runs?*', (route) => {
      fullLists++;
      return route.fulfill({ json: [] });
    });
    await page.route('**/api/workflows/evaluation-runs/history?*', async (route) => {
      if (new URL(route.request().url()).searchParams.has('after')) {
        if (++olderPages === 1 && supersedeOlderPage) {
          await pendingOlderPage;
          if (scenario === 'superseded older page failure')
            return route.fulfill({ status: 503, json: { error: 'Obsolete page failure' } });
          return route.fulfill({ json: { runs: [header('Stale')], nextCursor: 'stale-page' } });
        }
        return route.fulfill({ json: { runs: [header('Older')] } });
      }
      return route.fulfill({
        json: {
          runs: [header('Newest'), header('Previous'), { ...header('Foreign'), projectId: 'another-project' }],
          nextCursor: 'older-page',
        },
      });
    });
    await page.route('**/api/workflows/evaluation-runs/*?*', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
      if (id === 'history') return route.fallback();
      details.push(id);
      if (id === 'Newest' && ++newestAttempts === 1) {
        await initialDetails;
        return route.fulfill({ status: 503, json: { error: 'Initial detail failure' } });
      }
      if (id === 'Older' && ++olderAttempts === 1)
        return route.fulfill({ status: 503, json: { error: 'Temporary detail failure' } });
      return route.fulfill({ json: run(id) });
    });
    await page.goto('/?editor');
    await page
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('button', { name: 'Evaluations' })
      .click();
    await page
      .getByRole('button', { name: /^History suite(?: Main Graph)?$/ })
      .last()
      .click();
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    // Compact history must be usable even while the initial body is pending.
    await expect(page.getByText('Loading selected run…', { exact: true })).toBeVisible();
    await page.getByRole('combobox').last().click();
    await expect(page.getByText(/^Previous ·/)).toBeVisible();
    await expect(page.getByText(/^Foreign ·/)).toHaveCount(0);
    if (supersedeInitialDetails) {
      await page.getByText(/^Previous ·/).click();
      await expect(page.getByText('Detail evidence for Previous', { exact: true })).toBeVisible();
      releaseInitialDetails();
      await expect(page.getByText('Initial detail failure', { exact: true })).toHaveCount(0);
      await page.getByRole('combobox').last().click();
      await page.getByText(/^Newest ·/).click();
    } else {
      await page.keyboard.press('Escape');
      releaseInitialDetails();
      await expect(page.getByText('Initial detail failure', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Retry loading run' }).click();
    }
    await expect(page.getByText('Detail evidence for Newest', { exact: true })).toBeVisible();
    const initialRequests = supersedeInitialDetails ? ['Newest', 'Previous', 'Newest'] : ['Newest', 'Newest'];
    expect(details).toEqual(initialRequests);
    if (supersedeOlderPage) {
      await page.getByRole('button', { name: 'Load older runs' }).click();
      await expect.poll(() => olderPages).toBe(1);
      const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
      await navigation.getByRole('button', { name: 'Data Studio' }).click();
      await navigation.getByRole('button', { name: 'Evaluations' }).click();
    }
    await page.getByRole('button', { name: 'Load older runs' }).click();
    await expect(page.getByRole('button', { name: 'Load older runs' })).toHaveCount(0);
    if (supersedeOlderPage) {
      const response = page.waitForResponse((result) => {
        const url = new URL(result.url());
        return url.pathname.endsWith('/evaluation-runs/history') && url.searchParams.has('after');
      });
      releaseOlderPage();
      await (await response).finished();
      // The abandoned component must not replace the reopened panel's cursor
      // or inject obsolete headers after its request eventually finishes.
      await page.getByRole('combobox').last().click();
      await expect(page.getByText(/^Stale ·/)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Load older runs' })).toHaveCount(0);
      await expect(page.getByText('Obsolete page failure', { exact: true })).toHaveCount(0);
    }
    expect(details).toEqual(initialRequests);
    await page.getByRole('combobox').last().click();
    await page.getByText(/^Older ·/).click();
    await expect(page.getByText('Temporary detail failure', { exact: true })).toBeVisible();
    await expect(page.getByText('Detail evidence for Newest', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry loading run' }).click();
    await expect(page.getByText('Detail evidence for Older', { exact: true })).toBeVisible();
    expect(details).toEqual([...initialRequests, 'Older', 'Older']);
    expect(fullLists).toBe(0);
  });
}
