import { expect, test } from '@playwright/test';
import { getUiFontScale, getUiFontSizeCssVariables } from '../../app/src/utils/uiFontSize';
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
    // Production replay artifacts have a new ID, not the original bundle caller ID.
    const project =
      kind === 'root'
        ? { ...fixture.parent, metadata: { ...fixture.parent.metadata, id: 'detached-replay' as ProjectId } }
        : fixture.child;
    const liveTargetReads: string[] = [];
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
    await page.route('**/api/workflows/subgraph-projects/**', (route) => {
      liveTargetReads.push(route.request().url());
      return route.fulfill({
        status: 403,
        json: {
          error:
            'This project belongs to a bundle. Only projects in the same bundle can reference it through a Subgraph node.',
        },
      });
    });
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
      sourceProjectRelativePath: 'Bundle/Child.rivet-project',
      status: kind === 'nested child' ? 'failed' : kind === 'legacy child' ? 'suspicious' : 'succeeded',
      durationMs: 1234,
      runKind: kind === 'prompt child' ? 'editor' : kind === 'legacy child' ? 'published' : 'latest',
      errorMessage:
        kind === 'nested child' ? `Historical run failure: ${'long-unbroken-detail'.repeat(30)}` : undefined,
    };
    await page.route('**/api/workflows/recordings/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/summary'))
        return kind === 'root'
          ? route.fulfill({ status: 404, json: { error: 'Older server without recording summaries' } })
          : route.fulfill({
              json:
                kind === 'child'
                  ? { ...child, executionIdentity: undefined, endpointNameAtExecution: 'Recorded endpoint' }
                  : child,
            });
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
    const recordingInfo = editor.getByRole('region', { name: 'Loaded recording', exact: true });
    await expect(recordingInfo).toBeVisible();
    await expect(recordingInfo.getByRole('button', { name: 'Unload Recording', exact: true })).toHaveCount(0);
    if (kind === 'child') {
      await editor.locator('body').press('Control+s');
      const warning = editor
        .locator('.Toastify__toast--warning')
        .filter({ hasText: 'Recording replay projects are read-only' });
      await expect(warning).toBeVisible();
      await expect(warning).not.toContainText('Use Save As');
      await expect(editor.locator('.Toastify__toast--error')).toHaveCount(0);
      await warning.locator('.Toastify__close-button').click();
      await expect(warning).toBeHidden();
    }
    if (kind === 'root') {
      await expect(editor.locator('.node [data-recorded-target]')).toContainText('playback-child / main');
      await expect(editor.locator('.node .target-error')).toHaveCount(0);
      await expect(editor.getByRole('combobox', { name: 'Subgraph graph', exact: true })).toHaveCount(0);
    }
    const panelLayout = await recordingInfo.evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      const controls = panel.querySelector('.action-bar-controls')!;
      const play = controls.querySelector('.run-button')!.getBoundingClientRect();
      const more = controls.querySelector('.more-menu')!.getBoundingClientRect();
      return {
        leftInset: play.left - bounds.left,
        metadataInset: panel.querySelector('.loaded-recording-label')!.getBoundingClientRect().left - bounds.left,
        rightInset: bounds.right - more.right,
        contentGap:
          panel.querySelector('.loaded-recording-info')!.getBoundingClientRect().top -
          controls.getBoundingClientRect().bottom,
        sameRow: play.top === more.top,
        infoFont: getComputedStyle(panel.querySelector('.loaded-recording-info')!).fontSize,
        contentRightPadding: parseFloat(getComputedStyle(panel.querySelector('.loaded-recording-info')!).paddingRight),
        playWidth: play.width,
        panelFont: getComputedStyle(panel).fontSize,
        overflows: panel.scrollWidth > panel.clientWidth,
      };
    });
    expect(panelLayout.leftInset).toBeCloseTo(9, 0);
    expect(panelLayout.metadataInset).toBeCloseTo(9, 0);
    expect(panelLayout.rightInset).toBeCloseTo(9, 0);
    expect(panelLayout.contentGap).toBeCloseTo(12, 0);
    expect(panelLayout.sameRow).toBe(true);
    expect(panelLayout.infoFont).toBe(panelLayout.panelFont);
    expect(panelLayout.contentRightPadding).toBeGreaterThanOrEqual(panelLayout.playWidth * 0.4);
    expect(panelLayout.contentRightPadding).toBeLessThanOrEqual(panelLayout.playWidth * 0.6);
    expect(panelLayout.overflows).toBe(false);
    if (kind === 'child' || kind === 'nested child') {
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width: 900, height: 700 });
      await expect(recordingInfo).toBeVisible();
      const originalStyle = await recordingInfo.getAttribute('style');
      try {
        for (const fontSize of [14, 15, 20]) {
          const layout = await recordingInfo.evaluate((panel, variables) => {
            for (const [name, value] of Object.entries(variables)) panel.style.setProperty(name, String(value));
            const bounds = panel.getBoundingClientRect();
            const info = panel.querySelector<HTMLElement>('.loaded-recording-info')!;
            return {
              fits: bounds.left >= 0 && bounds.right <= window.innerWidth && panel.scrollWidth <= panel.clientWidth,
              contentFits: info.scrollWidth <= info.clientWidth,
              padding: parseFloat(getComputedStyle(info).paddingRight),
            };
          }, getUiFontSizeCssVariables(fontSize));
          expect(layout.fits, `recording panel at ${fontSize}px UI size`).toBe(true);
          expect(layout.contentFits, `recording details at ${fontSize}px UI size`).toBe(true);
          expect(layout.padding).toBeCloseTo(64 * getUiFontScale(fontSize), 2);
        }
      } finally {
        await recordingInfo.evaluate((panel, originalStyle) => {
          if (originalStyle == null) panel.removeAttribute('style');
          else panel.setAttribute('style', originalStyle);
        }, originalStyle);
        await page.setViewportSize({ width: 1600, height: 1000 });
      }
    }
    await expect(recordingInfo).not.toContainText('Details inferred from recording events');
    await expect(recordingInfo).not.toContainText('Project:');
    await expect(recordingInfo).not.toContainText('Graph:');
    await expect(recordingInfo).not.toContainText('Child main');
    await expect(recordingInfo).not.toContainText('playback-family');
    await expect(recordingInfo).toContainText(`Endpoint at execution: ${kind === 'child' ? 'Recorded endpoint' : '—'}`);
    const rows = recordingInfo.locator('.loaded-recording-heading');
    await expect(rows).toHaveCount(1);
    await expect(recordingInfo.locator('.loaded-recording-tag')).toHaveCount(1);
    await expect(rows.locator('.loaded-recording-tag')).toHaveText(
      child.status === 'failed' ? 'Failed' : child.status === 'suspicious' ? 'Suspicious' : 'Succeeded',
    );
    expect(await rows.evaluate((row) => row.firstElementChild?.classList.contains('loaded-recording-tag'))).toBe(true);
    await expect(rows.locator(':scope > span')).toContainText(/\d{4}/);
    await expect(recordingInfo).not.toContainText('1.23 s');
    if (kind === 'root') await expect(recordingInfo).not.toContainText('Parent');
    await expect(editor.locator('.recording-border')).toHaveAttribute('data-recording-status', child.status);
    const color = child.status === 'failed' ? 'error' : child.status === 'suspicious' ? 'warning' : 'success';
    const recordingTabIcon = editor.locator('.projects-container .project.active .recording-tab-icon');
    await expect(recordingTabIcon).toHaveAttribute('data-recording-status', child.status);
    await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/has-unsaved-changes/);
    await expect(recordingTabIcon).toHaveAttribute('style', `color: var(--${color});`);
    expect(
      await recordingTabIcon.evaluate((icon) => {
        const title = icon.nextElementSibling!.getBoundingClientRect();
        const bounds = icon.getBoundingClientRect();
        return bounds.width > 0 && bounds.width < 20 && bounds.right <= title.left;
      }),
    ).toBe(true);
    await expect(editor.locator('.recording-border')).toHaveAttribute('style', `--recording-color: var(--${color});`);
    if (child.errorMessage) await expect(recordingInfo).toContainText(child.errorMessage);
    if (['child', 'nested child', 'legacy child'].includes(kind))
      await recordingInfo.screenshot({ path: `../../artifacts/playwright/loaded-recording-${child.status}.png` });
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
    await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/has-unsaved-changes/);
    await expect(recordingTabIcon).toHaveAttribute('data-recording-status', child.status);
    await expect(editor.locator('[aria-label="Run Activity"]')).toContainText(
      kind === 'root' ? 'Parent' : 'Child main',
    );
    // A graph name in the drawer header alone doesn't prove playback populated it.
    const activityRows = editor.locator('[aria-label="Run Activity"] .run-activity-row');
    await expect(activityRows.first()).toBeVisible();
    const activityToggle = activityRows.first().locator('button.collapsible-panel-toggle');
    await activityToggle.click();
    const detailId = await activityToggle.getAttribute('aria-controls');
    expect(detailId).toBeTruthy();
    await expect(editor.locator(`[id="${detailId}"]`)).toHaveCount(1);
    await expect(
      activityRows.filter({ hasText: kind === 'root' ? 'Subgraph' : 'Recorded child output' }).first(),
    ).toBeVisible();
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
      const moveReplayNode = async () => {
        const node = editor.locator('.node[data-nodeid="child-text"]');
        const before = await node.evaluate((element) => (element as HTMLElement).style.transform);
        const title = (await node.locator('.node-title').boundingBox())!;
        await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
        await page.mouse.down();
        await page.mouse.move(title.x + title.width / 2 + 60, title.y + title.height / 2 + 30, { steps: 6 });
        await page.mouse.up();
        await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(before);
        // dnd-kit's pointer sensor deliberately captures clicks for 50 ms after
        // drag end. Settle that exact quarantine before issuing a single Play /
        // Close command in one task; otherwise the test never reaches the owner
        // race it claims to verify. Do not conceal it by retrying either command.
        await node.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 75)));
      };
      await editor.locator('.projects-container .project').filter({ hasText: 'Neighbor' }).click();
      await expect(play).toHaveCount(0);
      await expect(editor.getByRole('region', { name: 'Loaded recording', exact: true })).toHaveCount(0);
      await expect(editor.locator('.projects-container .project.active .recording-tab-icon')).toHaveCount(0);
      await expect(
        editor
          .locator('.projects-container .project')
          .filter({ hasText: 'Child replay' })
          .locator('.recording-tab-icon'),
      ).toHaveAttribute('data-recording-status', 'succeeded');
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
      // Disposable replay geometry must not trigger an unsaved-close dialog.
      await moveReplayNode();
      await play.evaluate((button) => {
        (button as HTMLButtonElement).click();
        const close = document.querySelector<HTMLButtonElement>('.projects-container .project.active .close-project');
        if (!close) throw new Error('Missing replay close button');
        close.click();
      });
      await expect(editor.locator('.projects-container .project').filter({ hasText: 'Child replay' })).toHaveCount(0);
      await expect(editor.getByRole('dialog', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
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
      await moveReplayNode();
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
      await expect(parentTab.locator('.recording-tab-icon')).toHaveAttribute('data-recording-status', 'succeeded');
      await expect(
        editor
          .locator('.projects-container .project')
          .filter({ hasText: 'Child replay' })
          .locator('.recording-tab-icon'),
      ).toHaveAttribute('data-recording-status', 'succeeded');
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
      await parentTab.click();
      const inactiveReplay = editor.locator('.projects-container .project').filter({ hasText: 'Child replay' });
      await inactiveReplay.hover();
      await inactiveReplay.locator('.close-project').click();
      await expect(inactiveReplay).toHaveCount(0);
      await expect(parentTab).toHaveClass(/active/);
      await expect(editor.getByRole('dialog', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
    }
    if (kind === 'root') {
      const call = editor
        .locator('.node')
        .filter({ has: editor.locator('[data-recorded-target]') })
        .first();
      await call.hover();
      await call.locator('.edit-button').click();
      const settings = editor.locator('.panel-container');
      await expect(settings.locator('[data-recorded-target]')).toBeVisible();
      await expect(settings).toContainText('Recorded graph');
      await expect(settings.getByRole('group', { name: 'Subgraph graph source', exact: true })).toHaveCount(0);
      await expect(
        settings.getByText('Could not check this project’s published version.', { exact: true }),
      ).toHaveCount(0);
      await expect(recordingInfo.getByRole('button', { name: 'Unload Recording', exact: true })).toHaveCount(0);
      await expect(recordingInfo).toBeVisible();
      await expect(editor.locator('.projects-container .project.active .recording-tab-icon')).toHaveCount(1);
      await expect(call.locator('[data-recorded-target]')).toBeVisible();
      await expect(call.locator('.target-error')).toHaveCount(0);
      await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/has-unsaved-changes/);
    }
    expect(liveTargetReads).toEqual([]);
  });
}
