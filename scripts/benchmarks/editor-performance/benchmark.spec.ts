// test-style: fixture-read: reads only source metadata and manifests emitted by the test-owned benchmark build.
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { repoRoot, findModuleAssetRequests, finalizeBenchmark } from './support.mjs';
import { createFixture } from './fixture';
import { startFixtureServer } from './server';
import { createProcessor } from '../../../packages/node/src/api';
import { startDebuggerServer } from '../../../packages/node/src/debugger';

const require = createRequire(path.join(repoRoot, 'packages/studio-server-web/package.json'));
const { test, expect } = require('@playwright/test');
const directory = process.env.RIVET_EDITOR_BENCH_OUTPUT!;
const repetitions = Number(process.env.RIVET_EDITOR_BENCH_SAMPLES || 7);

test('production editor performance and behavioral controls', async ({ browser }) => {
  const fixture = await createFixture();
  const chunks = JSON.parse(
    await readFile(path.join(process.env.RIVET_EDITOR_BENCH_DIST!, 'profile-attribution.json'), 'utf8'),
  );
  const result: any = {
    source: JSON.parse(await readFile(path.join(directory, 'build-source.json'), 'utf8')),
    browser: browser.version(),
    fixture: fixture.metrics,
    timings: {},
    resources: {},
    requests: [],
    errors: [],
    commands: [],
  };
  // Finish fallible metadata reads before acquiring the local listener.
  const host = await startFixtureServer(process.env.RIVET_EDITOR_BENCH_DIST!, fixture);
  const contexts: any[] = [];
  let debuggerServer: ReturnType<typeof startDebuggerServer> | undefined;
  let primaryError: unknown;
  const timing = (key: string, value: number) => (result.timings[key] ??= []).push(value);
  const dashboard = (page) => page.locator('.workflow-library-panel').waitFor({ state: 'visible', timeout: 90000 });
  const ready = (page) =>
    page.waitForFunction(
      () =>
        document.querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')?.contentWindow
          ?.__rivetEditorBootstrapState === 'ready',
    );
  const editor = (page) => page.frameLocator('iframe.dashboard-editor-frame');
  const tab = (page, p) =>
    editor(page)
      .locator('.projects-container .project:not(.opening)')
      .filter({ hasText: `Benchmark ${p}` });
  const output = (page, p) => editor(page).locator(`.node[data-nodeid="perf-${p}-text-0"] .node-output`);
  const open = async (page, p) => {
    await page
      .locator('.project-row')
      .filter({ hasText: `Benchmark ${p}` })
      .dblclick();
    await expect(editor(page).locator(`.node[data-nodeid="perf-${p}-text-0"]`)).toBeVisible();
  };
  async function context() {
    const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    contexts.push(c);
    await c.addInitScript(() => {
      if (!localStorage.getItem('recoil-persist'))
        localStorage.setItem(
          'recoil-persist',
          JSON.stringify({
            defaultExecutor: 'browser',
            recordExecutions: false,
            settings: { recordingPlaybackLatency: 0 },
          }),
        );
      (window as any).__bench = { longtasks: [] };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          (window as any).__bench.longtasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    });
    const page = await c.newPage();
    page.on('pageerror', (e) => result.errors.push(String(e)));
    const cdp = await c.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    return { c, page, cdp };
  }
  async function resources(page, assetStart: number) {
    const frames = await Promise.all(
      page.frames().map(async (frame) => ({
        url: frame.url(),
        ...(await frame
          .evaluate(() => ({
            entries: performance.getEntriesByType('resource').map((e) => e.toJSON()),
            longtasks: (window as any).__bench?.longtasks || [],
          }))
          .catch(() => ({ entries: [], longtasks: [] }))),
      })),
    );
    const workers = await Promise.all(
      page.workers().map(async (worker) => ({
        url: worker.url(),
        entries: await worker
          .evaluate(() => performance.getEntriesByType('resource').map((e) => e.toJSON()))
          .catch(() => []),
      })),
    );
    return { frames, workers, servedAssets: host.assetRequests.slice(assetStart) };
  }
  async function zoom(page, p: number) {
    const node = editor(page).locator(`.node[data-nodeid="perf-${p}-text-0"]`);
    // Only zoom fitted overviews; do not repeatedly magnify a tab on every run.
    if (await node.locator('.node-output').count()) return;
    const b = await node.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.keyboard.down('Shift');
    try {
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(60);
      }
    } finally {
      await page.keyboard.up('Shift');
    }
  }
  async function controlRun(page, button, key?: string) {
    await editor(page)
      .locator('body')
      .evaluate(() => {
        (window as any).__bench.control = { running: false, done: false };
        (window as any).__bench.controlObserver?.disconnect();
        const state = (window as any).__bench.control;
        const observer = new MutationObserver((records) => {
          if (
            document.querySelector('.run-button.running') ||
            records.some(
              (r) =>
                r.type === 'attributes' &&
                r.attributeName === 'class' &&
                r.oldValue?.includes('run-button') &&
                r.oldValue.includes('running'),
            )
          )
            state.running = true;
          if (
            state.running &&
            !document.querySelector('.run-button.running') &&
            !document.querySelector('.run-button [aria-busy="true"]')
          ) {
            state.done = true;
            observer.disconnect();
          }
        });
        observer.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, childList: true });
        (window as any).__bench.controlObserver = observer;
      });
    const start = performance.now();
    await button.click();
    await expect
      .poll(
        () =>
          editor(page)
            .locator('body')
            .evaluate(() => (window as any).__bench.control.done),
        { timeout: 60000 },
      )
      .toBe(true);
    await expect(button).toBeEnabled();
    if (key) timing(key, performance.now() - start);
  }
  async function memberTerminal(page, p: number) {
    await tab(page, p).click();
    await editor(page).getByRole('button', { name: 'Remote Debugger details', exact: true }).click();
    await expect(editor(page).getByTestId('remote-debugger-details')).toContainText('Remote run completed.');
    await editor(page).getByRole('button', { name: 'Done', exact: true }).click();
  }
  try {
    for (let i = 0; i < repetitions; i++) {
      const { c, page } = await context(),
        assets = host.assetRequests.length,
        start = performance.now();
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dashboard(page);
      timing('coldDashboard', performance.now() - start);
      (result.resources.coldDashboard ??= []).push(await resources(page, assets));
      await ready(page);
      const initialResources = await resources(page, assets);
      timing('coldEmptyReady', performance.now() - start);
      (result.resources.coldEmptyReady ??= []).push(initialResources);
      if (process.env.RIVET_EDITOR_BENCH_CHECK_LOADING === '1') {
        expect(findModuleAssetRequests(chunks, '/node_modules/monaco-editor/', initialResources.servedAssets)).toEqual(
          [],
        );
      }
      await open(page, 9);
      timing('coldFirstProject', performance.now() - start);
      (result.resources.coldFirstProject ??= []).push(await resources(page, assets));
      await zoom(page, 9);
      const codeStart = performance.now();
      await editor(page).locator('.node[data-nodeid="perf-9-text-0"] .edit-button').dispatchEvent('click');
      const input = editor(page).locator('.monaco-editor textarea').first();
      await expect(input).toBeVisible();
      await expect(input).toBeEditable();
      await expect(editor(page).locator('.monaco-editor .view-lines').first()).toContainText('Project 9 completed');
      timing('firstCodeEditor', performance.now() - codeStart);
      await input.focus();
      await expect(input).toBeFocused();
      (result.resources.coldEditor ??= []).push(await resources(page, assets));
      await c.close();
      console.log(`cold ${i + 1}/${repetitions}`);
    }
    const { page, cdp } = await context();
    await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await dashboard(page);
    await ready(page);
    for (let i = 0; i < repetitions; i++) {
      const assets = host.assetRequests.length,
        start = performance.now();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dashboard(page);
      await ready(page);
      timing('cachedReady', performance.now() - start);
      (result.resources.cached ??= []).push(await resources(page, assets));
    }
    console.log('cached navigation complete');
    for (let p = 9; p >= 0; p--) {
      const start = performance.now();
      await open(page, p);
      timing('openProjects', performance.now() - start);
    }
    for (let round = 0; round < 2; round++)
      for (let p = 9; p >= 0; p--) {
        const start = performance.now();
        await tab(page, p).click();
        await expect(editor(page).locator(`.node[data-nodeid="perf-${p}-text-0"]`)).toBeVisible();
        timing('tabs', performance.now() - start);
      }
    await zoom(page, 0);
    for (const drawerOpen of [false, true]) {
      if (drawerOpen) await editor(page).getByRole('button', { name: 'Open Run Activity', exact: true }).click();
      for (let i = 0; i < repetitions; i++) {
        const before = { ...host.apiCounts };
        await controlRun(
          page,
          editor(page).locator('.run-button button').first(),
          drawerOpen ? 'browserOpen' : 'browserClosed',
        );
        await expect(output(page, 0)).toContainText('Project 0 completed');
        const requests = Object.fromEntries(
          Object.entries(host.apiCounts).map(([key, n]) => [key, n - (before[key] || 0)]),
        );
        result.requests.push(requests);
        const count = (action: string) =>
          Object.entries(requests)
            .filter(([key]) => key.includes('/subgraph-projects/') && key.endsWith(`/${action}`))
            .reduce((sum, [, n]) => sum + n, 0);
        expect(count('execution')).toBe(9);
        expect(count('access')).toBe(36);
        console.log(`browser ${drawerOpen ? 'open' : 'closed'} ${i + 1}/${repetitions}`);
      }
      if (drawerOpen) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
        await controlRun(page, editor(page).locator('.run-button button').first());
        console.log('profiled open-drawer run complete');
        await writeFile(
          path.join(directory, 'execution-open.cpuprofile'),
          JSON.stringify((await cdp.send('Profiler.stop')).profile),
        );
        const activity = editor(page).locator('[aria-label="Run Activity"]');
        await expect(activity.locator('.run-activity-row')).toHaveCount(999);
        await expect(activity.locator('.run-activity-row.status-success')).toHaveCount(999);
        await expect(activity).toContainText('Step 0');
        const row = activity.locator('[data-activity-key*="perf-0-text-0"]');
        await row.locator('.run-activity-row-toggle').click();
        console.log('activity output row expanded');
        await row.getByRole('button', { name: 'Open full output', exact: true }).click();
        const fullOutput = editor(page).getByTestId('fullscreen-output-modal');
        await expect(fullOutput).toContainText('Project 0 completed');
        await page.keyboard.press('Escape');
        await expect(fullOutput).toHaveCount(0);
        // Escape also closes the activity surface. Do not wait for a close
        // control that is intentionally gone after keyboard dismissal.
        if (await activity.isVisible())
          await activity.getByRole('button', { name: 'Close Run Activity', exact: true }).click();
      }
    }
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    await controlRun(page, editor(page).locator('.run-button button').first());
    await writeFile(
      path.join(directory, 'execution.cpuprofile'),
      JSON.stringify((await cdp.send('Profiler.stop')).profile),
    );
    console.log('Browser output inspection complete');
    for (const p of [9, 5]) {
      await tab(page, p).click();
      await zoom(page, p);
      await expect(output(page, p)).toContainText(`Project ${p} completed`);
    }
    await tab(page, 0).click();
    debuggerServer = startDebuggerServer({
      port: 0,
      host: '127.0.0.1',
      heartbeatIntervalMs: 0,
      throttlePartialOutputs: 0,
    });
    await once(debuggerServer.webSocketServer, 'listening');
    const debugPort = (debuggerServer.webSocketServer.address() as any).port;
    debuggerServer.webSocketServer.on('connection', (client) =>
      client.on('message', (data) => result.commands.push(data.toString())),
    );
    await editor(page).locator('button.more-menu').click();
    await editor(page).getByRole('button', { name: 'Remote Debugger', exact: true }).click();
    await editor(page).getByPlaceholder('(Default)').fill(`ws://127.0.0.1:${debugPort}/ws/latest-debugger`);
    await editor(page).getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(editor(page).getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
    console.log('Node debugger connected');
    const remote = async (label: string, settle: boolean) => {
      fixture.root.graphs.main.nodes[0].data.text = label;
      const runner = createProcessor(fixture.root, {
        remoteDebugger: debuggerServer,
        subgraphProjectLoader: {
          loadTarget: async (target) => ({ project: fixture.projects.get(target.projectId), revisionKey: 'fixture' }),
        },
      });
      const completed = new Set<string>();
      runner.processor.on('nodeFinish', ({ node }) => completed.add(node.id));
      try {
        const start = performance.now();
        await runner.run();
        await runner.processor.waitForRunCompletion();
        timing('remoteEngine', performance.now() - start);
        expect(completed.size).toBe(999);
        await expect(output(page, 0)).toContainText(label);
        timing(settle ? 'remoteSteadyOutput' : 'remoteBurstOutput', performance.now() - start);
        if (settle) {
          await memberTerminal(page, 9);
          timing('remoteSteadyTerminal', performance.now() - start);
          await tab(page, 0).click();
        }
      } finally {
        await runner.processor.waitForRunCompletion();
        runner.dispose();
      }
    };
    for (let i = 0; i < repetitions; i++) await remote(`Steady ${i} completed`, true);
    for (let i = 0; i < 3; i++) await remote(`Burst ${i} completed`, false);
    for (let p = 9; p > 0; p--) {
      await memberTerminal(page, p);
      if (p === 9 || p === 5) await expect(output(page, p)).toContainText(`Project ${p} completed`);
    }
    await editor(page).getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
    expect(result.commands).toEqual([]);
    console.log('steady and burst debugger runs settled');
    const restoreStart = performance.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    for (let p = 0; p < 10; p++) await expect(tab(page, p)).toBeVisible();
    timing('restoreTabs', performance.now() - restoreStart);
    const recordingStart = performance.now();
    await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
    await page.getByTestId('run-recordings-modal').locator('.run-recordings-run-open-button').click();
    await expect(editor(page).getByRole('region', { name: 'Loaded recording', exact: true })).toBeVisible();
    timing('recordingOpen', performance.now() - recordingStart);
    await zoom(page, 0);
    for (let i = 0; i < repetitions; i++) {
      await controlRun(page, editor(page).getByRole('button', { name: 'Play Recording', exact: true }), 'playback');
      await expect(output(page, 0)).toContainText('Project 0 completed');
    }
    await editor(page).getByRole('button', { name: 'Open Run Activity', exact: true }).click();
    const activity = editor(page).locator('[aria-label="Run Activity"]');
    await expect(activity.locator('.run-activity-row')).toHaveCount(100);
    await expect(activity.locator('.run-activity-row.status-success')).toHaveCount(100);
    await expect(activity).toContainText('Step 0');
    result.activityRows = await activity.locator('.run-activity-row').count();
    await page.screenshot({ path: path.join(directory, 'final.png') });
    console.log('recording playback and activity complete');
    if (process.env.RIVET_EDITOR_BENCH_CHECK_LOADING === '1') {
      const recovery = await context();
      const releaseBootstrap = host.holdEditorBootstrap();
      try {
        await recovery.page.goto(host.url, { waitUntil: 'domcontentloaded' });
        await dashboard(recovery.page);
        await expect(recovery.page.locator('.project-row').filter({ hasText: 'Benchmark 9' })).toBeDisabled();
        expect(
          await recovery.page.evaluate(
            () =>
              document.querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')?.contentWindow
                ?.__rivetEditorBootstrapState,
          ),
        ).not.toBe('ready');
      } finally {
        releaseBootstrap();
      }
      await ready(recovery.page);
      await recovery.page.locator('.project-row').filter({ hasText: 'Benchmark 9' }).dblclick();
      await expect(editor(recovery.page).locator('.node[data-nodeid="perf-9-text-0"]')).toBeVisible();
      result.preReadyAdmissionGuard = true;
      await zoom(recovery.page, 9);
      host.failNextCodeEditor();
      await editor(recovery.page).locator('.node[data-nodeid="perf-9-text-0"] .edit-button').dispatchEvent('click');
      const retry = editor(recovery.page).getByRole('button', { name: 'Retry code editor', exact: true });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(editor(recovery.page).locator('.monaco-editor .view-lines').first()).toContainText(
        'Project 9 completed',
      );
      await recovery.page.keyboard.press('Escape');
      await editor(recovery.page).locator('.node[data-nodeid="perf-9-text-0"] .edit-button').dispatchEvent('click');
      await expect(retry).toHaveCount(0);
      await expect(editor(recovery.page).locator('.monaco-editor .view-lines').first()).toContainText(
        'Project 9 completed',
      );
      result.lazyRecovery = true;
      await recovery.page.keyboard.press('Escape');
      const recoveryEditor = editor(recovery.page);
      await recoveryEditor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
      const recoveryActivity = recoveryEditor.locator('[aria-label="Run Activity"]');
      await recoveryActivity.getByRole('button', { name: 'Show Run Activity filters', exact: true }).click();
      const search = recoveryActivity.getByRole('searchbox', { name: 'Search Run Activity by node title or metadata' });
      await search.fill('Remember this filter');
      await recoveryActivity.getByRole('checkbox', { name: 'Follow live', exact: true }).uncheck();
      await recoveryActivity.getByRole('button', { name: 'Close Run Activity', exact: true }).click();
      await recoveryEditor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
      await expect(search).toHaveValue('Remember this filter');
      await expect(recoveryActivity.getByRole('checkbox', { name: 'Follow live', exact: true })).not.toBeChecked();
      result.drawerPreferences = true;
      await recovery.c.close();
    }
    expect(result.errors).toEqual([]);
    result.passed = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    result.apiCounts = host.apiCounts;
    result.unknown = host.unknown;
    await finalizeBenchmark(
      [
        () => writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2)),
        ...contexts.map((c) => () => c.close()),
        async () => {
          if (!debuggerServer) return;
          for (const client of debuggerServer.webSocketServer.clients) client.terminate();
          await new Promise((resolve, reject) =>
            debuggerServer!.webSocketServer.close((error) => (error ? reject(error) : resolve(undefined))),
          );
        },
        () => host.close(),
      ],
      primaryError,
    );
  }
});
