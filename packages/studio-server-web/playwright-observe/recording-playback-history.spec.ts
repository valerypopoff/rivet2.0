import { expect, test } from '@playwright/test';
import { serializeProject, ExecutionRecorder, type GraphId, type ProjectId } from '@valerypopoff/rivet2-core';
import { createChildPlaybackFixture } from '../../app/src/hooks/fixtures/childPlaybackRecording.js';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowRecordingRunSummary } from '../../studio-server-shared/workflow-recording-types';

for (const kind of ['child', 'nested child', 'legacy child', 'root', 'prompt child'] as const) {
  test(`Run recordings: repeated ${kind} playback replaces display history without changing the artifact`, async ({
    page,
  }) => {
    const fixture = await createChildPlaybackFixture(
      kind === 'nested child' ? 2 : 0,
      kind === 'prompt child' ? 'prompt' : 'complete',
    );
    expect(fixture.recording.events.some((event) => event.type === 'start')).toBe(false);
    let recorder = kind === 'root' ? fixture.rootRecording : fixture.recording;
    if (kind === 'legacy child') {
      const serialized = JSON.parse(recorder.serialize());
      for (const event of serialized.recording.events) if (event.data) delete event.data.execution;
      recorder = ExecutionRecorder.deserializeFromString(JSON.stringify(serialized));
    }
    const project = kind === 'root' ? fixture.parent : fixture.child;
    const neighbor = {
      ...fixture.child,
      metadata: { ...fixture.child.metadata, id: 'neighbor' as ProjectId, title: 'Neighbor' },
      graphs: {
        ...fixture.child.graphs,
        ['main' as GraphId]: {
          ...fixture.child.graphs['main' as GraphId]!,
          nodes: fixture.child.graphs['main' as GraphId]!.nodes.map((node) =>
            node.type === 'text' ? { ...node, data: { text: 'neighbor live evidence' } } : node,
          ),
        },
      },
    };
    const serializedRecording = recorder.serialize();
    await page.addInitScript(() => {
      localStorage.setItem(
        'recoil-persist',
        JSON.stringify({
          defaultExecutor: 'browser',
          recordExecutions: false,
          settings: { recordingPlaybackLatency: 0 },
        }),
      );
      const saved: string[] = [];
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => ({
          createWritable: async () => ({
            write: async (content: string) => {
              saved.push(content);
            },
            close: async () => {},
          }),
        }),
      });
      (window as Window & { playbackExports?: string[] }).playbackExports = saved;
    });
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 503, json: { error: 'No ambient API in playback fixture' } }),
    );
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/workflows',
          projects:
            kind === 'child'
              ? [
                  {
                    id: 'neighbor',
                    projectMetadataId: 'neighbor',
                    name: 'Neighbor',
                    fileName: 'Neighbor.rivet-project',
                    absolutePath: '/workflows/Neighbor.rivet-project',
                    relativePath: 'Neighbor.rivet-project',
                    updatedAt: '2026-10-19T00:00:00Z',
                    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
                  },
                ]
              : [],
          folders: [],
          sync: { epoch: 'playback', revision: 0 },
        },
      }),
    );
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({ json: { contents: serializeProject(neighbor), datasetsContents: null, revisionId: null } }),
    );
    await page.route('**/api/workflows/recordings/workflows', (route) =>
      route.fulfill({ json: { workflows: [], totals: { totalRuns: 2, failedRuns: 0, suspiciousRuns: 0 } } }),
    );
    const root: WorkflowRecordingRunSummary = {
      id: 'parent-run',
      workflowId: 'parent',
      createdAt: '2026-10-19T10:00:00Z',
      runKind: 'latest',
      status: 'succeeded',
      durationMs: 1,
      endpointNameAtExecution: 'Parent run',
      hasReplayDataset: false,
      recordingCompressedBytes: 10,
      recordingUncompressedBytes: 20,
      projectCompressedBytes: 10,
      projectUncompressedBytes: 20,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
      executionIdentity: { surface: 'workflow_endpoint', correlationId: 'playback-family' },
    };
    const child: WorkflowRecordingRunSummary = {
      ...root,
      id: 'child-run',
      workflowId: 'child',
      endpointNameAtExecution: 'Subgraph: Child main',
      executionIdentity: { surface: 'subgraph_project', correlationId: 'playback-family', graphName: 'Child main' },
      sourceProjectName: 'Child replay',
    };
    await page.route('**/api/workflows/recordings/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/runs'))
        return route.fulfill({
          json: {
            workflowId: '',
            page: 1,
            pageSize: 20,
            totalRuns: 1,
            totalRunsExact: true,
            statusFilter: 'all',
            runs: [root],
          },
        });
      if (url.pathname.endsWith('/sub-runs'))
        return route.fulfill({
          json: {
            workflowId: root.id,
            page: Number(url.searchParams.get('page') ?? 1),
            pageSize: Number(url.searchParams.get('pageSize') ?? 100),
            totalRuns: 1,
            totalRunsExact: true,
            statusFilter: 'all',
            runs: [child],
          },
        });
      if (url.pathname.endsWith('/recording'))
        return route.fulfill({
          contentType: 'text/plain',
          body:
            kind === 'child' && url.pathname.includes('/parent-run/')
              ? fixture.rootRecording.serialize()
              : serializedRecording,
        });
      if (url.pathname.endsWith('/replay-project'))
        return route.fulfill({
          contentType: 'text/plain',
          body: serializeProject(kind === 'child' && url.pathname.includes('/parent-run/') ? fixture.parent : project),
        });
      if (url.pathname.endsWith('/replay-dataset'))
        return route.fulfill({ status: 404, json: { error: 'No replay dataset' } });
      return route.fallback();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    if (kind === 'child') {
      await page.locator('.project-row', { hasText: 'Neighbor' }).dblclick();
      await expect(editor.locator('.node[data-nodeid="child-text"]')).toBeVisible();
      await editor.locator('.run-button button').first().click();
      await expect(editor.locator('.node[data-nodeid="child-text"] .node-output')).toContainText(
        'neighbor live evidence',
      );
    }
    await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await modal.getByRole('button', { name: 'Show sub-runs', exact: true }).click();
    const childRow = modal.locator('.run-recordings-run').filter({ hasText: 'Called graph: Child main' });
    await expect(childRow).toBeVisible();
    await childRow.locator('.run-recordings-run-open-button').click();
    await expect(modal).toBeHidden();
    const play = editor.getByRole('button', { name: 'Play Recording', exact: true });
    const output = editor.locator('.node[data-nodeid="child-text"] .node-output');
    for (let iteration = 0; iteration < 3; iteration++) {
      await expect(play).toBeEnabled();
      await play.click();
      await expect(editor.getByRole('button', { name: 'Abort', exact: true })).toHaveCount(0);
      await expect(play).toBeEnabled();
      if (kind === 'nested child' && iteration > 0) {
        await expect(editor.getByText('Execution: 2/2', { exact: true })).toBeVisible();
        await editor.locator('.graph-item[data-graphid="main"] .graph-item-select').click();
      }
      if (kind !== 'root') await expect(output).toContainText('child playback evidence');
      await expect(editor.getByRole('dialog', { name: 'User Input', exact: true })).toHaveCount(0);
      // One recorded invocation must not acquire a selector merely because it was played again.
      await expect(editor.getByText(/^Execution: \d+\/\d+$/)).toHaveCount(0);
      if (kind === 'nested child') {
        await editor
          .locator('.node[data-nodeid="nested-call"]')
          .getByRole('button', { name: 'Go to subgraph', exact: true })
          .click();
        await expect(editor.getByText('Execution: 2/2', { exact: true })).toBeVisible();
        await editor.getByRole('button', { name: 'Previous execution (all nodes)', exact: true }).click();
        await expect(editor.getByText('Execution: 1/2', { exact: true })).toBeVisible();
        await expect(editor.locator('.node[data-nodeid="leaf-text"] .node-output')).toContainText(
          'child playback evidence',
        );
      }
    }
    await editor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
    await expect(editor.locator('[aria-label="Run Activity"]')).toContainText(
      kind === 'root' ? 'Parent' : 'Child main',
    );
    await editor
      .locator('[aria-label="Run Activity"]')
      .getByRole('button', { name: 'Close Run Activity', exact: true })
      .click();
    await editor.locator('button.more-menu').click();
    await editor.getByRole('button', { name: 'Export recording', exact: true }).click();
    const saved = () =>
      page
        .locator('iframe.dashboard-editor-frame')
        .evaluate(
          (frame) =>
            ((frame as HTMLIFrameElement).contentWindow as Window & { playbackExports?: string[] }).playbackExports,
        );
    await expect.poll(saved).toEqual([serializedRecording]);
    if (kind === 'child') {
      await editor.locator('.projects-container .project').filter({ hasText: 'Neighbor' }).click();
      await expect(play).toHaveCount(0);
      await expect(editor.locator('.node[data-nodeid="child-text"] .node-output')).toContainText(
        'neighbor live evidence',
      );
      await expect(editor.getByText(/^Execution: \d+\/\d+$/)).toHaveCount(0);
      await editor.locator('.projects-container .project').filter({ hasText: 'Child replay' }).click();
      await expect(play).toBeEnabled();
      await expect(output).toContainText('child playback evidence');
      // One macrotask deliberately switches/ closes the owner before the
      // executor's preparation repaint yield can finish.
      await play.evaluate((button) => {
        (button as HTMLButtonElement).click();
        const neighborTab = [...document.querySelectorAll<HTMLElement>('.projects-container .project')].find((tab) =>
          tab.textContent?.includes('Neighbor'),
        );
        if (!neighborTab) throw new Error('Missing neighbor tab');
        neighborTab.click();
      });
      await expect(play).toHaveCount(0);
      await expect(editor.locator('.node[data-nodeid="child-text"] .node-output')).toContainText(
        'neighbor live evidence',
      );
      await editor.locator('.projects-container .project').filter({ hasText: 'Child replay' }).click();
      await expect(play).toBeEnabled();
      await expect(output).toContainText('child playback evidence');
      await expect(editor.getByText(/^Execution: \d+\/\d+$/)).toHaveCount(0);
      // Cancel as soon as the reserved run's Abort control is rendered, then
      // switch tabs in that same turn, before preparation can settle.
      await play.evaluate(
        (button) =>
          new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              observer.disconnect();
              reject(new Error('Playback did not expose Abort'));
            }, 5000);
            const observer = new MutationObserver(() => {
              if (!button.textContent?.includes('Abort')) return;
              observer.disconnect();
              window.clearTimeout(timeout);
              const neighborTab = [...document.querySelectorAll<HTMLElement>('.projects-container .project')].find(
                (tab) => tab.textContent?.includes('Neighbor'),
              );
              if (!neighborTab) {
                reject(new Error('Missing neighbor tab'));
                return;
              }
              (button as HTMLButtonElement).click();
              neighborTab.click();
              resolve();
            });
            observer.observe(button, { childList: true, subtree: true, characterData: true });
            (button as HTMLButtonElement).click();
          }),
      );
      await expect(play).toHaveCount(0);
      await expect(editor.locator('.node[data-nodeid="child-text"] .node-output')).toContainText(
        'neighbor live evidence',
      );
      await editor.locator('.projects-container .project').filter({ hasText: 'Child replay' }).click();
      await expect(play).toBeEnabled();
      await expect(output).toContainText('child playback evidence');
      await play.evaluate((button) => {
        (button as HTMLButtonElement).click();
        const close = document.querySelector<HTMLButtonElement>('.projects-container .project.active .close-project');
        if (!close) throw new Error('Missing replay close button');
        close.click();
      });
      await expect(editor.locator('.projects-container .project').filter({ hasText: 'Child replay' })).toHaveCount(0);
      await expect(play).toHaveCount(0);
      await expect(editor.locator('.node[data-nodeid="child-text"] .node-output')).toContainText(
        'neighbor live evidence',
      );
      await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
      await expect(modal).toBeVisible();
      await expect(modal.locator('.run-recordings-run').first()).toBeVisible();
      const expand = modal.getByRole('button', { name: 'Show sub-runs', exact: true });
      if (await expand.count()) await expand.click();
      await expect(childRow).toBeVisible();
      await childRow.locator('.run-recordings-run-open-button').click();
      await expect(modal).toBeHidden();
      await expect(play).toBeEnabled();
      await expect.poll(async () => (await output.allTextContents()).join('')).not.toContain('child playback evidence');
      await play.click();
      await expect(play).toBeEnabled();
      await expect(output).toContainText('child playback evidence');
      await expect(editor.getByText(/^Execution: \d+\/\d+$/)).toHaveCount(0);
      // Keep a second recording open. Its activation changes the global loaded
      // recording, but must not strand the first tab's preparation reservation.
      await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
      await expect(modal).toBeVisible();
      await modal
        .locator('.run-recordings-run')
        .filter({ hasText: 'Parent run' })
        .locator('.run-recordings-run-open-button')
        .click();
      await expect(modal).toBeHidden();
      const parentTab = editor.locator('.projects-container .project').filter({ hasText: 'Parent' });
      await expect(parentTab).toBeVisible();
      await expect(play).toBeEnabled();
      await editor.locator('.projects-container .project').filter({ hasText: 'Child replay' }).click();
      await expect(play).toBeEnabled();
      await play.evaluate((button) => {
        (button as HTMLButtonElement).click();
        const parent = [...document.querySelectorAll<HTMLElement>('.projects-container .project')].find((tab) =>
          tab.textContent?.includes('Parent'),
        );
        if (!parent) throw new Error('Missing second recording tab');
        parent.click();
      });
      await expect(parentTab).toHaveClass(/active/);
      await expect(play).toBeEnabled();
      await editor.locator('.projects-container .project').filter({ hasText: 'Child replay' }).click();
      await expect(play).toBeEnabled();
      await play.click();
      await expect(play).toBeEnabled();
      await expect(output).toContainText('child playback evidence');
      await expect(editor.getByText(/^Execution: \d+\/\d+$/)).toHaveCount(0);
    }
  });
}
