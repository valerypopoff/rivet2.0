import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { deserializeProject, serializeProject, type Project } from '@valerypopoff/rivet2-core';
import type { WorkflowProjectItem } from '../dashboard/types';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { readCommittedWorkspaceCheckpoint } from './helpers/workspaceRecovery';

async function waitForWorkspaceCheckpoint(
  page: Page,
  activeProjectId: string,
  openedProjectIds: string[],
  markers: string[] = [],
) {
  // A rendered tab is not a persistence acknowledgement. Observe the normal
  // automatic checkpoint; do not force a flush or rely on unload-time writes.
  await expect
    .poll(async () => {
      const raw = await readCommittedWorkspaceCheckpoint(page);
      if (!raw) return null;
      const checkpoint = JSON.parse(raw) as {
        groups: {
          project?: {
            projectState?: { metadata: { id: string } };
            projectsState?: { openedProjectsSortedIds: string[] };
          };
        };
      };
      return {
        activeProjectId: checkpoint.groups.project?.projectState?.metadata.id,
        openedProjectIds: checkpoint.groups.project?.projectsState?.openedProjectsSortedIds,
        containsEdits: markers.every((marker) => raw.includes(marker)),
      };
    })
    .toEqual({ activeProjectId, openedProjectIds, containsEdits: true });
}

async function workspace(page: Page, type = 'object', extraNodes = 0, datasetRows = 0) {
  const field = type === 'object' ? 'jsonTemplate' : 'code';
  const value = (marker: string) => (type === 'object' ? JSON.stringify({ marker }) : `return "${marker}";`);
  const items: WorkflowProjectItem[] = ['A', 'B'].map((name) => ({
    id: `lifecycle-${name}`,
    name: `lifecycle-${name}`,
    fileName: `lifecycle-${name}.rivet-project`,
    relativePath: `lifecycle-${name}.rivet-project`,
    absolutePath: `/workflows/lifecycle-${name}.rivet-project`,
    updatedAt: '2026-10-02T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  }));
  const project = (item: WorkflowProjectItem) =>
    ({
      metadata: { id: item.id, title: item.name, description: '', mainGraphId: 'shared-main' },
      graphs: Object.fromEntries(
        ['shared-main', 'shared-other'].map((id, index) => [
          id,
          {
            metadata: { id, name: index ? 'Other Graph' : 'Main Graph', description: '' },
            connections: [],
            nodes: [
              {
                id: 'shared-node',
                type,
                title: 'Lifecycle node',
                visualData: { x: 520, y: 300, width: 260 },
                data:
                  type === 'subGraph'
                    ? {
                        targetScope: 'other-projects',
                        targetProjectId: 'external-project',
                        targetVersion: 'latest',
                        graphId: 'target',
                      }
                    : { [field]: value(index ? 'other-original' : 'main-original') },
              },
              ...Array.from({ length: extraNodes }, (_, i) => ({
                id: `filler-${i}`,
                type: 'text',
                title: `Filler ${i}`,
                // Keep the large fixture's bounds compact: a zoomed-out graph
                // intentionally omits node edit buttons in its simplified view.
                visualData: { x: 800 + (i % 10) * 20, y: 100 + Math.floor(i / 10) * 20, width: 260 },
                data: { text: `Representative graph payload ${i}`, normalizeLineEndings: true },
              })),
            ],
          },
        ]),
      ),
      plugins: [],
      references: [],
    }) as unknown as Project;
  const disk = new Map(items.map((item) => [item.absolutePath, serializeProject(project(item))]));
  const saves: Project[] = [];
  let loads = 0;
  let waitForLoad: Promise<void> | undefined;
  let waitForSave: Promise<void> | undefined;
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/config/env/*', (route) => route.fulfill({ json: { value: null } }));
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'lifecycle', revision: 0 }, folders: [], projects: items },
    }),
  );
  await page.route('**/api/projects/load', async (route) => {
    const { path } = route.request().postDataJSON();
    expect(disk.has(path)).toBe(true);
    loads++;
    await waitForLoad;
    const projectId = items.find((item) => item.absolutePath === path)!.id;
    const datasetsContents = datasetRows
      ? JSON.stringify({
          datasets: [
            {
              meta: { id: 'shared-dataset', projectId, name: 'Load fixture', description: '' },
              data: {
                id: 'shared-dataset',
                rows: Array.from({ length: datasetRows }, (_, i) => ({
                  id: `row-${i}`,
                  data: [`${projectId}:${i}:${'x'.repeat(1024)}`],
                })),
              },
            },
          ],
        })
      : null;
    return route.fulfill({ json: { contents: disk.get(path), datasetsContents, revisionId: null } });
  });
  await page.route('**/api/projects/save', async (route) => {
    const { path, contents } = route.request().postDataJSON();
    saves.push(deserializeProject(contents)[0]);
    await waitForSave;
    disk.set(path, contents);
    await route.fulfill({ json: { path, revisionId: `lifecycle-save-${saves.length}` } });
  });
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const editorFrame = page.frames().find((entry) => entry.parentFrame() === page.mainFrame())!;
  const row = (name: string) => page.locator('.project-row', { hasText: `lifecycle-${name}` });
  // Opening placeholders can already be active, but are not warm projects.
  // Switching away from one intentionally cancels its unfinished activation.
  const tab = (name: string) =>
    frame.locator('.projects-container .project:not(.opening)').filter({ hasText: `lifecycle-${name}` });
  const input = frame.locator('.monaco-editor textarea').first();
  const view = frame.locator('.monaco-editor .view-lines').first();
  const openNode = () => frame.locator('.node[data-nodeid="shared-node"] .edit-button').dispatchEvent('click');
  const edit = async (marker: string) => {
    await input.focus();
    await expect(input).toBeFocused();
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    await page.keyboard.insertText(value(marker));
  };
  const navigate = async (graphId: string, reloadFromDisk = false) => {
    await page.evaluate(
      ({ path, expectedProjectId, preferredGraphId, reloadFromDisk }) => {
        document
          .querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')!
          .contentWindow!.postMessage(
            { type: 'open-project', path, expectedProjectId, preferredGraphId, reloadFromDisk, replaceCurrent: false },
            window.location.origin,
          );
      },
      { path: items[0]!.absolutePath, expectedProjectId: items[0]!.id, preferredGraphId: graphId, reloadFromDisk },
    );
  };
  const saved = (index: number, graph = 'shared-main') =>
    (
      saves[index]!.graphs[graph as keyof Project['graphs']]!.nodes.find((node) => node.id === 'shared-node')!
        .data as Record<string, unknown>
    )[field];
  await expect(row('A')).toBeEnabled({ timeout: 120_000 });
  await row('A').dblclick();
  await expect(tab('A')).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  await openNode();
  if (type === 'subGraph') {
    await expect(frame.locator('.section-node .subgraph-node-body-select')).toBeVisible();
  } else {
    await expect(view).toContainText('main-original');
  }
  return {
    frame,
    editorFrame,
    row,
    tab,
    input,
    view,
    openNode,
    edit,
    navigate,
    saves,
    saved,
    disk,
    items,
    value,
    loads: () => loads,
    holdLoad: (gate: Promise<void> | undefined) => {
      waitForLoad = gate;
    },
    holdSave: (gate: Promise<void> | undefined) => {
      waitForSave = gate;
    },
  };
}

test('large hosted projects open once and warm tab switches retain edits without fetching or reparsing projects', async ({
  page,
}, info) => {
  const w = await workspace(page, 'object', 349, 2000);
  await w.edit('unsaved-tab-payload');
  let release!: () => void;
  w.holdLoad(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    await w.row('B').dblclick();
    await expect.poll(w.loads).toBe(2);
    // Force the state seen in the failing CI trace, independent of machine
    // speed: an active placeholder is visible while loading is unfinished.
    await expect(w.frame.locator('.project.opening.active', { hasText: 'lifecycle-B' })).toBeVisible();
    await expect(w.tab('B')).toHaveCount(0);
  } finally {
    release();
    w.holdLoad(undefined);
  }
  await expect(w.tab('B')).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  await expect(w.frame.locator('.projects-container .project.opening')).toHaveCount(0);
  await expect(w.tab('B')).not.toHaveClass(/\bpreview\b/);
  expect(w.loads()).toBe(2);
  const samples: number[] = [];
  for (const name of ['A', 'B', 'A', 'B', 'A']) {
    const start = performance.now();
    await w.tab(name).click();
    await expect(w.tab(name)).toHaveClass(/\bactive\b/);
    samples.push(performance.now() - start);
  }
  await w.openNode();
  await expect(w.view).toContainText('unsaved-tab-payload');
  await expect(w.tab('A')).toHaveClass(/\bhas-unsaved-changes\b/);
  await expect(w.frame.locator('.projects-container .project:not(.opening)')).toHaveCount(2);
  expect(w.loads()).toBe(2);
  // Check worker-prepared datasets survived both imports and repeated selection.
  const retained = await w.editorFrame.evaluate(async () => {
    const request = indexedDB.open('datasets');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction('data');
      return await Promise.all(
        ['A', 'B'].map((name) => {
          const read = transaction.objectStore('data').get([`lifecycle-${name}`, 'shared-dataset']);
          return new Promise<{ count: number; first: string }>((resolve, reject) => {
            read.onsuccess = () =>
              resolve({ count: read.result?.rows.length ?? 0, first: read.result?.rows[0]?.data[0] ?? '' });
            read.onerror = () => reject(read.error);
          });
        }),
      );
    } finally {
      db.close();
    }
  });
  expect(retained.map((dataset) => dataset.count)).toEqual([2000, 2000]);
  expect(retained[0]!.first).toMatch(/^lifecycle-A:0:/);
  expect(retained[1]!.first).toMatch(/^lifecycle-B:0:/);
  await info.attach('project-tab-loading.json', {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        nodesPerGraph: 350,
        graphsPerProject: 2,
        datasetRowsPerProject: 2000,
        projectRequests: w.loads(),
        warmTabSamplesMs: samples,
        note: 'Local synthetic browser click-to-active observations including automation overhead; not production latency.',
      },
      null,
      2,
    ),
  });
});

test('a retired Subgraph preview cannot contaminate the next project and current version changes still work', async ({
  page,
}) => {
  let title = 'Initial target';
  let holdNext = false;
  let held = false;
  let settled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workflows/subgraph-projects/external-project/preview?version=*', async (route) => {
    const obsolete = holdNext;
    if (obsolete) {
      holdNext = false;
      held = true;
      await gate;
    }
    const version = new URL(route.request().url()).searchParams.get('version');
    await route.fulfill({
      json: {
        revisionKey: obsolete ? 'retired-preview' : title,
        project: {
          metadata: { id: 'external-project', title: obsolete ? 'Obsolete target' : title, mainGraphId: 'target' },
          graphs: {
            target: {
              metadata: { id: 'target', name: version === 'published' ? 'Published graph' : 'Latest graph' },
              nodes: [],
              connections: [],
            },
          },
          plugins: [],
          references: [],
        },
      },
    });
    if (obsolete) settled = true;
  });
  const w = await workspace(page, 'subGraph');
  const target = w.frame.locator('.section-node .subgraph-node-body-select');
  await expect(target).toContainText('Initial target');
  holdNext = true;
  await target.locator('input').click();
  await expect.poll(() => held).toBe(true);
  title = 'Current target';
  await w.row('B').dblclick();
  await expect(w.tab('B')).toHaveClass(/\bactive\b/);
  await w.openNode();
  await expect(target).toContainText('Current target');
  release();
  await expect.poll(() => settled).toBe(true);
  // Recreate the control to read the shared reference cache, not its own local
  // preview. A late result from A must not replace B's reference authority.
  await w.frame.locator('body').press('Escape');
  await expect(target).toHaveCount(0);
  await w.openNode();
  await expect(target).toContainText('Current target');
  await expect(target).not.toContainText('Obsolete target');
  await w.frame.getByRole('button', { name: 'Published', exact: true }).click();
  await expect(target).toContainText('Published graph');
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => w.saves.length).toBe(1);
  const data = w.saves[0]!.graphs['shared-main' as keyof Project['graphs']]!.nodes.find(
    (node) => node.id === 'shared-node',
  )!.data as Record<string, unknown>;
  expect(data.targetVersion).toBe('published');
  expect(w.saves[0]!.metadata.id).toBe('lifecycle-B');
});

test('reload preserves open tabs, unsaved content and sidebar selection while the tree is loading', async ({
  page,
}) => {
  const w = await workspace(page);
  await w.edit('reload-A');
  await w.row('B').dblclick();
  await expect(w.tab('B')).toHaveClass(/\bactive\b/);
  await w.openNode();
  await w.edit('reload-B');
  await expect(w.row('B')).toHaveClass(/\bactive\b/);
  await waitForWorkspaceCheckpoint(
    page,
    w.items[1]!.id,
    w.items.map((item) => item.id),
    ['reload-A', 'reload-B'],
  );
  let releaseTree!: () => void;
  const treeGate = new Promise<void>((resolve) => {
    releaseTree = resolve;
  });
  await page.route('**/api/workflows/tree', async (route) => {
    await treeGate;
    await route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'lifecycle', revision: 0 },
        folders: [],
        projects: w.items,
      },
    });
  });
  try {
    await page.reload();
    await expect(w.tab('B')).toHaveClass(/\bactive\b/, { timeout: 120_000 });
    expect(await page.evaluate(() => sessionStorage.getItem('rivet-studio-workflow-selection-v1'))).toBe(
      w.items[1]!.absolutePath,
    );
    releaseTree();
    await expect(w.row('B')).toHaveClass(/\bactive\b/);
    await expect(w.frame.locator('.projects-container .project .project-name')).toHaveText([
      'lifecycle-A',
      'lifecycle-B',
    ]);
    await w.openNode();
    await expect(w.view).toContainText('reload-B');
    await expect(w.tab('B')).toHaveClass(/\bhas-unsaved-changes\b/);
    await w.tab('A').click();
    await expect(w.row('A')).toHaveClass(/\bactive\b/);
    await w.openNode();
    await expect(w.view).toContainText('reload-A');
    await expect(w.tab('A')).toHaveClass(/\bhas-unsaved-changes\b/);
    expect(w.saves).toHaveLength(0);
  } finally {
    releaseTree();
  }
});

test('reload preserves independent sidebar selection across a failed tree request', async ({ page }) => {
  const w = await workspace(page);
  await w.row('B').dblclick();
  await expect(w.tab('B')).toHaveClass(/\bactive\b/);
  await waitForWorkspaceCheckpoint(
    page,
    w.items[1]!.id,
    w.items.map((item) => item.id),
  );
  // Sidebar selection can precede an editor open or remain independent of it.
  // Seed that persisted state so startup ordering is deterministic.
  await page.evaluate(
    (path) => sessionStorage.setItem('rivet-studio-workflow-selection-v1', path),
    w.items[0]!.absolutePath,
  );
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({ status: 503, json: { error: 'Tree unavailable' } }),
  );
  await page.reload();
  await expect(w.tab('B')).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  await expect(page.getByText('Tree unavailable', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('rivet-studio-workflow-selection-v1'))).toBe(
    w.items[0]!.absolutePath,
  );
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'lifecycle', revision: 0 },
        folders: [],
        projects: w.items,
      },
    }),
  );
  await waitForWorkspaceCheckpoint(
    page,
    w.items[1]!.id,
    w.items.map((item) => item.id),
  );
  await page.reload();
  await expect(w.tab('B')).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  await expect(w.row('A')).toHaveClass(/\bactive\b/);
  await w.tab('A').click();
  await expect(w.tab('A')).toHaveClass(/\bactive\b/);
  await w.tab('B').click();
  await expect(w.tab('B')).toHaveClass(/\bactive\b/);
  await expect(w.row('B')).toHaveClass(/\bactive\b/);
  expect(w.saves).toHaveLength(0);
});

test('reload clears a deleted sidebar selection without closing recovered tabs', async ({ page }) => {
  const w = await workspace(page);
  await expect(w.row('A')).toHaveClass(/\bactive\b/);
  await waitForWorkspaceCheckpoint(page, w.items[0]!.id, [w.items[0]!.id]);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'lifecycle', revision: 1 },
        folders: [],
        projects: [w.items[1]],
      },
    }),
  );
  await page.reload();
  await expect(w.tab('A')).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  await expect(w.row('B')).toBeVisible();
  await expect(page.locator('.project-row.active')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('rivet-studio-workflow-selection-v1'))).toBeNull();
  await w.openNode();
  await expect(w.view).toContainText('main-original');
  expect(w.saves).toHaveLength(0);
});

test('a delayed save preserves newer text and sibling settings through close and recovery', async ({ page }) => {
  const w = await workspace(page);
  let release!: () => void;
  w.holdSave(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    await w.edit('first-save');
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => w.saves.length).toBe(1);
    await w.edit('newer-edit');
    await w.frame.getByText('Conditional node', { exact: true }).click();
    await expect(w.frame.locator('#node-conditional-shared-node')).toBeChecked();
    await w.input.focus();
    await w.input.press('Escape');
    await expect(w.view).toHaveCount(0);
    await w.openNode();
    await expect(w.view).toContainText('newer-edit');
    release();
    w.holdSave(undefined);
    await expect(page.locator('.active-project-save-button')).toBeEnabled();
    await expect(w.tab('A')).toHaveClass(/\bhas-unsaved-changes\b/);
    expect(w.saved(0)).toBe(w.value('first-save'));
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => w.saves.length).toBe(2);
    expect(w.saved(1)).toBe(w.value('newer-edit'));
    expect(Object.values(w.saves[1]!.graphs)[0]!.nodes[0]!.isConditional).toBe(true);
    await expect(w.tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await w.edit('unsaved-recovery');
    // Hidden-page checkpoint uses the public browser lifecycle, not a test-only store hook.
    await w.input.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await waitForWorkspaceCheckpoint(page, w.items[0]!.id, [w.items[0]!.id], ['unsaved-recovery']);
    await page.reload();
    await waitForDashboardReady(page);
    await w.openNode();
    await expect(w.view).toContainText('unsaved-recovery');
    await expect(w.tab('A')).toHaveClass(/\bhas-unsaved-changes\b/);
    await expect(w.frame.locator('#node-conditional-shared-node')).toBeChecked();
  } finally {
    release();
  }
});

test('reused node IDs across graphs, focused Undo/Redo and explicit reload preserve authority', async ({ page }) => {
  const w = await workspace(page, 'codeNew');
  await w.edit('main-edited');
  await w.navigate('shared-other');
  await w.openNode();
  await expect(w.view).toContainText('other-original');
  await w.edit('other-edited');
  await w.input.press('ControlOrMeta+z');
  await expect(w.view).not.toContainText('other-edited');
  await w.input.press('ControlOrMeta+Shift+z');
  await expect(w.view).toContainText('other-edited');
  await w.navigate('shared-main');
  await w.openNode();
  await expect(w.view).toContainText('main-edited');
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => w.saves.length).toBe(1);
  expect(w.saved(0)).toBe(w.value('main-edited'));
  expect(w.saved(0, 'shared-other')).toBe(w.value('other-edited'));
  await expect(w.tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
  const [replacement] = deserializeProject(w.disk.get(w.items[0]!.absolutePath)!);
  (replacement.graphs['shared-main' as keyof Project['graphs']]!.nodes[0]!.data as { code: string }).code =
    w.value('disk-reloaded');
  w.disk.set(w.items[0]!.absolutePath, serializeProject(replacement));
  await w.input.focus();
  await w.navigate('shared-main', true);
  await w.openNode();
  await expect(w.view).toContainText('disk-reloaded');
  await expect(w.view).not.toContainText('main-edited');
  await expect(w.tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
});

async function delayedAi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'ai',
      JSON.stringify({
        selectAssistModel: 'custom',
        aiAssistCustomProviderBaseURL: 'https://node-editor-fixture.invalid/v1',
        aiAssistCustomModel: 'synthetic-model',
      }),
    );
    localStorage.setItem('recoil-persist', JSON.stringify({ settings: { customAiApiKey: 'synthetic-key' } }));
    type Pending = { aborted: boolean; released: boolean; release(): void };
    const owner = window.top as Window & { __nodeEditorAi?: Pending[] };
    owner.__nodeEditorAi ??= [];
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).hostname !== 'node-editor-fixture.invalid') return fetch(input, init);
      const streaming = (await request.clone().json()).stream === true;
      return new Promise<Response>((resolve) => {
        const pending: Pending = {
          aborted: false,
          released: false,
          release() {
            pending.released = true;
            const content = '```json\n{"marker":"generated-late"}\n```';
            const chunk = (delta: object, finish_reason: string | null) =>
              `data: ${JSON.stringify({
                id: 'synthetic',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'synthetic-model',
                choices: [{ index: 0, delta, finish_reason }],
              })}\n\n`;
            resolve(
              streaming
                ? new Response(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
                    headers: { 'content-type': 'text/event-stream' },
                  })
                : new Response(
                    JSON.stringify({
                      id: 'synthetic',
                      object: 'chat.completion',
                      created: 1,
                      model: 'synthetic-model',
                      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
                    }),
                    { headers: { 'content-type': 'application/json' } },
                  ),
            );
          },
        };
        // Deliberately ignore abort: the application must discard late results too.
        request.signal.addEventListener(
          'abort',
          () => {
            pending.aborted = true;
          },
          { once: true },
        );
        owner.__nodeEditorAi!.push(pending);
      });
    };
  });
}

for (const change of ['switch', 'delete', 'edit', 'apply'] as const) {
  test(
    change === 'apply'
      ? 'a current AI generation applies its real fixture result'
      : `late AI results cannot overwrite a ${change === 'edit' ? 'newer edit' : `retired ${change} session`}`,
    async ({ page }) => {
      await delayedAi(page);
      const w = await workspace(page);
      await w.frame.getByRole('button', { name: 'Generate using AI', exact: true }).click();
      const modal = w.frame.getByRole('dialog', { name: 'Generate using AI', exact: true });
      await modal.locator('textarea').fill('Generate a harmless marker object.');
      await modal.getByRole('button', { name: 'Generate', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__nodeEditorAi?.length ?? 0)).toBe(1);
      if (change === 'switch') {
        await w.row('B').dblclick();
        await expect(w.tab('B')).toHaveClass(/\bactive\b/);
        await w.openNode();
        await w.tab('A').click();
        await expect(w.view).toContainText('main-original');
        await expect(modal).toHaveCount(0);
      } else if (change !== 'apply') {
        await modal.getByRole('button', { name: 'Close modal', exact: true }).click();
        await expect(modal).toHaveCount(0);
        if (change === 'delete') {
          await w.input.press('Escape');
          await expect(w.view).toHaveCount(0);
          await w.frame.locator('.node[data-nodeid="shared-node"] .node-title').click({ button: 'right' });
          await w.frame.getByText('Delete', { exact: true }).click();
          await expect(w.frame.locator('.node[data-nodeid="shared-node"]')).toHaveCount(0);
        } else await w.edit('newer-than-generation');
      }
      await page.evaluate(() => (window as any).__nodeEditorAi[0].release());
      await expect.poll(() => page.evaluate(() => (window as any).__nodeEditorAi[0].released)).toBe(true);
      if (change === 'apply') {
        // Positive control: the same fixture must succeed for a current owner.
        await expect(w.view).toContainText('generated-late');
        await expect(w.tab('A')).toHaveClass(/\bhas-unsaved-changes\b/);
        return;
      }
      await w.editorFrame.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await expect(w.frame.getByText('Object generated successfully!', { exact: true })).toHaveCount(0);
      if (change === 'delete') {
        await page.locator('.active-project-save-button').click();
        await expect.poll(() => w.saves.length).toBe(1);
        expect(Object.values(w.saves[0]!.graphs)[0]!.nodes).toHaveLength(0);
      } else {
        await expect(w.view).toContainText(change === 'switch' ? 'main-original' : 'newer-than-generation');
        await expect(w.view).not.toContainText('generated-late');
        if (change === 'switch') await expect(w.tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
      }
    },
  );
}

test('cancelling an uncooperative AI request permits retry without the old completion clearing it', async ({
  page,
}) => {
  await delayedAi(page);
  const w = await workspace(page);
  await w.frame.getByRole('button', { name: 'Generate using AI', exact: true }).click();
  const modal = w.frame.getByRole('dialog', { name: 'Generate using AI', exact: true });
  await modal.locator('textarea').fill('Harmless fixture output.');
  const generate = modal.getByRole('button', { name: 'Generate', exact: true });
  const cancel = modal.getByRole('button', { name: 'Cancel generation', exact: true });
  await generate.click();
  await expect.poll(() => page.evaluate(() => (window as any).__nodeEditorAi?.length ?? 0)).toBe(1);
  await cancel.click();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect.poll(() => page.evaluate(() => (window as any).__nodeEditorAi.length)).toBe(2);
  await page.evaluate(() => (window as any).__nodeEditorAi[0].release());
  await w.editorFrame.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(generate).toBeDisabled();
  await expect(cancel).toBeVisible();
  await expect(w.view).toContainText('main-original');
  await page.evaluate(() => (window as any).__nodeEditorAi[1].release());
  await expect(w.view).toContainText('generated-late');
  await expect(generate).toBeEnabled();
});

test('evicted Monaco models reopen from their own canonical node without restoring stale text', async ({ page }) => {
  const w = await workspace(page, 'codeNew', 14);
  await w.edit('before-eviction');
  for (let index = 0; index < 14; index++) {
    await w.frame.locator(`.node[data-nodeid="filler-${index}"] .edit-button`).dispatchEvent('click');
    await expect(w.view).toContainText(`Representative graph payload ${index}`);
  }
  await w.openNode();
  await expect(w.view).toContainText('before-eviction');
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => w.saves.length).toBe(1);
  expect(w.saved(0)).toBe(w.value('before-eviction'));
  await expect(w.tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
});

test('synchronous Code typing remains measurable on a 350-node graph without losing input', async ({ page }, info) => {
  const w = await workspace(page, 'codeNew', 349);
  await w.input.focus();
  await w.input.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n// ');
  await w.input.evaluate((element) => {
    const owner = window as Window & { __typingFrames?: number[] };
    owner.__typingFrames = [];
    element.addEventListener(
      'input',
      () => {
        const start = performance.now();
        requestAnimationFrame(() => owner.__typingFrames!.push(performance.now() - start));
      },
      { capture: true },
    );
  });
  const typed = 'each-keystroke-reaches-the-owning-node-before-close-and-save';
  await page.keyboard.type(typed);
  await w.input.press('Escape');
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => w.saves.length).toBe(1);
  // Monaco chooses the platform EOL for a newly inserted first newline.
  expect(String(w.saved(0)).replace(/\r\n/g, '\n')).toBe(w.value('main-original') + '\n// ' + typed);
  const samples = await w.editorFrame.evaluate(() => (window as any).__typingFrames as number[]);
  expect(samples.length).toBe(typed.length);
  const sorted = [...samples].sort((a, b) => a - b);
  const measurements = info.outputPath('typing-frame-latency.json');
  await writeFile(
    measurements,
    JSON.stringify(
      {
        graphNodes: 350,
        keystrokes: samples.length,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        maximumMs: sorted.at(-1),
        samplesMs: samples,
        note: 'Synthetic local input-to-next-frame measurement, not a production hardware performance guarantee.',
      },
      null,
      2,
    ),
  );
  await info.attach('typing-frame-latency.json', { contentType: 'application/json', path: measurements });
});
