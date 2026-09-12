import { expect, test, type Locator } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem } from '../dashboard/types';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const name = 'Bend selection fixture';
test.use({ actionTimeout: 20_000 });
const initialContents = `version: 4
data:
  metadata:
    id: bend-selection
    title: Bend selection fixture
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[a]:text "Source A"':
          data:
            text: Alpha
          visualData: 300/200/240/null//
          outgoingConnections:
            - output->"Target A __rivet_bend:650,260" b/value
        '[b]:graphOutput "Target A"':
          data:
            id: first
            dataType: string
          visualData: 820/200/240/null//
        '[c]:text "Source B"':
          data:
            text: Beta
          visualData: 300/450/240/null//
          outgoingConnections:
            - output->"Target B __rivet_bend:650,510" d/value
        '[d]:graphOutput "Target B"':
          data:
            id: second
            dataType: string
          visualData: 820/450/240/null//
  plugins: []
  references: []
`;

const commentEnclosureContents = `version: 4
data:
  metadata:
    id: comment-bend-enclosure
    title: Comment bend enclosure fixture
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[comment]:comment "Comment mover"':
          data:
            backgroundColor: rgba(0,0,0,0.05)
            color: rgba(255,255,255,1)
            height: 320
            text: Moves its enclosed bend
          visualData: 300/150/500/null//
        '[a]:text "Inside source"':
          data:
            text: Inside
          visualData: 350/250/240/null//
          outgoingConnections:
            - output->"Inside target __rivet_bend:550,300" b/value
        '[b]:graphOutput "Inside target"':
          data:
            id: inside
            dataType: string
          visualData: 850/250/240/null//
        '[c]:text "Outside source"':
          data:
            text: Outside
          visualData: 350/550/240/null//
          outgoingConnections:
            - output->"Outside target __rivet_bend:650,560" d/value
        '[d]:graphOutput "Outside target"':
          data:
            id: outside
            dataType: string
          visualData: 850/550/240/null//
  plugins: []
  references: []
`;

async function positions(nodes: Locator, bends: Locator) {
  return {
    nodes: await nodes.evaluateAll((elements) =>
      elements.map((element) => {
        const style = (element as HTMLElement).style;
        const matrix = new DOMMatrixReadOnly(style.transform);
        return { x: matrix.m41, y: matrix.m42 };
      }),
    ),
    bends: await bends.evaluateAll((elements) =>
      elements.map((element) => ({
        x: Number(element.getAttribute('cx')),
        y: Number(element.getAttribute('cy')),
      })),
    ),
  };
}

test('marquee and group dragging include bends with nodes and share Undo/Redo', async ({ page }, testInfo) => {
  test.slow();
  let contents = initialContents;
  let saves = 0;
  const project: WorkflowProjectItem = {
    id: 'bend-selection',
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/workflows/${name}.rivet-project`,
    updatedAt: '2026-09-07T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/workflows/tree' && request.method() === 'GET') {
      await route.fulfill({
        json: { root: '/workflows', sync: { epoch: 'bends', revision: 0 }, folders: [], projects: [project] },
      });
    } else if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
    } else if (path === '/api/projects/save' && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.path).toBe(project.absolutePath);
      contents = body.contents;
      saves++;
      await route.fulfill({ json: { path: project.absolutePath, revisionId: null } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      await route.abort('blockedbyclient');
    } else {
      await route.fallback();
    }
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.locator('.project-row', { hasText: name })).toBeEnabled({ timeout: 90_000 });
  await page.locator('.project-row', { hasText: name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const nodes = frame.locator('.node[data-nodeid]');
  const bends = frame.locator('.wire-bend-point[data-connection-key]');
  await expect(nodes).toHaveCount(4, { timeout: 90_000 });
  await expect(bends).toHaveCount(2);
  await bends.first().click();
  await expect(frame.locator('.wire-bend-point.selected')).toHaveCount(0);
  const original = await positions(nodes, bends);
  const boxes = await nodes.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    }),
  );
  const iframe = (await page.locator('iframe.dashboard-editor-frame').boundingBox())!;
  const start = {
    x: iframe.x + Math.min(...boxes.map((box) => box.x)) - 20,
    y: iframe.y + Math.min(...boxes.map((box) => box.y)) - 20,
  };
  const end = {
    x: iframe.x + Math.max(...boxes.map((box) => box.right)) + 20,
    y: iframe.y + Math.max(...boxes.map((box) => box.bottom)) + 60,
  };
  await page.keyboard.down('Shift');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(frame.locator('.node.selected')).toHaveCount(4);
  await expect(frame.locator('.wire-bend-point.selected')).toHaveCount(2);

  const drag = async (target: Locator, dx: number, dy: number) => {
    const box = (await target.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 10 });
    await page.mouse.up();
  };
  const assertMovedTogether = async (before: Awaited<ReturnType<typeof positions>>) => {
    await expect.poll(async () => (await positions(nodes, bends)).bends[0]!.x).not.toBe(before.bends[0]!.x);
    const after = await positions(nodes, bends);
    const dx = after.bends[0]!.x - before.bends[0]!.x,
      dy = after.bends[0]!.y - before.bends[0]!.y;
    for (const kind of ['nodes', 'bends'] as const) {
      after[kind].forEach((point, i) => {
        expect(point.x - before[kind][i]!.x).toBeCloseTo(dx, 1);
        expect(point.y - before[kind][i]!.y).toBeCloseTo(dy, 1);
      });
    }
    return after;
  };
  await drag(nodes.first().locator('.node-title'), 45, 25);
  const movedByNode = await assertMovedTogether(original);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => positions(nodes, bends)).toEqual(original);
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect.poll(() => positions(nodes, bends)).toEqual(movedByNode);

  // A cancelled mixed drag must leave both nodes and bends unchanged.
  const cancelBox = (await bends.first().boundingBox())!;
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + 50, cancelBox.y + 30, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => positions(nodes, bends)).toEqual(movedByNode);

  await page.keyboard.down('Shift');
  await drag(bends.first(), 40, 10);
  await page.keyboard.up('Shift');
  const movedByBend = await assertMovedTogether(movedByNode);
  expect(movedByBend.bends[0]!.y).toBe(movedByNode.bends[0]!.y);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => positions(nodes, bends)).toEqual(movedByNode);

  // Blank-canvas click clears both kinds; a subsequent bend-only drag leaves nodes alone.
  await page.mouse.click(start.x, start.y);
  await expect(frame.locator('.wire-bend-point.selected')).toHaveCount(0);
  await expect(frame.locator('.node.selected')).toHaveCount(0);
  const bendBoxes = await bends.all();
  const firstBendBox = (await bendBoxes[0]!.boundingBox())!;
  const secondBendBox = (await bendBoxes[1]!.boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.move(firstBendBox.x - 20, firstBendBox.y - 20);
  await page.mouse.down();
  await page.mouse.move(secondBendBox.x + secondBendBox.width + 20, secondBendBox.y + secondBendBox.height + 20, {
    steps: 8,
  });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(frame.locator('.wire-bend-point.selected')).toHaveCount(2);
  await expect(frame.locator('.node.selected')).toHaveCount(0);
  await drag(bends.first(), 20, 10);
  const bendsOnly = await positions(nodes, bends);
  expect(bendsOnly.nodes).toEqual(movedByNode.nodes);
  expect(bendsOnly.bends[1]!.x - movedByNode.bends[1]!.x).toBeCloseTo(
    bendsOnly.bends[0]!.x - movedByNode.bends[0]!.x,
    1,
  );
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => positions(nodes, bends)).toEqual(movedByNode);
  await page.mouse.click(start.x, start.y);
  await drag(bends.first(), 30, 15);
  const bendOnly = await positions(nodes, bends);
  expect(bendOnly.nodes).toEqual(movedByNode.nodes);
  expect(bendOnly.bends[1]).toEqual(movedByNode.bends[1]);
  expect(bendOnly.bends[0]).not.toEqual(movedByNode.bends[0]);
  await expect(frame.locator('.wire-bend-point.selected')).toHaveCount(0);
  await bends.first().dblclick();
  await expect(bends).toHaveCount(1);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => positions(nodes, bends)).toEqual(bendOnly);
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => saves).toBeGreaterThan(0);
  expect(contents).toContain('__rivet_bend:');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  await expect(page.locator('.project-row', { hasText: name })).toBeEnabled({ timeout: 90_000 });
  await page.locator('.project-row', { hasText: name }).dblclick();
  await expect(nodes).toHaveCount(4, { timeout: 90_000 });
  await expect.poll(() => positions(nodes, bends)).toEqual(bendOnly);
  await expect(frame.locator('.wire-bend-point.selected')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('bend-selection.png') });
});

test('Ctrl/Cmd-dragging a Comment carries only bend points inside its area', async ({ page }, testInfo) => {
  test.slow();
  let contents = commentEnclosureContents;
  const projectName = 'Comment bend enclosure fixture';
  const project: WorkflowProjectItem = {
    id: 'comment-bend-enclosure',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: `/workflows/${projectName}.rivet-project`,
    updatedAt: '2026-09-12T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/workflows/tree' && request.method() === 'GET') {
      await route.fulfill({
        json: { root: '/workflows', sync: { epoch: 'comment-bends', revision: 0 }, folders: [], projects: [project] },
      });
    } else if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
    } else if (path === '/api/projects/save' && request.method() === 'POST') {
      contents = request.postDataJSON().contents;
      await route.fulfill({ json: { path: project.absolutePath, revisionId: null } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      await route.abort('blockedbyclient');
    } else {
      await route.fallback();
    }
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.locator('.project-row', { hasText: projectName })).toBeEnabled({ timeout: 90_000 });
  await page.locator('.project-row', { hasText: projectName }).dblclick();

  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const comment = frame.locator('.node.isComment[data-nodeid]', { hasText: 'Comment mover' });
  const bends = frame.locator('.wire-bend-point[data-connection-key]');
  await expect(comment).toHaveCount(1, { timeout: 90_000 });
  await expect(bends).toHaveCount(2);
  const original = await positions(comment, bends);
  const insideBendIndex = original.bends.findIndex((bend) => bend.x === 550 && bend.y === 300);
  const outsideBendIndex = original.bends.findIndex((bend) => bend.x === 650 && bend.y === 560);
  expect(insideBendIndex).toBeGreaterThanOrEqual(0);
  expect(outsideBendIndex).toBeGreaterThanOrEqual(0);

  const commentBox = (await comment.locator('.node-title').boundingBox())!;
  await page.keyboard.down(modifier);
  await page.mouse.move(commentBox.x + commentBox.width / 2, commentBox.y + commentBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(commentBox.x + commentBox.width / 2 + 60, commentBox.y + commentBox.height / 2 + 35, {
    steps: 10,
  });
  await expect
    .poll(async () => (await positions(comment, bends)).bends[insideBendIndex]!.x)
    .not.toBe(original.bends[insideBendIndex]!.x);
  const preview = await positions(comment, bends);
  expect(preview.bends[insideBendIndex]!.x - original.bends[insideBendIndex]!.x).toBeCloseTo(
    preview.nodes[0]!.x - original.nodes[0]!.x,
    1,
  );
  expect(preview.bends[outsideBendIndex]).toEqual(original.bends[outsideBendIndex]);
  await page.mouse.up();
  await page.keyboard.up(modifier);

  await expect.poll(async () => (await positions(comment, bends)).nodes[0]!.x).not.toBe(original.nodes[0]!.x);
  const moved = await positions(comment, bends);
  const commentDelta = {
    x: moved.nodes[0]!.x - original.nodes[0]!.x,
    y: moved.nodes[0]!.y - original.nodes[0]!.y,
  };
  expect(moved.bends[insideBendIndex]!.x - original.bends[insideBendIndex]!.x).toBeCloseTo(commentDelta.x, 1);
  expect(moved.bends[insideBendIndex]!.y - original.bends[insideBendIndex]!.y).toBeCloseTo(commentDelta.y, 1);
  expect(moved.bends[outsideBendIndex]).toEqual(original.bends[outsideBendIndex]);

  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => positions(comment, bends)).toEqual(original);
  await page.screenshot({ path: testInfo.outputPath('comment-bend-enclosure.png') });
});
