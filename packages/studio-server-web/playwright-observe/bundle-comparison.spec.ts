import { expect, test, type Page } from '@playwright/test';
import { serializeProject, deserializeProject, type Project } from '@valerypopoff/rivet2-core';
import type {
  BundleComparisonCatalog,
  BundleComparisonManifest,
  BundleComparisonPairRequest,
} from '../../studio-server-shared/workflow-bundle-comparison-types';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

const olderId = '5c07c7c1-62b1-4140-911b-03c714e580b1';
const newerId = '5c07c7c1-62b1-4140-911b-03c714e580b2';
test.use({ actionTimeout: 10_000 });
const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});
function catalog(bundleId: string, name: string, ids: string[]): BundleComparisonCatalog {
  return {
    bundleId,
    name,
    relativePath: name,
    folders: ['Nested'],
    projects: ids.map((projectId, index) => ({
      projectId,
      name:
        index === 0
          ? 'Main project'
          : index === 1
            ? 'Dependency'
            : bundleId === olderId
              ? 'Removed member'
              : 'Added member',
      relativePath:
        index === 0
          ? 'Main.rivet-project'
          : index === 1
            ? 'Nested/Dependency.rivet-project'
            : `${bundleId === olderId ? 'Removed' : 'Added'}.rivet-project`,
      revisionId: `saved-${projectId}`,
      publishedRevisionId: null,
    })),
  };
}
function contents(id: string, text: string, removed = false) {
  const node = (nodeId: string, value: string) => ({
    id: nodeId,
    type: 'text',
    title: nodeId === 'text' ? 'Editable text' : 'Removed text',
    data: { text: value },
    visualData: { x: 400, y: 250, width: 260 },
  });
  return serializeProject({
    metadata: { id, title: 'Main project', description: '', mainGraphId: 'main' },
    graphs: {
      main: { metadata: { id: 'main', name: 'Main Graph' }, nodes: [node('text', text)], connections: [] },
      alternative: {
        metadata: { id: 'alternative', name: 'Alternative Graph' },
        nodes: [node('alternative-text', 'Alternative')],
        connections: [],
      },
      ...(removed
        ? {
            removed: {
              metadata: { id: 'removed', name: 'Removed Graph' },
              nodes: [node('deleted', 'Only in Older')],
              connections: [],
            },
          }
        : {}),
    },
    plugins: [],
    references: [],
  } as unknown as Project) as string;
}
async function fixture(page: Page, bundleCompare = true) {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const older = catalog(olderId, 'Original', ['old-a', 'old-b', 'old-only']);
  const newer = catalog(newerId, 'Working', ['new-a', 'new-b', 'new-only']);
  const manifest: BundleComparisonManifest = { older, newer, capturedAt: '2026-11-12T00:00:00Z' };
  const snapshots = new Map(
    [...older.projects, ...newer.projects].map((p) => [
      p.projectId,
      contents(
        p.projectId,
        p.projectId.endsWith('-b') ? 'Unchanged' : p.projectId.startsWith('old') ? 'Before' : 'After',
        p.projectId === 'old-a' || p.projectId === 'old-only',
      ),
    ]),
  );
  const pathFor = (c: BundleComparisonCatalog, id: string) =>
    `/managed/workflows/${c.name}/${c.projects.find((p) => p.projectId === id)!.relativePath}`;
  const saves: { path: string; contents: string }[] = [];
  const reads: BundleComparisonPairRequest[] = [];
  const loads: string[] = [];
  let block: Promise<void> | undefined;
  let release: (() => void) | undefined;
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (path === '/api/workflows/tree')
        return route.fulfill({
          json: {
            root: '/managed/workflows',
            capabilities: { explicitBundles: true, ...(bundleCompare ? { bundleCompare: true } : {}) },
            folders: [older, newer].map((c) => ({
              id: c.name,
              bundleId: c.bundleId,
              namespaceId: c.bundleId,
              name: c.name,
              relativePath: c.name,
              absolutePath: `/managed/workflows/${c.name}`,
              updatedAt: '',
              folders: [],
              projects: c.projects.map((p) => ({
                id: p.projectId,
                projectMetadataId: p.projectId,
                namespaceProtocol: 1,
                revisionId: p.revisionId,
                name: p.name,
                fileName: p.relativePath.split('/').at(-1),
                relativePath: `${c.name}/${p.relativePath}`,
                absolutePath: pathFor(c, p.projectId),
                updatedAt: '',
                bundleId: c.bundleId,
                settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
              })),
            })),
            projects: [],
          },
        });
      if (path === '/api/workflows/bundles/compare/manifest')
        return route.fulfill({
          json: body.olderId === olderId ? manifest : { ...manifest, older: newer, newer: older },
        });
      if (path === '/api/workflows/bundles/compare/pair') {
        reads.push(body);
        if (block) await block;
        const current = body.newer ? [older, newer].find((c) => c.bundleId === body.newer.bundleId)! : null;
        return route.fulfill({
          json: {
            older: body.older
              ? {
                  ...body.older,
                  contents:
                    snapshots.get(`${body.older.projectId}:${body.older.revisionId}`) ??
                    snapshots.get(body.older.projectId),
                }
              : null,
            newer: current ? { ...body.newer, path: pathFor(current, body.newer.projectId) } : null,
          },
        });
      }
      if (path === '/api/projects/load') {
        loads.push(body.path);
        const c = [older, newer].find((c) => body.path.startsWith(`/managed/workflows/${c.name}/`));
        const p = c?.projects.find((p) => pathFor(c, p.projectId) === body.path);
        return p
          ? route.fulfill({
              json: {
                contents: snapshots.get(p.projectId),
                datasetsContents: null,
                revisionId: p.revisionId,
                namespaceProtocol: 1,
              },
            })
          : route.fulfill({ status: 404, json: { error: 'Project not found' } });
      }
      if (path === '/api/projects/save') {
        saves.push(body);
        const [project] = deserializeProject(body.contents);
        snapshots.set(project.metadata.id, body.contents);
        const member = [...older.projects, ...newer.projects].find((p) => p.projectId === project.metadata.id)!;
        member.revisionId = `saved-again-${saves.length}`;
        return route.fulfill({ json: { path: body.path, revisionId: `saved-again-${saves.length}` } });
      }
      if (path.endsWith('/scheduled-runs/summary')) return route.fulfill({ json: { enabledCount: 0 } });
      if (path.endsWith('/projects/references'))
        return route.fulfill({
          json: { references: [], graphReferences: [], complete: true, checkedProjects: 0, totalProjects: 0 },
        });
      if (path.endsWith('/datasets')) return route.fulfill({ json: [] });
      return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await waitForDashboardReady(page);
  return {
    older,
    newer,
    saves,
    reads,
    loads,
    snapshots,
    pathFor,
    block: () => {
      block = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      block = undefined;
      release?.();
    },
  };
}
async function select(page: Page, label: string, text: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByText(text, { exact: true }).last().click();
}
async function begin(page: Page) {
  await page.getByRole('button', { name: /^(Expand|Collapse) Working bundle$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compare with another bundle…', exact: true }).click();
  await select(page, 'Older bundle', 'Original');
  const modal = page.getByRole('dialog', { name: 'Compare bundles', exact: true });
  await expect(modal.getByRole('table', { name: 'Match projects' })).toBeVisible();
  return modal;
}
async function openRealNavigationTabs(page: Page) {
  await page.getByRole('button', { name: 'Expand Original bundle', exact: true }).click();
  await page.locator('.project-row', { hasText: 'Dependency' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const outsideTab = editor.locator('.projects-container .project', { hasText: 'Dependency' });
  await expect(outsideTab).toHaveClass(/\bactive\b/);
  await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click();
  await page.locator('.project-row', { hasText: 'Main project' }).last().dblclick();
  await expect(outsideTab).not.toHaveClass(/\bactive\b/);
  return { editor, outsideTab };
}

test('matches both bundles, saves only Newer, and inspects removed graphs without restoring them', async ({ page }) => {
  const f = await fixture(page);
  const modal = await begin(page);
  await expect(modal).toContainText('No corresponding project (Suggested)');
  await expect(modal.getByRole('list')).toContainText('Added member — Added');
  await expect(modal.getByRole('row')).toHaveCount(4);
  expect(f.reads).toHaveLength(0);
  await modal.getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node.compare-changed')).toHaveCount(1);
  const tree = page.getByLabel('Compared bundles', { exact: true });
  await expect(tree.locator(':scope > details')).toHaveCount(2);
  await expect(tree.locator('[aria-current="true"]')).toHaveCount(2);
  await tree.getByRole('button', { name: 'Compare Older project Dependency' }).click();
  await expect(editor.locator('.node-body')).toContainText('Unchanged');
  await expect(editor.locator('.node.compare-changed')).toHaveCount(0);
  await tree.getByRole('button', { name: 'Compare Newer project Main project' }).click();
  await expect(editor.locator('.node.compare-changed')).toHaveCount(1);
  const title = editor.locator('.node[data-nodeid="text"] .node-title');
  const box = await title.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + 70, box!.y + 15);
  await page.mouse.down();
  await page.mouse.move(box!.x + 110, box!.y + 45, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.active-project-save-button')).toBeVisible();
  await title.click();
  await page.keyboard.press('Control+s');
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0]!.path).toBe(f.pathFor(f.newer, 'new-a'));
  expect(deserializeProject(f.saves[0]!.contents)[0].metadata.id).toBe('new-a');
  await expect(page.locator('.active-project-save-button')).toHaveCount(0);
  await editor.getByText('Removed Graph', { exact: true }).click();
  await expect(editor.locator('.node.compare-removed')).toHaveCount(1);
  await expect(editor.locator('[data-comparison-nodeid="deleted"]')).toContainText('Only in Older');
  await expect(page.locator('.active-project-save-button')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect.poll(() => f.saves.length).toBe(2);
  expect(deserializeProject(f.saves[1]!.contents)[0].graphs).not.toHaveProperty('removed');
  await editor.getByText('Alternative Graph', { exact: true }).click();
  await expect(editor.locator('.node[data-nodeid="alternative-text"]')).toBeVisible();
  await page.getByRole('button', { name: 'Exit comparison', exact: true }).click();
  await expect(editor.locator('.node[data-nodeid="alternative-text"]')).toBeVisible();
  await expect(editor.locator('.project-compare-notice')).toHaveCount(0);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  await tree.getByRole('button', { name: 'Compare Older project Removed member' }).click();
  await expect(editor.locator('.node.compare-removed')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Older-only comparison inspection is read-only.', { exact: false })).toBeVisible();
  expect(f.saves).toHaveLength(2);
  await page.getByRole('button', { name: 'Exit comparison', exact: true }).click();
  await expect(tree).toHaveCount(0);
  await expect(editor.locator('.project-compare-notice')).toHaveCount(0);
  await expect(editor.locator('.node[data-nodeid="text"] .node-body')).toContainText('Unchanged');
  expect(f.loads.filter((path) => path.includes('/Original/'))).toEqual([]);
});

test('collapsed comparison folders indicate the selected project after native tab navigation', async ({ page }) => {
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const tree = page.getByLabel('Compared bundles', { exact: true });
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await tree.getByRole('button', { name: 'Compare Newer project Dependency' }).click();
  const dependency = editor.locator('.projects-container .project', { hasText: 'Dependency' });
  await expect(dependency).toHaveClass(/\bactive\b/);
  await tree.getByRole('button', { name: 'Compare Newer project Main project' }).click();
  await expect(dependency).not.toHaveClass(/\bactive\b/);
  const folders = tree.locator('summary').filter({ hasText: /^Nested/ });
  await expect(folders).toHaveCount(2);
  for (const folder of await folders.all()) await folder.click();
  await dependency.locator('.project-name').click();
  await expect(dependency).toHaveClass(/\bactive\b/);
  for (const folder of await folders.all()) {
    await expect(folder.locator('..')).toHaveJSProperty('open', false);
    await expect(folder).toContainText('Contains selected project');
    await expect(folder).toHaveClass(/contains-selection/);
    await expect(folder).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.04)');
  }
  await folders.last().click();
  await expect(tree.getByRole('button', { name: 'Compare Newer project Dependency' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(f.saves).toHaveLength(0);
});

test('Refresh discards stale pair errors from the previously reviewed saved versions', async ({ page }) => {
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const tree = page.getByLabel('Compared bundles', { exact: true });
  const dependency = tree.getByRole('button', { name: 'Compare Newer project Dependency' });
  let failures = 0;
  await page.route('**/api/workflows/bundles/compare/pair', (route) => {
    const body = route.request().postDataJSON() as BundleComparisonPairRequest;
    if (body.older?.projectId === 'old-b' && body.older.revisionId === 'saved-old-b') {
      failures++;
      return route.fulfill({ status: 410, json: { error: 'The pinned saved revision has been collected.' } });
    }
    return route.fallback();
  });
  await dependency.click();
  await expect(dependency).toContainText('Unavailable');
  await expect(tree.getByRole('button', { name: 'Compare Newer project Main project' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await tree.getByRole('button', { name: 'Compare Newer project Main project' }).click();
  await expect(tree.getByRole('button', { name: 'Compare Newer project Main project' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(dependency).toContainText('Unavailable');
  f.older.projects.find((p) => p.projectId === 'old-b')!.revisionId = 'fresh-old-b';
  await page.getByRole('button', { name: 'Refresh older version', exact: true }).click();
  await expect(dependency).toContainText('Paired');
  await expect(dependency).not.toContainText('Unavailable');
  await dependency.click();
  await expect(dependency).toHaveAttribute('aria-current', 'true');
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('.node-body')).toContainText('Unchanged');
  expect(failures).toBe(1);
  expect(f.saves).toHaveLength(0);
});

test('a crowded matching modal keeps its actions reachable and Escape dismisses the menu before the modal', async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  for (let index = 0; index < 60; index++) {
    for (const [catalog, prefix] of [
      [f.older, 'old'],
      [f.newer, 'new'],
    ] as const) {
      catalog.projects.push({
        projectId: `${prefix}-extra-${index}`,
        name: `A lengthy project name to distinguish this member ${index}`,
        relativePath: `Nested/Extra ${index}.rivet-project`,
        revisionId: `saved-extra-${index}`,
        publishedRevisionId: null,
      });
    }
  }
  await page.setViewportSize({ width: 520, height: 650 });
  const modal = await begin(page);
  await expect(modal.locator('tbody tr')).toHaveCount(63);
  const mobileLabels = modal.locator('td .workflow-bundle-merge-mobile-column');
  await expect(mobileLabels.first()).toHaveText('Project in Original');
  await expect(mobileLabels.first()).toBeVisible();
  await expect(mobileLabels.nth(1)).toHaveText('Corresponding project in Working');
  await expect(mobileLabels.nth(1)).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Compare bundles', exact: true })).toBeInViewport();
  await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  expect(
    await modal.locator('.workflow-bundle-merge-content').evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Counterpart for Main project', exact: true }).click();
  const menuOption = page.getByText('No corresponding project', { exact: true });
  await expect(menuOption).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuOption).toHaveCount(0);
  await expect(modal).toBeVisible();
  await testInfo.attach('crowded-matching-modal', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand Working bundle', exact: true })).toBeFocused();
  expect(f.reads).toHaveLength(0);
  expect(f.loads).toHaveLength(0);
});

test('cancel and delayed Exit never activate a late comparison', async ({ page }) => {
  const f = await fixture(page);
  let modal = await begin(page);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(f.reads).toHaveLength(0);
  await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
  modal = await begin(page);
  f.block();
  await modal.getByRole('button', { name: 'Compare bundles', exact: true }).click();
  await expect.poll(() => f.reads.length).toBe(1);
  await page.getByRole('button', { name: 'Exit comparison', exact: true }).click();
  f.release();
  await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('.project-compare-notice')).toHaveCount(0);
  expect(f.loads).toHaveLength(0);
});

for (const navigation of ['native tab', 'library project'] as const) {
  test(`a ${navigation} switch while starting comparison cancels it and restores the normal library`, async ({
    page,
  }) => {
    const f = await fixture(page);
    const { editor, outsideTab } = await openRealNavigationTabs(page);
    f.block();
    try {
      await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
      await expect.poll(() => f.reads.length).toBe(1);
      if (navigation === 'native tab') await outsideTab.locator('.project-name').click();
      else await page.locator('.project-row', { hasText: 'Dependency' }).first().dblclick();
      await expect(outsideTab).toHaveClass(/\bactive\b/);
      await expect(page.getByRole('button', { name: 'Exit comparison', exact: true })).toHaveCount(0);
    } finally {
      f.release();
    }
    await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
    await expect(editor.locator('.project-compare-notice')).toHaveCount(0);
    expect(f.loads).toHaveLength(2);
    expect(f.saves).toHaveLength(0);
  });
}

for (const navigation of ['switch tab', 'close tab'] as const) {
  test(`a failed initial reference read does not trap the library after ${navigation}`, async ({ page }) => {
    const f = await fixture(page);
    const { editor, outsideTab } = await openRealNavigationTabs(page);
    let failures = 0;
    await page.route('**/api/workflows/bundles/compare/pair', (route) => {
      failures++;
      return route.fulfill({ status: 503, json: { error: 'Saved reference temporarily unavailable.' } });
    });
    await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Saved reference temporarily unavailable.' })).toBeVisible();
    await expect(page.getByLabel('Compared bundles', { exact: true })).toBeVisible();
    if (navigation === 'switch tab') await outsideTab.locator('.project-name').click();
    else {
      const active = editor.locator('.projects-container .project.active');
      await active.hover();
      await active.locator('.close-project').click();
    }
    await expect(outsideTab).toHaveClass(/\bactive\b/);
    await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exit comparison', exact: true })).toHaveCount(0);
    expect(failures).toBe(1);
    expect(f.loads).toHaveLength(2);
    expect(f.saves).toHaveLength(0);
  });
}

test('a failed pair read keeps the displayed Older-only inspection selected and owned', async ({ page }) => {
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const tree = page.getByLabel('Compared bundles', { exact: true });
  const removed = tree.getByRole('button', { name: 'Compare Older project Removed member' });
  await removed.click();
  await expect(removed).toHaveAttribute('aria-current', 'true');
  let failures = 0;
  await page.route('**/api/workflows/bundles/compare/pair', (route) => {
    failures++;
    return route.fulfill({ status: 503, json: { error: 'Saved reference temporarily unavailable.' } });
  });
  await tree.getByRole('button', { name: 'Compare Newer project Main project' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Saved reference temporarily unavailable.' })).toBeVisible();
  await expect(removed).toHaveAttribute('aria-current', 'true');
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node.compare-removed')).toHaveCount(1);
  await editor.locator('.project-compare-notice').getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(tree).toHaveCount(0);
  await expect(editor.locator('.projects-container .project', { hasText: 'Older only' })).toHaveCount(0);
  expect(failures).toBe(1);
  expect(f.saves).toHaveLength(0);
});

test('opening project matching cancels an in-flight toolbar Swap without changing the confirmed roles', async ({
  page,
}) => {
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  await expect(page.getByLabel('Compared bundles', { exact: true })).toBeVisible();
  let requested = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workflows/bundles/compare/manifest', async (route) => {
    if (route.request().postDataJSON().olderId !== newerId) return route.fallback();
    requested = true;
    await gate;
    await route.fulfill({ json: { older: f.newer, newer: f.older, capturedAt: '2026-11-12T00:00:00Z' } });
  });
  const cancelled = page
    .waitForEvent('requestfailed', {
      predicate: (request) => request.url().endsWith('/compare/manifest') && request.postDataJSON().olderId === newerId,
      timeout: 10_000,
    })
    .then(
      () => true,
      () => false,
    );
  try {
    await page.getByRole('button', { name: 'Swap', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.getByRole('button', { name: 'Match projects', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Compare bundles', exact: true });
    await expect(modal.getByRole('table', { name: 'Match projects' })).toBeVisible();
    release();
    expect(await cancelled).toBe(true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    release();
  }
  await expect(page.locator('.bundle-comparison-title')).toHaveText(
    'Original (Older, saved) → Working (Newer, editable)',
  );
  expect(f.loads).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
});

test('manual correspondence survives modal Swap and cancelling its draft leaves the editor unchanged', async ({
  page,
}) => {
  const f = await fixture(page);
  const modal = await begin(page);
  await select(page, 'Counterpart for Dependency', 'No corresponding project');
  await select(page, 'Counterpart for Main project', 'Dependency — Nested/Dependency');
  await select(page, 'Counterpart for Dependency', 'Main project — Main');
  await modal.getByRole('button', { name: 'Swap', exact: true }).click();
  const row = modal
    .getByRole('row')
    .filter({ has: page.getByRole('combobox', { name: 'Counterpart for Main project', exact: true }) });
  await expect(row).toContainText('Dependency — Nested/Dependency');
  await expect(row).not.toContainText('.rivet-project');
  await modal.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(
    modal
      .getByRole('row')
      .filter({ has: page.getByRole('combobox', { name: 'Counterpart for Main project', exact: true }) }),
  ).toContainText('Dependency — Nested/Dependency');
  await page.setViewportSize({ width: 700, height: 650 });
  await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(f.loads).toHaveLength(0);
  expect(f.reads).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Expand Working bundle', exact: true })).toBeFocused();
});

test('Swap and Refresh preserve unsaved real tabs, use saved Older versions, and inner Exit restores the library', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click();
  await page.locator('.project-row', { hasText: 'Main project' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const title = editor.locator('.node[data-nodeid="text"] .node-title');
  await expect(title).toBeVisible();
  const box = await title.boundingBox();
  await page.mouse.move(box!.x + 70, box!.y + 15);
  await page.mouse.down();
  await page.mouse.move(box!.x + 120, box!.y + 35, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.active-project-save-button')).toBeVisible();
  const currentTransform = () =>
    editor.locator('.node[data-nodeid="text"]').evaluate((node: HTMLElement) => node.style.transform);
  const dirtyPosition = await currentTransform();
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  await expect.poll(currentTransform).toBe(dirtyPosition);
  await expect(page.locator('.active-project-save-button')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh older version', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh older version', exact: true })).toBeEnabled();
  await expect.poll(currentTransform).toBe(dirtyPosition);
  expect(f.loads.filter((p) => p.includes('/Working/Main'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(page.locator('.bundle-comparison-title')).toHaveText(
    'Working (Older, saved) → Original (Newer, editable)',
  );
  await expect(editor.locator('.node[data-nodeid="text"] .node-body')).toContainText('Before');
  await expect(page.getByLabel('Compared bundles', { exact: true })).toContainText('Unsaved edits excluded');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(page.locator('.bundle-comparison-title')).toHaveText(
    'Original (Older, saved) → Working (Newer, editable)',
  );
  await expect.poll(currentTransform).toBe(dirtyPosition);
  await expect(page.locator('.active-project-save-button')).toBeVisible();
  const before = await title.boundingBox();
  await title.click();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await title.boundingBox())?.x).not.toBe(before!.x);
  await page.keyboard.press('Control+y');
  await expect.poll(currentTransform).toBe(dirtyPosition);
  await editor.locator('.project-compare-notice').getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Expand|Collapse) Working bundle$/ })).toBeVisible();
  await expect(page.locator('.active-project-save-button')).toBeVisible();
  expect(f.saves).toHaveLength(0);
});

test('Newer-only editing works and reloading an Older-only inspection recovers real tabs only', async ({ page }) => {
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const tree = page.getByLabel('Compared bundles', { exact: true });
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await tree.getByRole('button', { name: 'Compare Newer project Added member' }).click();
  await expect(editor.locator('.node.compare-added')).toHaveCount(1);
  await editor.locator('.node[data-nodeid="text"] .node-title').click();
  await page.keyboard.press('Control+s');
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0]!.path).toBe(f.pathFor(f.newer, 'new-only'));
  await tree.getByRole('button', { name: 'Compare Older project Removed member' }).click();
  await expect(editor.locator('.node.compare-removed')).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'Run project', exact: true })).toHaveCount(0);
  await page.reload();
  await waitForDashboardReady(page);
  await expect(tree).toHaveCount(0);
  await expect(editor.getByRole('button', { name: /Older only/ })).toHaveCount(0);
  await expect(editor.locator('.project-compare-notice')).toHaveCount(0);
  await expect(editor.locator('.node-canvas')).toBeVisible();
  expect(f.saves).toHaveLength(1);
});

test('an Older-only tab stays non-runnable when its post-Exit cleanup message is lost', async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener(
      'message',
      (event) => {
        if (
          document.body?.dataset.dropComparisonCleanup === 'true' &&
          event.source === window.parent &&
          event.data?.type === 'bundle-comparison' &&
          event.data.action === 'stop'
        ) {
          event.stopImmediatePropagation();
          document.body.dataset.comparisonCleanupBlocked = 'true';
        }
      },
      { capture: true },
    );
  });
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  await page
    .getByLabel('Compared bundles', { exact: true })
    .getByRole('button', { name: 'Compare Older project Removed member' })
    .click();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node.compare-removed')).toHaveCount(1);
  await editor.locator('body').evaluate((body) => {
    body.dataset.dropComparisonCleanup = 'true';
  });
  await editor.locator('.project-compare-notice').getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(editor.locator('body')).toHaveAttribute('data-comparison-cleanup-blocked', 'true');
  await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
  const inspection = editor.locator('.projects-container .project', { hasText: 'Older only' });
  await expect(inspection).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'Run project', exact: true })).toHaveCount(0, { timeout: 3_000 });
  await editor.locator('.node-canvas').click({ position: { x: 600, y: 500 } });
  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Older-only comparison inspection is read-only.', { exact: false })).toBeVisible();
  expect(f.saves).toHaveLength(0);
  await inspection.hover();
  await inspection.locator('.close-project').click();
  await expect(inspection).toHaveCount(0);
});

test('Older ghost Subgraphs use captured Published definitions instead of latest or Newer definitions', async ({
  page,
}) => {
  const f = await fixture(page);
  const source = deserializeProject(f.snapshots.get('old-a')!)[0];
  source.graphs.main!.nodes.push({
    id: 'published-call',
    type: 'subGraph',
    title: 'Published call',
    data: { graphId: 'main', targetProjectId: 'old-b', targetVersion: 'published' },
    visualData: { x: 800, y: 220, width: 260 },
  } as never);
  f.snapshots.set('old-a', serializeProject(source) as string);
  const member = f.older.projects.find((p) => p.projectId === 'old-b')!;
  member.publishedRevisionId = 'published-old-b';
  const published = deserializeProject(f.snapshots.get('old-b')!)[0];
  published.graphs.main!.metadata!.name = 'Pinned published graph';
  published.graphs.main!.nodes = [
    {
      id: 'boundary',
      type: 'graphInput',
      title: 'Input',
      data: { id: 'published-input', dataType: 'string' },
      visualData: { x: 0, y: 0 },
    },
  ] as never;
  f.snapshots.set('old-b:published-old-b', serializeProject(published) as string);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const ghost = page.frameLocator('iframe.dashboard-editor-frame').locator('[data-comparison-nodeid="published-call"]');
  await expect(ghost).toContainText('Pinned published graph');
  await expect(ghost).toContainText('published-input');
  expect(f.reads.filter((r) => r.older?.projectId === 'old-b').map((r) => r.older?.revisionId)).toEqual([
    'published-old-b',
  ]);
  expect(f.loads.some((p) => p.includes('/Original/'))).toBe(false);
});

test('Subgraph navigation and PgUp/PgDn keep comparison attached to the actual real project', async ({ page }) => {
  const f = await fixture(page);
  for (const [ownerId, targetId] of [
    ['old-a', 'old-b'],
    ['new-a', 'new-b'],
  ]) {
    const project = deserializeProject(f.snapshots.get(ownerId!)!)[0];
    project.graphs.main!.nodes.push({
      id: 'go-to-dependency',
      type: 'subGraph',
      title: 'Call dependency',
      data: { graphId: 'main', targetProjectId: targetId, targetVersion: 'latest' },
      visualData: { x: 760, y: 250, width: 260 },
    } as never);
    f.snapshots.set(ownerId!, serializeProject(project) as string);
  }
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor
    .locator('.node[data-nodeid="go-to-dependency"]')
    .getByRole('button', { name: 'Go to subgraph', exact: true })
    .click();
  await expect(editor.locator('.node-body')).toContainText('Unchanged');
  const tree = page.getByLabel('Compared bundles', { exact: true });
  await expect(tree.getByRole('button', { name: 'Compare Newer project Dependency' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await editor.locator('.node[data-nodeid="text"] .node-title').click();
  await page.keyboard.press('PageUp');
  await expect(editor.locator('.node[data-nodeid="go-to-dependency"]')).toBeVisible();
  await expect(tree.getByRole('button', { name: 'Compare Newer project Main project' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await page.keyboard.press('PageDown');
  await expect(editor.locator('.node-body')).toContainText('Unchanged');
  await expect(tree.getByRole('button', { name: 'Compare Newer project Dependency' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(f.loads.filter((p) => p.includes('/Original/'))).toHaveLength(0);
});

test('a failed post-activation membership check stays located and does not automatically reopen the failed pair', async ({
  page,
}) => {
  const f = await fixture(page);
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const tree = page.getByLabel('Compared bundles', { exact: true });
  await expect(tree.locator('[aria-current="true"]')).toHaveCount(2);
  let failures = 0;
  await page.route('**/api/workflows/bundles/compare/pair', (route) => {
    const body = route.request().postDataJSON() as BundleComparisonPairRequest;
    if (body.older === null && body.newer?.projectId === 'new-b') {
      failures++;
      return route.fulfill({ status: 409, json: { error: 'Dependency moved. Review project matching.' } });
    }
    return route.fallback();
  });
  await tree.getByRole('button', { name: 'Compare Newer project Dependency' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Dependency moved. Review project matching.' })).toBeVisible();
  await expect(tree.locator('[aria-current="true"]')).toHaveCount(0);
  await expect(tree.getByRole('button', { name: 'Compare Newer project Dependency' })).toContainText('Unavailable');
  await tree.getByRole('button', { name: 'Compare Newer project Main project' }).click();
  await expect(tree.getByRole('button', { name: 'Compare Newer project Main project' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(failures).toBe(1);
  expect(f.saves).toHaveLength(0);
});

test('empty bundles show two empty roots without opening an arbitrary project', async ({ page }) => {
  const f = await fixture(page);
  f.older.projects = [];
  f.newer.projects = [];
  await (await begin(page)).getByRole('button', { name: 'Compare bundles', exact: true }).click();
  const tree = page.getByLabel('Compared bundles', { exact: true });
  await expect(tree.locator(':scope > details')).toHaveCount(2);
  await expect(tree.getByText('No projects', { exact: true })).toHaveCount(2);
  expect(f.loads).toHaveLength(0);
  expect(f.reads).toHaveLength(0);
  await page.getByRole('button', { name: 'Exit comparison', exact: true }).click();
  await expect(tree).toHaveCount(0);
});

for (const hasRealTab of [true, false]) {
  test(`an empty reviewed comparison settles an Older-only inspection ${hasRealTab ? 'with' : 'without'} a real return tab`, async ({
    page,
  }) => {
    const f = await fixture(page);
    const setup = await begin(page);
    if (!hasRealTab) await select(page, 'Counterpart for Main project', 'No corresponding project');
    await setup.getByRole('button', { name: 'Compare bundles', exact: true }).click();
    const tree = page.getByLabel('Compared bundles', { exact: true });
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    if (hasRealTab) await tree.getByRole('button', { name: 'Compare Older project Removed member' }).click();
    await expect(editor.locator('.node.compare-removed')).toHaveCount(1);
    f.older.projects = [];
    f.newer.projects = [];
    await page.getByRole('button', { name: 'Match projects', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Compare bundles', exact: true });
    await expect(modal).toContainText('No projects in the Older bundle.');
    await modal.getByRole('button', { name: 'Compare bundles', exact: true }).click();
    await expect(tree.getByText('No projects', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Refresh older version', exact: true })).toBeEnabled();
    await expect(editor.locator('.project-compare-notice')).toHaveCount(0);
    await expect(editor.locator('.projects-container .project', { hasText: 'Older only' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Exit comparison', exact: true }).click();
    await expect(tree).toHaveCount(0);
    expect(f.loads).toHaveLength(hasRealTab ? 1 : 0);
    expect(f.saves).toHaveLength(0);
  });
}

test('older APIs keep normal bundle actions and hide unsupported comparison', async ({ page }) => {
  const f = await fixture(page, false);
  await page.getByRole('button', { name: /^(Expand|Collapse) Working bundle$/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Download bundle', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Compare with another bundle…', exact: true })).toHaveCount(0);
  expect(f.reads).toHaveLength(0);
});

for (const phase of ['active', 'pending'] as const) {
  test(`reloading only the editor ends a ${phase} comparison without replaying its selection`, async ({ page }) => {
    const f = await fixture(page);
    const modal = await begin(page);
    if (phase === 'pending') f.block();
    await modal.getByRole('button', { name: 'Compare bundles', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit comparison', exact: true })).toBeVisible();
    if (phase === 'active') await expect(page.getByLabel('Compared bundles', { exact: true })).toBeVisible();
    else await expect.poll(() => f.reads.length).toBe(1);
    const beforeLoads = f.loads.length;
    try {
      await page
        .locator('iframe.dashboard-editor-frame')
        .evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow!.location.reload());
      await expect(page.getByRole('button', { name: 'Exit comparison', exact: true })).toHaveCount(0);
    } finally {
      f.release();
    }
    await expect(page.getByLabel('Compared bundles', { exact: true })).toHaveCount(0);
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    await expect(editor.locator('.project-compare-notice')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) Working bundle$/ })).toBeVisible();
    expect(f.loads.length).toBe(beforeLoads);
  });
}
