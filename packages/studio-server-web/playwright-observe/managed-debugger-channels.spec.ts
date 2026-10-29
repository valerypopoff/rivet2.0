import { expect, test, type Page } from '@playwright/test';
import {
  createBuiltInRegistry,
  NodeRegistration,
  serializeProject,
  type ChartNode,
  type Project,
  type ProjectId,
  type GraphId,
  type NodeId,
  type PortId,
  type Inputs,
  type InternalProcessContext,
  type GraphExecutionMetadata,
} from '@valerypopoff/rivet2-core';
import { createProcessor } from '../../node/src/api.js';
import { createLatestDebuggerFixture } from './latestDebuggerFixture';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

function projects(bundle: boolean) {
  const registry = createBuiltInRegistry(),
    result = new Map<string, Project>();
  for (const [id, child] of bundle
    ? [
        ['a', 'b'],
        ['b', 'c'],
        ['c', ''],
      ]
    : [['a', '']]) {
    const text = registry.createDynamic('text');
    text.id = 'shared-node' as NodeId;
    text.title = `${id} source`;
    text.data.text = 'Fixture';
    text.visualData = { x: 40, y: 100, width: 260 };
    const output = registry.createDynamic('graphOutput');
    output.id = 'output' as NodeId;
    output.data.id = 'value';
    output.data.dataType = 'string';
    output.visualData = { x: 750, y: 100, width: 220 };
    const nodes: ChartNode[] = [text, output];
    let producer = text.id,
      port = 'output';
    if (child) {
      const call = registry.createDynamic('subGraph');
      call.id = 'call' as NodeId;
      call.data = { graphId: 'main', targetProjectId: child, targetVersion: 'latest' };
      call.visualData = { x: 400, y: 100, width: 240 };
      nodes.push(call);
      producer = call.id;
      port = 'value';
    }
    result.set(id!, {
      metadata: {
        id: id as ProjectId,
        title: `Project ${id!.toUpperCase()}`,
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
  return result;
}

async function openDebugger(
  page: Page,
  items: Map<string, Project>,
  port: number,
  channel: string | null,
  encoded = false,
) {
  let outputReadyFrames = 0;
  const observedEvents: Array<{ message: string; rivetScope?: unknown; rivetHistory?: true | 'peer' }> = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.message === 'graphOutputsReady') outputReadyFrames++;
        if (frame.message)
          observedEvents.push({
            message: frame.message,
            rivetScope: frame.rivetScope,
            rivetHistory: frame.rivetHistory,
          });
      } catch {
        /* Vite's websocket is not the debugger transport. */
      }
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 503, json: { error: 'No ambient API' } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        folders: [],
        projects: [...items.values()].map((project) => ({
          id: project.metadata.id,
          projectMetadataId: project.metadata.id,
          name: project.metadata.title,
          fileName: `${project.metadata.title}.rivet-project`,
          absolutePath: `/workflows/${project.metadata.title}.rivet-project`,
          relativePath: `${project.metadata.title}.rivet-project`,
          bundleId: items.size > 1 ? '58019223-bd4e-49c3-a042-321215efaa35' : null,
          updatedAt: '2026-10-29T00:00:00Z',
          settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
        })),
      },
    }),
  );
  await page.route('**/api/projects/load', (route) => {
    const path = route.request().postDataJSON().path;
    const project = [...items.values()].find(
      (project) => path === `/workflows/${project.metadata.title}.rivet-project`,
    )!;
    return route.fulfill({ json: { contents: serializeProject(project), datasetsContents: null, revisionId: null } });
  });
  await page.route('**/api/workflows/subgraph-projects/*/preview?*', (route) =>
    route.fulfill({ json: { project: items.get(new URL(route.request().url()).pathname.split('/').at(-2)!) } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  for (const project of [...items.values()].reverse()) {
    await page.locator('.project-row').filter({ hasText: project.metadata.title }).dblclick();
    await expect(editor.locator('.node[data-nodeid="shared-node"]')).toBeVisible();
  }
  const picker = editor.getByRole('combobox', { name: 'Debugger run', exact: true });
  const info = editor.getByRole('button', { name: 'Remote Debugger details', exact: true });
  const details = editor.getByRole('dialog').filter({ has: editor.getByTestId('remote-debugger-details') });
  const closeDetails = async () => {
    await details.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(picker).toHaveCount(0);
  };
  const connect = async () => {
    await editor.locator('button.more-menu').click();
    await editor.getByRole('button', { name: 'Remote Debugger', exact: true }).click();
    await editor
      .getByPlaceholder('(Default)')
      .fill(`ws://127.0.0.1:${port}/ws/latest-debugger${channel === null ? '' : `${encoded ? '%40' : '@'}${channel}`}`);
    await editor.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(info).toBeVisible();
    await expect(picker).toHaveCount(0);
    await info.click();
    await expect(details).toContainText(`Channel: ${channel ?? 'default'}`);
    await expect(picker).toBeVisible();
    await closeDetails();
  };
  await connect();
  return {
    connect,
    outputReadyFrames: () => outputReadyFrames,
    observedEvents,
    editor,
    output: editor.locator('.node[data-nodeid="shared-node"] .node-output'),
    selectRun: async (option: { index: number }) => {
      await info.click();
      await picker.selectOption(option);
      await closeDetails();
    },
    followNewest: async () => {
      await info.click();
      await details.getByRole('button', { name: 'Follow newest', exact: true }).click();
      await closeDetails();
    },
    expectIncomplete: async () => {
      await info.click();
      await expect(details.getByText('Retained history is incomplete.', { exact: true })).toBeVisible();
      await closeDetails();
    },
    expectRunStatus: async (status: string) => {
      await info.click();
      await expect(picker).toContainText(status);
      await closeDetails();
    },
    expectWaiting: async (historyCount: number) => {
      await info.click();
      await expect(picker).toHaveValue('');
      await expect(picker.locator('option:checked')).toHaveText('Waiting for a new run');
      await expect(picker.locator('option').filter({ hasText: 'History' })).toHaveCount(historyCount);
      await closeDetails();
    },
  };
}

for (const ha of [false, true]) {
  test(`${ha ? 'HA named' : 'standalone default'} debugger waits after explicit connect and recovers after a dropped socket`, async ({
    page,
  }) => {
    const fixture = await createLatestDebuggerFixture({ ha, managed: true, throttlePartialOutputs: 0 });
    const items = projects(false);
    const defaults = createBuiltInRegistry();
    const Base = defaults.getNodeConstructors().find((ctor) => ctor.create().type === 'text')!;
    let calls = 0;
    let hold = false;
    let release = () => {};
    class CountingText extends Base {
      async process(_inputs: Inputs, context: InternalProcessContext) {
        const value = `Invocation ${++calls}`;
        if (hold) {
          context.onPartialOutputs?.({ output: { type: 'string', value: `${value} streaming` } });
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { output: { type: 'string' as const, value: `${value} done` } };
      }
    }
    const registry = new NodeRegistration<string, ChartNode>();
    for (const ctor of defaults.getNodeConstructors())
      registry.register({ impl: ctor.create().type === 'text' ? CountingText : ctor, displayName: 'Fixture' });
    const runner = createProcessor(items.get('a')!, {
      registry,
      remoteDebugger: fixture.forChannel(ha ? '00123' : null),
    });
    let active: Promise<unknown> | undefined;
    try {
      await expect.poll(fixture.ready).toBe(true);
      if (ha) await fixture.pausePeers();
      await runner.run();
      let firstTransport = true;
      await page.routeWebSocket(/\/ws\/latest-debugger/, (socket) => {
        const server = socket.connectToServer();
        if (!firstTransport) return;
        firstTransport = false;
        let closed = false;
        server.onMessage((raw) => {
          if (closed) return;
          const frame = JSON.parse(String(raw));
          if (frame.rivetScope) {
            // Interrupt initial catch-up before admitting the old start.
            closed = true;
            server.close();
            socket.close({ code: 1012, reason: 'initial history interrupted' });
          } else {
            socket.send(raw);
            if (frame.message === 'latest-session') socket.send(raw);
          }
        });
      });
      const view = await openDebugger(page, items, fixture.port, ha ? '00123' : null);
      if (ha) fixture.resumePeers();
      await expect.poll(fixture.connectionCount).toBe(2);
      await view.expectWaiting(1);
      await view.expectRunStatus('completed · History');
      await expect(view.output).toHaveCount(0);
      expect(calls).toBe(1);
      await view.selectRun({ index: 1 });
      await expect(view.output).toContainText('Invocation 1 done');
      await expect(view.editor.getByRole('status', { name: 'Node running', exact: true })).toHaveCount(0);

      await view.editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
      await view.connect();
      await expect.poll(fixture.connectionCount).toBe(3);
      await view.expectWaiting(1);
      await view.expectRunStatus('completed · History');
      await expect(view.output).toContainText('Invocation 1 done');
      await expect(view.editor.getByRole('status', { name: 'Node running', exact: true })).toHaveCount(0);
      expect(calls).toBe(1, 'manual reconnect did not execute the workflow again');

      hold = true;
      active = runner.run();
      await expect(view.output).toContainText('Invocation 2 streaming');
      await expect(view.editor.getByRole('status', { name: 'Node running', exact: true })).toBeVisible();
      if (ha) fixture.routeToOwner(0);
      fixture.disconnectObservers();
      await expect.poll(fixture.connectionCount).toBe(4);
      await expect(view.output).toContainText('Invocation 2 streaming');
      await expect(view.editor.getByRole('button', { name: /Pause/ }).first()).toBeEnabled();
      release();
      await active;
      await expect(view.output).toContainText('Invocation 2 done');
      await expect(view.editor.getByRole('status', { name: 'Node running', exact: true })).toHaveCount(0);
      expect(calls).toBe(2, 'automatic recovery preserves the original physical execution');
      expect(fixture.commands).toEqual([], 'history and reconnection send no execution, abort or control commands');
    } finally {
      release();
      await active?.catch(() => {});
      runner.dispose();
      await fixture.close();
    }
  });
}

test('mixed predecessor default history reaches the managed browser without entering a named channel', async ({
  browser,
}) => {
  const fixture = await createLatestDebuggerFixture({ ha: true, managed: true, legacyOwner: true });
  const contexts = [await browser.newContext(), await browser.newContext()];
  const items = projects(false);
  const runner = createProcessor(items.get('a')!, { remoteDebugger: fixture.forChannel(null) });
  try {
    await expect.poll(fixture.ready).toBe(true);
    const first = await openDebugger(await contexts[0]!.newPage(), items, fixture.port, null);
    const named = await openDebugger(await contexts[1]!.newPage(), items, fixture.port, 'private');
    await runner.run();
    await expect.poll(() => first.observedEvents.filter((frame) => frame.message === 'start')).toHaveLength(1);
    await expect(first.output).toContainText('Fixture');
    await expect(named.editor.locator('.node[data-nodeid="shared-node"]')).toBeVisible();
    await expect(named.output).toHaveCount(0);
    expect(named.observedEvents.filter((frame) => frame.message === 'start')).toHaveLength(0);
    fixture.disconnectObservers();
    await expect.poll(fixture.connectionCount).toBe(4);
    await expect(first.output).toContainText('Fixture');
    await expect(named.output).toHaveCount(0);
    expect(named.observedEvents.filter((frame) => frame.message === 'start')).toHaveLength(0);
    expect(fixture.commands.filter((raw) => /latest-control|"type":"run"/.test(raw))).toHaveLength(0);
  } finally {
    runner.dispose();
    for (const context of contexts) await context.close();
    await fixture.close();
  }
});

for (const scenario of [
  'different channels',
  'shared selection',
  'bundle channels',
  'prompt replies',
  'history eviction',
] as const) {
  test(`managed latest debugger isolates ${scenario} across independent browsers`, async ({ browser }) => {
    const fixture = await createLatestDebuggerFixture({ ha: true, managed: true, throttlePartialOutputs: 0 });
    const contexts = [await browser.newContext(), await browser.newContext()];
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const items = projects(scenario === 'bundle channels' || scenario === 'history eviction');
    const active: Array<{
      runner: ReturnType<typeof createProcessor>;
      run: Promise<unknown>;
      release(): void;
      paused(): boolean;
    }> = [];
    const make = (channel: string, label: string) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const defaults = createBuiltInRegistry(),
        Base = defaults.getNodeConstructors().find((ctor) => ctor.create().type === 'text')!;
      class HeldText extends Base {
        async process(_inputs: Inputs, context: InternalProcessContext) {
          const owner = context.project.metadata.id;
          context.onPartialOutputs?.({ output: { type: 'string', value: `${label}-${owner} streaming` } });
          const answer =
            scenario === 'prompt replies'
              ? await context.requestUserInput([`Question for ${label}`], 'text')
              : undefined;
          await gate;
          return {
            output: { type: 'string' as const, value: `${label}-${owner}${answer ? ' ' + answer.value[0] : ''} done` },
          };
        }
      }
      const registry = new NodeRegistration<string, ChartNode>();
      for (const ctor of defaults.getNodeConstructors())
        registry.register({ impl: ctor.create().type === 'text' ? HeldText : ctor, displayName: 'Fixture' });
      const runner = createProcessor(items.get('a')!, {
        registry,
        remoteDebugger: fixture.forChannel(channel),
        subgraphProjectLoader: {
          loadTarget: async (target) => ({ project: items.get(target.projectId)!, revisionKey: 'fixture' }),
        },
      });
      let paused = false;
      let execution: GraphExecutionMetadata | undefined;
      runner.processor.on('start', (data) => {
        execution = data.execution;
      });
      runner.processor.on('pause', () => {
        paused = true;
      });
      runner.processor.on('resume', () => {
        paused = false;
      });
      const run = runner.run();
      void run.catch(() => {});
      const item = {
        runner,
        run,
        release,
        paused: () => paused,
        outputsReady() {
          if (!execution) throw new Error('Root admission is missing');
          // Simulate an in-flight output boundary after an actual processor pause.
          fixture.debuggerServer.broadcast(runner.processor, 'graphOutputsReady', { execution, outputs: {} });
        },
      };
      active.push(item);
      return item;
    };
    let releasePromptClosures = () => {};
    let reportHistoryGap = () => {};
    if (scenario === 'prompt replies') {
      await pages[0]!.routeWebSocket(/\/ws\/latest-debugger/, (socket) => {
        socket.connectToServer();
        reportHistoryGap = () =>
          socket.send(JSON.stringify({ message: 'latest-diagnostic', data: { protocol: 1, code: 'history-gap' } }));
      });
      // A delayed closure leaves one genuine browser with a stale open prompt.
      // Its rejected submission must never answer another invocation.
      await pages[1]!.routeWebSocket(/\/ws\/latest-debugger/, (socket) => {
        const server = socket.connectToServer();
        let hold = true;
        const pending: Array<string | Buffer> = [];
        server.onMessage((message) => {
          if (hold && JSON.parse(String(message)).message === 'latest-prompt-closed') pending.push(message);
          else socket.send(message);
        });
        releasePromptClosures = () => {
          hold = false;
          pending.splice(0).forEach((message) => socket.send(message));
        };
      });
    }
    try {
      await expect.poll(fixture.ready).toBe(true);
      const first = await openDebugger(pages[0]!, items, fixture.port, '00123', scenario === 'history eviction');
      const second = await openDebugger(
        pages[1]!,
        items,
        fixture.port,
        scenario === 'shared selection' || scenario === 'prompt replies' || scenario === 'history eviction'
          ? '00123'
          : 'B',
      );
      if (scenario === 'history eviction') {
        // Real authored edits, not a synthetic dirty-state response. Both source
        // and passive member must warn without replacing the edited definition.
        for (const id of ['b', 'a']) {
          await first.editor
            .locator('.projects-container .project:not(.opening)')
            .filter({ hasText: `Project ${id.toUpperCase()}` })
            .click();
          const box = (await first.editor.locator('.node[data-nodeid="shared-node"] .node-title').boundingBox())!;
          await pages[0]!.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await pages[0]!.mouse.down();
          await pages[0]!.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
          await pages[0]!.mouse.up();
        }
      }
      const old = make('00123', 'first');
      await expect(first.output).toContainText('first-a streaming');
      if (scenario === 'history eviction') {
        await expect(second.output).toContainText('first-a streaming');
        for (const id of ['b', 'a']) {
          await first.editor
            .locator('.projects-container .project:not(.opening)')
            .filter({ hasText: `Project ${id.toUpperCase()}` })
            .click();
          await first.editor.getByRole('button', { name: 'Remote Debugger details', exact: true }).click();
          await expect(first.editor.getByTestId('remote-debugger-details')).toContainText(
            'Unsaved definitions were not changed.',
          );
          await first.editor.getByRole('button', { name: 'Done', exact: true }).click();
        }
        for (let batch = 0; batch < 130; batch++) {
          for (let index = 0; index < 64; index++)
            fixture.debuggerServer.broadcast(old.runner.processor, 'trace', { log: 'bounded history fixture' });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        old.runner.processor.pause();
        await expect(first.editor.getByRole('button', { name: /Resume/ }).first()).toBeVisible();
        const receivedOutputs = first.outputReadyFrames();
        old.outputsReady();
        await expect.poll(first.outputReadyFrames).toBeGreaterThan(receivedOutputs);
        await first.selectRun({ index: 0 });
        await expect(first.editor.getByRole('button', { name: /Resume/ }).first()).toBeEnabled();
        await first.expectIncomplete();
        await expect(first.editor.getByRole('button', { name: /Abort/ }).first()).toBeEnabled();
        await first.editor
          .getByRole('button', { name: /Resume/ })
          .first()
          .click();
        await expect.poll(old.paused).toBe(false);
        await second.selectRun({ index: 0 });
        await second.editor.getByRole('button', { name: /Pause/ }).first().click();
        await expect.poll(old.paused).toBe(true);
        for (const view of [first, second]) {
          await view.editor
            .locator('.projects-container .project:not(.opening)')
            .filter({ hasText: 'Project B' })
            .click();
          await expect(view.editor.getByRole('button', { name: /Pause|Resume|Abort/ })).toHaveCount(0);
        }
        const before = fixture.commands.length;
        await first.selectRun({ index: 0 });
        expect(fixture.commands.length).toBe(before, 'passive selection never replays a command');
        old.runner.processor.resume();
        old.release();
        await old.run;
        for (const view of [first, second]) {
          await view.editor
            .locator('.projects-container .project:not(.opening)')
            .filter({ hasText: 'Project A' })
            .click();
          await expect(view.editor.getByRole('button', { name: /Pause|Resume|Abort/ })).toHaveCount(0);
          await view.expectRunStatus('completed');
        }
        expect(fixture.commands.filter((raw) => JSON.parse(raw).type === 'latest-control')).toHaveLength(2);
      } else if (scenario === 'prompt replies') {
        const answer = async (index: number, text: string, label = 'first') => {
          const modal = [first, second][index]!.editor.getByRole('dialog');
          await expect(modal).toContainText(`Question for ${label}`);
          await modal.locator('.monaco-editor textarea').focus();
          await pages[index]!.keyboard.press('Control+A');
          await pages[index]!.keyboard.insertText(text);
          await modal.getByRole('button', { name: 'Submit', exact: true }).click();
        };
        await answer(0, 'alpha');
        await answer(1, 'beta');
        await expect(second.editor.getByText('Prompt is stale or answer is invalid')).toBeVisible();
        releasePromptClosures();
        await expect(second.editor.getByRole('dialog')).toHaveCount(0);
        const newer = make('00123', 'newer-prompt');
        await expect(second.editor.getByRole('dialog')).toContainText('Question for newer-prompt');
        await expect(first.editor.getByRole('dialog')).toContainText('Question for newer-prompt');
        const commandsBeforeGap = fixture.commands.length;
        reportHistoryGap();
        await expect(first.editor.getByRole('dialog')).toHaveCount(0);
        await expect(first.editor.getByRole('button', { name: /Abort/ }).first()).toBeVisible();
        await first.expectIncomplete();
        expect(fixture.commands.length).toBe(commandsBeforeGap, 'diagnostic recovery never resends a command');
        await first.selectRun({ index: 0 });
        await expect(first.editor.getByRole('dialog')).toHaveCount(0);
        await expect(first.editor.getByRole('button', { name: 'User Input Needed', exact: true })).toHaveCount(0);
        await expect(second.editor.getByRole('dialog')).toContainText('Question for newer-prompt');
        old.release();
        await old.run;
        await expect(first.output).toContainText('first-a alpha done');
        await first.followNewest();
        await answer(1, 'gamma', 'newer-prompt');
        newer.release();
        await newer.run;
        await expect(first.output).toContainText('newer-prompt-a gamma done');
        await expect(second.output).toContainText('newer-prompt-a gamma done');
        const fresh = make('00123', 'fresh-after-gap');
        await expect(first.editor.getByRole('dialog')).toContainText('Question for fresh-after-gap');
        await expect(second.editor.getByRole('dialog')).toContainText('Question for fresh-after-gap');
        const beforeSecondGap = fixture.commands.length;
        reportHistoryGap();
        await expect(first.editor.getByRole('dialog')).toHaveCount(0);
        expect(fixture.commands.length).toBe(beforeSecondGap);
        await answer(1, 'delta', 'fresh-after-gap');
        fresh.release();
        await fresh.run;
        await expect(second.output).toContainText('fresh-after-gap-a delta done');
        const replies = fixture.commands
          .map((raw) => JSON.parse(raw))
          .filter((frame) => frame.data?.action === 'user-input');
        expect(replies).toHaveLength(4);
        expect(new Set(replies.slice(0, 2).map((frame) => frame.data.target.rootRunId)).size).toBe(1);
        expect(replies[2].data.target.rootRunId).not.toBe(replies[0].data.target.rootRunId);
      } else if (scenario !== 'shared selection') {
        await expect(second.editor.locator('.node[data-nodeid="shared-node"]')).not.toContainText('first-a streaming');
        const other = make('B', 'second');
        await expect(second.output).toContainText('second-a streaming');
        await expect(first.output).not.toContainText('second-a streaming');
        if (scenario === 'bundle channels')
          for (const id of ['b', 'c']) {
            for (const [index, view] of [first, second].entries()) {
              await view.editor
                .locator('.projects-container .project:not(.opening)')
                .filter({ hasText: `Project ${id.toUpperCase()}` })
                .click();
              await expect(view.output).toContainText(`${index === 0 ? 'first' : 'second'}-${id} streaming`);
              await expect(view.editor.getByRole('button', { name: 'Pause', exact: false })).toHaveCount(0);
            }
          }
        await first.editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true }).click();
        await expect(first.editor.getByRole('status', { name: 'Node running', exact: true })).toHaveCount(0);
        await expect(first.output).toContainText(
          scenario === 'bundle channels' ? 'first-c streaming' : 'first-a streaming',
        );
        expect(old.runner.processor.isRunning).toBe(true);
        expect(other.runner.processor.isRunning).toBe(true);
        other.release();
        await other.run;
        await expect(second.output).toContainText(scenario === 'bundle channels' ? 'second-c done' : 'second-a done');
      } else {
        await expect(second.output).toContainText('first-a streaming');
        const newer = make('00123', 'newer');
        await expect(first.output).toContainText('newer-a streaming');
        await expect(second.output).toContainText('newer-a streaming');
        await first.selectRun({ index: 0 });
        await expect(first.output).toContainText('first-a streaming');
        await expect(second.output).toContainText('newer-a streaming');
        old.release();
        await old.run;
        await expect(first.output).toContainText('first-a done');
        await expect(second.editor.getByRole('button', { name: /Abort/ }).first()).toBeVisible();
        const connections = fixture.connectionCount(),
          commands = fixture.commands.length;
        fixture.routeToOwner(0);
        fixture.disconnectObservers();
        await expect.poll(fixture.connectionCount).toBeGreaterThanOrEqual(connections + 2);
        await expect(first.output).toContainText('first-a done');
        await expect(second.output).toContainText('newer-a streaming');
        expect(fixture.commands.length).toBe(commands, 'reconnect must not replay controls or execution');
        await first.followNewest();
        await expect(first.output).toContainText('newer-a streaming');
        await second.editor.getByRole('button', { name: /Pause/ }).first().click();
        await expect.poll(newer.paused).toBe(true);
        await first.editor
          .getByRole('button', { name: /Resume/ })
          .first()
          .click();
        await expect.poll(newer.paused).toBe(false);
        const beforeUnsupportedEvent = fixture.commands.length;
        fixture.debuggerServer.broadcast(newer.runner.processor, 'future-event', {});
        for (const view of [first, second]) {
          await view.expectIncomplete();
          await expect(view.output).toContainText('newer-a streaming');
          await expect(view.editor.getByRole('button', { name: /Abort/ }).first()).toBeEnabled();
        }
        expect(fixture.commands.length).toBe(beforeUnsupportedEvent, 'unsupported observation never replays work');
        const beforeMismatch = fixture.commands.length;
        fixture.announceUnsupportedProtocol();
        for (const view of [first, second]) {
          await expect(view.editor.getByRole('button', { name: 'Stop Remote Debugger', exact: true })).toHaveCount(0);
          await expect(view.editor.getByRole('status', { name: 'Node running', exact: true })).toHaveCount(0);
          await expect(view.output).toContainText('newer-a streaming');
        }
        expect(newer.runner.processor.isRunning).toBe(true, 'protocol rejection only ends observation');
        expect(fixture.commands.length).toBe(beforeMismatch, 'protocol failure sends no abort or replay');
      }
      for (const page of pages) expect(await page.pageErrors()).toEqual([]);
    } finally {
      for (const item of active) {
        item.runner.processor.resume();
        item.release();
        if (scenario === 'prompt replies' && item.runner.processor.isRunning) void item.runner.processor.abort();
      }
      await Promise.allSettled(active.map((item) => item.run));
      active.forEach((item) => item.runner.dispose());
      await Promise.all(contexts.map((context) => context.close()));
      await fixture.close();
    }
  });
}
