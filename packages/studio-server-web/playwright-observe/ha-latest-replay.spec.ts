import { expect, test } from '@playwright/test';
import {
  createBuiltInRegistry,
  NodeRegistration,
  type ChartNode,
  type Inputs,
  type InternalProcessContext,
  type Project,
  type GraphId,
  type ProjectId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { createProcessor } from '../../node/src/api.js';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { createLatestDebuggerFixture } from './helpers/latestDebuggerFixture';

for (const ha of [true, false])
  test(`${ha ? 'HA large-history' : 'local'} remote debugger stays usable through repeated observation`, async ({
    page,
  }) => {
    const fixture = await createLatestDebuggerFixture({ ha });
    const { debuggerServer, peerDebugger, commands } = fixture;
    let receivedFrames = 0;
    page.on('websocket', (socket) => socket.on('framereceived', () => receivedFrames++));
    const defaults = createBuiltInRegistry();
    const node = defaults.createDynamic('text');
    node.title = 'Remote source';
    node.data.text = 'First live result';
    node.visualData = { x: 100, y: 150, width: 300 };
    const result = defaults.createDynamic('graphOutput');
    result.data.id = 'result';
    result.visualData = { x: 600, y: 150, width: 250 };
    const graph = {
      metadata: { id: 'main' as GraphId, name: 'Main Graph' },
      nodes: [node, result],
      connections: [
        {
          outputNodeId: node.id,
          outputId: 'output' as PortId,
          inputNodeId: result.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const project: Project = {
      metadata: { id: 'replay-ui' as ProjectId, title: 'Replay UI', description: '', mainGraphId: graph.metadata.id },
      graphs: { main: graph },
      plugins: [],
    };
    let releaseRun: (() => void) | undefined;
    let holdRun = false;
    let largeResult = false;
    const TextBase = defaults.getNodeConstructors().find((ctor) => ctor.create().type === 'text')!;
    class StreamingText extends TextBase {
      async process(_inputs: Inputs, context: InternalProcessContext) {
        if (holdRun) {
          context.onPartialOutputs?.({ output: { type: 'string', value: 'Second live streaming' } });
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
        }
        return {
          output: {
            type: 'string' as const,
            value: largeResult ? 'x'.repeat(33 * 1024 * 1024) : String(node.data.text),
          },
        };
      }
    }
    const registry = new NodeRegistration<string, ChartNode>();
    for (const ctor of defaults.getNodeConstructors())
      registry.register({ impl: ctor.create().type === 'text' ? StreamingText : ctor, displayName: 'Fixture' });
    const runner = createProcessor(project, { remoteDebugger: debuggerServer, registry });
    const peerRunner = peerDebugger ? createProcessor(project, { remoteDebugger: peerDebugger, registry }) : undefined;
    let activeRun: ReturnType<typeof runner.run> | undefined;
    const historySequence = ha ? fixture.warmHistory() : 0;
    try {
      if (ha) {
        await expect.poll(fixture.ready).toBe(true);
        await expect.poll(fixture.peerSequence).toBeGreaterThanOrEqual(historySequence);
      }
      await seedHostedEditorProject(page, {
        graphId: 'main',
        projectId: 'replay-ui',
        title: 'Replay UI',
        loaded: true,
        projectPath: '/workflows/Replay UI.rivet-project',
        graph,
      });
      await page.addInitScript(() =>
        localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
      );
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => route.fulfill({ status: 503, json: { error: 'No ambient API allowed' } }),
      );
      await mockHostedEditorBootstrap(page);
      await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.node-canvas').first()).toBeVisible();
      const connect = async () => {
        await page.locator('button.more-menu').click();
        await page.getByRole('button', { name: 'Remote Debugger', exact: true }).click();
        await page.getByPlaceholder('(Default)').fill(`ws://127.0.0.1:${fixture.port}/ws/latest-debugger`);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
      };
      await connect();
      if (ha) {
        await expect(page.getByText(/Latest debugger history was truncated/)).toBeVisible();
        await expect.poll(() => receivedFrames).toBeGreaterThanOrEqual(33);
      }
      const output = page.locator(`.node[data-nodeid="${node.id}"] .node-output`);
      await runner.run();
      await expect(output).toContainText('First live result');
      if (peerRunner) {
        node.data.text = 'Other backend result';
        await peerRunner.run();
        await expect(output).toContainText('Other backend result');
      }
      node.data.text = 'Second live result';
      if (ha) {
        holdRun = true;
        activeRun = runner.run();
        void activeRun.catch(() => {});
        await expect(output).toContainText('Second live streaming');
        // A network loss must resume diagnostics, never resubmit a run or turn
        // the truncation notice into a graph-terminal error.
        // Reconnect through the same URL, but onto the other backend, as a
        // production load balancer may do. Per-owner IDs must still dedupe.
        fixture.routeToOwner(0);
        fixture.disconnectObservers();
        await expect.poll(fixture.connectionCount).toBe(2);
        await expect.poll(() => receivedFrames).toBeGreaterThan(65);
        await expect(output).toContainText('Second live streaming');
        releaseRun!();
        await activeRun;
      } else {
        await page.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
        await connect();
        await runner.run();
      }
      await expect(output).toContainText('Second live result');
      if (ha) {
        holdRun = false;
        largeResult = true;
        const actual = await runner.run();
        expect(actual.result.value).toHaveLength(33 * 1024 * 1024);
        await expect(page.getByText(/Some diagnostic values were omitted/)).toBeVisible();
        await expect(page.locator(`.node[data-nodeid="${node.id}"]`)).toHaveClass(/success/);
        await expect(page.locator('.run-button.running')).toHaveCount(0);
        await expect(page.locator('.pause-button')).toHaveCount(0);
        largeResult = false;
        node.data.text = 'After oversized completion';
        await runner.run();
        await expect(output).toContainText('After oversized completion');
      }
      await expect(page.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toBeVisible();
      await expect(page.getByText(/Graph execution error/)).toHaveCount(0);
      expect(fixture.connectionCount()).toBe(2);
      expect(commands).toEqual([]);
      await page.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
    } finally {
      releaseRun?.();
      await activeRun?.catch(() => {});
      await page.goto('about:blank');
      runner.dispose();
      peerRunner?.dispose();
      await fixture.close();
    }
  });
