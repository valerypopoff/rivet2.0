import { expect, test } from '@playwright/test';
import { startHostedSubgraphRuntime } from '../../studio-server-api/src/tests/helpers/hosted-subgraph-runtime';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.use({ actionTimeout: 20_000 });

for (const topology of ['single-host', 'replicated'] as const) {
  test(`hosted Node (${topology}) executes same-bundle targets with the real UI gate and live cached-target policy`, async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    const runtime = await startHostedSubgraphRuntime(topology);
    try {
      const { caller, target } = runtime.fixture;
      const executorEvents: Array<{
        message: string;
        data?: { node?: { id: string }; execution?: { projectId?: string } };
      }> = [];
      page.on('websocket', (socket) => {
        if (socket.url() !== runtime.executorWsUrl) return;
        socket.on('framereceived', ({ payload }) => executorEvents.push(JSON.parse(payload.toString())));
      });
      const freshEvents = (since: number) =>
        executorEvents.slice(since).filter((event) => event.data?.execution?.projectId === caller.projectMetadataId);
      const accessPath = `/api/workflows/subgraph-projects/${target.projectMetadataId}/access?version=latest&callerProjectId=${caller.projectMetadataId}`;
      // No operator session or trusted IP: the exact service route alone is allowed.
      expect((await fetch(runtime.baseUrl + accessPath, { headers: runtime.serviceHeaders })).status).toBe(204);
      for (const headers of [
        {},
        { ...runtime.serviceHeaders, 'x-rivet-proxy-auth': 'wrong' },
        { 'x-rivet-executor-auth': runtime.serviceHeaders['x-rivet-executor-auth'] },
      ] as Record<string, string>[]) {
        expect(
          (await fetch(runtime.baseUrl + accessPath, { headers })).status,
          'the fixture must not repair missing or wrong proxy credentials',
        ).toBe(403);
      }
      expect(
        (
          await fetch(runtime.baseUrl + accessPath, {
            headers: { 'x-rivet-proxy-auth': runtime.serviceHeaders['x-rivet-proxy-auth'] },
          })
        ).status,
      ).toBe(403);
      expect((await fetch(runtime.baseUrl + '/api/workflows/tree', { headers: runtime.serviceHeaders })).status).toBe(
        403,
      );
      const missingCaller = await fetch(runtime.baseUrl + accessPath.split('&callerProjectId=')[0], {
        headers: runtime.serviceHeaders,
      });
      expect(missingCaller.status).toBe(403);
      expect((await missingCaller.json()).code).toBe('subgraph_bundle_scope_forbidden');
      const absent = await fetch(runtime.baseUrl + '/api/workflows/subgraph-projects/absent/access?version=latest', {
        headers: runtime.serviceHeaders,
      });
      expect(absent.status).toBe(404);

      await context.addCookies([runtime.cookie]);
      await page.addInitScript(() =>
        localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'nodejs', recordExecutions: false })),
      );
      // Browser requests go to the test-owned real API as an operator. The hosted
      // Node process is outside Playwright interception and sends only service auth.
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const original = new URL(request.url());
        // This scenario does not need catalog notifications. route.fetch buffers
        // an SSE body forever; the executor's finite /access calls remain real.
        if (request.headers().accept === 'text/event-stream') return route.fulfill({ status: 204 });
        const response = await route.fetch({
          url: runtime.baseUrl + original.pathname + original.search,
          headers: { ...request.headers(), ...runtime.operatorHeaders },
        });
        await route.fulfill({ response });
      });
      await mockHostedEditorBootstrap(page);
      await page.route('**/api/config', (route) =>
        route.fulfill({
          json: {
            executorWsUrl: runtime.executorWsUrl,
            remoteDebuggerDefaultWs: runtime.baseUrl.replace('http:', 'ws:') + '/ws/latest-debugger',
            publishedWorkflowsBasePath: '/workflows',
            latestWorkflowsBasePath: '/workflows-latest',
            publishedAppsBasePath: '/apps',
            latestAppsBasePath: '/apps-latest',
            webAppsAuthMode: 'ui-gate',
          },
        }),
      );
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await waitForDashboardReady(page);
      await page.getByRole('button', { name: 'Expand Hosted Subgraph fixture bundle', exact: true }).click();
      await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();
      const frame = page.frameLocator('iframe.dashboard-editor-frame');
      const first = frame.locator('.node[data-nodeid="bundle-call-one"]');
      const second = frame.locator('.node[data-nodeid="bundle-call-two"]');
      const result = frame.locator('.node[data-nodeid="bundle-result"]');
      await expect(first).toBeVisible();
      const run = frame.locator('.run-button button').first();
      const serviceAccess = () =>
        runtime.requests.filter((entry) => entry.path.includes('/access?') && entry.service && !entry.cookie);
      // Exercise each selected Subgraph directly before any whole-graph run.
      // Distinct outputs prove the target graph, not merely the project, is correct.
      for (const [node, id, expected] of [
        [first, 'bundle-call-one', 'child-result'],
        [second, 'bundle-call-two', 'second-child-result'],
      ] as const) {
        const checks = serviceAccess().length;
        const since = executorEvents.length;
        await node.locator('.node-title').click({ button: 'right' });
        await frame.getByText('Run to here', { exact: true }).click();
        await expect.poll(() => freshEvents(since).some((event) => event.message === 'done')).toBe(true);
        expect(freshEvents(since).some((event) => event.message === 'nodeFinish' && event.data?.node?.id === id)).toBe(
          true,
        );
        await expect.poll(() => serviceAccess().length).toBeGreaterThan(checks);
        expect(serviceAccess().at(-1)?.status).toBe(204);
        await expect(node).toHaveClass(/success/);
        await expect(node).toContainText(expected);
      }
      if (topology === 'replicated')
        expect(executorEvents.some((event) => event.message === 'executor-session-ready')).toBe(true);
      for (let repeat = 0; repeat < 2; repeat++) {
        const checks = serviceAccess().length;
        const since = executorEvents.length;
        await run.click();
        await expect.poll(() => freshEvents(since).some((event) => event.message === 'done')).toBe(true);
        for (const id of ['bundle-call-one', 'bundle-call-two'])
          expect(
            freshEvents(since).some((event) => event.message === 'nodeFinish' && event.data?.node?.id === id),
          ).toBe(true);
        await expect(first).toHaveClass(/success/);
        await expect(second).toHaveClass(/success/);
        await expect(result).toHaveClass(/success/);
        await expect.poll(() => serviceAccess().length).toBeGreaterThan(checks);
        expect(serviceAccess().at(-1)?.status).toBe(204);
        await expect(result).toContainText('child-result');
        await expect(second).toContainText('second-child-result');
      }
      // Run to here is the single-Subgraph execution path used in the incident.
      const checks = serviceAccess().length;
      const since = executorEvents.length;
      await first.locator('.node-title').click({ button: 'right' });
      await frame.getByText('Run to here', { exact: true }).click();
      await expect.poll(() => freshEvents(since).some((event) => event.message === 'done')).toBe(true);
      expect(
        freshEvents(since).some(
          (event) => event.message === 'nodeFinish' && event.data?.node?.id === 'bundle-call-one',
        ),
      ).toBe(true);
      await expect.poll(() => serviceAccess().length).toBeGreaterThan(checks);
      await expect(first).toHaveClass(/success/);
      expect(serviceAccess().at(-1)?.status).toBe(204);
      await expect(frame.locator('.Toastify__toast--error')).toHaveCount(0);

      // A valid sibling without a published snapshot is a publication problem,
      // not a bundle/auth denial. Check the real API contract and hosted UI.
      const unpublished = await fetch(
        runtime.baseUrl + accessPath.replace('/access?', '/execution?').replace('version=latest', 'version=published'),
        {
          headers: runtime.serviceHeaders,
        },
      );
      expect(unpublished.status).toBe(409);
      expect((await unpublished.json()).code).toBe('workflow_publication_missing');
      await frame.locator('.graph-list').getByText('Published target', { exact: true }).click();
      await expect(frame.locator('.node[data-nodeid="unpublished-call"]')).toBeVisible();
      const publishedSince = executorEvents.length;
      await run.click();
      await expect(frame.getByText(/has no published version.*Publish.*Saved latest/).first()).toBeVisible();
      expect(executorEvents.slice(publishedSince).some((event) => event.message === 'error')).toBe(true);
      expect(executorEvents.slice(publishedSince).some((event) => event.message === 'done')).toBe(false);
      await frame.locator('.graph-list').getByText('Main', { exact: true }).click();
      await expect(first).toBeVisible();

      // Move after the first /execution read, immediately before the cached-target
      // /access check. This changes real catalog state; no permission response is mocked.
      runtime.moveOnNextAccess();
      const deniedSince = executorEvents.length;
      await run.click();
      await expect.poll(() => serviceAccess().at(-1)?.status).toBe(403);
      await expect(frame.getByText(/Bundle members can only be referenced from the same bundle/).first()).toBeVisible();
      expect(executorEvents.slice(deniedSince).some((event) => event.message === 'error')).toBe(true);
      expect(executorEvents.slice(deniedSince).some((event) => event.message === 'done')).toBe(false);
      await testInfo.attach('service-checks', {
        body: JSON.stringify(serviceAccess(), null, 2),
        contentType: 'application/json',
      });
    } finally {
      try {
        await testInfo.attach('isolated-runtime-log', { body: runtime.logs, contentType: 'text/plain' });
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      } finally {
        try {
          await context.close();
        } finally {
          await runtime.close();
        }
      }
    }
  });
}
