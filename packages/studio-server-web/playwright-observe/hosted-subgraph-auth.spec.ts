import { expect, test } from '@playwright/test';
import { startHostedSubgraphRuntime } from '../../studio-server-api/src/tests/helpers/hosted-subgraph-runtime';
import type { WorkflowTreeResponse } from '../../studio-server-shared/workflow-types';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import { collectProjectBundle } from '../../studio-server-api/src/routes/workflows/project-bundle';
import { zipSync, strToU8 } from 'fflate';

test.use({ actionTimeout: 20_000 });

test('structural authoring preserves real PostgreSQL/MinIO data after lost create, copy, upload and bundle acknowledgements', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000);
  const runtime = await startHostedSubgraphRuntime();
  const writes = new Map<string, number>();
  let recoveries = 0;
  try {
    await context.addCookies([runtime.cookie]);
    await page.addInitScript(() => {
      delete (window as any).showOpenFilePicker;
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return route.fallback();
      if (request.headers().accept === 'text/event-stream') return route.fulfill({ status: 204 });
      const response = await route.fetch({
        url: runtime.baseUrl + url.pathname + url.search,
        headers: { ...request.headers(), ...runtime.operatorHeaders },
      });
      if (url.pathname === '/api/workflows/namespace/receipt') {
        recoveries++;
        expect(request.postData()!.length).toBeLessThan(200);
        expect(response.status()).toBe(200);
      } else if (request.method() === 'POST' && request.postDataJSON()?.mutation) {
        const id = request.postDataJSON().mutation.operationId;
        writes.set(id, (writes.get(id) ?? 0) + 1);
        expect(response.ok()).toBe(true);
        return route.abort('failed'); // Data committed; only the acknowledgement is lost.
      }
      return route.fulfill({ response });
    });
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await waitForDashboardReady(page);
    const newFolder = async (name: string) => {
      page.once('dialog', (dialog) => dialog.accept(name));
      await page.getByRole('button', { name: '+ New folder', exact: true }).click();
      await expect(page.getByRole('button', { name: `Collapse ${name}`, exact: true })).toBeVisible();
    };
    await newFolder('Structural UI');
    const folderRow = () =>
      page.getByRole('button', { name: /(?:Expand|Collapse) Structural UI(?: bundle)?$/, exact: true });
    await folderRow().click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept('Created member'));
    await page.getByRole('menuitem', { name: 'New project', exact: true }).click();
    await expect(page.locator('.project-row', { hasText: 'Created member' })).toBeVisible();
    const fixture = projectBundleFixture();
    await folderRow().click({ button: 'right' });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Upload project', exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: 'Uploaded member.rivet-project',
      mimeType: 'application/x-yaml',
      buffer: Buffer.from(fixture.child.projectContents),
    });
    const uploaded = page.locator('.project-row', { hasText: 'Uploaded member' });
    await expect(uploaded).toBeVisible();
    await uploaded.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await expect(page.locator('.project-row', { hasText: 'Uploaded member [unpublished] Copy' })).toBeVisible();
    await folderRow().click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('menuitem', { name: 'Convert to bundle', exact: true }).click();
    await expect(folderRow()).toHaveAttribute('aria-label', /Structural UI bundle$/);
    await folderRow().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
    const copied = page.getByRole('button', { name: 'Collapse Structural UI copy bundle', exact: true });
    await expect(copied).toBeVisible();
    await copied.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete bundle', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete bundle', exact: true });
    await deletion.getByRole('textbox', { name: 'Bundle name', exact: true }).fill('Structural UI copy');
    await deletion.getByRole('button', { name: 'Delete bundle', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(copied).toHaveCount(0);
    await expect(folderRow()).toBeVisible();

    await newFolder('Import target');
    const files: Array<{ path: string; contents: string }> = [];
    await collectProjectBundle({
      source: {
        ...fixture.source,
        versionPolicy: 'latest',
        workspace: {
          name: 'Imported UI feature',
          folders: ['Empty'],
          members: [fixture.root, fixture.child].map((item) => ({
            projectId: item.project.metadata.id,
            relativePath: `${item.project.metadata.id}.rivet-project`,
          })),
        },
      },
      rootVersion: 'latest',
      signal: new AbortController().signal,
      progress: () => {},
      writeFile: async (path, contents) => {
        files.push({ path, contents });
      },
    });
    await page.getByRole('button', { name: 'Collapse Import target', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Upload bundle', exact: true }).click();
    const upload = page.getByRole('dialog', { name: 'Upload bundle', exact: true });
    await upload.getByLabel('Bundle archive').setInputFiles({
      name: 'feature.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync(Object.fromEntries(files.map((file) => [file.path, strToU8(file.contents)])))),
    });
    await expect(upload).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Collapse Imported UI feature [a-f0-9]{8} bundle$/ })).toBeVisible();
    expect(writes.size).toBe(9);
    expect([...writes.values()].every((count) => count === 1)).toBe(true);
    expect(recoveries).toBe(9);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    await expect(folderRow()).toBeVisible();
    await expect(page.getByRole('button', { name: /Structural UI copy bundle$/, exact: true })).toHaveCount(0);
  } finally {
    await testInfo.attach('isolated-runtime-log', { body: runtime.logs, contentType: 'text/plain' });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
    await runtime.close();
  }
});

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
        data?: { node?: { id: string }; execution?: { projectId?: string; graphId?: string } };
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
        // Vite source modules can contain /api/ in their filesystem path.
        // Only actual root API routes belong to the isolated backend.
        if (!original.pathname.startsWith('/api/')) return route.fallback();
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
      // Open the dependency before running the caller, just as a designer does.
      await page.locator('.project-row', { hasText: 'Hosted target' }).dblclick();
      const frame = page.frameLocator('iframe.dashboard-editor-frame');
      const childOutput = frame.locator(`.node[data-nodeid="${runtime.fixture.childOutputId}"]`);
      await expect(childOutput).toBeVisible();
      await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();
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
        await expect
          .poll(() =>
            executorEvents
              .slice(since)
              .some(
                (event) =>
                  event.message === 'graphFinish' && event.data?.execution?.projectId === target.projectMetadataId,
              ),
          )
          .toBe(true);
        await page.locator('.project-row', { hasText: 'Hosted target' }).dblclick();
        await expect(childOutput).toHaveClass(/success/);
        await expect(childOutput).toContainText('child-result');
        await expect(frame.getByText(/^Execution: \d+\/\d+$/)).toHaveCount(0);
        expect(freshEvents(since).some((event) => event.message === 'done')).toBe(false);
        await expect(frame.locator('.run-button button').first()).not.toContainText('Abort');
        await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();
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
        await page.locator('.project-row', { hasText: 'Hosted target' }).dblclick();
        await expect(childOutput).toHaveClass(/success/);
        await expect(childOutput).toContainText('child-result');
        await expect(frame.locator('.run-button button').first()).not.toContainText('Abort');
        await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();
        await expect(result).toContainText('child-result');
      }
      // A reopened receiver is a new display lifetime, not a continuation of
      // the old tab, even though project ID/path/bundle are all unchanged.
      const lifetimeSince = executorEvents.length;
      await run.click();
      await expect
        .poll(() =>
          executorEvents
            .slice(lifetimeSince)
            .some(
              (event) =>
                event.message === 'nodeStart' &&
                event.data?.node?.id === 'bundle-child-delay' &&
                event.data.execution?.projectId === target.projectMetadataId &&
                event.data.execution.graphId === 'child-main',
            ),
        )
        .toBe(true);
      const childTab = frame.locator('.projects-container .project:not(.opening)').filter({ hasText: 'Hosted target' });
      await childTab.hover();
      await childTab.getByRole('button', { name: /^Close / }).click();
      await expect(childTab).toHaveCount(0);
      await page.locator('.project-row', { hasText: 'Hosted target' }).dblclick();
      await expect(childOutput).toBeVisible();
      await expect.poll(() => freshEvents(lifetimeSince).some((event) => event.message === 'done')).toBe(true);
      await expect(childOutput).not.toHaveClass(/success/);
      await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();
      await expect(result).toContainText('child-result');
      const nextSince = executorEvents.length;
      await run.click();
      await expect.poll(() => freshEvents(nextSince).some((event) => event.message === 'done')).toBe(true);
      await page.locator('.project-row', { hasText: 'Hosted target' }).dblclick();
      await expect(childOutput).toHaveClass(/success/);
      await expect(childOutput).toContainText('child-result');
      await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();

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

test('moving a bundle reparents the persisted PostgreSQL tree and survives a dashboard reload', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await startHostedSubgraphRuntime();
  try {
    let droppedMoveAcknowledgement = false;
    let moveRequests = 0;
    let expectedParentId: string | null = null;
    for (const [name, parentRelativePath] of [
      ['Trash', ''],
      ['Test', 'Trash'],
    ]) {
      const response = await fetch(runtime.baseUrl + '/api/workflows/folders', {
        method: 'POST',
        headers: { ...runtime.operatorHeaders, 'content-type': 'application/json', 'X-Rivet-Namespace-Intent': '1' },
        body: JSON.stringify({
          name,
          parentRelativePath,
          mutation: {
            operationId: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            expectedDestinationId: expectedParentId,
          },
        }),
      });
      expect(response.status).toBe(201);
      expectedParentId = (await response.json()).folder.namespaceId;
    }
    await context.addCookies([runtime.cookie]);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return route.fallback();
      if (request.headers().accept === 'text/event-stream') return route.fulfill({ status: 204 });
      const response = await route.fetch({
        url: runtime.baseUrl + url.pathname + url.search,
        headers: { ...request.headers(), ...runtime.operatorHeaders },
      });
      if (url.pathname === '/api/workflows/namespace/mutate') {
        moveRequests++;
        expect(response.status()).toBe(200);
        if (!droppedMoveAcknowledgement) {
          droppedMoveAcknowledgement = true;
          return route.abort('failed'); // Commit happened; only its reply is lost.
        }
      }
      await route.fulfill({ response });
    });
    await mockHostedEditorBootstrap(page);
    const readTree = async () => {
      const response = await fetch(runtime.baseUrl + '/api/workflows/tree', { headers: runtime.operatorHeaders });
      expect(response.status).toBe(200);
      return response.json() as Promise<WorkflowTreeResponse>;
    };
    const before = await readTree();
    const source = before.folders.find((folder) => folder.name === 'Hosted Subgraph fixture')!;
    expect(source.bundleId).toBeTruthy();
    expect(source.projects.map((project) => project.projectMetadataId).sort()).toEqual(
      [runtime.fixture.caller.projectMetadataId, runtime.fixture.target.projectMetadataId].sort(),
    );
    const command = {
      kind: 'move',
      itemType: 'folder',
      relativePath: source.relativePath,
      destinationRelativePath: 'Trash/Test',
    };
    const mutationBody = {
      operationId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      command,
      expectedSource: { id: source.namespaceId },
    };
    for (const [headers, body, status] of [
      [{}, mutationBody, 403],
      [runtime.operatorHeaders, mutationBody, 403],
      [
        { ...runtime.operatorHeaders, 'X-Rivet-Namespace-Intent': '1', 'Sec-Fetch-Site': 'cross-site' },
        mutationBody,
        403,
      ],
      [
        { ...runtime.operatorHeaders, 'X-Rivet-Namespace-Intent': '1' },
        { ...mutationBody, operationId: 'invalid' },
        400,
      ],
    ] as const) {
      const rejected = await fetch(runtime.baseUrl + '/api/workflows/namespace/mutate', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(rejected.status).toBe(status);
      await rejected.arrayBuffer();
    }
    const legacyMove = await fetch(runtime.baseUrl + '/api/workflows/move', {
      method: 'POST',
      headers: { ...runtime.operatorHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemType: 'folder',
        sourceRelativePath: source.relativePath,
        destinationFolderRelativePath: 'Trash/Test',
      }),
    });
    expect(legacyMove.status).toBe(428);
    await legacyMove.arrayBuffer();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Expand Trash', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Hosted Subgraph fixture bundle', exact: true }).click();
    await page.locator('.project-row', { hasText: 'Hosted caller' }).dblclick();
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const title = editor.locator('.node[data-nodeid="bundle-call-one"] .node-title');
    await expect(title).toBeVisible();
    const bounds = (await title.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 20, { steps: 8 });
    await page.mouse.up();
    await expect(editor.locator('.projects-container .project.active')).toHaveClass(/has-unsaved-changes/);
    const sourceRow = page.getByRole('button', { name: 'Collapse Hosted Subgraph fixture bundle', exact: true });
    await expect(sourceRow).toHaveAttribute('draggable', 'true');
    const movedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/workflows/namespace/recover' &&
        response.request().method() === 'POST',
    );
    await sourceRow.dragTo(page.getByRole('button', { name: 'Expand Test', exact: true }));
    expect((await movedResponse).status()).toBe(200);
    expect(droppedMoveAcknowledgement).toBe(true);
    expect(moveRequests).toBe(1);
    const after = await readTree();
    expect(after.folders.some((folder) => folder.bundleId === source.bundleId)).toBe(false);
    const trash = after.folders.find((folder) => folder.name === 'Trash')!;
    const testFolder = trash.folders.find((folder) => folder.name === 'Test')!;
    const moved = testFolder.folders.find((folder) => folder.bundleId === source.bundleId)!;
    expect(moved.relativePath).toBe('Trash/Test/Hosted Subgraph fixture');
    expect(moved.projects.map((project) => project.projectMetadataId).sort()).toEqual(
      source.projects.map((project) => project.projectMetadataId).sort(),
    );
    await expect(page.locator('.Toastify__toast')).toContainText('was moved on the server');
    await expect(editor.locator('.projects-container .project.active')).toHaveClass(/has-unsaved-changes/);
    const saved = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/projects/save' && response.request().method() === 'POST',
    );
    await page.locator('.active-project-save-button').click();
    const save = await saved;
    expect(save.request().postDataJSON().path).toBe(
      moved.projects.find((project) => project.projectMetadataId === runtime.fixture.caller.projectMetadataId)!
        .absolutePath,
    );
    expect(save.status()).toBe(200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    const trashRow = page.getByRole('button', { name: 'Expand Trash', exact: true });
    if (await trashRow.count()) await trashRow.click();
    const testRow = page.getByRole('button', { name: 'Expand Test', exact: true });
    if (await testRow.count()) await testRow.click();
    const destination = page.locator('.folder').filter({
      has: page.locator(':scope > .folder-row[aria-label="Collapse Test"]'),
    });
    await expect(destination.getByRole('button', { name: /Hosted Subgraph fixture bundle$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Hosted Subgraph fixture bundle$/ })).toHaveCount(1);
  } finally {
    try {
      await testInfo.attach('isolated-runtime-log', { body: runtime.logs, contentType: 'text/plain' });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    } finally {
      await runtime.close();
    }
  }
});
