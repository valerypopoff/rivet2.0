import { expect, test, type Page } from '@playwright/test';
import { serializeProject, type Project } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowPublishedVersionSummary, WorkflowTreeResponse } from '../dashboard/types';

function isRouteRequest(
  routeRequest: { method: () => string; url: () => string },
  method: string,
  pathname: string,
): boolean {
  const url = new URL(routeRequest.url());

  return routeRequest.method() === method && url.pathname === pathname;
}

function createCompareProjectItem(
  name: string,
  settings: Partial<WorkflowProjectItem['settings']> = {},
): WorkflowProjectItem {
  return {
    id: `compare-${name}-project-id`,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/workflows/${name}.rivet-project`,
    updatedAt: '2026-06-12T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
      ...settings,
    },
  };
}

function createCompareProjectFile(options: {
  graphId: string;
  nodeText: string;
  projectId: string;
  secondNode?: boolean;
  title: string;
}): string {
  const secondNodeBlock = options.secondNode
    ? [
        '        \'[compare-node-2]:text "Added Node"\':',
        '          visualData: 860/320/260/null//',
        '          data:',
        '            text: added',
      ]
    : [];

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(options.projectId)}`,
    `    title: ${JSON.stringify(options.title)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(options.graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(options.graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(options.graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes:',
    '        \'[compare-node-1]:text "Compared Node"\':',
    '          visualData: 520/320/260/null//',
    '          data:',
    `            text: ${options.nodeText}`,
    ...secondNodeBlock,
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function installCompareModeRoutes(
  page: Page,
  projects: WorkflowProjectItem[],
  projectContentsByPath: Map<string, string>,
): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/workflows/tree')) {
      await route.fallback();
      return;
    }

    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      sync: { epoch: 'playwright-fixture', revision: 0 },
      folders: [],
      projects,
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });

  await page.route('**/api/projects/load', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/projects/load')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as { path?: string };
    const contents = requestBody.path ? projectContentsByPath.get(requestBody.path) : null;

    if (!contents) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Unknown project path: ${requestBody.path ?? ''}` }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents,
        datasetsContents: null,
        revisionId: null,
      }),
    });
  });

  await page.route('**/api/projects/save', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/projects/save')) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Project compare mode spec should not save projects.' }),
    });
  });
}

async function installPublishedVersionRoutes(
  page: Page,
  project: WorkflowProjectItem,
  publishedVersion: WorkflowPublishedVersionSummary,
  publishedContents: string,
): Promise<void> {
  await page.route('**/api/workflows/projects/published-versions**', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/workflows/projects/published-versions')) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        versions: [publishedVersion],
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/preview', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/published-versions/preview')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath?: string;
      versionId?: string;
    };

    if (requestBody.relativePath !== project.relativePath || requestBody.versionId !== publishedVersion.id) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: publishedContents,
        datasetsContents: null,
      }),
    });
  });
}

test.describe('Project compare mode', () => {
  for (const theme of ['molten', 'bright']) {
    test(`deleted nodes show reference settings, passive ports and complete read-only inspection (${theme})`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      page.setDefaultTimeout(25_000);
      await page.addInitScript((theme) => localStorage.setItem('recoil-persist', JSON.stringify({ theme })), theme);
      const currentItem = createCompareProjectItem('deleted-current');
      const referenceItem = createCompareProjectItem('deleted-reference');
      const fullText = Array.from({ length: 40 }, (_, index) => `Original prompt line ${index}`).join('\n');
      const makeNode = (id: string, type: string, data: unknown, x: number, y: number) => ({
        id,
        type,
        title: id,
        visualData: { x, y, width: 260 },
        data,
      });
      const survivor = makeNode('survivor', 'graphOutput', { id: 'result', dataType: 'any' }, 920, 550);
      const changed = makeNode('changed', 'text', { text: 'old' }, 0, -180);
      const reference = {
        metadata: { id: referenceItem.id, title: referenceItem.name, description: '', mainGraphId: 'main' },
        graphs: {
          main: {
            metadata: { id: 'main', name: 'Main' },
            nodes: [
              changed,
              survivor,
              makeNode('deleted-global', 'getGlobal', { id: 'which-global', dataType: 'string' }, 0, 0),
              makeNode(
                'deleted-input',
                'graphInput',
                { id: 'which-input', dataType: 'string', defaultValue: 'original default' },
                310,
                0,
              ),
              makeNode('deleted-bool', 'boolean', { value: true }, 620, 0),
              makeNode('deleted-text', 'text', { text: fullText }, 0, 230),
              makeNode('deleted-subgraph', 'subGraph', { graphId: 'child' }, 310, 230),
              makeNode('deleted-library', 'nodePrefabInstance', { prefabId: 'library' }, 620, 230),
              makeNode(
                'deleted-code',
                'code',
                {
                  code: fullText
                    .split('\n')
                    .map((line) => `// ${line}`)
                    .join('\n'),
                  inputNames: ['original_code_input'],
                  outputNames: ['original_code_output'],
                },
                620,
                570,
              ),
              makeNode(
                'deleted-plugin',
                'unavailablePlugin',
                { prompt: fullText, customSetting: 'preserved' },
                310,
                570,
              ),
            ],
            connections: [
              { outputNodeId: 'deleted-bool', outputId: 'value', inputNodeId: 'survivor', inputId: 'value' },
            ],
          },
          child: {
            metadata: { id: 'child', name: 'Original child name' },
            nodes: [
              makeNode('child-input', 'graphInput', { id: 'historical-input', dataType: 'string' }, 0, 0),
              makeNode('child-output', 'graphOutput', { id: 'historical-output', dataType: 'string' }, 300, 0),
            ],
            connections: [],
          },
        },
        nodePrefabs: {
          library: {
            id: 'library',
            sourceNode: makeNode('source', 'getGlobal', { id: 'library-original', dataType: 'number' }, 0, 0),
          },
        },
        plugins: [],
        references: [],
      } as unknown as Project;
      const current = structuredClone(reference);
      current.metadata.id = currentItem.id as Project['metadata']['id'];
      current.metadata.title = currentItem.name;
      current.graphs.main!.nodes = [
        { ...changed, data: { text: 'new' } },
        survivor,
        makeNode('added', 'text', { text: 'added content' }, 920, -180),
      ] as Project['graphs'][string]['nodes'];
      current.graphs.main!.connections = [];
      delete current.graphs.child;
      current.nodePrefabs = {};
      const contents = new Map([
        [currentItem.absolutePath, serializeProject(current) as string],
        [referenceItem.absolutePath, serializeProject(reference) as string],
      ]);
      await installCompareModeRoutes(page, [currentItem, referenceItem], contents);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      const editor = page.frameLocator('iframe.dashboard-editor-frame');
      await page.locator('.project-row', { hasText: currentItem.name }).dblclick();
      await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });
      const startCompare = async () => {
        await page.locator('.project-row', { hasText: referenceItem.name }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Compare opened project with this one' }).click();
        await expect(editor.locator('.node.compare-removed')).toHaveCount(8);
      };
      await startCompare();
      const deleted = (id: string) => editor.locator(`[data-comparison-nodeid="deleted-${id}"]`);
      await expect(deleted('global')).toContainText('which-global');
      await expect(deleted('global')).toContainText('Type: string');
      await expect(deleted('input')).toContainText('which-input');
      await expect(deleted('input')).toContainText('Default: original default');
      await expect(deleted('bool').locator('.node-body')).toHaveText('true');
      await expect(deleted('subgraph')).toContainText('Original child name');
      await expect(deleted('subgraph')).toContainText('historical-input');
      await expect(deleted('subgraph')).toContainText('historical-output');
      await expect(deleted('library')).toContainText('library-original');
      await expect(deleted('text')).toContainText('Original prompt line 0');
      await expect(deleted('text')).not.toContainText('Original prompt line 39');
      await expect(deleted('code')).toContainText('// Original prompt line 0');
      await expect(deleted('code')).toContainText('original_code_input');
      await expect(deleted('code')).toContainText('original_code_output');
      await expect(editor.locator('.node.compare-added')).toHaveCount(1);
      await expect(editor.locator('.node.compare-changed')).toHaveCount(1);
      await expect(
        editor.locator(
          '.compare-removed input, .compare-removed select, .compare-removed .node-output, .compare-removed .node-resize-handles',
        ),
      ).toHaveCount(0);
      await editor.locator('.node[data-nodeid="added"] .node-title').dispatchEvent('click', { shiftKey: true });
      await expect(editor.locator('.node[data-nodeid="added"]')).toHaveClass(/selected/);
      await page.keyboard.press('Control+c');
      await deleted('text').getByRole('button', { name: 'Inspect deleted node' }).focus();
      await page.keyboard.press('Delete');
      await expect(editor.locator('.node[data-nodeid="added"]')).toHaveCount(1);
      await page.keyboard.press('Enter');
      await expect(editor.getByText('Deleted node details', { exact: true })).toBeVisible();
      await expect(editor.locator('[role="dialog"] pre')).toContainText(fullText.split('\n').at(-1)!);
      await editor.locator('[role="dialog"] pre').focus();
      await page.keyboard.press('Delete');
      await page.keyboard.press('Control+x');
      await page.keyboard.press('Control+d');
      await page.keyboard.press('Control+v');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+y');
      await expect(editor.locator('.node[data-nodeid="added"]')).toHaveCount(1);
      await expect(editor.locator('.node[data-nodeid]')).toHaveCount(3);
      await expect(editor.locator('.node.selected[data-nodeid="added"]')).toHaveCount(1);
      await editor.getByRole('button', { name: 'Done', exact: true }).click();
      await editor.locator('.node[data-nodeid="added"] .node-title').focus();
      await page.keyboard.press('Control+d');
      await expect(editor.locator('.node[data-nodeid]')).toHaveCount(4);
      await deleted('library').dblclick();
      await expect(editor.getByText('Saved node configuration', { exact: true })).toBeVisible();
      await expect(editor.locator('[role="dialog"]')).toContainText('nodePrefabInstance');
      await expect(editor.locator('[role="dialog"]')).toContainText('Reference library source configuration');
      await expect(editor.locator('[role="dialog"]')).toContainText('library-original');
      await editor.getByRole('button', { name: 'Done', exact: true }).click();
      await deleted('plugin').getByRole('button', { name: 'Inspect deleted node' }).click();
      await expect(editor.locator('[role="dialog"]')).toContainText('customSetting: preserved');
      await page.keyboard.press('Escape');
      await expect(editor.getByText('Deleted node details', { exact: true })).toHaveCount(0);
      const originalTransform = await deleted('bool').getAttribute('style');
      await deleted('code').getByRole('button', { name: 'Inspect deleted node' }).click();
      await expect(editor.locator('[role="dialog"]')).toContainText('// Original prompt line 39');
      await editor.getByRole('button', { name: 'Done', exact: true }).click();
      const bounds = await deleted('bool').boundingBox();
      await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
      await page.mouse.down();
      await page.mouse.move(bounds!.x + 90, bounds!.y + 90);
      await page.mouse.up();
      expect(await deleted('bool').getAttribute('style')).toBe(originalTransform);
      await expect(editor.locator('.wire.compare-removed')).toHaveCount(1);
      const assertWireAttachment = async () => {
        await expect
          .poll(() =>
            editor.locator('.node-canvas').evaluate((canvas) => {
              const wire = canvas.querySelector<SVGPathElement>('.wire.compare-removed')!;
              const matrix = wire.getScreenCTM()!;
              return [
                ['deleted-bool', 'output', 0],
                ['survivor', 'input', wire.getTotalLength()],
              ]
                .map(([id, side, distance]) => {
                  const point = wire.getPointAtLength(Number(distance)).matrixTransform(matrix);
                  const port = canvas
                    .querySelector(`[data-comparison-nodeid="${id}"] [data-porttype="${side}"]`)!
                    .getBoundingClientRect();
                  return Math.hypot(point.x - port.x - port.width / 2, point.y - port.y - port.height / 2);
                })
                .every((error) => error < 2);
            }),
          )
          .toBe(true);
      };
      await assertWireAttachment();
      await page.setViewportSize({ width: 1700, height: 1100 });
      await expect(deleted('global')).toContainText('which-global');
      await assertWireAttachment();
      await page.screenshot({ path: testInfo.outputPath('deleted-node-previews.png') });
      await editor.locator('.node.compare-changed .project-compare-changes-button').click();
      await expect(editor.getByText('Node config changes', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Done', exact: true }).click();
      // Zoom around a deleted node so it stays on-screen; wait for each observable transform.
      await deleted('global').getByRole('button', { name: 'Inspect deleted node' }).click();
      const replacement = structuredClone(reference);
      replacement.graphs.main!.nodes.find((node) => node.id === 'deleted-global')!.data = {
        id: 'replacement-global',
        dataType: 'string',
      };
      contents.set(referenceItem.absolutePath, serializeProject(replacement) as string);
      await startCompare();
      await expect(editor.getByText('Deleted node details', { exact: true })).toHaveCount(0);
      await expect(deleted('global')).toContainText('replacement-global');
      await expect(deleted('global')).not.toContainText('which-global');
      for (let step = 0; step < 20 && (await deleted('global').locator('.node-body').count()); step++) {
        const before = await editor.locator('.canvas-node-contents').getAttribute('style');
        await deleted('global').hover();
        await page.mouse.wheel(0, 120);
        await expect(editor.locator('.canvas-node-contents')).not.toHaveAttribute('style', before!);
      }
      await expect(deleted('global').locator('.node-body')).toHaveCount(0);
      await deleted('global').getByRole('button', { name: 'Inspect deleted node' }).click();
      await expect(editor.locator('[role="dialog"]')).toContainText('replacement-global');
      await editor.getByRole('button', { name: 'Done', exact: true }).click();
      await editor.locator('.project-compare-notice').getByRole('button', { name: 'Exit', exact: true }).click();
      await expect(editor.locator('.compare-removed')).toHaveCount(0);
      await startCompare();
      await deleted('global').getByRole('button', { name: 'Inspect deleted node' }).click();
      await expect(editor.locator('[role="dialog"]')).toContainText('replacement-global');
      await page.locator('.project-row', { hasText: referenceItem.name }).dblclick();
      await expect(page.locator('.active-project-name')).toHaveText(referenceItem.name);
      await expect(editor.getByText('Deleted node details', { exact: true })).toHaveCount(0);
      await expect(editor.locator('.node.compare-removed')).toHaveCount(0);
    });
  }

  test('starts compare mode from another project row context menu', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-current');
    const referenceProject = createCompareProjectItem('codex-compare-reference');
    const projectContentsByPath = new Map<string, string>([
      [
        currentProject.absolutePath,
        createCompareProjectFile({
          graphId: 'compare-current-graph',
          nodeText: 'current',
          projectId: currentProject.id,
          secondNode: true,
          title: currentProject.name,
        }),
      ],
      [
        referenceProject.absolutePath,
        createCompareProjectFile({
          graphId: 'compare-current-graph',
          nodeText: 'reference',
          projectId: referenceProject.id,
          title: referenceProject.name,
        }),
      ],
    ]);

    await installCompareModeRoutes(page, [currentProject, referenceProject], projectContentsByPath);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const referenceRow = page.locator('.project-row', { hasText: referenceProject.name });
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await currentRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Compare opened project with this one' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await referenceRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare opened project with this one' }).click();

    await expect(
      editorFrame
        .locator('.project-compare-notice')
        .getByText(`Compare mode: ${currentProject.name} against ${referenceProject.name}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(referenceProject.fileName)).toBeVisible({ timeout: 30_000 });
  });

  test('starts compare mode against the current published version from the open project row', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-published', {
      status: 'unpublished_changes',
      endpointName: 'codex-compare-published-endpoint',
      lastPublishedAt: '2026-06-12T09:00:00.000Z',
    });
    const currentPublishedVersion: WorkflowPublishedVersionSummary = {
      id: 'current-published-version-id',
      projectId: currentProject.id,
      projectName: currentProject.name,
      endpointName: currentProject.settings.endpointName,
      publishedAt: currentProject.settings.lastPublishedAt ?? '2026-06-12T09:00:00.000Z',
      isCurrent: true,
      isStarred: false,
      comment: '',
    };
    const liveContents = createCompareProjectFile({
      graphId: 'compare-published-graph',
      nodeText: 'unpublished changes',
      projectId: currentProject.id,
      secondNode: true,
      title: currentProject.name,
    });
    const publishedContents = createCompareProjectFile({
      graphId: 'compare-published-graph',
      nodeText: 'published',
      projectId: currentProject.id,
      title: currentProject.name,
    });
    const projectContentsByPath = new Map<string, string>([[currentProject.absolutePath, liveContents]]);

    await installCompareModeRoutes(page, [currentProject], projectContentsByPath);
    await installPublishedVersionRoutes(page, currentProject, currentPublishedVersion, publishedContents);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Compare to the published version' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await currentRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare to the published version' }).click();

    await expect(
      editorFrame.locator('.project-compare-notice').getByText('Compare mode: Unpublished against Published'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(`Published version of ${currentProject.fileName}`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test('asks which saved version to compare when the reference project has unpublished changes', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-current-for-chooser');
    const referenceProject = createCompareProjectItem('codex-compare-reference-with-changes', {
      status: 'unpublished_changes',
      endpointName: 'codex-compare-reference-endpoint',
      lastPublishedAt: '2026-06-12T09:30:00.000Z',
    });
    const currentPublishedVersion: WorkflowPublishedVersionSummary = {
      id: 'reference-current-published-version-id',
      projectId: referenceProject.id,
      projectName: referenceProject.name,
      endpointName: referenceProject.settings.endpointName,
      publishedAt: referenceProject.settings.lastPublishedAt ?? '2026-06-12T09:30:00.000Z',
      isCurrent: true,
      isStarred: false,
      comment: '',
    };
    const currentContents = createCompareProjectFile({
      graphId: 'compare-version-choice-graph',
      nodeText: 'current',
      projectId: currentProject.id,
      secondNode: true,
      title: currentProject.name,
    });
    const referencePublishedContents = createCompareProjectFile({
      graphId: 'compare-version-choice-graph',
      nodeText: 'reference published',
      projectId: referenceProject.id,
      title: referenceProject.name,
    });
    const projectContentsByPath = new Map<string, string>([[currentProject.absolutePath, currentContents]]);

    await installCompareModeRoutes(page, [currentProject, referenceProject], projectContentsByPath);
    await installPublishedVersionRoutes(page, referenceProject, currentPublishedVersion, referencePublishedContents);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const referenceRow = page.locator('.project-row', { hasText: referenceProject.name });
    const chooserModal = page.getByTestId('workflow-project-version-modal');
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await referenceRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare opened project with this one' }).click();

    await expect(chooserModal).toBeVisible();
    await expect(chooserModal.locator('.project-settings-modal-title')).toHaveText('Compare');
    await expect(page.getByRole('button', { name: 'Compare "Published"' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare "Unpublished changes"' })).toBeVisible();

    await page.getByRole('button', { name: 'Compare "Published"' }).click();

    await expect(
      editorFrame
        .locator('.project-compare-notice')
        .getByText(`Compare mode: ${currentProject.name} against ${referenceProject.name} (Published)`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(`Published version of ${referenceProject.fileName}`)).toBeVisible({
      timeout: 30_000,
    });
  });
});
