import { expect, test } from '@playwright/test';
import { serializeProject, TextNodeImpl, type GraphId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import {
  saveHaBrowserProject,
  selectHaBrowserRecordingWorkflow,
} from '../../../deploy/studio-server/scripts/lib/ha-browser-probe.mjs';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('HA retained browser can still save through the legacy sidebar', async ({ page }) => {
  await page.setContent('<button class="active-project-save-button" onclick="this.remove()">Save</button>');
  await saveHaBrowserProject(page, 'Legacy project', expect);
  await expect(page.locator('.active-project-save-button')).toHaveCount(0);
});

test('HA browser saves a real retained edit through the current project menu and closes the overlay', async ({
  page,
}) => {
  const name = 'HA retained project';
  const path = `/workflows/${name}.rivet-project`;
  const graphId = 'ha-save-graph' as GraphId;
  const node = TextNodeImpl.create();
  node.title = 'Retained text';
  node.data.text = 'retained content';
  node.visualData = { x: 100, y: 100, width: 250 };
  const project: Project = {
    metadata: { id: 'ha-save-project' as ProjectId, title: name, description: '', mainGraphId: graphId },
    graphs: {
      [graphId]: { metadata: { id: graphId, name: 'Main Graph', description: '' }, nodes: [node], connections: [] },
    },
  };
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({
      json: { contents: serializeProject(project), datasetsContents: null, revisionId: 'ha-open-revision' },
    }),
  );
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        folders: [],
        sync: { epoch: 'ha-save', revision: 0 },
        projects: [
          {
            id: 'ha-save-project',
            name,
            fileName: `${name}.rivet-project`,
            relativePath: `${name}.rivet-project`,
            absolutePath: path,
            updatedAt: '',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          },
        ],
      },
    }),
  );
  const saved: string[] = [];
  await page.route('**/api/projects/save', (route) => {
    const body = route.request().postDataJSON() as { path: string; contents: string };
    expect(body.path).toBe(path);
    saved.push(body.contents);
    return route.fulfill({ json: { path, revisionId: 'ha-save-revision' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row').filter({ hasText: name }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const title = editor.locator(`.node[data-nodeid="${node.id}"] .node-title`);
  await expect(title).toBeVisible();
  const box = (await title.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  const dirty = editor.locator('.projects-container .project.active.has-unsaved-changes');
  await expect(dirty).toBeVisible();
  await expect(page.locator('.active-project-save-button')).toHaveCount(0);
  await saveHaBrowserProject(page, name, expect);
  await expect(dirty).toHaveCount(0);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toContain('retained content');
  await expect(page.locator('.workflow-project-context-menu-with-summary')).toBeHidden();
  await title.click(); // A forgotten overlay must not intercept subsequent editor actions.
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`HA browser proof finds its ${status} recording beyond the global first page`, async ({ page }) => {
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/workflows',
          folders: [],
          projects: [],
          sync: { epoch: 'ha-recording-selection', revision: 0 },
        },
      }),
    );
    const project = (id: string, name: string) => ({
      id,
      name,
      fileName: `${name}.rivet-project`,
      relativePath: `${name}.rivet-project`,
      absolutePath: `/workflows/${name}.rivet-project`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    });
    const run = (id: string, workflowId: string, createdAt: string) => ({
      id,
      workflowId,
      createdAt,
      runKind: 'editor',
      status,
      durationMs: 1,
      endpointNameAtExecution: '',
      hasReplayDataset: false,
      recordingCompressedBytes: 1,
      recordingUncompressedBytes: 1,
      projectCompressedBytes: 1,
      projectUncompressedBytes: 1,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
    });
    const owned = [run('owned-recording', 'owned', '2026-01-01T00:00:00.000Z')];
    const traffic = Array.from({ length: 120 }, (_, i) => run(`traffic-${i}`, 'traffic', '2026-02-01T00:00:00.000Z'));
    const name = 'Owned browser fixture';
    await page.route(/\/api\/workflows\/recordings\/workflows(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          workflows: [
            {
              workflowId: 'owned',
              project: project('owned', name),
              totalRuns: 1,
              failedRuns: status === 'failed' ? 1 : 0,
              suspiciousRuns: 0,
            },
            {
              workflowId: 'traffic',
              project: project('traffic', `${name} traffic`),
              totalRuns: traffic.length,
              failedRuns: status === 'failed' ? traffic.length : 0,
              suspiciousRuns: 0,
            },
          ],
          totals: { totalRuns: 121, failedRuns: status === 'failed' ? 121 : 0, suspiciousRuns: 0 },
        },
      }),
    );
    const requests: string[] = [];
    await page.route(/\/api\/workflows\/recordings\/(?:workflows\/owned\/)?runs\?/, (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      const scoped = url.pathname.includes('/workflows/owned/');
      const rows = scoped ? owned : [...traffic, ...owned];
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      return route.fulfill({
        json: {
          workflowId: scoped ? 'owned' : '',
          page: 1,
          pageSize,
          totalRuns: rows.length,
          totalRunsExact: true,
          hasMore: rows.length > pageSize,
          statusFilter: 'all',
          runs: rows.slice(0, pageSize),
        },
      });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal.locator('[data-recording-id="traffic-0"]')).toBeVisible();
    await expect(modal.locator('[data-recording-id="owned-recording"]')).toHaveCount(0);
    await selectHaBrowserRecordingWorkflow(page, name, expect);
    await expect(modal.locator('[data-recording-id="owned-recording"]')).toBeVisible();
    await expect(modal.locator('[data-recording-id="traffic-0"]')).toHaveCount(0);
    expect(requests).toContain('/api/workflows/recordings/workflows/owned/runs');
  });
}
