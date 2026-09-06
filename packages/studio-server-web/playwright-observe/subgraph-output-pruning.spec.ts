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
    child:
      metadata:
        id: child
        name: Child Graph
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
  const installFixture = async (fixturePage: Page) => {
    await fixturePage.addInitScript(() => {
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
    });
    await fixturePage.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/workflows/tree' && request.method() === 'GET') {
        const tree: WorkflowTreeResponse = {
          root: '/workflows',
          sync: { epoch: 'pruning-fixture', revision: 0 },
          folders: [],
          projects: [project],
        };
        await route.fulfill({ json: tree });
      } else if (path === '/api/projects/load' && request.method() === 'POST') {
        loadCount++;
        await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
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
  const toggle = frame.locator('input#skipUnusedOutputs');
  const pruningBodySetting = (node: Locator) => node.getByTestId('subgraph-skip-unused-outputs');

  await test.step('Enable the setting and verify its ordinary editing behavior', async () => {
    await expect(pruningBodySetting(optimized)).toHaveCount(0);
    await expect(pruningBodySetting(full)).toHaveCount(0);
    await editNode(optimized);
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
        data: { skipUnusedOutputs?: boolean };
      };
    expect(nodeData('subgraph-a').data.skipUnusedOutputs).toBe(true);
    expect(nodeData('subgraph-b').data.skipUnusedOutputs ?? false).toBe(false);
  });

  // A fresh browser context proves file persistence rather than restoring the
  // original editor's IndexedDB snapshot after a page reload.
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
    await editNode(optimizedReloaded);
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
  } finally {
    await reloaded.close();
  }
  expect(unexpectedMutations).toEqual([]);
});
