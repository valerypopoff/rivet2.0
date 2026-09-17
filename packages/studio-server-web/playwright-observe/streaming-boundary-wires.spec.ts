import { expect, test } from '@playwright/test';
import { stringify } from 'yaml';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

for (const direction of ['outputs', 'inputs']) {
  test(`streaming arrows survive navigation through two named Subgraph ${direction}`, async ({ page }) => {
    const projectName = 'Nested streaming wires';
    const projectPath = `/workflows/${projectName}.rivet-project`;
    const fixture = {
      version: 4,
      data: {
        metadata: { id: 'streaming-wires', title: projectName, description: '', mainGraphId: 'root' },
        graphs: {
          root: {
            metadata: { id: 'root', name: 'Root' },
            nodes: {
              '[caller]:subGraph "Middle caller"': {
                data: { graphId: 'middle' },
                visualData: '100/150/260/null//',
                outgoingConnections: ['renamed->"Watch" watch/stream'],
              },
              '[watch]:watchStreamingOutput "Watch"': { data: {}, visualData: '600/150/280/null//' },
            },
          },
          middle: {
            metadata: { id: 'middle', name: 'Middle' },
            nodes: {
              '[caller]:subGraph "Leaf caller"': {
                data: { graphId: 'leaf' },
                visualData: '100/150/260/null//',
                outgoingConnections: ['answer->"Boundary" out/value'],
              },
              '[out]:graphOutput "Boundary"': {
                data: { id: 'renamed', dataType: 'string' },
                visualData: '600/150/240/null//',
              },
            },
          },
          leaf: {
            metadata: { id: 'leaf', name: 'Leaf' },
            nodes: {
              '[llm]:llmChatV2 "LLM Chat"': {
                data: {},
                visualData: '100/150/280/null//',
                outgoingConnections: ['response->"Boundary" out/value'],
              },
              '[out]:graphOutput "Boundary"': {
                data: { id: 'answer', dataType: 'string' },
                visualData: '600/150/240/null//',
              },
            },
          },
        },
        plugins: [],
        references: [],
      },
    };
    if (direction === 'inputs') {
      Object.assign(fixture.data.graphs, {
        root: {
          metadata: { id: 'root', name: 'Root' },
          nodes: {
            '[llm]:llmChatV2 "LLM Chat"': {
              data: {},
              visualData: '100/150/280/null//',
              outgoingConnections: ['response->"Middle caller" caller/outer'],
            },
            '[caller]:subGraph "Middle caller"': {
              data: { graphId: 'middle' },
              visualData: '600/150/260/null//',
            },
          },
        },
        middle: {
          metadata: { id: 'middle', name: 'Middle' },
          nodes: {
            '[input]:graphInput "Graph Input"': {
              data: { id: 'outer', dataType: 'string' },
              visualData: '100/150/260/null//',
              outgoingConnections: ['data->"Leaf caller" caller/stream'],
            },
            '[caller]:subGraph "Leaf caller"': {
              data: { graphId: 'leaf' },
              visualData: '600/150/260/null//',
            },
          },
        },
        leaf: {
          metadata: { id: 'leaf', name: 'Leaf' },
          nodes: {
            '[input]:graphInput "Graph Input"': {
              data: { id: 'stream', dataType: 'string' },
              visualData: '100/150/260/null//',
              outgoingConnections: ['data->"Watch" watch/stream'],
            },
            '[watch]:watchStreamingOutput "Watch"': { data: {}, visualData: '600/150/280/null//' },
          },
        },
      });
    }
    const contents = stringify(fixture);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/config') {
        await route.fulfill({
          json: {
            publishedWorkflowsBasePath: '/workflows',
            latestWorkflowsBasePath: '/workflows-latest',
            publishedAppsBasePath: '/apps',
            latestAppsBasePath: '/apps-latest',
            webAppsAuthMode: 'ui-gate',
          },
        });
      } else if (path === '/api/workflows/evaluation-runs/library') {
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
      } else if (path === '/api/workflows/tree') {
        await route.fulfill({
          json: {
            root: '/workflows',
            sync: { epoch: 'streaming-wires', revision: 0 },
            folders: [],
            projects: [
              {
                id: 'streaming-wires',
                name: projectName,
                fileName: `${projectName}.rivet-project`,
                relativePath: `${projectName}.rivet-project`,
                absolutePath: projectPath,
                updatedAt: '2026-09-17T00:00:00.000Z',
                settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
              },
            ],
          },
        });
      } else if (path === '/api/projects/load') {
        await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        await route.abort('blockedbyclient');
      } else {
        await route.fallback();
      }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const row = page.locator('.project-row', { hasText: projectName });
    await expect(row).toBeEnabled({ timeout: 90_000 });
    await row.dblclick();
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const markers = editor.locator('.streaming-output-watch-marker-path');
    const expectArrows = async () => {
      await expect.poll(() => markers.count()).toBeGreaterThan(0);
      await expect(markers.first()).toBeVisible();
    };
    await expect(editor.locator(`.node[data-nodeid="${direction === 'inputs' ? 'llm' : 'watch'}"]`)).toBeVisible();
    await expectArrows();
    await editor.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
    await expect(editor.locator(`.node[data-nodeid="${direction === 'inputs' ? 'input' : 'out'}"]`)).toContainText(
      direction === 'inputs' ? 'outer' : 'renamed',
    );
    await expectArrows();
    await editor.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
    await expect(editor.locator(`.node[data-nodeid="${direction === 'inputs' ? 'watch' : 'llm'}"]`)).toBeVisible();
    await expectArrows();
    await editor.getByRole('button', { name: 'Go to previous graph', exact: true }).click();
    await expect(editor.locator(`.node[data-nodeid="${direction === 'inputs' ? 'input' : 'out'}"]`)).toContainText(
      direction === 'inputs' ? 'outer' : 'renamed',
    );
    await expectArrows();
  });
}
