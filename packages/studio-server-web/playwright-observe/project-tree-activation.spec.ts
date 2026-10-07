import { expect, test, type Locator, type Page } from '@playwright/test';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

// Valid two-sample silent WAV; media decode errors must not obscure regressions.
const STATIC_AUDIO = 'UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA';

function fixture(name: string): { project: WorkflowProjectItem; contents: string } {
  return {
    project: {
      id: `${name}-id`,
      name,
      fileName: `${name}.rivet-project`,
      relativePath: `${name}.rivet-project`,
      absolutePath: `/workflows/${name}.rivet-project`,
      updatedAt: '2026-10-02T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    },
    contents: [
      'version: 4',
      'data:',
      '  metadata:',
      `    id: ${name}-id`,
      `    title: ${name}`,
      '    description: ""',
      `    mainGraphId: ${name}-graph`,
      '  graphs:',
      `    ${name}-graph:`,
      '      metadata:',
      `        id: ${name}-graph`,
      '        name: Main Graph',
      '        description: ""',
      '      nodes:',
      `        \'[${name}-node]:text "Activation Node"\':`,
      '          visualData: 520/300/260/null//',
      '          data:',
      `            text: ${name}`,
      `        \'[${name}-audio]:audio "Static File"\':`,
      '          visualData: 850/300/260/null//',
      '          data:',
      '            data:',
      `              refId: ${name}-asset`,
      '            useDataInput: false',
      '            useMediaTypeInput: false',
      '            mediaType: audio/wav',
      '      connections: []',
      '  plugins: []',
      '  references: []',
      '  data:',
      `    ${name}-asset: ${STATIC_AUDIO}`,
      '',
    ].join('\n'),
  };
}

test('tree selection survives folder toggles and row padding until another project is selected', async ({ page }) => {
  const a = fixture('selection-a');
  const b = fixture('selection-b');
  a.project.relativePath = `owner/${a.project.fileName}`;
  a.project.absolutePath = `/workflows/${a.project.relativePath}`;
  const loads: string[] = [];
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'selection-fixture', revision: 0 },
        folders: [
          {
            id: 'owner',
            name: 'Owner folder',
            relativePath: 'owner',
            absolutePath: '/workflows/owner',
            updatedAt: a.project.updatedAt,
            folders: [],
            projects: [a.project],
          },
          ...Array.from({ length: 30 }, (_, index) => ({
            id: `spacer-${index}`,
            name: `Spacer ${index}`,
            relativePath: `spacer-${index}`,
            absolutePath: `/workflows/spacer-${index}`,
            updatedAt: a.project.updatedAt,
            folders: [],
            projects: [],
          })),
          {
            id: 'other',
            name: 'Other folder',
            relativePath: 'other',
            absolutePath: '/workflows/other',
            updatedAt: a.project.updatedAt,
            folders: [],
            projects: [],
          },
        ],
        projects: [b.project],
      } satisfies WorkflowTreeResponse,
    }),
  );
  await page.route('**/api/projects/load', (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    loads.push(path);
    const entry = [a, b].find((item) => item.project.absolutePath === path);
    expect(entry).toBeDefined();
    return route.fulfill({ json: { contents: entry!.contents, datasetsContents: null, revisionId: null } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Expand Owner folder', exact: true }).click();
  const aRow = page.locator('.project-row', { hasText: a.project.name });
  const bRow = page.locator('.project-row', { hasText: b.project.name });
  const card = page.locator('.active-project-section');
  const tabs = page.frameLocator('iframe.dashboard-editor-frame').locator('.projects-container .project:not(.opening)');
  await expect(aRow).toBeEnabled({ timeout: 120_000 });
  await aRow.dblclick();
  await expect(tabs.filter({ hasText: a.project.name })).toHaveClass(/\bactive\b/);
  const expectSelection = async () => {
    await expect(card).toContainText(a.project.name);
    await expect(aRow).toHaveClass(/\bactive\b/);
  };
  await expectSelection();

  // Click actual padding on both sides, not inside the project row.
  const body = page.locator('.workflow-library-panel .body');
  const bodyBox = (await body.boundingBox())!;
  const rowBox = (await aRow.boundingBox())!;
  for (const x of [bodyBox.x + 2, bodyBox.x + bodyBox.width - 2]) {
    const y = rowBox.y + rowBox.height / 2;
    expect(
      await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.project-row'), { x, y }),
    ).toBe(false);
    await page.mouse.click(x, y);
    await expectSelection();
  }
  await page.getByRole('button', { name: 'Expand Other folder', exact: true }).click();
  await expectSelection();
  // Keeping a selection must not scroll a large tree away from the folder
  // the user is navigating. Let any scheduled automatic scroll settle.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page.getByRole('button', { name: 'Collapse Other folder', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Collapse Other folder', exact: true }).click();
  await expectSelection();
  const otherFolder = page.locator('.folder-row', { hasText: 'Other folder' });
  await otherFolder.press('Enter');
  await expect(otherFolder).toHaveAttribute('aria-expanded', 'true');
  await expectSelection();
  await otherFolder.press('Space');
  await expect(otherFolder).toHaveAttribute('aria-expanded', 'false');
  await expectSelection();
  await page.getByRole('button', { name: 'Collapse Owner folder', exact: true }).click();
  await expect(aRow).toHaveCount(0);
  await expect(card).toContainText(a.project.name);
  await page.getByRole('button', { name: 'Expand Owner folder', exact: true }).click();
  await expectSelection();
  await expect(aRow).toBeInViewport();
  await page.getByRole('button', { name: 'Collapse Owner folder', exact: true }).click({ modifiers: ['Control'] });
  await expect(aRow).toHaveCount(0);
  await expect(card).toContainText(a.project.name);
  await page.getByRole('button', { name: 'Expand Owner folder', exact: true }).click({ modifiers: ['Control'] });
  await expectSelection();
  await expect(aRow).toBeInViewport();
  await body.click({ position: { x: 2, y: bodyBox.height - 2 } });
  await expectSelection();
  expect(loads).toEqual([a.project.absolutePath]);

  await bRow.click();
  await expect(bRow).toHaveClass(/\bactive\b/);
  await expect(aRow).not.toHaveClass(/\bactive\b/);
  await expect(card).toContainText(b.project.name);
  await expect(tabs.filter({ hasText: b.project.name })).toHaveClass(/\bactive\b/);
});

test('tree activation preserves active and inactive edits, dirty dots, and the saved baseline', async ({ page }) => {
  const a = fixture('activation-a');
  const b = fixture('activation-b');
  const fixtures = new Map([a, b].map((entry) => [entry.project.absolutePath, entry]));
  const loads: string[] = [];
  const saves: string[] = [];
  const errors: string[] = [];
  let delayBLoad = false;
  let bLoadStarted = false;
  let releaseBLoad!: () => void;
  const bGate = new Promise<void>((resolve) => {
    releaseBLoad = resolve;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'activation-fixture', revision: 0 },
        folders: [],
        projects: [a.project, b.project],
      } satisfies WorkflowTreeResponse,
    }),
  );
  await page.route('**/api/projects/load', async (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    const entry = fixtures.get(path);
    expect(entry).toBeDefined();
    loads.push(path);
    if (delayBLoad && path === b.project.absolutePath) {
      bLoadStarted = true;
      await bGate;
    }
    await route.fulfill({ json: { contents: entry!.contents, datasetsContents: null, revisionId: null } });
  });
  await page.route('**/api/projects/save', async (route) => {
    const body = route.request().postDataJSON() as { path: string; contents: string };
    expect(fixtures.has(body.path)).toBe(true);
    saves.push(body.contents);
    await route.fulfill({ json: { path: body.path, revisionId: 'activation-saved' } });
  });
  await page.addInitScript(() => {
    const runtime = window as Window & { __treeActivationAcks?: number; __treeActivationFailures?: number };
    runtime.__treeActivationAcks = 0;
    runtime.__treeActivationFailures = 0;
    window.addEventListener('message', (event) => {
      if (event.source !== document.querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')?.contentWindow)
        return;
      if (event.data?.type === 'project-opened') runtime.__treeActivationAcks! += 1;
      if (event.data?.type === 'project-open-failed') runtime.__treeActivationFailures! += 1;
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const acknowledgements = () =>
    page.evaluate(() => (window as Window & { __treeActivationAcks?: number }).__treeActivationAcks ?? 0);
  async function activateRow(row: Locator, doubleClick = true): Promise<void> {
    await expect(row, 'Hosted editor must be ready before opening a project').toBeEnabled({ timeout: 120_000 });
    const before = await acknowledgements();
    if (doubleClick) {
      await row.dblclick();
    } else {
      await row.click();
    }
    // Active/dirty classes may already be present before a same-tab command
    // runs. Wait for its public bridge acknowledgement before asserting.
    await expect.poll(acknowledgements).toBeGreaterThan(before);
  }
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const tabs = frame.locator('.projects-container .project:not(.opening)');
  const aTab = tabs.filter({ hasText: a.project.name });
  const bTab = tabs.filter({ hasText: b.project.name });
  const aRow = page.locator('.project-row', { hasText: a.project.name });
  const bRow = page.locator('.project-row', { hasText: b.project.name });
  const node = frame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  const saveButton = page.locator('.active-project-save-button');

  await expect(frame.getByRole('region', { name: 'Workspace recovery' })).toHaveCount(0);
  await activateRow(aRow);
  await expect(aTab).toHaveClass(/\bactive\b/);
  const title = node.locator('.node-title');
  await expect(title).toBeVisible();
  const before = await title.boundingBox();
  const initialPosition = await node.evaluate((element) => (element as HTMLElement).style.transform);
  expect(before).not.toBeNull();
  const x = before!.x + before!.width / 2;
  const y = before!.y + before!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await expect(saveButton).toBeVisible();
  const editedPosition = await node.evaluate((element) => (element as HTMLElement).style.transform);
  expect(editedPosition).not.toBe(initialPosition);
  await expect(frame.getByRole('region', { name: 'Workspace recovery' })).toHaveCount(0);

  // Reopening the active tab must not reload its graph or move the node back.
  await activateRow(aRow);
  await expect(aTab).toHaveClass(/\bactive\b/);
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);
  await expect(saveButton).toBeVisible();

  // Inactive tab activation must preserve both content and its original baseline.
  await activateRow(bRow);
  await expect(bTab).toHaveClass(/\bactive\b/);
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await activateRow(aRow);
  await expect(aTab).toHaveClass(/\bactive\b/);
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);
  await expect(saveButton).toBeVisible();
  await expect(tabs).toHaveCount(2);
  expect(loads).toEqual([a.project.absolutePath, b.project.absolutePath]);

  // Recovery must retain both the edits and their original saved baseline,
  // including the dirty indicator on the inactive tab.
  await bTab.click();
  await expect(bTab).toHaveClass(/\bactive\b/);
  // A cache clear failure can leave data from another tab. Reload recovery
  // must use the active payload persisted with project identity, not that cache.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rivet_static_data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('data', 'readwrite');
        transaction.objectStore('data').clear();
        transaction
          .objectStore('data')
          .put({ id: 'wrong-project-asset', data: 'residual cache' }, 'wrong-project-asset');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(bTab).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  const audioNode = frame.locator(`.node[data-nodeid="${b.project.name}-audio"]`);
  await audioNode.hover();
  await audioNode.locator('.edit-button').click({ timeout: 10_000 });
  await expect(frame.getByText('Data (48 B)', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await activateRow(aRow);
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);

  // Closing must inspect live content, not rely on a delayed tab-dot render.
  // Cancelling the warning keeps the recovered project and its edits intact.
  await aTab.hover();
  await frame.getByRole('button', { name: `Close ${a.project.name}`, exact: true }).click();
  const closeWarning = frame.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(closeWarning).toBeVisible();
  await closeWarning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(closeWarning).toHaveCount(0);
  await expect(aTab).toHaveClass(/\bhas-unsaved-changes\b/);
  await expect(tabs).toHaveCount(2);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);

  // Only an actual save may clear the dirty state. All IO remains mocked.
  await saveButton.click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(aTab).not.toHaveClass(/\bhas-unsaved-changes\b/);
  await expect(saveButton).toHaveCount(0);
  expect(saves[0]).not.toBe(a.contents);
  expect(saves[0]).toContain(`${a.project.name}-asset: ${STATIC_AUDIO}`);
  expect(saves[0]).not.toContain('wrong-project-asset');
  await bTab.click();
  await expect(bTab).toHaveClass(/\bactive\b/);
  await activateRow(aRow, false);
  await expect(aTab).toHaveClass(/\bactive\b/);
  await expect(aTab).not.toHaveClass(/\bhas-unsaved-changes\b/);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);
  // Re-activation also must not reset the active resource workspace.
  await frame.getByRole('button', { name: 'Node library', exact: true }).click();
  await expect(node).toHaveCount(0);
  await activateRow(aRow);
  await expect(node).toHaveCount(0);
  await activateRow(bRow);
  await activateRow(aRow);
  await expect(node).toHaveCount(0);

  // Explicit graph navigation (used by Subgraph links) must still leave a
  // resource workspace, even when its retained graph id is already the target.
  const beforeNavigation = await acknowledgements();
  await page.evaluate(
    ({ path, projectId, graphId }) => {
      document.querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')!.contentWindow!.postMessage(
        {
          type: 'open-project',
          path,
          replaceCurrent: false,
          expectedProjectId: projectId,
          preferredGraphId: graphId,
        },
        window.location.origin,
      );
    },
    { path: a.project.absolutePath, projectId: a.project.id, graphId: `${a.project.name}-graph` },
  );
  await expect.poll(acknowledgements).toBeGreaterThan(beforeNavigation);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);
  await expect(aTab).not.toHaveClass(/\bhas-unsaved-changes\b/);

  // Reload clears the Evaluation session cache but retains tab snapshots.
  // Cancelling an inactive tab's slow recovery must keep the current tab and
  // live graph intact, rather than letting the late response steal selection.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(aTab).toHaveClass(/\bactive\b/, { timeout: 120_000 });
  await expect(node).toBeVisible();
  delayBLoad = true;
  await bRow.dblclick();
  await expect
    .poll(() => bLoadStarted, { message: 'Reloaded tab must fetch its missing Evaluation session' })
    .toBe(true);
  await aTab.click();
  releaseBLoad();
  // A subsequent public acknowledgement is a completion barrier for the
  // shared activation queue, not an arbitrary timing delay.
  await activateRow(aRow);
  expect(
    await page.evaluate(() => (window as Window & { __treeActivationFailures?: number }).__treeActivationFailures),
    'Superseded activation is cancellation, not an open failure',
  ).toBe(0);
  await expect(aTab).toHaveClass(/\bactive\b/);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);
  await expect(tabs).toHaveCount(2);
  // A path reused for a different project must fail before switching content
  // or importing its Evaluation attachment, and a corrected retry must work.
  delayBLoad = false;
  fixtures.set(b.project.absolutePath, { ...b, contents: a.contents });
  await bTab.click();
  await expect(
    frame.locator('.Toastify__toast', { hasText: 'saved path now belongs to a different project' }),
  ).toBeVisible();
  await expect(aTab).toHaveClass(/\bactive\b/);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(editedPosition);
  fixtures.set(b.project.absolutePath, b);
  await bTab.click();
  await expect(bTab).toHaveClass(/\bactive\b/);
  await expect(frame.locator(`.node[data-nodeid="${b.project.name}-node"]`)).toBeVisible();
  expect(errors).toEqual([]);
});

async function prepareRecoveryPage(
  page: Page,
  options: { missingCheckpoint?: boolean; failedBootstrap?: boolean } = {},
) {
  if (options.missingCheckpoint) {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('test-recovery-seeded')) {
        sessionStorage.setItem('test-recovery-seeded', '1');
        sessionStorage.setItem('rivet-workspace-recovery-v1', 'workspace-recovery/v1/missing-test-checkpoint');
      }
    });
  }
  const a = fixture('recovery-a');
  const b = fixture('recovery-b');
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'recovery', revision: 0 },
        folders: [],
        projects: [a.project, b.project],
      },
    }),
  );
  await page.route('**/api/projects/load', (route) => {
    const entry = route.request().postDataJSON().path === a.project.absolutePath ? a : b;
    return route.fulfill({ json: { contents: entry.contents, datasetsContents: null, revisionId: null } });
  });
  await page.route('**/api/projects/save', (route) =>
    route.fulfill({
      json: {
        path: route.request().postDataJSON().path,
        revisionId: 'saved',
      },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  if (!options.missingCheckpoint && !options.failedBootstrap) await waitForDashboardReady(page);
  return { a, b };
}

test('missing recovery exposes usable recovery controls instead of an endless hidden editor', async ({ page }) => {
  await prepareRecoveryPage(page, { missingCheckpoint: true });
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(page.locator('iframe.dashboard-editor-frame')).toBeVisible();
  await expect(
    frame.getByRole('alert').filter({ hasText: 'Could not restore your previous workspace.' }),
  ).toBeVisible();
  await expect(
    frame.getByText('The selected workspace recovery checkpoint is missing.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.dashboard-app-loading')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Recover workspace', exact: true }).click();
  const modal = frame.getByRole('dialog', { name: 'Recover a previous workspace' });
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await frame.getByRole('button', { name: 'Recover workspace', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await modal.getByRole('button', { name: 'Start empty', exact: true }).click();
  await waitForDashboardReady(page);
  await expect(frame.getByRole('alert').filter({ hasText: 'Could not restore your previous workspace.' })).toHaveCount(
    0,
  );
});

async function editRecoveryNode(page: Page, name: string) {
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const node = frame.locator(`.node[data-nodeid="${name}-node"]`);
  await expect(node).toBeVisible({ timeout: 120_000 });
  const box = await node.locator('.node-title').boundingBox();
  expect(box).not.toBeNull();
  const original = await node.evaluate((element) => (element as HTMLElement).style.transform);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(original);
  return node.evaluate((element) => (element as HTMLElement).style.transform);
}

type BrowserRecoveryCheckpoint = {
  groups: {
    project?: { hostedProjectRevisions?: Array<{ projectId: string; acceptedRevisionId: string }> };
    graph?: { graphState?: { nodes: Array<{ id: string; visualData: { x: number; y: number } }> } };
  };
};

async function readRecoveryCheckpoint(page: Page): Promise<BrowserRecoveryCheckpoint | undefined> {
  const editor = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  return editor!.evaluate(async () => {
    const key = sessionStorage.getItem('rivet-workspace-recovery-v1');
    if (!key) return undefined;
    const checkpoint = await new Promise<string | undefined>((resolve, reject) => {
      const request = indexedDB.open('jotai-store', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('state', 'readonly').objectStore('state').get(key);
        read.onsuccess = () => {
          db.close();
          resolve(read.result);
        };
        read.onerror = () => {
          db.close();
          reject(read.error);
        };
      };
    });
    return checkpoint ? JSON.parse(checkpoint) : undefined;
  });
}

async function checkpointAcceptedRevision(page: Page, projectId: string): Promise<string | undefined> {
  return (await readRecoveryCheckpoint(page))?.groups.project?.hostedProjectRevisions?.find(
    (entry) => entry.projectId === projectId,
  )?.acceptedRevisionId;
}

async function waitForRecoveryCheckpoint(page: Page): Promise<void> {
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const expected = await frame.locator('.node[data-nodeid]').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const position = new DOMMatrix((node as HTMLElement).style.transform);
        return { id: node.getAttribute('data-nodeid'), x: position.m41, y: position.m42 };
      })
      .sort((a, b) => a.id!.localeCompare(b.id!)),
  );
  expect(expected.length).toBeGreaterThan(0);
  // Routine recovery is intentionally invisible. Verify actual committed
  // content rather than using a success notification as an IO barrier.
  await expect
    .poll(async () =>
      (await readRecoveryCheckpoint(page))?.groups.graph?.graphState?.nodes
        .map((node) => ({ id: node.id, x: node.visualData.x, y: node.visualData.y }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
    .toEqual(expected);
  await expect(frame.getByRole('region', { name: 'Workspace recovery' })).toHaveCount(0);
}

test('same-origin browser windows retain independent unsaved recovery across reloads', async ({ page, context }) => {
  const { a, b } = await prepareRecoveryPage(page);
  const second = await context.newPage();
  await prepareRecoveryPage(second);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const aPosition = await editRecoveryNode(page, a.project.name);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(page);
  await second.locator('.project-row', { hasText: b.project.name }).dblclick();
  const bPosition = await editRecoveryNode(second, b.project.name);
  const secondFrame = second.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(second);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  await expect(frame.locator('.projects-container .project')).toHaveCount(1);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await expect
    .poll(() =>
      frame
        .locator(`.node[data-nodeid="${a.project.name}-node"]`)
        .evaluate((element) => (element as HTMLElement).style.transform),
    )
    .toBe(aPosition);
  await second.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(second);
  await expect(secondFrame.locator('.projects-container .project')).toHaveCount(1);
  await expect(secondFrame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await expect
    .poll(() =>
      secondFrame
        .locator(`.node[data-nodeid="${b.project.name}-node"]`)
        .evaluate((element) => (element as HTMLElement).style.transform),
    )
    .toBe(bPosition);
  await second.close();
});

test('a duplicated tab inherits recovery but forks its writer and ignores independent navigation fragments', async ({
  page,
  context,
}) => {
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const firstPosition = await editRecoveryNode(page, a.project.name);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(page);
  const firstKey = await page.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'));
  expect(firstKey).toBeTruthy();
  const popup = context.waitForEvent('page');
  await page.evaluate(() => {
    window.open('about:blank');
  });
  const second = await popup;
  expect(await second.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'))).toBe(firstKey);
  await second.evaluate((projectId) => {
    // This former standalone authority must no longer override the checkpoint.
    sessionStorage.setItem(
      'rivet-project-editor-reload-v1',
      JSON.stringify({
        projectId,
        state: {
          navigationStack: { stack: [], index: 0 },
          canvasPositionsByGraph: { 'recovery-a-graph': { x: 9999, y: 9999, zoom: 1 } },
        },
      }),
    );
  }, a.project.id);
  await prepareRecoveryPage(second);
  const secondFrame = second.frameLocator('iframe.dashboard-editor-frame');
  const secondNode = secondFrame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect(secondNode).toBeVisible();
  await expect
    .poll(() => secondNode.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(firstPosition);
  const secondPosition = await editRecoveryNode(second, a.project.name);
  await waitForRecoveryCheckpoint(second);
  expect(await second.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'))).not.toBe(firstKey);
  expect(await second.evaluate(() => sessionStorage.getItem('rivet-project-editor-reload-v1'))).toBeTruthy();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  await expect
    .poll(() =>
      frame
        .locator(`.node[data-nodeid="${a.project.name}-node"]`)
        .evaluate((element) => (element as HTMLElement).style.transform),
    )
    .toBe(firstPosition);
  await second.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(second);
  await expect
    .poll(() => secondNode.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(secondPosition);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await expect(secondFrame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await second.close();
});

test('corrupt project recovery fails before mounting an empty clean editor', async ({ page }) => {
  await page.route('**/recovery-seed', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/recovery-seed');
  await page.evaluate(async () => {
    const key = 'workspace-recovery/v1/corrupt-project';
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('jotai-store', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('state', 'readwrite');
        transaction.objectStore('state').put(
          JSON.stringify({
            version: 1,
            revision: 1,
            updatedAt: new Date().toISOString(),
            groups: { project: { projectState: { metadata: { id: 'damaged', title: 'Damaged' }, graphs: null } } },
          }),
          key,
        );
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      };
    });
    sessionStorage.setItem('rivet-workspace-recovery-v1', key);
  });
  await prepareRecoveryPage(page, { failedBootstrap: true });
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(
    frame.getByRole('alert').filter({ hasText: 'Could not restore your previous workspace.' }),
  ).toBeVisible();
  await expect(frame.getByText('Invalid workspace recovery project.', { exact: false })).toBeVisible();
  await expect(frame.locator('.projects-container')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'))).toBe(
    'workspace-recovery/v1/corrupt-project',
  );
});

test('browser transaction abort after a successful put never reports recovery saved', async ({ page }) => {
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frame.locator(`.node[data-nodeid="${a.project.name}-node"]`)).toBeVisible({ timeout: 120_000 });
  await waitForRecoveryCheckpoint(page);
  const editor = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  await editor!.evaluate(() => {
    const runtime = window as Window & { __abortRecovery?: boolean };
    runtime.__abortRecovery = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (this.name === 'state' && String(key).startsWith('workspace-recovery/')) {
        const transaction = this.transaction;
        request.addEventListener(
          'success',
          () => {
            if (runtime.__abortRecovery) transaction.abort();
          },
          { once: true },
        );
      }
      return request;
    };
  });
  await editRecoveryNode(page, a.project.name);
  await expect(frame.getByRole('alert').filter({ hasText: 'Unsaved changes may not survive a reload.' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await editor!.evaluate(() => {
    (window as Window & { __abortRecovery?: boolean }).__abortRecovery = false;
  });
  await frame.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await waitForRecoveryCheckpoint(page);
});

test('transient checkpoint failures repair themselves without a recovery panel or toast', async ({ page }) => {
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frame.locator(`.node[data-nodeid="${a.project.name}-node"]`)).toBeVisible();
  await waitForRecoveryCheckpoint(page);
  const editor = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  await editor!.evaluate(() => {
    const runtime = window as Window & { __recoveryWarningSeen?: boolean; __recoveryWriteFailures?: number };
    runtime.__recoveryWarningSeen = false;
    runtime.__recoveryWriteFailures = 0;
    new MutationObserver(() => {
      if (document.querySelector('[aria-label="Workspace recovery"]')) runtime.__recoveryWarningSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'state' && String(key).startsWith('workspace-recovery/') && !runtime.__recoveryWriteFailures) {
        runtime.__recoveryWriteFailures++;
        throw new DOMException('Temporary checkpoint failure', 'UnknownError');
      }
      return put.call(this, value, key);
    };
  });
  const position = await editRecoveryNode(page, a.project.name);
  await waitForRecoveryCheckpoint(page);
  expect(
    await editor!.evaluate(() => (window as Window & { __recoveryWriteFailures?: number }).__recoveryWriteFailures),
  ).toBe(1);
  expect(
    await editor!.evaluate(() => (window as Window & { __recoveryWarningSeen?: boolean }).__recoveryWarningSeen),
  ).toBe(false);
  await expect(frame.locator('.Toastify__toast', { hasText: /browser recovery|persistent storage item/i })).toHaveCount(
    0,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  const node = frame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(position);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
});

test('temporarily blocked session-storage access restores the chosen workspace automatically', async ({ page }) => {
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const position = await editRecoveryNode(page, a.project.name);
  await waitForRecoveryCheckpoint(page);
  await page.addInitScript(() => {
    if (!new URLSearchParams(location.search).has('editor')) return;
    const storage = sessionStorage;
    let reads = 0;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        if (++reads < 3) throw new DOMException('Session access temporarily blocked', 'SecurityError');
        return storage;
      },
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  const node = frame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(position);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await expect(frame.getByRole('region', { name: 'Workspace recovery', exact: true })).toHaveCount(0);
});

test('persistent recovery failure warns about unsaved work, not a successfully saved project', async ({ page }) => {
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frame.locator(`.node[data-nodeid="${a.project.name}-node"]`)).toBeVisible({ timeout: 120_000 });
  const editorFrame = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  expect(editorFrame).not.toBeNull();
  await editorFrame!.evaluate(() => {
    const runtime = window as Window & { __failRecovery?: boolean };
    runtime.__failRecovery = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (runtime.__failRecovery && this.name === 'state' && String(key).startsWith('workspace-recovery/')) {
        throw new DOMException('Recovery storage quota exceeded', 'QuotaExceededError');
      }
      return put.call(this, value, key);
    };
  });
  await editRecoveryNode(page, a.project.name);
  await expect(frame.getByRole('alert').filter({ hasText: 'Unsaved changes may not survive a reload.' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(frame.getByRole('button', { name: 'Recover workspace', exact: true })).toHaveCount(0);
  await page.locator('.active-project-save-button').click();
  await expect(frame.locator('.projects-container .project')).not.toHaveClass(/has-unsaved-changes/);
  await expect(frame.getByRole('region', { name: 'Workspace recovery', exact: true })).toHaveCount(0);
  await expect(frame.locator('.Toastify__toast', { hasText: /browser recovery|persistent storage item/i })).toHaveCount(
    0,
  );
  await editorFrame!.evaluate(() => {
    (window as Window & { __failRecovery?: boolean }).__failRecovery = false;
  });
  await editorFrame!.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForRecoveryCheckpoint(page);
});

test('a failed reload pointer remains retryable and recovers without making another edit', async ({ page }) => {
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frame.locator(`.node[data-nodeid="${a.project.name}-node"]`)).toBeVisible({ timeout: 120_000 });
  await waitForRecoveryCheckpoint(page);
  const editor = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  await editor!.evaluate(() => {
    const runtime = window as Window & { __failRecoveryPointer?: boolean };
    runtime.__failRecoveryPointer = true;
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (runtime.__failRecoveryPointer && this === sessionStorage && key === 'rivet-workspace-recovery-v1')
        throw new DOMException('Session storage unavailable', 'QuotaExceededError');
      write.call(this, key, value);
    };
  });
  const position = await editRecoveryNode(page, a.project.name);
  await expect(frame.getByRole('alert').filter({ hasText: 'Unsaved changes may not survive a reload.' })).toBeVisible({
    timeout: 15_000,
  });
  const retry = frame.getByRole('button', { name: 'Retry recovery', exact: true });
  await expect(retry).toBeEnabled();
  expect(
    await editor!.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await editor!.evaluate(() => {
    (window as Window & { __failRecoveryPointer?: boolean }).__failRecoveryPointer = false;
  });
  await editor!.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForRecoveryCheckpoint(page);
  await expect(retry).toHaveCount(0);
  expect(
    await editor!.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  const node = frame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(position);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
});

test('memory-only browser recovery warns before losing edits and does not claim reload safety', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = indexedDB;
    (window as Window & { __restoreDatasetIndexedDB?: () => void }).__restoreDatasetIndexedDB = () => {
      Object.defineProperty(window, 'indexedDB', { value: original, configurable: true });
    };
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  });
  const { a } = await prepareRecoveryPage(page);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const warning = frame.getByRole('alert').filter({ hasText: 'Automatic recovery is unavailable in this browser.' });
  await expect(warning).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'Retry recovery', exact: true })).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'Recover workspace', exact: true })).toHaveCount(0);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  await expect(
    page.locator('.Toastify__toast', { hasText: 'Browser IndexedDB storage is unavailable.' }),
  ).toBeVisible();
  // Dataset IO requires IndexedDB. Restore that capability, but keep the
  // already-selected memory-only recovery backend to test its honest status.
  const editor = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  await editor!.evaluate(() =>
    (window as Window & { __restoreDatasetIndexedDB?: () => void }).__restoreDatasetIndexedDB!(),
  );
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  await editRecoveryNode(page, a.project.name);
  await expect(warning).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Retry recovery', exact: true })).toHaveCount(0);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  expect(await editor!.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'))).toBeNull();
  expect(
    await editor!.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  // A real server save is still valid even when browser recovery is volatile.
  await page.locator('.active-project-save-button').click();
  await expect(frame.locator('.projects-container .project')).not.toHaveClass(/has-unsaved-changes/);
  await expect(warning).toHaveCount(0);
  await expect(frame.getByRole('status').filter({ hasText: 'Browser recovery saved' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an unreadable reload reference blocks bootstrap rather than silently starting a clean workspace', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (this === sessionStorage && key === 'rivet-workspace-recovery-v1')
        throw new DOMException('Recovery reference inaccessible', 'SecurityError');
      return read.call(this, key);
    };
  });
  await prepareRecoveryPage(page, { failedBootstrap: true });
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(
    frame.getByRole('alert').filter({ hasText: 'Could not restore your previous workspace.' }),
  ).toBeVisible();
  await expect(frame.getByText('Browser recovery reference is unavailable.', { exact: false })).toBeVisible();
  await expect(frame.locator('.projects-container')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'Recover workspace', exact: true })).toBeEnabled();
});

test('blocked session-storage access cannot authorize importing an unknown legacy workspace', async ({ page }) => {
  await page.addInitScript(() => {
    if (!new URLSearchParams(location.search).has('editor')) return;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Session storage blocked', 'SecurityError');
      },
    });
  });
  await prepareRecoveryPage(page, { failedBootstrap: true });
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(
    frame.getByRole('alert').filter({ hasText: 'Could not restore your previous workspace.' }),
  ).toBeVisible();
  await expect(frame.getByText('Browser recovery reference is unavailable.', { exact: false })).toBeVisible();
  await expect(frame.locator('.projects-container')).toHaveCount(0);
});

test('recovery selection freezes another live window before the selected editor reloads', async ({ page, context }) => {
  const { a, b } = await prepareRecoveryPage(page);
  const second = await context.newPage();
  await prepareRecoveryPage(second);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frame.locator(`.node[data-nodeid="${a.project.name}-node"]`)).toBeVisible({ timeout: 120_000 });
  await waitForRecoveryCheckpoint(page);
  await second.locator('.project-row', { hasText: b.project.name }).dblclick();
  const originalPosition = await editRecoveryNode(second, b.project.name);
  const secondFrame = second.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(second);
  const otherKey = await second.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'));
  // Choosing older content is available only for blocked bootstrap, never
  // offered as a repair for a live workspace's failed background write.
  await page.evaluate(() =>
    sessionStorage.setItem('rivet-workspace-recovery-v1', 'workspace-recovery/v1/missing-selection-fixture'),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    frame.getByRole('alert').filter({ hasText: 'Could not restore your previous workspace.' }),
  ).toBeVisible();
  let reloadStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/\?editor(?:&|$)/, async (route) => {
    reloadStarted = true;
    await gate;
    await route.continue();
  });
  await frame.getByRole('button', { name: 'Recover workspace', exact: true }).click();
  const modal = frame.getByRole('dialog', { name: 'Recover a previous workspace' });
  await expect(modal).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  const selection = modal.getByRole('button', { name: /^recovery-b ·/ }).click();
  try {
    await expect.poll(() => reloadStarted).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('rivet-workspace-recovery-v1'))).not.toBe(otherKey);
    const newerPosition = await editRecoveryNode(second, b.project.name);
    expect(newerPosition).not.toBe(originalPosition);
    await waitForRecoveryCheckpoint(second);
  } finally {
    release();
  }
  await selection;
  await waitForDashboardReady(page);
  const node = frame.locator(`.node[data-nodeid="${b.project.name}-node"]`);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(originalPosition);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await expect(secondFrame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await second.close();
});

test('recovery bootstraps and reloads when the browser UUID helper is unavailable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  });
  const { a } = await prepareRecoveryPage(page);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const position = await editRecoveryNode(page, a.project.name);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  const node = frame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(position);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  expect(errors).toEqual([]);
});

test('another window save cannot authorize a recovered tab to overwrite its newer revision', async ({
  page,
  context,
}) => {
  const { a } = await prepareRecoveryPage(page);
  const second = await context.newPage();
  await prepareRecoveryPage(second);
  let savedRevision = 'original';
  const load = (target: Page) =>
    target.route('**/api/projects/load', (route) =>
      route.fulfill({ json: { contents: a.contents, datasetsContents: null, revisionId: savedRevision } }),
    );
  await Promise.all([load(page), load(second)]);
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  await second.locator('.project-row', { hasText: a.project.name }).dblclick();
  const firstPosition = await editRecoveryNode(page, a.project.name);
  await editRecoveryNode(second, a.project.name);
  const firstFrame = page.frameLocator('iframe.dashboard-editor-frame');
  const secondFrame = second.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(page);
  await expect.poll(() => checkpointAcceptedRevision(page, a.project.id)).toBe('original');
  await second.route('**/api/projects/save', (route) => {
    expect(route.request().postDataJSON().expectedRevisionId).toBe('original');
    savedRevision = 'other-window';
    return route.fulfill({ json: { path: a.project.absolutePath, revisionId: savedRevision } });
  });
  await second.locator('.active-project-save-button').click();
  await expect(secondFrame.locator('.projects-container .project')).not.toHaveClass(/has-unsaved-changes/);
  await expect.poll(() => checkpointAcceptedRevision(second, a.project.id)).toBe('other-window');
  await expect.poll(() => checkpointAcceptedRevision(page, a.project.id)).toBe('original');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const node = firstFrame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(firstPosition);
  expect(await checkpointAcceptedRevision(page, a.project.id)).toBe('original');
  let rejected = false;
  await page.route('**/api/projects/save', (route) => {
    expect(route.request().postDataJSON().expectedRevisionId).toBe('original');
    rejected = true;
    return route.fulfill({ status: 409, json: { error: 'The saved project changed in another window.' } });
  });
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => rejected).toBe(true);
  await expect(firstFrame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
  await second.close();
});

test('a saved project with failed recovery cannot authorize an older checkpoint to overwrite it after reload', async ({
  page,
}) => {
  const { a } = await prepareRecoveryPage(page);
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({ json: { contents: a.contents, datasetsContents: null, revisionId: 'original' } }),
  );
  await page.locator('.project-row', { hasText: a.project.name }).dblclick();
  const position = await editRecoveryNode(page, a.project.name);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await waitForRecoveryCheckpoint(page);
  expect(await checkpointAcceptedRevision(page, a.project.id)).toBe('original');
  const editor = await (await page.locator('iframe.dashboard-editor-frame').elementHandle())!.contentFrame();
  await editor!.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'state' && String(key).startsWith('workspace-recovery/')) {
        throw new DOMException('Recovery storage quota exceeded', 'QuotaExceededError');
      }
      return put.call(this, value, key);
    };
  });
  await page.route('**/api/projects/save', (route) => {
    expect(route.request().postDataJSON().expectedRevisionId).toBe('original');
    return route.fulfill({ json: { path: a.project.absolutePath, revisionId: 'saved-but-not-checkpointed' } });
  });
  await page.locator('.active-project-save-button').click();
  await expect(frame.locator('.projects-container .project')).not.toHaveClass(/has-unsaved-changes/);
  await expect(frame.getByRole('region', { name: 'Workspace recovery', exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardReady(page);
  const node = frame.locator(`.node[data-nodeid="${a.project.name}-node"]`);
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(position);
  expect(await checkpointAcceptedRevision(page, a.project.id)).toBe('original');
  let rejected = false;
  await page.route('**/api/projects/save', (route) => {
    expect(route.request().postDataJSON().expectedRevisionId).toBe('original');
    rejected = true;
    return route.fulfill({ status: 409, json: { error: 'The saved project is newer than its recovered checkpoint.' } });
  });
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => rejected).toBe(true);
  await expect(frame.locator('.projects-container .project')).toHaveClass(/has-unsaved-changes/);
});
