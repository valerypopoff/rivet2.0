import { expect, test, type Page, type Route } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem } from '../dashboard/types';

type TreeState = {
  folders: Array<{
    id: string;
    name: string;
    relativePath: string;
    absolutePath: string;
    updatedAt: string;
    folders: [];
    projects: [];
  }>;
  projects: WorkflowProjectItem[];
  revision: number;
};

function createProjectFixture(name: string): WorkflowProjectItem {
  const fileName = `${name}.rivet-project`;

  return {
    id: `${name}-project-id`,
    projectMetadataId: `${name}-project-id`,
    name,
    fileName,
    relativePath: fileName,
    absolutePath: `/managed/workflows/${fileName}`,
    updatedAt: '2026-08-31T00:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };
}

function createProjectContents(projectName: string): string {
  const projectId = `${projectName}-project-id`;
  const graphId = `${projectName}-graph-id`;

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(projectId)}`,
    `    title: ${JSON.stringify(projectName)}`,
    `    mainGraphId: ${JSON.stringify(graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes: {}',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function installMockEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      static instances: MockEventSource[] = [];
      readonly url: string;
      readyState = 1;

      constructor(url: string) {
        super();
        this.url = url;
        MockEventSource.instances.push(this);
      }

      close() {
        this.readyState = 2;
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: MockEventSource,
      writable: true,
    });
    Object.assign(window, {
      __emitWorkflowTreeEvent(eventName: string, payload: unknown) {
        for (const stream of MockEventSource.instances) {
          if (stream.readyState !== 2) {
            stream.dispatchEvent(new MessageEvent(eventName, { data: JSON.stringify(payload) }));
          }
        }
      },
    });
  });
}

async function installTreeRoute(page: Page, state: TreeState, treeReads: { count: number }): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    treeReads.count += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        root: '/managed/workflows',
        folders: state.folders,
        projects: state.projects,
        sync: { epoch: 'playwright-tree-sync', revision: state.revision },
      }),
    });
  });
}

async function emitTreeChange(page: Page, payload: unknown): Promise<void> {
  await page.evaluate((nextPayload) => {
    (window as Window & {
      __emitWorkflowTreeEvent?: (eventName: string, eventPayload: unknown) => void;
    }).__emitWorkflowTreeEvent?.('tree-changed', nextPayload);
  }, payload);
}

async function dispatchProjectOpenedFromEditorFrame(page: Page, path: string): Promise<void> {
  await page.evaluate((projectPath) => {
    const editorFrame = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'project-opened', path: projectPath },
      origin: window.location.origin,
      source: editorFrame?.contentWindow ?? null,
    }));
  }, path);
}

test('a workflow tree mutation refreshes a second administrator browser without reloading it', async ({ browser }) => {
  const administratorA = await browser.newContext();
  const administratorB = await browser.newContext();
  const pageA = await administratorA.newPage();
  const pageB = await administratorB.newPage();
  const state: TreeState = { folders: [], projects: [], revision: 0 };
  const treeReadsA = { count: 0 };
  const treeReadsB = { count: 0 };

  try {
    await Promise.all([
      installMockEventSource(pageA),
      installMockEventSource(pageB),
    ]);
    await Promise.all([
      installTreeRoute(pageA, state, treeReadsA),
      installTreeRoute(pageB, state, treeReadsB),
    ]);

    let originClientId: string | null = null;
    await pageA.route('**/api/workflows/folders', async (route: Route) => {
      if (route.request().method() !== 'POST') {
        await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected request' }) });
        return;
      }

      originClientId = route.request().headers()['x-rivet-workflow-tree-client'] ?? null;
      state.folders = [{
        id: 'shared-folder',
        name: 'Shared folder',
        relativePath: 'Shared folder',
        absolutePath: '/managed/workflows/Shared folder',
        updatedAt: '2026-08-31T00:00:00.000Z',
        folders: [],
        projects: [],
      }];
      state.revision += 1;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ folder: state.folders[0] }) });

      setTimeout(() => {
        const event = {
          epoch: 'playwright-tree-sync',
          revision: state.revision,
          sourceClientId: originClientId,
        };
        void Promise.all([emitTreeChange(pageA, event), emitTreeChange(pageB, event)]);
      }, 0);
    });

    await Promise.all([
      pageA.goto('/', { waitUntil: 'domcontentloaded' }),
      pageB.goto('/', { waitUntil: 'domcontentloaded' }),
    ]);
    await Promise.all([
      authenticateIfNeeded(pageA),
      authenticateIfNeeded(pageB),
    ]);
    await Promise.all([
      waitForDashboardReady(pageA),
      waitForDashboardReady(pageB),
    ]);
    await expect(pageB.locator('.folder-row', { hasText: 'Shared folder' })).toHaveCount(0);

    pageA.once('dialog', (dialog) => void dialog.accept('Shared folder'));
    await pageA.getByRole('button', { name: '+ New folder' }).click();

    await expect(pageA.locator('.folder-row', { hasText: 'Shared folder' })).toBeVisible();
    await expect(pageB.locator('.folder-row', { hasText: 'Shared folder' })).toBeVisible();
    expect(originClientId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(treeReadsA.count).toBeGreaterThan(1);
    expect(treeReadsB.count).toBeGreaterThan(1);
  } finally {
    await administratorA.close();
    await administratorB.close();
  }
});

test('a remote removal updates the tree but preserves the already open editor document', async ({ page }) => {
  const projectName = 'Remote project';
  const project = createProjectFixture(projectName);
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  const treeReads = { count: 0 };
  let projectLoadRequests = 0;

  await installMockEventSource(page);
  await installTreeRoute(page, state, treeReads);
  await page.route('**/api/projects/load', async (route) => {
    projectLoadRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createProjectContents(projectName),
        datasetsContents: null,
        revisionId: null,
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const projectRow = page.locator('.project-row', { hasText: projectName });
  await expect(projectRow).toBeVisible();
  await projectRow.dblclick();
  const editorFrame = page.locator('iframe.dashboard-editor-frame');
  await expect(editorFrame).toBeVisible();
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('.projects-container')).toBeVisible();
  await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);
  await expect(page.locator('.active-project-name')).toHaveText(projectName);
  expect(projectLoadRequests).toBe(1);

  state.projects = [];
  state.revision += 1;
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: state.revision,
    sourceClientId: 'other-administrator',
  });

  await expect(projectRow).toHaveCount(0);
  await expect(page.locator('.Toastify__toast')).toContainText(
    'was removed by another administrator. It remains open unchanged in the editor.',
  );
  await expect(editorFrame).toBeVisible();
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('.projects-container')).toBeVisible();
  await page.waitForTimeout(250);
  expect(projectLoadRequests).toBe(1);
  expect(treeReads.count).toBeGreaterThan(1);
});
