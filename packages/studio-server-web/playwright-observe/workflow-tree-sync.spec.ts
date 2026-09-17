import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  startAsyncWorkflowProcess,
  withAsyncDeadline,
} from '../../studio-server-api/src/tests/helpers/workflow-async-process';

import { authenticateIfNeeded, panGraphCanvas, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../dashboard/types';
import type { HostedProjectConflictSnapshot } from '../../studio-server-shared/editor-bridge';

declare global {
  interface Window {
    __conflictSnapshots: HostedProjectConflictSnapshot[];
    __dropNextCapture: boolean;
    __captures: number;
    __savedProjects: number;
    __reconciliationStatuses: string[];
  }
}

let api: Awaited<ReturnType<typeof startAsyncWorkflowProcess>>;
test.beforeAll(async () => {
  api = await startAsyncWorkflowProcess();
});
test.afterAll(async () => {
  await api?.close();
});
async function routeFixtureApi(page: Page) {
  const proxyToken = createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex');
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch({
      url: `${api.baseUrl}${url.pathname}${url.search}`,
      headers: { ...request.headers(), 'x-rivet-proxy-auth': proxyToken },
    });
    await route.fulfill({ response });
  });
}
test.beforeEach(async ({ page }) => {
  await routeFixtureApi(page);
  await page.addInitScript(() => {
    window.__conflictSnapshots = [];
    window.__captures = 0;
    window.__savedProjects = 0;
    window.__reconciliationStatuses = [];
    window.addEventListener(
      'message',
      (event) => {
        if (event.data?.type === 'project-saved') window.__savedProjects++;
        if (event.data?.type === 'workflow-project-bindings-reconciled')
          window.__reconciliationStatuses.push(event.data.status);
        if (event.data?.type === 'workflow-project-conflicts') window.__conflictSnapshots.push(event.data.snapshot);
        if (event.data?.type === 'workflow-project-reconciliation-captured') {
          window.__captures++;
          if (window.__dropNextCapture) {
            window.__dropNextCapture = false;
            event.stopImmediatePropagation();
          }
        }
      },
      true,
    );
  });
});

type TreeState = {
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
  revision: number;
};

function createProjectFixture(name: string, revisionId?: string): WorkflowProjectItem {
  const fileName = `${name}.rivet-project`;

  return {
    id: `${name}-project-id`,
    projectMetadataId: `${name}-project-id`,
    name,
    fileName,
    relativePath: fileName,
    absolutePath: `/managed/workflows/${fileName}`,
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...(revisionId ? { revisionId } : {}),
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
    '      nodes:',
    '        \'[tree-sync-node]:text "Tree sync fixture"\':',
    '          visualData: 300/200/260/null//',
    '          data:',
    '            text: Tree synchronization fixture',
    '      connections: []',
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
    (
      window as Window & {
        __emitWorkflowTreeEvent?: (eventName: string, eventPayload: unknown) => void;
      }
    ).__emitWorkflowTreeEvent?.('tree-changed', nextPayload);
  }, payload);
}

async function dispatchProjectOpenedFromEditorFrame(page: Page, path: string): Promise<void> {
  await page.evaluate((projectPath) => {
    const editorFrame = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'project-opened', path: projectPath },
        origin: window.location.origin,
        source: editorFrame?.contentWindow ?? null,
      }),
    );
  }, path);
}

test('folder context menu creates a nested folder inside the selected folder', async ({ page }) => {
  const parentFolder: WorkflowFolderItem = {
    id: 'parent-folder',
    name: 'Parent folder',
    relativePath: 'Parent folder',
    absolutePath: '/managed/workflows/Parent folder',
    updatedAt: '2026-09-16T00:00:00.000Z',
    folders: [],
    projects: [],
  };
  const state: TreeState = { folders: [parentFolder], projects: [], revision: 0 };
  const createRequests: unknown[] = [];
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/workflows/folders', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON();
    createRequests.push(requestBody);
    const childFolder: WorkflowFolderItem = {
      id: 'parent-folder/child-folder',
      name: 'Child folder',
      relativePath: 'Parent folder/Child folder',
      absolutePath: '/managed/workflows/Parent folder/Child folder',
      updatedAt: '2026-09-16T00:00:01.000Z',
      folders: [],
      projects: [],
    };
    parentFolder.folders = [childFolder];
    state.revision += 1;
    await route.fulfill({ status: 201, json: { folder: childFolder } });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  await page.getByRole('button', { name: 'Expand Parent folder' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New folder' })).toBeVisible();
  expect(await page.getByRole('menuitem').allTextContents()).toEqual([
    'Rename folder',
    'New folder',
    'New project',
    'Upload project',
    'Delete folder',
  ]);
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe('New folder name in folder "Parent folder":');
    void dialog.accept('Child folder');
  });
  await page.getByRole('menuitem', { name: 'New folder' }).click();

  await expect(page.getByRole('button', { name: 'Collapse Parent folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Child folder' })).toBeVisible();
  expect(createRequests).toEqual([
    {
      name: 'Child folder',
      parentRelativePath: 'Parent folder',
    },
  ]);
});

test('a workflow tree mutation refreshes a second administrator browser without reloading it', async ({ browser }) => {
  const administratorA = await browser.newContext();
  const administratorB = await browser.newContext();
  const pageA = await administratorA.newPage();
  const pageB = await administratorB.newPage();
  await routeFixtureApi(pageA);
  await routeFixtureApi(pageB);
  const state: TreeState = { folders: [], projects: [], revision: 0 };
  const treeReadsA = { count: 0 };
  const treeReadsB = { count: 0 };

  try {
    await Promise.all([installMockEventSource(pageA), installMockEventSource(pageB)]);
    await Promise.all([installTreeRoute(pageA, state, treeReadsA), installTreeRoute(pageB, state, treeReadsB)]);

    let originClientId: string | null = null;
    await pageA.route('**/api/workflows/folders', async (route: Route) => {
      if (route.request().method() !== 'POST') {
        await route.fulfill({
          status: 405,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unexpected request' }),
        });
        return;
      }

      originClientId = route.request().headers()['x-rivet-workflow-tree-client'] ?? null;
      state.folders = [
        {
          id: 'shared-folder',
          name: 'Shared folder',
          relativePath: 'Shared folder',
          absolutePath: '/managed/workflows/Shared folder',
          updatedAt: '2026-08-31T00:00:00.000Z',
          folders: [],
          projects: [],
        },
      ];
      state.revision += 1;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ folder: state.folders[0] }),
      });

      setTimeout(() => {
        const event = {
          epoch: 'playwright-tree-sync',
          revision: state.revision,
          sourceClientId: originClientId,
        };
        void Promise.all([emitTreeChange(pageA, event), emitTreeChange(pageB, event)]);
      }, 0);
    });

    const initialTrees = [pageA, pageB].map((page) =>
      page.waitForResponse((response) => response.url().endsWith('/api/workflows/tree') && response.status() === 200),
    );
    await Promise.all([
      pageA.goto('/', { waitUntil: 'domcontentloaded' }),
      pageB.goto('/', { waitUntil: 'domcontentloaded' }),
    ]);
    await Promise.all(initialTrees.map(async (response) => (await response).finished()));
    await Promise.all([authenticateIfNeeded(pageA), authenticateIfNeeded(pageB)]);
    await Promise.all([waitForDashboardReady(pageA), waitForDashboardReady(pageB)]);
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

test('a tab opened by another dashboard still receives that dashboard’s tree changes', async ({ page }) => {
  const state: TreeState = { folders: [], projects: [], revision: 0 };
  let sourceClientId: string | null = null;
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/workflows/folders', async (route) => {
    sourceClientId = route.request().headers()['x-rivet-workflow-tree-client'] ?? null;
    const folder: TreeState['folders'][number] = {
      id: 'first-folder',
      name: 'First folder',
      relativePath: 'First folder',
      absolutePath: '/managed/workflows/First folder',
      updatedAt: '2026-08-31T00:00:00.000Z',
      folders: [],
      projects: [],
    };
    state.folders = [folder];
    state.revision++;
    await route.fulfill({ status: 201, json: { folder } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  page.once('dialog', (dialog) => void dialog.accept('First folder'));
  await page.getByRole('button', { name: '+ New folder' }).click();
  await expect(page.locator('.folder-row', { hasText: 'First folder' })).toBeVisible();
  expect(sourceClientId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

  const popup = page.waitForEvent('popup');
  await page.evaluate(() => window.open('about:blank', '_blank'));
  const secondPage = await popup;
  await routeFixtureApi(secondPage);
  await installMockEventSource(secondPage);
  const secondPageTreeReads = { count: 0 };
  await installTreeRoute(secondPage, state, secondPageTreeReads);
  const initialTree = secondPage.waitForResponse((response) => response.url().endsWith('/api/workflows/tree'));
  await secondPage.goto('/');
  await (await initialTree).finished();
  await waitForDashboardReady(secondPage);
  await expect(secondPage.locator('.folder-row', { hasText: 'First folder' })).toBeVisible();
  const readsBeforeChange = secondPageTreeReads.count;

  state.folders = [
    ...state.folders,
    {
      id: 'second-folder',
      name: 'Second folder',
      relativePath: 'Second folder',
      absolutePath: '/managed/workflows/Second folder',
      updatedAt: '2026-08-31T00:00:00.000Z',
      folders: [],
      projects: [],
    },
  ];
  await emitTreeChange(secondPage, {
    epoch: 'playwright-tree-sync',
    revision: ++state.revision,
    sourceClientId,
  });
  await expect.poll(() => secondPageTreeReads.count).toBeGreaterThan(readsBeforeChange);
  await expect(secondPage.locator('.folder-row', { hasText: 'Second folder' })).toBeVisible();
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
    'no longer appears in the project tree. It remains open unchanged in the editor.',
  );
  await expect(editorFrame).toBeVisible();
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('.projects-container')).toBeVisible();
  await page.waitForTimeout(250);
  expect(projectLoadRequests).toBe(1);
  expect(treeReads.count).toBeGreaterThan(1);
});

test('a page reload restores the latest graph canvas position', async ({ page }) => {
  const projectName = 'Viewport persistence project';
  const project = createProjectFixture(projectName);
  const state: TreeState = { folders: [], projects: [project], revision: 0 };

  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', async (route) => {
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
  await page.locator('.project-row', { hasText: projectName }).dblclick();

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvasContents = editor.locator('.canvas-node-contents');
  const movedTransform = await panGraphCanvas(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(editor.locator('.projects-container .project.active', { hasText: projectName })).toBeVisible();
  await expect.poll(() => canvasContents.evaluate((element) => (element as HTMLElement).style.transform)).toBe(movedTransform);
});

test('closing a preview project before reload preserves its canvas position when reopened', async ({ page }) => {
  const projectName = 'Closed viewport persistence project';
  const project = createProjectFixture(projectName);
  const state: TreeState = { folders: [], projects: [project], revision: 0 };

  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', async (route) => {
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
  await page.locator('.project-row', { hasText: projectName }).click();

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.projects-container .project.active.preview', { hasText: projectName })).toBeVisible();
  const canvasContents = editor.locator('.canvas-node-contents');
  const movedTransform = await panGraphCanvas(page);

  // Match a normal editing session: startup hydrates the last loaded graph
  // separately from the project-scoped editor state.
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jotai-store');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = database.transaction('state').objectStore('state').get('graph');
        request.onsuccess = () => resolve(JSON.parse(request.result ?? '{}').graphState?.metadata?.id);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  })).toBe(`${projectName}-graph-id`);
  const activeProjectTab = editor.locator('.projects-container .project.active', { hasText: projectName });
  await activeProjectTab.hover();
  await activeProjectTab.getByRole('button', { name: `Close ${projectName}` }).click();
  await expect(editor.locator('.projects-container .project', { hasText: projectName })).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(editor.locator('h1', { hasText: 'Welcome to Rivet' })).toBeAttached();
  await page.locator('.project-row', { hasText: projectName }).click();

  await expect(editor.locator('.projects-container .project.active.preview', { hasText: projectName })).toBeVisible();
  await expect.poll(() => canvasContents.evaluate((element) => (element as HTMLElement).style.transform)).toBe(movedTransform);
});

test('a remote tree change does not misidentify an open recording replay as a removed project', async ({ page }) => {
  const state: TreeState = { folders: [], projects: [], revision: 0 };
  const treeReads = { count: 0 };
  const replayPath = 'recording://recording-for-tree-sync/replay.rivet-project';

  await installMockEventSource(page);
  await installTreeRoute(page, state, treeReads);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  await dispatchProjectOpenedFromEditorFrame(page, replayPath);
  await expect.poll(() => treeReads.count).toBeGreaterThan(1);
  const treeReadsBeforeRemoteChange = treeReads.count;
  state.revision += 1;
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: state.revision,
    sourceClientId: 'other-administrator',
  });

  await expect.poll(() => treeReads.count).toBeGreaterThan(treeReadsBeforeRemoteChange);
  await expect(page.locator('.Toastify__toast', { hasText: 'recording-for-tree-sync' })).toHaveCount(0);
  await expect(page.locator('.Toastify__toast', { hasText: 'replay' })).toHaveCount(0);
});

test('a remote project move retargets the open editor tab and notifies the user without reloading project contents', async ({
  page,
}) => {
  const projectName = 'Project moved remotely';
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
  await projectRow.dblclick();
  const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editorFrame.locator('.projects-container .project.active', { hasText: projectName })).toBeVisible();
  await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);

  const movedProject = {
    ...project,
    relativePath: `Moved by collaborator/${project.fileName}`,
    absolutePath: `/managed/workflows/Moved by collaborator/${project.fileName}`,
  };
  state.projects = [movedProject];
  state.revision += 1;
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: state.revision,
    sourceClientId: 'other-administrator',
  });

  await expect(page.locator('.Toastify__toast')).toContainText(
    `"${projectName}" was moved on the server. Your editor tab now follows the new location.`,
  );
  await expect(editorFrame.locator('.projects-container .project.active', { hasText: projectName })).toBeVisible();
  await expect(page.locator('.active-project-name')).toHaveText(projectName);
  expect(projectLoadRequests).toBe(1);
  expect(treeReads.count).toBeGreaterThan(1);
});

test('a remote project rename updates the open tab title and notifies the user without reloading it', async ({
  page,
}) => {
  const originalName = 'Project renamed remotely';
  const renamedName = 'Collaborator renamed project';
  const project = createProjectFixture(originalName);
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  let projectLoadRequests = 0;

  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', async (route) => {
    projectLoadRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createProjectContents(originalName),
        datasetsContents: null,
        revisionId: null,
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  await page.locator('.project-row', { hasText: originalName }).dblclick();
  const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editorFrame.locator('.projects-container .project.active', { hasText: originalName })).toBeVisible();
  await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);

  state.projects = [
    {
      ...project,
      name: renamedName,
      fileName: `${renamedName}.rivet-project`,
      relativePath: `${renamedName}.rivet-project`,
      absolutePath: `/managed/workflows/${renamedName}.rivet-project`,
    },
  ];
  state.revision += 1;
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: state.revision,
    sourceClientId: 'other-administrator',
  });

  await expect(page.locator('.Toastify__toast')).toContainText(
    `"${originalName}" was renamed to "${renamedName}" on the server. Your editor tab now follows the renamed project.`,
  );
  await expect(editorFrame.locator('.projects-container .project.active', { hasText: renamedName })).toBeVisible();
  await expect(page.locator('.active-project-name')).toHaveText(renamedName);
  expect(projectLoadRequests).toBe(1);
});

test('a remote content edit keeps an open project in place and requires an explicit reload or keep-mine choice', async ({
  page,
}) => {
  const projectName = 'Project edited remotely';
  const project = createProjectFixture(projectName, 'revision-1');
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  let projectLoadRequests = 0;

  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', async (route) => {
    projectLoadRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createProjectContents(projectName),
        datasetsContents: null,
        revisionId: projectLoadRequests === 1 ? 'revision-1' : 'revision-3',
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  await page.locator('.project-row', { hasText: projectName }).dblclick();
  const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editorFrame.locator('.projects-container .project.active', { hasText: projectName })).toBeVisible();
  await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);

  state.projects = [{ ...project, revisionId: 'revision-2' }];
  state.revision += 1;
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: state.revision,
    sourceClientId: 'other-administrator',
  });

  const remoteChangeToast = page.locator('.Toastify__toast', { hasText: 'differs from the version open in this tab' });
  await expect(remoteChangeToast).toContainText('Reload');
  await expect(remoteChangeToast).toContainText('Keep mine');
  await expect(remoteChangeToast.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(remoteChangeToast.getByRole('button', { name: 'Keep mine' })).toBeVisible();
  await expect(editorFrame.locator('.projects-container .project.active', { hasText: projectName })).toBeVisible();
  expect(projectLoadRequests).toBe(1);

  // Delay only the action acknowledgement. Conflict snapshots must continue
  // updating the notice independently of this old callback.
  await page.evaluate(() => {
    window.addEventListener(
      'message',
      function hold(event) {
        if (event.data?.type !== 'workflow-project-content-change-resolved') return;
        event.stopImmediatePropagation();
        window.removeEventListener('message', hold, true);
        Object.assign(window, { __heldResolution: event.data });
      },
      true,
    );
  });
  await remoteChangeToast.getByRole('button', { name: 'Keep mine' }).click();
  await expect(remoteChangeToast).toHaveCount(0);
  expect(projectLoadRequests).toBe(1);

  state.projects = [{ ...project, revisionId: 'revision-3' }];
  state.revision += 1;
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: state.revision,
    sourceClientId: 'other-administrator',
  });

  await expect(remoteChangeToast).toBeVisible();
  await page.evaluate(() => {
    const data = (window as Window & { __heldResolution?: unknown }).__heldResolution;
    if (!data) throw new Error('Resolution acknowledgement was not captured');
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: location.origin,
        source: document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame')!.contentWindow,
      }),
    );
  });
  await expect(remoteChangeToast.getByRole('button', { name: 'Reload' })).toBeEnabled();
  await remoteChangeToast.getByRole('button', { name: 'Reload' }).click();
  await expect(remoteChangeToast).toHaveCount(0);
  await expect.poll(() => projectLoadRequests).toBe(2);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function saveThroughEditor(page: Page) {
  const title = page
    .frameLocator('iframe.dashboard-editor-frame')
    .locator('.node[data-nodeid="tree-sync-node"] .node-title');
  await expect(title).toBeVisible();
  const bounds = (await title.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator('.active-project-save-button').click();
}

for (const race of ['old tree after save', 'tree before save response', 'remote edit during save'] as const) {
  test(`revision freshness: ${race}`, async ({ page }) => {
    const name = 'Save race';
    const project = createProjectFixture(name, 'revision-1');
    const state: TreeState = { folders: [], projects: [project], revision: 0 };
    const saveStarted = deferred();
    const releaseSave = deferred();
    const treeStarted = deferred();
    const releaseTree = deferred();
    let holdTree = false;
    const expectedRevisions: string[] = [];
    await installMockEventSource(page);
    await installTreeRoute(page, state, { count: 0 });
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({
        json: {
          contents: createProjectContents(name),
          datasetsContents: null,
          revisionId: 'revision-1',
        },
      }),
    );
    await page.route('**/api/projects/save', async (route) => {
      expectedRevisions.push(route.request().postDataJSON().expectedRevisionId);
      if (expectedRevisions.length === 1) {
        state.projects = [{ ...project, revisionId: 'revision-2' }];
        saveStarted.resolve();
        if (race !== 'old tree after save') await releaseSave.promise;
      }
      await route.fulfill({ json: { path: project.absolutePath, revisionId: 'revision-2' } });
    });
    await page.route('**/api/workflows/tree', async (route) => {
      if (!holdTree) {
        await route.fallback();
        return;
      }
      holdTree = false;
      const snapshot = JSON.stringify({
        root: '/managed/workflows',
        folders: [],
        projects: state.projects,
        sync: { epoch: 'playwright-tree-sync', revision: state.revision },
      });
      treeStarted.resolve();
      await releaseTree.promise;
      await route.fulfill({ contentType: 'application/json', body: snapshot });
    });
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.locator('.project-row', { hasText: name }).dblclick();
    await expect(
      page
        .frameLocator('iframe.dashboard-editor-frame')
        .locator('.projects-container .project.active', { hasText: name }),
    ).toBeVisible();
    await expect(page.locator('.active-project-name')).toHaveText(name);
    try {
      if (race === 'old tree after save') {
        holdTree = true;
        await emitTreeChange(page, {
          epoch: 'playwright-tree-sync',
          revision: ++state.revision,
          sourceClientId: 'other-browser',
        });
        await withAsyncDeadline(treeStarted.promise, 'old tree request');
        const saved = page.waitForResponse('**/api/projects/save');
        await saveThroughEditor(page);
        await (await saved).finished();
        await expect.poll(() => page.evaluate(() => window.__savedProjects)).toBe(1);
        releaseTree.resolve();
      } else {
        await saveThroughEditor(page);
        await withAsyncDeadline(saveStarted.promise, 'save request');
        holdTree = true;
        await emitTreeChange(page, {
          epoch: 'playwright-tree-sync',
          revision: ++state.revision,
          sourceClientId: 'other-browser',
        });
        await withAsyncDeadline(treeStarted.promise, 'tree request during save');
        releaseTree.resolve();
        await expect
          .poll(() => page.evaluate(() => window.__reconciliationStatuses.includes('waiting-for-save')))
          .toBe(true);
        if (race === 'remote edit during save') state.projects = [{ ...project, revisionId: 'revision-3' }];
        releaseSave.resolve();
      }
      const warning = page.locator('.workflow-remote-project-change-notice');
      if (race === 'remote edit during save') {
        await expect(warning).toContainText('differs from the version open in this tab');
        await expect(warning).not.toContainText('administrator');
        await warning.getByRole('button', { name: 'Keep mine' }).click();
        await expect(warning).toHaveCount(0);
        await saveThroughEditor(page);
        await expect.poll(() => expectedRevisions).toEqual(['revision-1', 'revision-3']);
      } else {
        // A second actual save proves that the tracker did not retain a hidden save block.
        await expect.poll(() => expectedRevisions.length).toBe(1);
        await expect(page.locator('.active-project-save-button')).toHaveCount(0);
        await saveThroughEditor(page);
        await expect.poll(() => expectedRevisions).toEqual(['revision-1', 'revision-2']);
        await expect(warning).toHaveCount(0);
      }
    } finally {
      releaseTree.resolve();
      releaseSave.resolve();
    }
  });
}

test('a matching observation clears an obsolete warning, but failed fetches and reloads do not', async ({ page }) => {
  const name = 'Warning recovery';
  const project = createProjectFixture(name, 'accepted');
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  let failTree = false;
  let loads = 0;
  let saves = 0;
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/workflows/tree', (route) =>
    failTree ? route.fulfill({ status: 503, json: { error: 'controlled failure' } }) : route.fallback(),
  );
  await page.route('**/api/projects/load', (route) =>
    ++loads === 1
      ? route.fulfill({
          json: { contents: createProjectContents(name), datasetsContents: null, revisionId: 'accepted' },
        })
      : route.fulfill({ status: 503, json: { error: 'controlled reload failure' } }),
  );
  await page.route('**/api/projects/save', (route) => {
    saves++;
    expect(route.request().postDataJSON().expectedRevisionId).toBe('accepted');
    return route.fulfill({ json: { path: project.absolutePath, revisionId: 'accepted' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: name }).dblclick();
  await expect(page.locator('.active-project-name')).toHaveText(name);
  const warning = page.locator('.workflow-remote-project-change-notice');
  state.projects = [{ ...project, revisionId: 'remote' }];
  const change = () =>
    emitTreeChange(page, {
      epoch: 'playwright-tree-sync',
      revision: ++state.revision,
      sourceClientId: 'another-browser',
    });
  await change();
  await expect(warning).toBeVisible();
  failTree = true;
  const failedTree = page.waitForResponse(
    (response) => response.url().endsWith('/api/workflows/tree') && response.status() === 503,
  );
  await change();
  await failedTree;
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Reload and discard mine' }).click();
  await expect.poll(() => loads).toBe(2);
  await expect(warning.getByRole('button', { name: 'Keep mine' })).toBeEnabled();
  await expect(warning).toBeVisible();
  failTree = false;
  state.projects = [project];
  await change();
  await expect(warning).toHaveCount(0);
  await saveThroughEditor(page);
  await expect.poll(() => saves).toBe(1);
});

test('a move with a newer saved revision rebinds the tab but blocks overwriting remote content', async ({ page }) => {
  const name = 'Moved and edited project';
  const project = createProjectFixture(name, 'accepted');
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  const movedPath = `/managed/workflows/New folder/${project.fileName}`;
  const saves: Array<{ path: string; expectedRevisionId: string | null }> = [];
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({ json: { contents: createProjectContents(name), datasetsContents: null, revisionId: 'accepted' } }),
  );
  await page.route('**/api/projects/save', (route) => {
    const request = route.request().postDataJSON();
    saves.push({ path: request.path, expectedRevisionId: request.expectedRevisionId });
    return route.fulfill({ json: { path: movedPath, revisionId: 'saved-after-choice' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: name }).dblclick();
  await expect(page.locator('.active-project-name')).toHaveText(name);
  state.projects = [
    {
      ...project,
      relativePath: `New folder/${project.fileName}`,
      absolutePath: movedPath,
      revisionId: 'remote',
    },
  ];
  await emitTreeChange(page, {
    epoch: 'playwright-tree-sync',
    revision: ++state.revision,
    sourceClientId: 'other-browser',
  });
  const warning = page.locator('.workflow-remote-project-change-notice');
  await expect(warning).toContainText(name);
  await saveThroughEditor(page);
  expect(saves).toHaveLength(0);
  await warning.getByRole('button', { name: 'Keep mine' }).click();
  await expect(warning).toHaveCount(0);
  await saveThroughEditor(page);
  await expect.poll(() => saves).toEqual([{ path: movedPath, expectedRevisionId: 'remote' }]);
});

test('a renamed pending project updates its warning and fences the old resolution identity', async ({ page }) => {
  const originalName = 'Pending project title';
  const renamedName = 'Current project title';
  const project = createProjectFixture(originalName, 'accepted');
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({
      json: { contents: createProjectContents(originalName), datasetsContents: null, revisionId: 'accepted' },
    }),
  );
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: originalName }).dblclick();
  await expect(page.locator('.active-project-name')).toHaveText(originalName);
  const warning = page.locator('.workflow-remote-project-change-notice');
  const change = () =>
    emitTreeChange(page, {
      epoch: 'playwright-tree-sync',
      revision: ++state.revision,
      sourceClientId: 'other-browser',
    });
  state.projects = [{ ...project, revisionId: 'remote' }];
  await change();
  await expect(warning).toContainText(originalName);
  const before = await page.evaluate(
    () => window.__conflictSnapshots.findLast((snapshot) => snapshot.contentChanges.length > 0)!,
  );
  state.projects = [
    {
      ...project,
      name: renamedName,
      fileName: `${renamedName}.rivet-project`,
      relativePath: `${renamedName}.rivet-project`,
      absolutePath: `/managed/workflows/${renamedName}.rivet-project`,
      revisionId: 'remote',
    },
  ];
  await change();
  await expect(warning).toContainText(renamedName);
  const after = await page.evaluate(
    () => window.__conflictSnapshots.findLast((snapshot) => snapshot.contentChanges.length > 0)!,
  );
  expect(after.sequence).toBeGreaterThan(before.sequence);
  expect(after.contentChanges[0]?.changeId).not.toBe(before.contentChanges[0]?.changeId);
  await warning.getByRole('button', { name: 'Keep mine' }).click();
  await expect(warning).toHaveCount(0);
});

test('two independent browsers retain the real API stale-overwrite protection', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const headers = { 'x-rivet-proxy-auth': createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex') };
  try {
    const load = (context: typeof first) =>
      context.request.post(`${api.baseUrl}/api/projects/load`, {
        headers,
        data: { path: api.projectPath },
      });
    const a = await load(first);
    const b = await load(second);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    const original = await a.json();
    expect((await b.json()).revisionId).toBe(original.revisionId);
    const winningContents = original.contents.replace('Async acceptance', 'First browser accepted');
    const save = (context: typeof first, contents: string) =>
      context.request.post(`${api.baseUrl}/api/projects/save`, {
        headers,
        data: {
          path: api.projectPath,
          projectId: api.projectId,
          saveIntent: 'in-place',
          expectedRevisionId: original.revisionId,
          contents,
          datasetsContents: original.datasetsContents,
        },
      });
    expect((await save(first, winningContents)).status()).toBe(200);
    expect((await save(second, original.contents)).status()).toBe(409);
    const after = await (await load(second)).json();
    expect(after.revisionId).not.toBe(original.revisionId);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a rejected save requests fresh conflict controls even without a tree event', async ({ page }) => {
  const name = 'Rejected save';
  const project = createProjectFixture(name, 'accepted');
  const state: TreeState = { folders: [], projects: [project], revision: 0 };
  const expectations: string[] = [];
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({
      json: {
        contents: createProjectContents(name),
        datasetsContents: null,
        revisionId: 'accepted',
      },
    }),
  );
  await page.route('**/api/projects/save', (route) => {
    expectations.push(route.request().postDataJSON().expectedRevisionId);
    if (expectations.length === 1) {
      state.projects = [{ ...project, revisionId: 'remote' }];
      return route.fulfill({ status: 409, json: { error: 'Saved version changed' } });
    }
    return route.fulfill({ json: { path: project.absolutePath, revisionId: 'remote' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: name }).dblclick();
  await expect(page.locator('.active-project-name')).toHaveText(name);
  await saveThroughEditor(page);
  const warning = page.locator('.workflow-remote-project-change-notice');
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Keep mine' }).click();
  await expect(warning).toHaveCount(0);
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => expectations).toEqual(['accepted', 'remote']);
});

test('inactive conflicts survive bridge timeouts and reconnects, but not closing and reopening the tab', async ({
  page,
}) => {
  const a = createProjectFixture('Inactive project', 'accepted');
  const b = createProjectFixture('Other project', 'accepted');
  const state: TreeState = { folders: [], projects: [a, b], revision: 0 };
  await installMockEventSource(page);
  await installTreeRoute(page, state, { count: 0 });
  await page.route('**/api/projects/load', (route) => {
    const project = state.projects.find((project) => project.absolutePath === route.request().postDataJSON().path)!;
    return route.fulfill({
      json: { contents: createProjectContents(project.name), datasetsContents: null, revisionId: project.revisionId },
    });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  for (const project of [a, b]) {
    await page.locator('.project-row', { hasText: project.name }).dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(project.name);
  }
  const warning = page.locator('.workflow-remote-project-change-notice');
  const change = () =>
    emitTreeChange(page, {
      epoch: 'playwright-tree-sync',
      revision: ++state.revision,
      sourceClientId: 'same-user-other-browser',
    });
  state.projects = [{ ...a, revisionId: 'remote' }, b];
  await change();
  await expect(warning).toContainText(a.name);
  await expect(page.locator('.active-project-name')).toHaveText(b.name);
  const oldSnapshot = await page.evaluate(
    () => window.__conflictSnapshots.findLast((snapshot) => snapshot.contentChanges.length > 0)!,
  );
  const captures = await page.evaluate(() => {
    window.__dropNextCapture = true;
    return window.__captures;
  });
  await change();
  await expect
    .poll(() => page.evaluate(() => window.__captures), { timeout: 15000 })
    .toBeGreaterThanOrEqual(captures + 2);
  await expect(warning).toBeVisible();
  // Replacing the iframe invalidates all old observation/snapshot identities.
  await page
    .locator('iframe.dashboard-editor-frame')
    .evaluate((frame: HTMLIFrameElement) => frame.contentWindow!.location.reload());
  await expect
    .poll(() => page.evaluate(() => window.__conflictSnapshots.at(-1)?.editorInstanceId))
    .not.toBe(oldSnapshot.editorInstanceId);
  await expect(warning).toContainText(a.name);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor.locator('.projects-container .project', { hasText: a.name }).hover();
  await editor.getByRole('button', { name: `Close ${a.name}`, exact: true }).click();
  await expect(warning).toHaveCount(0);
  await page.locator('.project-row', { hasText: a.name }).dblclick();
  await expect(page.locator('.active-project-name')).toHaveText(a.name);
  await page.evaluate((snapshot) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'workflow-project-conflicts', snapshot },
        origin: location.origin,
        source: document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame')!.contentWindow,
      }),
    );
  }, oldSnapshot);
  await change();
  await expect.poll(() => page.evaluate(() => window.__conflictSnapshots.at(-1)?.contentChanges.length)).toBe(0);
  await expect(warning).toHaveCount(0);
});
