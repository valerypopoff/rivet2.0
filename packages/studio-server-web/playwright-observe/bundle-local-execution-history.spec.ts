import { expect, test } from '@playwright/test';
import { GraphOutputNodeImpl, serializeProject, type PortId } from '@valerypopoff/rivet2-core';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('hosted bundle dependencies show repeated calls only within the newest editor run', async ({ page }) => {
  const fixture = projectBundleFixture();
  const a = fixture.root.project,
    b = fixture.child.project;
  const graph = a.graphs[a.metadata.mainGraphId!]!,
    child = b.graphs[b.metadata.mainGraphId!]!;
  const call = graph.nodes.find((node) => node.type === 'subGraph')!;
  const second = { ...structuredClone(call), id: 'second-call' as typeof call.id };
  const secondOutput = GraphOutputNodeImpl.create();
  secondOutput.data.id = 'second';
  graph.nodes.push(second, secondOutput);
  graph.connections.push({
    outputNodeId: second.id,
    outputId: 'result' as PortId,
    inputNodeId: secondOutput.id,
    inputId: 'value' as PortId,
  });
  for (const [index, node] of graph.nodes.entries()) node.visualData = { x: 100 + index * 280, y: 200, width: 250 };
  const childOutput = child.nodes.find((node) => node.type === 'graphOutput')!;
  const text = child.nodes.find((node) => node.type === 'text')!;
  let executionReads = 0;
  let run = 0;
  const items = [a, b].map((project) => ({
    id: project.metadata.id,
    projectMetadataId: project.metadata.id,
    bundleId: '58019223-bd4e-49c3-a042-321215efaa35',
    name: project.metadata.title,
    fileName: `${project.metadata.title}.rivet-project`,
    relativePath: `${project.metadata.title}.rivet-project`,
    absolutePath: `/workflows/${project.metadata.title}.rivet-project`,
    updatedAt: '2026-10-28T00:00:00Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  }));
  await page.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: 'Isolated history fixture' } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname === '/api/workflows/tree')
        return route.fulfill({
          json: { root: '/workflows', projects: items, folders: [], sync: { epoch: 'history-fixture', revision: 0 } },
        });
      if (url.pathname === '/api/projects/load') {
        const index = items.findIndex((item) => item.absolutePath === request.postDataJSON().path);
        expect(index).toBeGreaterThanOrEqual(0);
        return route.fulfill({
          json: { contents: serializeProject([a, b][index]!), datasetsContents: null, revisionId: null },
        });
      }
      if (url.pathname === `/api/workflows/subgraph-projects/${b.metadata.id}/preview`)
        return route.fulfill({ json: { project: b } });
      if (url.pathname === `/api/workflows/subgraph-projects/${b.metadata.id}/access`) {
        expect(url.searchParams.get('callerProjectId')).toBe(a.metadata.id);
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === `/api/workflows/subgraph-projects/${b.metadata.id}/execution`) {
        expect(url.searchParams.get('callerProjectId')).toBe(a.metadata.id);
        executionReads++;
        (text.data as { text: string }).text = `child-run-${run}`;
        return route.fulfill({ json: { projectContents: serializeProject(b), revisionKey: `child-revision-${run}` } });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    },
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const tab = (title: string) =>
    editor.locator('.projects-container .project:not(.opening)').filter({ hasText: title });
  for (const item of [items[1]!, items[0]!]) {
    await page.locator('.project-row').filter({ hasText: item.name }).dblclick();
    await expect(tab(item.name)).toHaveClass(/active/, { timeout: 90_000 });
  }
  for (run = 1; run <= 3; run++) {
    await tab(a.metadata.title).click();
    const before = executionReads;
    await editor.locator('.run-button button').first().click();
    await expect.poll(() => executionReads).toBeGreaterThan(before);
    const rootOutput = graph.nodes.find((node) => node.type === 'graphOutput')!;
    await expect(editor.locator(`.node[data-nodeid="${rootOutput.id}"]`)).toContainText(`child-run-${run}`);
    await expect(editor.locator('.run-button button').first()).not.toContainText('Abort');
    await tab(b.metadata.title).click();
    await expect(editor.locator(`.node[data-nodeid="${childOutput.id}"]`)).toContainText(`child-run-${run}`);
    await expect(editor.getByText('Execution: 2/2', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Previous execution (all nodes)', exact: true }).click();
    await expect(editor.getByText('Execution: 1/2', { exact: true })).toBeVisible();
    await expect(editor.locator(`.node[data-nodeid="${childOutput.id}"]`)).toContainText(`child-run-${run}`);
  }
  await expect(editor.locator('.Toastify__toast--error')).toHaveCount(0);
});
