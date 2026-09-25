import { expect, test, type Locator, type Page } from '@playwright/test';
import { parse } from 'yaml';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

const projectName = 'Subgraph output pruning';
const projectPath = `/workflows/${projectName}.rivet-project`;
const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const helpText =
  'Only run branches needed by connected outputs. Skipped branches also skip their side effects and errors. Runs the full subgraph for Run to here, partial-output forwarding, or a connected Error output.';

test.use({ actionTimeout: 30_000 });

async function editNode(node: Locator) {
  // The cog intentionally ignores pointer events until its node is hovered.
  await node.hover();
  await node.locator('.edit-button').click();
}

// Two connected instances share a child graph; only the first opts in. A third
// opted-in caller has no consumers and must create no child invocation.
function createFixture(): string {
  return `version: 4
data:
  metadata:
    id: pruning-project
    title: "${projectName}"
    description: ""
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[subgraph-a]:subGraph "Optimized caller"':
          data:
            graphId: child
          visualData: 400/220/260/null//
          outgoingConnections:
            - wanted->"First result" result-a/value
            - wanted->"Full caller" subgraph-b/gate
        '[result-a]:graphOutput "First result"':
          data:
            id: first
            dataType: string
          visualData: 860/220/240/null//
        '[subgraph-b]:subGraph "Full caller"':
          data:
            graphId: child
          visualData: 400/620/260/null//
          outgoingConnections:
            - wanted->"Second result" result-b/value
        '[result-b]:graphOutput "Second result"':
          data:
            id: second
            dataType: string
          visualData: 860/620/240/null//
        '[subgraph-skipped]:subGraph "Skipped caller"':
          data:
            graphId: child
            skipUnusedOutputs: true
          visualData: 800/420/260/null//
        '[subgraph-unset]:subGraph "Unconfigured caller"':
          data:
            skipUnusedOutputs: true
          visualData: 800/820/260/null//
    child:
      metadata:
        id: child
        name: Folder B/Child Graph
      nodes:
        '[gate]:graphInput "Gate"':
          data:
            id: gate
            dataType: any
          visualData: 100/220/200/null//
        '[wanted-text]:text "Wanted value"':
          data:
            text: wanted-result
          visualData: 400/220/260/null//
          outgoingConnections:
            - output->"Wanted output" wanted-output/value
        '[wanted-output]:graphOutput "Wanted output"':
          data:
            id: wanted
            dataType: string
          visualData: 860/220/240/null//
        '[unused-text]:text "Unused value"':
          data:
            text: unused-result
          visualData: 400/620/260/null//
          outgoingConnections:
            - output->"Unused output" unused-output/value
        '[unused-output]:graphOutput "Unused output"':
          data:
            id: unused
            dataType: string
          visualData: 860/620/240/null//
    selector-search-target:
      metadata:
        id: selector-search-target
        name: Folder A/Selector search target
      nodes: []
    selector-alpha:
      metadata:
        id: selector-alpha
        name: Folder A/Alpha graph
      nodes: []
  plugins: []
  references: []
`;
}

function createExternalFixture(): string {
  return `version: 4
data:
  metadata:
    id: external-project
    title: Reusable logic
    description: ""
    mainGraphId: external-graph
  graphs:
    external-graph:
      metadata:
        id: external-graph
        name: Graph group/Saved graph
      nodes:
        '[external-output]:graphOutput "Result"':
          data:
            id: result
            dataType: string
          visualData: 400/220/240/null//
  plugins: []
  references: []
`;
}

test('Subgraph pruning is opt-in per instance, undoable, persisted, and reflected in outputs', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  let contents = createFixture();
  let externalGraphAvailable = true;
  let externalOutputId = 'result';
  let publishedOutputId = 'outputStream2';
  let publishedOutputType = 'string';
  let externalPreviewUnavailable = false;
  let externalPreviewRequests = 0;
  let saveCount = 0;
  let loadCount = 0;
  const unexpectedMutations: string[] = [];
  const project: WorkflowProjectItem = {
    id: 'pruning-project',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: projectPath,
    updatedAt: '2026-09-05T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  const externalProject: WorkflowProjectItem = {
    id: 'external-project-row',
    projectMetadataId: 'external-project',
    name: 'Reusable logic',
    fileName: 'Reusable logic.rivet-project',
    relativePath: 'Components/Reusable/Reusable logic.rivet-project',
    absolutePath: '/workflows/Components/Reusable/Reusable logic.rivet-project',
    updatedAt: '2026-09-05T00:00:00.000Z',
    settings: { status: 'published', endpointName: 'reusable-logic', lastPublishedAt: null, publishedWebApps: [] },
  };
  const installFixture = async (fixturePage: Page) => {
    await fixturePage.addInitScript(() => {
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
    });
    await fixturePage.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/config' && request.method() === 'GET') {
        await route.fulfill({
          json: {
            publishedWorkflowsBasePath: '/workflows',
            latestWorkflowsBasePath: '/workflows-latest',
            publishedAppsBasePath: '/apps',
            latestAppsBasePath: '/apps-latest',
            webAppsAuthMode: 'ui-gate',
          },
        });
      } else if (path === '/api/workflows/evaluation-runs/library' && request.method() === 'GET') {
        await route.fulfill({
          json: {
            revision: 0,
            resourceVersions: { suites: {}, datasets: {} },
            library: {
              version: 1,
              data: { version: 1, suites: [], baselines: [] },
              datasets: [],
              migratedLegacyProjectIds: [],
            },
          },
        });
      } else if (path === '/api/workflows/tree' && request.method() === 'GET') {
        const tree: WorkflowTreeResponse = {
          root: '/workflows',
          sync: { epoch: 'pruning-fixture', revision: 0 },
          folders: [
            {
              id: 'components',
              name: 'Components',
              relativePath: 'Components',
              absolutePath: '/workflows/Components',
              updatedAt: '2026-09-05T00:00:00.000Z',
              projects: [],
              folders: [
                {
                  id: 'reusable',
                  name: 'Reusable',
                  relativePath: 'Components/Reusable',
                  absolutePath: '/workflows/Components/Reusable',
                  updatedAt: '2026-09-05T00:00:00.000Z',
                  projects: [externalProject],
                  folders: [],
                },
              ],
            },
            {
              id: 'zeta',
              name: 'Zeta',
              relativePath: 'Zeta',
              absolutePath: '/workflows/Zeta',
              updatedAt: '2026-09-05T00:00:00.000Z',
              projects: [],
              folders: [],
            },
          ],
          projects: [project],
        };
        await route.fulfill({ json: tree });
      } else if (path === '/api/workflows/subgraph-projects/external-project/preview' && request.method() === 'GET') {
        externalPreviewRequests++;
        if (externalPreviewUnavailable) {
          await route.fulfill({ status: 503, json: { error: 'Preview temporarily unavailable' } });
          return;
        }
        const version = new URL(request.url()).searchParams.get('version');
        await route.fulfill({
          json: {
            project: {
              metadata: { id: 'external-project', title: 'Reusable logic', mainGraphId: 'external-graph' },
              graphs: externalGraphAvailable
                ? {
                    'external-graph': {
                      metadata: {
                        id: 'external-graph',
                        name: version === 'published' ? 'Graph group/Published graph' : 'Graph group/Saved graph',
                      },
                      nodes: [
                        {
                          id: 'external-output',
                          type: 'graphOutput',
                          data: {
                            id: version === 'published' ? publishedOutputId : externalOutputId,
                            dataType: version === 'published' ? publishedOutputType : 'string',
                          },
                        },
                      ],
                      connections: [],
                    },
                  }
                : {},
            },
          },
        });
      } else if (path === '/api/projects/load' && request.method() === 'POST') {
        loadCount++;
        const requestedPath = request.postDataJSON().path;
        await route.fulfill({
          json: {
            contents: requestedPath === externalProject.absolutePath ? createExternalFixture() : contents,
            datasetsContents: null,
            revisionId: null,
          },
        });
      } else if (path === '/api/projects/save' && request.method() === 'POST') {
        const saved = request.postDataJSON();
        expect(saved.path).toBe(projectPath);
        expect(saved.projectId).toBe(project.id);
        expect(saved.saveIntent).toBe('in-place');
        contents = saved.contents;
        saveCount++;
        await route.fulfill({ json: { path: projectPath, revisionId: null } });
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        // Never let a fixture run upload recordings or mutate real workflows.
        unexpectedMutations.push(`${request.method()} ${path}`);
        await route.abort('blockedbyclient');
      } else {
        await route.fallback();
      }
    });
  };
  const openFixture = async (fixturePage: Page) => {
    await fixturePage.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(fixturePage);
    await waitForDashboardReady(fixturePage);
    const projectRow = fixturePage.locator('.project-row', { hasText: projectName });
    await expect(projectRow).toBeEnabled({ timeout: 90_000 });
    await projectRow.dblclick();
    const frame = fixturePage.frameLocator('iframe.dashboard-editor-frame');
    await expect(frame.locator('.node[data-nodeid="subgraph-a"]')).toBeVisible({ timeout: 90_000 });
    return frame;
  };

  await installFixture(page);
  const frame = await openFixture(page);
  const optimized = frame.locator('.node[data-nodeid="subgraph-a"]');
  const full = frame.locator('.node[data-nodeid="subgraph-b"]');
  const unset = frame.locator('.node[data-nodeid="subgraph-unset"]');
  const toggle = frame.locator('input#skipUnusedOutputs');
  const pruningBodySetting = (node: Locator) => node.getByTestId('subgraph-skip-unused-outputs');

  await test.step('Keep the Subgraph header icon before a target is configured', async () => {
    await expect(unset.locator('.subgraph-link-placeholder svg')).toBeVisible();
    await expect(unset.getByRole('button', { name: 'Go to subgraph', exact: true })).toHaveCount(0);
  });

  await test.step('Browse folder sections and select a graph through the searchable dropdown', async () => {
    await editNode(unset);
    const scope = frame.getByRole('group', { name: 'Subgraph graph source' });
    await expect(frame.locator('.panel-container').getByText('Graph source', { exact: true })).toBeVisible();
    await scope.getByRole('button', { name: 'Other projects' }).click();
    const selector = frame.locator('.panel-container').getByRole('combobox', { name: 'Subgraph graph' });
    await selector.click();
    const panel = frame.locator('.panel-container');
    await panel.getByText('Components', { exact: true }).click();
    const reusableY = (await panel.getByText('Reusable', { exact: true }).boundingBox())?.y;
    const zetaY = (await panel.getByText('Zeta', { exact: true }).boundingBox())?.y;
    expect(reusableY).toBeDefined();
    expect(zetaY).toBeDefined();
    expect(reusableY!).toBeLessThan(zetaY!);
    await panel.getByText('Reusable', { exact: true }).click();
    await panel.getByText('Reusable logic', { exact: true }).click();
    const graphFolder = panel.getByText('Graph group', { exact: true });
    await expect(graphFolder.locator('..').locator('svg')).toBeVisible();
    const graphFolderY = (await graphFolder.boundingBox())?.y;
    const savedGraphY = (await panel.getByText('Saved graph', { exact: true }).boundingBox())?.y;
    expect(graphFolderY).toBeDefined();
    expect(savedGraphY).toBeDefined();
    expect(graphFolderY!).toBeLessThan(savedGraphY!);
    await panel.getByText('Saved graph', { exact: true }).click();
    await expect(panel.locator('.subgraph-node-body-select')).toContainText('Reusable logic > Saved graph');
    await expect(unset.locator('.subgraph-node-body-select')).toContainText('Reusable logic > Saved graph');
    await expect(unset.getByRole('button', { name: 'Go to subgraph', exact: true })).toBeVisible();
    await expect(panel.getByText('A later save to the selected project changes this Subgraph’s next run.')).toHaveCount(
      0,
    );

    const version = frame.getByRole('group', { name: 'Subgraph project version' });
    await expect(version.getByRole('button', { name: 'Published' })).toBeEnabled();
    await version.getByRole('button', { name: 'Published' }).click();
    await expect(unset.locator('.subgraph-node-body-select')).toContainText('Published graph');
    await expect(panel.locator('.subgraph-node-body-select')).toContainText('Reusable logic > Published graph');
    await expect(unset.locator('.output-port[data-portid="result"]')).toHaveCount(1);
    await expect(unset.locator('.output-port[data-portid="outputStream2"]')).toHaveCount(0);
    await expect(panel.getByText(/The selected project's graph changed its output/)).toHaveCount(0);
    await version.getByRole('button', { name: 'Saved latest' }).click();
    await expect(version.getByRole('button', { name: 'Saved latest' })).toHaveAttribute('aria-pressed', 'true');
    publishedOutputType = 'number';
    await version.getByRole('button', { name: 'Published' }).click();
    const automaticWarning = panel.getByText(
      'The selected project\'s graph changed its output "result". The graph selection was updated automatically; review its connections.',
      { exact: true },
    );
    await expect(automaticWarning).toBeVisible();
    const versionBounds = await version.boundingBox();
    const warningBounds = await automaticWarning.boundingBox();
    expect(versionBounds).not.toBeNull();
    expect(warningBounds).not.toBeNull();
    expect(warningBounds!.y).toBeGreaterThan(versionBounds!.y + versionBounds!.height);
    const warningColors = await automaticWarning.evaluate((element) => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--warning)';
      element.append(reference);
      const colors = { actual: getComputedStyle(element).color, expected: getComputedStyle(reference).color };
      reference.remove();
      return colors;
    });
    expect(warningColors.actual).toBe(warningColors.expected);
    externalPreviewUnavailable = true;
    await version.getByRole('button', { name: 'Saved latest' }).click();
    await expect(
      panel.getByText('Could not load the selected project version. The current version was kept.'),
    ).toBeVisible();
    await expect(version.getByRole('button', { name: 'Published' })).toHaveAttribute('aria-pressed', 'true');
    const previewRequestsBeforeRefresh = externalPreviewRequests;
    await selector.click();
    await expect(frame.locator('.panel-container').getByText('Preview temporarily unavailable')).toBeVisible();
    expect(externalPreviewRequests).toBe(previewRequestsBeforeRefresh + 1);
    await selector.press('Escape');
    await expect(unset.locator('.subgraph-node-body-select')).toContainText('Published graph');
    await expect(
      frame.locator('.panel-container').getByText('Could not refresh the target preview. Try again.'),
    ).toBeVisible();
    externalPreviewUnavailable = false;
    publishedOutputId = 'renamed-result';
    await selector.click();
    await expect(panel.getByText(/The selected project's graph changed its output/)).toHaveCount(0);
    await selector.press('Escape');
    publishedOutputType = 'boolean';
    await selector.click();
    await expect(
      frame
        .locator('.panel-container')
        .getByText(
          'The selected project\'s graph changed its output "outputStream2". Re-select the graph and review its connections.',
        ),
    ).toBeVisible();
    await selector.press('Escape');
    publishedOutputType = 'number';
    publishedOutputId = 'outputStream2';
    externalGraphAvailable = false;
    await selector.click();
    await expect(
      frame.locator('.panel-container').getByText('Selected graph is unavailable. Choose another graph.'),
    ).toBeVisible();
    await selector.press('Escape');
    externalGraphAvailable = true;
    await expect(unset.getByRole('button', { name: 'Go to subgraph', exact: true })).toBeVisible();
  });

  await test.step('Choose current-project graphs from the compact Subgraph target control', async () => {
    await frame
      .getByRole('group', { name: 'Subgraph graph source' })
      .getByRole('button', { name: 'This project' })
      .click();
    const selector = frame.locator('.panel-container').getByRole('combobox', { name: 'Subgraph graph' });
    const selectorContainer = unset.locator('.subgraph-node-body-select-wrap');

    await expect
      .poll(async () => {
        const selectorWidth = await selectorContainer.evaluate((element) => element.getBoundingClientRect().width);
        const bodyWidth = await unset
          .locator('.node-body')
          .evaluate((element) => element.getBoundingClientRect().width);
        return Math.abs(selectorWidth - bodyWidth);
      })
      .toBeLessThan(1);

    await selector.click();
    const panel = frame.locator('.panel-container');
    const rows = [
      panel.getByText('Folder A', { exact: true }),
      panel.getByText('Alpha graph', { exact: true }),
      panel.getByText('Selector search target', { exact: true }),
      panel.getByText('Folder B', { exact: true }),
      panel.getByText('Child Graph', { exact: true }),
      panel.getByText('Main Graph', { exact: true }),
    ];
    const positions = await Promise.all(rows.map(async (row) => (await row.boundingBox())?.y));
    await expect(rows[0]!.locator('..').locator('svg')).toBeVisible();
    await expect(rows[3]!.locator('..').locator('svg')).toBeVisible();
    expect(positions.every((position) => position != null)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left! - right!));
    await selector.fill('Selector search');
    await frame.locator('.panel-container').getByText('Selector search target', { exact: true }).click();
    await expect(selectorContainer).toContainText('Selector search target');
    await expect(unset.getByRole('button', { name: 'Go to subgraph', exact: true })).toBeVisible();

    await selector.click();
    await selector.fill('Child Graph');
    await frame.locator('.panel-container').getByText('Child Graph', { exact: true }).click();
    await expect(selectorContainer).toContainText('Child Graph');
  });

  await test.step('Enable the setting and verify its ordinary editing behavior', async () => {
    await expect(pruningBodySetting(optimized)).toHaveCount(0);
    await expect(pruningBodySetting(full)).toHaveCount(0);
    await editNode(optimized);
    const outputs = frame.locator('.panel-container .collapsible-panel-toggle').filter({ hasText: 'Outputs' });
    await expect(outputs).toHaveAttribute('aria-expanded', 'false');
    await outputs.click();
    await expect(outputs).toHaveAttribute('aria-expanded', 'true');
    await expect(frame.getByText('Use Error Output', { exact: true })).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(frame.getByText(helpText, { exact: true })).toBeVisible();
    await frame.getByText('Skip unused outputs', { exact: true }).click();
    await expect(toggle).toBeChecked();
    await expect(pruningBodySetting(optimized)).toHaveText('Skip unused outputs: Enabled');
    await expect(pruningBodySetting(full)).toHaveCount(0);
    await expect(
      optimized.locator('.subgraph-node-body-select-wrap + [data-testid="subgraph-skip-unused-outputs"]'),
    ).toHaveCount(1);
    await frame.locator('.section-footer .node-id').click();
    await page.keyboard.press(`${shortcutModifier}+Z`);
    await expect(toggle).not.toBeChecked();
    await expect(pruningBodySetting(optimized)).toHaveCount(0);
    await page.keyboard.press(`${shortcutModifier}+Shift+Z`);
    await expect(toggle).toBeChecked();
    await expect(pruningBodySetting(optimized)).toHaveText('Skip unused outputs: Enabled');
    await editNode(full);
    await expect(toggle).not.toBeChecked();
    await editNode(optimized);
    await expect(toggle).toBeChecked();
  });

  await test.step('Save only into mocked storage', async () => {
    await toggle.press(`${shortcutModifier}+S`);
    await expect.poll(() => saveCount).toBe(1);
    const savedNodes = parse(contents).data.graphs.main.nodes;
    const nodeData = (id: string) =>
      Object.entries(savedNodes).find(([key]) => key.startsWith(`[${id}]:`))?.[1] as {
        data: { skipUnusedOutputs?: boolean; graphId?: string };
      };
    expect(nodeData('subgraph-a').data.skipUnusedOutputs).toBe(true);
    expect(nodeData('subgraph-b').data.skipUnusedOutputs ?? false).toBe(false);
    expect(nodeData('subgraph-unset').data.graphId).toBe('child');
  });

  await test.step('Follow an external Subgraph to its project and selected graph', async () => {
    await unset.locator('.edit-button').evaluate((button: HTMLElement) => button.click());
    await frame.getByRole('group', { name: 'Subgraph graph source' }).getByRole('button', { name: 'Other projects' }).click();
    const selector = frame.locator('.panel-container').getByRole('combobox', { name: 'Subgraph graph' });
    await selector.click();
    const panel = frame.locator('.panel-container');
    await panel.getByText('Components', { exact: true }).click();
    await panel.getByText('Reusable', { exact: true }).click();
    await panel.getByText('Reusable logic', { exact: true }).click();
    await panel.getByText('Saved graph', { exact: true }).click();
    await expect(unset.locator('.subgraph-node-body-select')).toContainText('Reusable logic > Saved graph');
    await unset.getByRole('button', { name: 'Go to subgraph', exact: true }).evaluate((button: HTMLElement) => button.click());
    await expect(frame.locator('.node[data-nodeid="external-output"]')).toBeVisible();
    await expect(frame.locator('.projects .project.active', { hasText: 'Reusable logic' })).toBeVisible();
  });

  // A fresh browser context proves file persistence rather than restoring the
  // original editor's IndexedDB snapshot after a page reload.
  // Close the first editor before starting another Vite-backed iframe: on
  // Windows, two live editors can exhaust Chromium's local socket pool.
  await page.close();
  const reloaded = await browser.newPage({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  try {
    await installFixture(reloaded);
    const loadCountBeforeReload = loadCount;
    const reloadedFrame = await openFixture(reloaded);
    await expect.poll(() => loadCount).toBeGreaterThan(loadCountBeforeReload);
    const optimizedReloaded = reloadedFrame.locator('.node[data-nodeid="subgraph-a"]');
    const fullReloaded = reloadedFrame.locator('.node[data-nodeid="subgraph-b"]');
    await expect(
      reloadedFrame.locator('.node[data-nodeid="subgraph-unset"] .subgraph-node-body-select-wrap'),
    ).toContainText('Child Graph');
    await editNode(optimizedReloaded);
    await reloadedFrame.locator('.panel-container .collapsible-panel-toggle').filter({ hasText: 'Outputs' }).click();
    await expect(reloadedFrame.locator('input#skipUnusedOutputs')).toBeChecked();
    await editNode(fullReloaded);
    await expect(reloadedFrame.locator('input#skipUnusedOutputs')).not.toBeChecked();
    await reloaded.keyboard.press('Escape');

    await test.step('Run locally and show requested versus excluded values', async () => {
      await reloadedFrame.locator('.run-button button').first().click();
      await expect(optimizedReloaded).toHaveClass(/success/);
      await expect(fullReloaded).toHaveClass(/success/);
      await optimizedReloaded.hover();
      await expect(optimizedReloaded.locator('.node-output')).toContainText('wanted-result');
      await expect(optimizedReloaded.locator('.node-output')).toContainText('Not ran');
      await expect(optimizedReloaded.locator('.node-output')).not.toContainText('unused-result');
      await fullReloaded.hover();
      await expect(fullReloaded.locator('.node-output')).toContainText('unused-result');
    });

    await test.step('Following a caller selects its execution while preserving explicit history navigation', async () => {
      await optimizedReloaded.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
      const wanted = reloadedFrame.locator('.node[data-nodeid="wanted-text"]');
      const unused = reloadedFrame.locator('.node[data-nodeid="unused-text"]');
      await expect(wanted).toBeVisible();
      await expect(wanted).toHaveClass(/success/);
      await expect(unused).not.toHaveClass(/success/);
      await unused.hover();
      await expect(unused.locator('.node-output')).toHaveCount(0);
      await expect(reloadedFrame.getByText('Execution: 1/2', { exact: true })).toBeVisible();
      await reloadedFrame.getByRole('button', { name: 'Next execution (all nodes)', exact: true }).click();
      await expect(unused).toHaveClass(/success/);
      await unused.hover();
      await expect(unused.locator('.node-output')).toContainText('unused-result');

      await reloadedFrame.getByRole('button', { name: 'Go to previous graph', exact: true }).click();
      const skipped = reloadedFrame.locator('.node[data-nodeid="subgraph-skipped"]');
      await expect(skipped).toBeVisible();
      await skipped.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
      await expect(reloadedFrame.getByText('No execution for selected caller', { exact: true })).toBeVisible();
      await expect(wanted).not.toHaveClass(/success/);
      await expect(unused).not.toHaveClass(/success/);
      await wanted.hover();
      await expect(wanted.locator('.node-output')).toHaveCount(0);
      await reloadedFrame.getByRole('button', { name: 'Next execution (all nodes)', exact: true }).click();
      await expect(wanted).toHaveClass(/success/);
      await expect(reloadedFrame.getByText('Execution: 1/2', { exact: true })).toBeVisible();
    });

    await test.step('Re-selecting the same external graph in the node body saves a refreshed boundary', async () => {
      await reloadedFrame.getByRole('button', { name: 'Go to previous graph', exact: true }).click();
      const caller = reloadedFrame.locator('.node[data-nodeid="subgraph-unset"]');
      await caller.locator('.edit-button').evaluate((button: HTMLElement) => button.click());
      await reloadedFrame.getByRole('group', { name: 'Subgraph graph source' })
        .getByRole('button', { name: 'Other projects' }).click();
      const panelSelector = reloadedFrame.locator('.panel-container').getByRole('combobox', { name: 'Subgraph graph' });
      await panelSelector.click();
      const panel = reloadedFrame.locator('.panel-container');
      await panel.getByText('Components', { exact: true }).click();
      await panel.getByText('Reusable', { exact: true }).click();
      await panel.getByText('Reusable logic', { exact: true }).click();
      await panel.getByText('Saved graph', { exact: true }).click();

      externalOutputId = 'renamed-result';
      await reloaded.setViewportSize({ width: 1800, height: 1600 });
      await reloadedFrame.locator('.node-canvas').click({ position: { x: 300, y: 60 } });
      const bodySelector = caller.locator('.subgraph-node-body-select');
      const previewsBeforeReselect = externalPreviewRequests;
      await bodySelector.locator('input').click();
      await expect.poll(() => externalPreviewRequests).toBeGreaterThan(previewsBeforeReselect);
      await reloadedFrame.getByText('Components', { exact: true }).click();
      await reloadedFrame.getByText('Reusable', { exact: true }).click();
      const savedOption = reloadedFrame.getByText('Saved graph', { exact: true });
      if (!(await savedOption.isVisible())) {
        await reloadedFrame.getByText('Reusable logic', { exact: true }).click();
      }
      await savedOption.click();
      await reloaded.keyboard.press(`${shortcutModifier}+S`);
      await expect.poll(() => saveCount).toBe(2);
      const savedNodes = parse(contents).data.graphs.main.nodes;
      const savedCaller = Object.entries(savedNodes).find(([key]) => key.startsWith('[subgraph-unset]:'))?.[1] as {
        data: { targetBoundary?: { outputs: Array<{ id: string; portId: string }> } };
      };
      expect(savedCaller.data.targetBoundary?.outputs[0]).toMatchObject({ id: 'renamed-result', portId: 'result' });
    });
  } finally {
    await reloaded.close();
  }

  expect(unexpectedMutations).toEqual([]);
});
