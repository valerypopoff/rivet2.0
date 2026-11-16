import { expect, test, type Locator, type Page } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem } from '../dashboard/types';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('new Bus items append, can be dragged and undone, and keep their saved positions and wiring', async ({
  page,
  browser,
}) => {
  const suffix = String(Date.now());
  const busId = `ordered-bus-${suffix}`;
  const secondBusId = `other-bus-${suffix}`;
  const fixture = {
    graphId: `bus-order-${suffix}-graph`,
    loaded: true,
    projectId: `bus-order-${suffix}-project`,
    projectPath: `/workflows/Bus order ${suffix}.rivet-project`,
    title: `Bus order ${suffix}`,
    graph: {
      nodes: [
        ...[1, 2, 3].map((index) => ({
          id: `provider-${index}`,
          type: 'number',
          title: `Provider ${index}`,
          data: { value: index, round: false, roundTo: 0 },
          visualData: { x: 150 + (index - 1) * 300, y: 220, width: 200 },
        })),
        ...[busId, secondBusId].map((id) => ({ id, type: 'dataBus', title: id, data: {}, visualData: { x: 0, y: 0 } })),
      ],
      connections: [
        ...[2, 3].map((index) => ({
          outputNodeId: `provider-${index}`,
          outputId: 'value',
          inputNodeId: busId,
          inputId: `input${index}`,
        })),
        { outputNodeId: 'provider-2', outputId: 'value', inputNodeId: secondBusId, inputId: 'input2' },
        { outputNodeId: 'provider-3', outputId: 'value', inputNodeId: secondBusId, inputId: 'input3' },
      ],
    },
  };
  let contents = JSON.stringify({
    metadata: { id: fixture.projectId, title: fixture.title, mainGraphId: fixture.graphId, description: '' },
    graphs: {
      [fixture.graphId]: { metadata: { id: fixture.graphId, name: 'Main Graph', description: '' }, ...fixture.graph },
    },
    plugins: [],
    references: [],
  });
  let saves = 0;
  const project: WorkflowProjectItem = {
    id: fixture.projectId,
    name: fixture.title,
    fileName: `${fixture.title}.rivet-project`,
    relativePath: `${fixture.title}.rivet-project`,
    absolutePath: fixture.projectPath,
    updatedAt: '2026-11-16T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  const mockProject = async (target: Page) => {
    await mockHostedEditorBootstrap(target);
    await target.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/workflows/tree' && request.method() === 'GET') {
        await route.fulfill({
          json: { root: '/workflows', sync: { epoch: suffix, revision: 0 }, folders: [], projects: [project] },
        });
      } else if (path === '/api/projects/load' && request.method() === 'POST') {
        await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
      } else if (path === '/api/projects/save' && request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body.path).toBe(project.absolutePath);
        contents = body.contents;
        saves++;
        await route.fulfill({ json: { path: project.absolutePath, revisionId: null } });
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) await route.abort('blockedbyclient');
      else await route.fallback();
    });
  };
  await mockProject(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const projectRow = page.locator('.project-row', { hasText: fixture.title });
  await expect(projectRow).toBeEnabled();
  await projectRow.dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const rail = editor.locator(`.data-bus-group[data-nodeid="${busId}"]`);
  const otherRail = editor.locator(`.data-bus-group[data-nodeid="${secondBusId}"]`);
  const channels = rail.locator('.data-bus-channel');
  const order = async (group = rail) =>
    group
      .locator('.data-bus-channel')
      .evaluateAll((items) => items.map((item) => Number((item as HTMLElement).dataset.channelIndex)));
  await expect.poll(() => order()).toEqual([2, 3]);

  // Reusing the lowest vacant slot (input1) must still append its new item.
  const provider = editor.locator('.node[data-nodeid="provider-1"] .port-circle[data-portid="value"]');
  const connect = rail.locator('.data-bus-connect-provider .port-circle[data-portid="input1"]');
  const start = (await provider.boundingBox())!;
  const end = (await connect.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => order()).toEqual([2, 3, 1]);
  await expect(channels.last().locator('.data-bus-provider-source')).toHaveText('Provider 1');

  const label = (index: number) =>
    rail.locator(`.data-bus-channel[data-channel-index="${index}"] .data-bus-channel-label`);
  // Native dragend can be lost (for example, when its source DOM is replaced).
  // A later unrelated text drop must not inherit the interrupted Bus drag.
  const interruptedDrag = await label(1).evaluateHandle(() => new DataTransfer());
  const textDrag = await label(1).evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'unrelated text');
    return transfer;
  });
  try {
    await label(1).dispatchEvent('dragstart', { dataTransfer: interruptedDrag });
    const rect = await channels.first().evaluate((item) => {
      const bounds = item.getBoundingClientRect();
      return { x: bounds.left + 2, y: bounds.top + 10 };
    });
    await channels
      .first()
      .dispatchEvent('dragover', { dataTransfer: interruptedDrag, clientX: rect.x, clientY: rect.y });
    await expect(channels.first()).toHaveClass(/\bdrop-before\b/);
    // Moving between a channel's descendants retains its insertion indicator.
    await channels.first().evaluate((item) => {
      item.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: item.querySelector('span') }));
    });
    await expect(channels.first()).toHaveClass(/\bdrop-before\b/);
    // Related targets are EventTargets, not necessarily DOM Nodes.
    const leaveErrors = await channels.first().evaluate((item) => {
      const errors: string[] = [];
      const collect = (event: ErrorEvent) => errors.push(event.message);
      window.addEventListener('error', collect);
      try {
        item.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: window }));
      } finally {
        window.removeEventListener('error', collect);
      }
      return errors;
    });
    expect(leaveErrors).toEqual([]);
    await expect(channels.first()).not.toHaveClass(/\bdrop-before\b/);
    await channels.first().dispatchEvent('drop', { dataTransfer: textDrag, clientX: rect.x, clientY: rect.y });
    expect(await order()).toEqual([2, 3, 1]);
  } finally {
    await label(1).dispatchEvent('dragend', { dataTransfer: interruptedDrag });
    await interruptedDrag.dispose();
    await textDrag.dispose();
  }
  const dragBefore = async (source: Locator, target: Locator) => {
    await source.dragTo(target, { targetPosition: { x: 2, y: 10 } });
  };
  await dragBefore(label(1), channels.first());
  await expect.poll(() => order()).toEqual([1, 2, 3]);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => order()).toEqual([2, 3, 1]);
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect.poll(() => order()).toEqual([1, 2, 3]);

  // An item cannot accidentally move into a different bus.
  await dragBefore(label(1), otherRail.locator('.data-bus-channel').first());
  await expect.poll(() => order()).toEqual([1, 2, 3]);
  await expect.poll(() => order(otherRail)).toEqual([2, 3]);

  // Keyboard alternative uses the same undoable operation, and never renumbers ports.
  await label(1).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => order()).toEqual([2, 1, 3]);
  for (const index of [1, 2, 3]) {
    const channel = rail.locator(`.data-bus-channel[data-channel-index="${index}"]`);
    await expect(channel.locator(`.port-circle[data-portid="input${index}"]`)).toHaveCount(1);
    await expect(channel.locator(`.port-circle[data-portid="output${index}"]`)).toHaveCount(1);
    await expect(channel.locator('.data-bus-provider-source')).toHaveText(`Provider ${index}`);
  }

  await label(1).click({ modifiers: ['Shift'] });
  await expect(rail).toHaveClass(/\bselected\b/);
  // Save through the normal hosted bridge, then load the file in a clean session
  // rather than selecting an already-open browser recovery snapshot.
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => saves).toBeGreaterThan(0);
  expect(contents).toContain('dataBusChannelOrder:');
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    storageState: { cookies: await page.context().cookies(), origins: [] },
  });
  try {
    const fresh = await context.newPage();
    await mockProject(fresh);
    await fresh.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(fresh);
    await waitForDashboardReady(fresh);
    await fresh.locator('.project-row', { hasText: fixture.title }).dblclick();
    const restored = fresh
      .frameLocator('iframe.dashboard-editor-frame')
      .locator(`.data-bus-group[data-nodeid="${busId}"]`);
    await expect.poll(() => order(restored)).toEqual([2, 1, 3]);
  } finally {
    await context.close();
  }
});
