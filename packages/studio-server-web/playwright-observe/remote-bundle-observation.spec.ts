import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import {
  createBuiltInRegistry,
  NodeRegistration,
  serializeProject,
  type ChartNode,
  type GraphId,
  type Project,
  type ProjectId,
  type NodeId,
  type PortId,
  type Inputs,
  type InternalProcessContext,
} from '@valerypopoff/rivet2-core';
import { createProcessor } from '../../node/src/api.js';
import { startDebuggerServer } from '../../node/src/debugger.js';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { createLatestDebuggerFixture } from './helpers/latestDebuggerFixture';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const outcome of [
  'completion',
  'failure',
  'abort',
  'shared stop',
  'mixed versions',
  'source reopen',
  'outside caller',
  'external dependency',
  'member deleted',
  'HA replay',
  'HA replay failure',
  'HA replay shared stop',
] as const) {
  test(`one remote connection shows A → B → C ${outcome} without child controls or ID collisions`, async ({ page }) => {
    const defaults = createBuiltInRegistry();
    const gates = new Map(['a', 'b', 'c'].map((id) => [id, gate()]));
    const cleanupGate = gate();
    const started = new Set<string>();
    const TextBase = defaults.getNodeConstructors().find((ctor) => ctor.create().type === 'text')!;
    class StreamingText extends TextBase {
      async process(_inputs: Inputs, context: InternalProcessContext) {
        const owner = context.project.metadata.id;
        started.add(owner);
        context.onPartialOutputs?.({ output: { type: 'string', value: `${owner.toUpperCase()} streaming` } });
        await gates.get(owner)!.promise;
        if ((outcome === 'failure' || outcome === 'HA replay failure') && owner === 'c')
          throw new Error('Fixture C failure');
        if (outcome === 'abort' && owner === 'c') {
          context.reportProgress({ message: 'C cleanup diagnostics after abort', percent: 90 });
          await cleanupGate.promise;
        }
        return { output: { type: 'string' as const, value: `${owner.toUpperCase()} done` } };
      }
    }
    const registry = new NodeRegistration<string, ChartNode>();
    for (const ctor of defaults.getNodeConstructors())
      registry.register({ impl: ctor.create().type === 'text' ? StreamingText : ctor, displayName: 'Fixture' });
    const projects = new Map<string, Project>();
    for (const [id, next] of [
      ['a', 'b'],
      ['b', 'c'],
      ['c', ''],
      ['d', ''],
    ] as const) {
      const text = defaults.createDynamic('text');
      text.id = 'shared-node' as NodeId;
      text.title = `${id.toUpperCase()} source`;
      text.data.text = 'Runtime fixture';
      text.visualData = { x: 70, y: 200, width: 250 };
      const output = defaults.createDynamic('graphOutput');
      output.id = 'shared-output' as NodeId;
      output.data.id = 'value';
      output.data.dataType = 'string';
      output.visualData = { x: 800, y: 200, width: 200 };
      const nodes: ChartNode[] = [text, output];
      let producer = text.id,
        port = 'output';
      if (next) {
        const call = defaults.createDynamic('subGraph');
        call.id = 'shared-call' as NodeId;
        call.title = `Call ${next.toUpperCase()}`;
        call.data = { graphId: 'main', targetProjectId: next, targetVersion: 'latest' };
        call.visualData = { x: 400, y: 200, width: 220 };
        nodes.push(call);
        if (id === 'a' && outcome === 'mixed versions') {
          nodes.push({
            ...call,
            id: 'published-call' as NodeId,
            title: 'Call B published',
            data: { ...call.data, targetVersion: 'published' },
            visualData: { x: 400, y: 400, width: 220 },
          });
        }
        producer = call.id;
        port = 'value';
      }
      projects.set(id, {
        metadata: {
          id: id as ProjectId,
          title: `Project ${id.toUpperCase()}`,
          description: '',
          mainGraphId: 'main' as GraphId,
        },
        graphs: {
          main: {
            metadata: { id: 'main' as GraphId, name: 'Main Graph' },
            nodes,
            connections: [
              { outputNodeId: producer, outputId: port as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
            ],
          },
        },
        plugins: [],
      });
    }
    const ha = outcome.startsWith('HA replay');
    const fixture = ha ? await createLatestDebuggerFixture({ ha: true, throttlePartialOutputs: 0 }) : undefined;
    const debuggerServer =
      fixture?.debuggerServer ??
      startDebuggerServer({
        port: 0,
        host: '127.0.0.1',
        heartbeatIntervalMs: 0,
        throttlePartialOutputs: 0,
      });
    let port = fixture?.port;
    if (!fixture) {
      await once(debuggerServer.webSocketServer, 'listening');
      const address = debuggerServer.webSocketServer.address();
      if (typeof address === 'string') throw new Error('Missing debugger address');
      port = address.port;
    }
    const commands: string[] = fixture?.commands ?? [];
    const clientCount = () => fixture?.clientCount() ?? debuggerServer.webSocketServer.clients.size;
    if (!fixture)
      debuggerServer.webSocketServer.on('connection', (client) =>
        client.on('message', (data) => commands.push(data.toString())),
      );
    const runner = createProcessor(projects.get('a')!, {
      registry,
      remoteDebugger: debuggerServer,
      subgraphProjectLoader: {
        loadTarget: async (target) => ({ project: projects.get(target.projectId)!, revisionKey: 'fixture' }),
      },
    });
    let run: ReturnType<typeof runner.run> | undefined;
    let memberDeleted = false;
    try {
      if (fixture) {
        const history = fixture.warmHistory();
        await expect.poll(fixture.ready).toBe(true);
        await expect.poll(fixture.peerSequence).toBeGreaterThanOrEqual(history);
      }
      if (outcome === 'member deleted') {
        await page.addInitScript(() => {
          class TreeEventSource extends EventTarget {
            private changed = () =>
              this.dispatchEvent(
                new MessageEvent('tree-changed', {
                  data: JSON.stringify({ epoch: 'bundle-fixture', revision: 1, sourceClientId: 'other-user' }),
                }),
              );
            constructor(_url: string) {
              super();
              window.addEventListener('fixture-delete-member', this.changed);
            }
            close() {
              window.removeEventListener('fixture-delete-member', this.changed);
            }
          }
          Object.defineProperty(window, 'EventSource', { configurable: true, value: TreeEventSource });
        });
      }
      await page.addInitScript(() =>
        localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
      );
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => route.fulfill({ status: 503, json: { error: 'No ambient API in fixture' } }),
      );
      await mockHostedEditorBootstrap(page);
      const paths = new Map(
        [...projects].map(([id, project]) => [`/workflows/Project ${id.toUpperCase()}.rivet-project`, project]),
      );
      await page.route('**/api/workflows/tree', (route) =>
        route.fulfill({
          json: {
            root: '/workflows',
            folders: [],
            sync: { epoch: 'bundle-fixture', revision: memberDeleted ? 1 : 0 },
            projects: [...paths]
              .filter(([, project]) => !memberDeleted || project.metadata.id !== 'b')
              .map(([absolutePath, project]) => ({
                id: project.metadata.id,
                projectMetadataId: project.metadata.id,
                bundleId:
                  project.metadata.id === 'd' ||
                  (outcome === 'outside caller' && project.metadata.id === 'a') ||
                  (outcome === 'external dependency' && project.metadata.id === 'c')
                    ? null
                    : '58019223-bd4e-49c3-a042-321215efaa35',
                name: project.metadata.title,
                fileName: absolutePath.split('/').pop(),
                absolutePath,
                relativePath: absolutePath.slice('/workflows/'.length),
                updatedAt: '2026-10-19T00:00:00Z',
                settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
              })),
          },
        }),
      );
      await page.route('**/api/projects/load', (route) =>
        route.fulfill({
          json: {
            contents: serializeProject(paths.get(route.request().postDataJSON().path)!),
            datasetsContents: null,
            revisionId: null,
          },
        }),
      );
      await page.route('**/api/workflows/subgraph-projects/*/preview?*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
        return route.fulfill({ json: { project: projects.get(id) } });
      });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      const editor = page.frameLocator('iframe.dashboard-editor-frame');
      const infoButton = editor.getByRole('button', { name: 'Remote Debugger details', exact: true });
      const details = editor.getByTestId('remote-debugger-details');
      const showDetails = async (text: string) => {
        await infoButton.click();
        await expect(details).toHaveAttribute('role', 'status');
        await expect(details).toContainText(text);
        await editor.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(details).toHaveCount(0);
        await expect(infoButton).toBeFocused();
      };
      const tab = (id: string) =>
        editor.locator('.projects-container .project:not(.opening)').filter({ hasText: `Project ${id.toUpperCase()}` });
      for (const id of ['d', 'c', 'b', 'a']) {
        await page
          .locator('.project-row')
          .filter({ hasText: `Project ${id.toUpperCase()}` })
          .dblclick();
        await expect(editor.locator('.node[data-nodeid="shared-node"]')).toBeVisible();
      }
      if (outcome === 'member deleted') {
        await tab('b').click();
        const title = editor.locator('.node[data-nodeid="shared-node"] .node-title');
        const box = (await title.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2 + 40, { steps: 8 });
        await page.mouse.up();
        await expect(tab('b')).toHaveClass(/has-unsaved-changes/);
      }
      const connectFrom =
        outcome === 'completion' || outcome === 'source reopen' || ha
          ? 'c'
          : outcome === 'mixed versions' || outcome === 'outside caller'
            ? 'b'
            : 'a';
      await tab(connectFrom).click();
      await editor.locator('button.more-menu').click();
      await editor.getByRole('button', { name: 'Remote Debugger', exact: true }).click();
      await editor.getByPlaceholder('(Default)').fill(`ws://127.0.0.1:${port}/ws/latest-debugger`);
      await editor.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(editor.getByText('Stop Remote Debugger', { exact: true })).toBeVisible();
      await expect(infoButton).toHaveText('?');
      await expect(details).toHaveCount(0);
      const infoBox = (await infoButton.boundingBox())!;
      const stopBox = (await editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).boundingBox())!;
      const moreBox = (await editor.locator('button.more-menu').boundingBox())!;
      expect(Math.round(infoBox.width)).toBe(Math.round(moreBox.width));
      expect(Math.round(infoBox.height)).toBe(Math.round(moreBox.height));
      for (const property of ['font-family', 'font-size', 'font-weight']) {
        const expected = await editor
          .getByRole('button', { name: 'Stop Remote Debugger', exact: true })
          .evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property);
        await expect(infoButton).toHaveCSS(property, expected);
      }
      expect(infoBox.x + infoBox.width).toBeLessThan(stopBox.x);
      expect(stopBox.x + stopBox.width).toBeLessThan(moreBox.x);
      await showDetails('Remote Debugger is active. Execution details will appear here when available.');
      await infoButton.click();
      await editor.getByRole('button', { name: 'Done', exact: true }).press('Escape');
      await expect(details).toHaveCount(0);
      await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
      if (outcome === 'completion') {
        await infoButton.click();
        await expect(details).toBeVisible();
        // The outer dashboard remains a project-navigation surface while an
        // editor-iframe modal is open. Its state must not leak into another tab.
        await page.locator('.project-row').filter({ hasText: 'Project D' }).dblclick();
        await expect(details).toHaveCount(0);
        await expect(infoButton).toHaveCount(0);
        await tab(connectFrom).click();
        await expect(infoButton).toHaveAttribute('aria-expanded', 'false');
        await expect(details).toHaveCount(0);
      }
      if (ha) await expect(editor.getByText(/Latest debugger history was truncated/)).toBeVisible();
      const members =
        outcome === 'outside caller' ? ['b', 'c'] : outcome === 'external dependency' ? ['a', 'b'] : ['a', 'b', 'c'];
      for (const id of members) {
        await tab(id).click();
        await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
      }
      await tab('d').click();
      await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
      await tab('a').click();
      await expect.poll(clientCount).toBe(1);
      run = runner.run();
      void run.catch(() => {});
      await expect.poll(() => [...started].sort().join(',')).toBe('a,b,c');
      const output = editor.locator('.node[data-nodeid="shared-node"] .node-output');
      if (outcome === 'outside caller' || outcome === 'external dependency') {
        const outside = outcome === 'outside caller' ? 'a' : 'c';
        await tab(outside).click();
        await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
        await expect(editor.locator('.node[data-nodeid="shared-node"]')).not.toContainText(
          `${outside.toUpperCase()} streaming`,
        );
        await tab('b').click();
        await expect(output).toContainText('B streaming');
        for (const gate of gates.values()) gate.release();
        await run;
        await expect(output).toContainText('B done');
        await editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
        expect(commands).toEqual([]);
        return;
      }
      await expect(output).toContainText('A streaming');
      await tab('b').click();
      await expect(output).toContainText('B streaming');
      await expect(output).not.toContainText('C streaming');
      await expect(editor.getByText('through Project A — view only', { exact: false })).toHaveCount(0);
      await infoButton.click();
      await expect(details).toContainText('through Project A — view only');
      if (outcome === 'mixed versions') await expect(details).toContainText('Runtime target: latest and published.');
      await expect(editor.locator('.run-button')).toHaveCount(0);
      await editor.getByRole('button', { name: 'Go to debugger source: Project A' }).click();
      await expect(details).toHaveCount(0);
      await expect(output).toContainText('A streaming');
      await tab('b').click();
      await page.keyboard.press('Control+Enter');
      await expect(output).toContainText('B streaming');
      await tab('c').click();
      await expect(output).toContainText('C streaming');
      if (fixture) {
        // Evict the active run's cached start while its live projection is
        // already admitted, then resume the same logical bundle on owner 0.
        const history = fixture.warmHistory();
        await expect.poll(fixture.peerSequence).toBeGreaterThanOrEqual(history);
        await infoButton.click();
        await expect(details).toContainText('through Project A — view only');
        fixture.routeToOwner(0);
        fixture.disconnectObservers();
        await expect.poll(fixture.connectionCount).toBe(2);
        await expect.poll(clientCount).toBe(1);
        await expect(details).toContainText('through Project A — view only');
        await editor.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(details).toHaveCount(0);
        for (const id of ['a', 'b', 'c']) {
          await tab(id).click();
          await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
          await expect(output).toContainText(`${id.toUpperCase()} streaming`);
        }
        await expect(editor.getByText(/Graph execution error/)).toHaveCount(0);
        await tab('d').click();
        await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
        await expect(editor.locator('.node[data-nodeid="shared-node"]')).not.toContainText('C streaming');
        await tab('c').click();
      }
      if (outcome === 'member deleted') {
        memberDeleted = true;
        await page.evaluate(() => window.dispatchEvent(new Event('fixture-delete-member')));
        await expect(page.locator('.project-row').filter({ hasText: 'Project B' })).toHaveCount(0);
        await tab('b').click();
        await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
        await showDetails('This project no longer belongs to this Remote Debugger session.');
        await expect(editor.locator('.run-button').first()).toBeVisible();
        await expect(tab('b')).toHaveClass(/has-unsaved-changes/);
        await expect(output).toContainText('B streaming');
        expect(runner.processor.isRunning).toBe(true);
        expect(clientCount()).toBe(1);
        for (const item of gates.values()) item.release();
        await run;
        await expect(output).not.toContainText('B done');
        await tab('c').click();
        await expect(output).toContainText('C done');
        await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
        await editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
        await expect.poll(clientCount).toBe(0);
        expect(commands).toEqual([]);
        return;
      }
      if (outcome === 'source reopen') {
        await tab('a').hover();
        await tab('a').getByRole('button', { name: 'Close Project A', exact: true }).click();
        await expect(tab('a')).toHaveCount(0);
        await page.locator('.project-row').filter({ hasText: 'Project A' }).dblclick();
        await expect(tab('a')).toBeVisible();
        await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
        const sourceNode = editor.locator('.node[data-nodeid="shared-node"]');
        await expect(sourceNode).toBeVisible();
        await expect(sourceNode).not.toContainText('A streaming');
        await tab('c').click();
        gates.get('c')!.release();
        await expect(output).toContainText('C done');
        await tab('b').click();
        gates.get('b')!.release();
        await expect(output).toContainText('B done');
        await tab('a').click();
        gates.get('a')!.release();
        await run;
        await expect(sourceNode).not.toContainText('A done');
        await editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
        await expect.poll(clientCount).toBe(0);
        expect(commands).toEqual([]);
        return;
      }
      if (outcome === 'abort') {
        const aborting = runner.processor.abort();
        void aborting.catch(() => {});
        gates.get('c')!.release();
        await editor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
        const drawer = editor.locator('[aria-label="Run Activity"]');
        await drawer
          .locator('.run-activity-row')
          .filter({ hasText: 'C source' })
          .locator('.run-activity-row-toggle')
          .click();
        await expect(drawer).toContainText('C cleanup diagnostics after abort');
        cleanupGate.release();
        for (const item of gates.values()) item.release();
        await aborting;
        await expect(run).rejects.toThrow();
        await showDetails('Remote run interrupted');
        expect(commands).toEqual([]);
        return;
      }
      if (outcome === 'shared stop' || outcome === 'HA replay shared stop') {
        await tab('b').click();
        await editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
        await expect(infoButton).toHaveCount(0);
        await expect(details).toHaveCount(0);
        await expect(editor.locator('.run-button').first()).toBeVisible();
        expect(runner.processor.isRunning).toBe(true);
        for (const id of ['a', 'c']) {
          await tab(id).click();
          await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
        }
        for (const item of gates.values()) item.release();
        await run;
        await expect(editor.locator('.run-button').first()).toBeVisible();
        await expect(infoButton).toHaveCount(0);
        expect(commands).toEqual([]);
        return;
      }
      if (outcome === 'failure' || outcome === 'HA replay failure') {
        for (const item of gates.values()) item.release();
        await expect(run).rejects.toThrow('failed to process');
        await showDetails('Remote run interrupted');
        await expect(editor.locator('.node[data-nodeid="shared-node"]')).toContainText('Fixture C failure');
        await editor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
        await expect(editor.locator('[aria-label="Run Activity"]')).toContainText('C source');
        expect(clientCount()).toBe(1);
        expect(commands).toEqual([]);
        return;
      }
      gates.get('c')!.release();
      await expect(output).toContainText('C done');
      await tab('b').click();
      gates.get('b')!.release();
      await expect(output).toContainText('B done');
      await tab('c').click();
      await infoButton.click();
      gates.get('a')!.release();
      await run;
      await expect(details).toContainText('Remote run completed.');
      if (outcome === 'completion') {
        await page.screenshot({ path: test.info().outputPath('remote-debugger-details.png'), animations: 'disabled' });
      }
      await editor.getByRole('button', { name: 'Close modal', exact: true }).click();
      await expect(details).toHaveCount(0);
      await tab('a').click();
      await expect(output).toContainText('A done');
      await editor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
      await expect(editor.locator('[aria-label="Run Activity"]')).toContainText('B source');
      await expect(editor.locator('[aria-label="Run Activity"]')).toContainText('C source');
      await editor
        .locator('[aria-label="Run Activity"]')
        .getByRole('button', { name: 'Close Run Activity', exact: true })
        .click();
      await tab('c').click();
      await expect(output).toContainText('C done');
      await editor.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
      await expect(editor.locator('[aria-label="Run Activity"]')).toContainText('C source');
      await editor
        .locator('[aria-label="Run Activity"]')
        .getByRole('button', { name: 'Close Run Activity', exact: true })
        .click();
      await tab('d').click();
      await expect(infoButton).toHaveCount(0);
      await expect(editor.locator('.node[data-nodeid="shared-node"]')).not.toContainText('C done');
      await tab('b').click();
      await editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
      await expect(infoButton).toHaveCount(0);
      await expect(editor.locator('.run-button').first()).toBeVisible();
      expect(commands).toEqual([]);
      await expect.poll(clientCount).toBe(0);
      await tab('a').click();
      await expect(editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
      await tab('c').click();
      await expect(infoButton).toHaveCount(0);
      await expect(output).toContainText('C done');
    } finally {
      cleanupGate.release();
      for (const item of gates.values()) item.release();
      if (runner.processor.isRunning) await runner.processor.abort();
      await run?.catch(() => {});
      runner.dispose();
      if (fixture) await fixture.close();
      else {
        for (const client of debuggerServer.webSocketServer.clients) client.terminate();
        await new Promise<void>((resolve) => debuggerServer.webSocketServer.close(() => resolve()));
      }
    }
  });
}
