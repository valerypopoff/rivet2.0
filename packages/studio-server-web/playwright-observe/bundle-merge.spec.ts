import { test, expect, type Locator, type Page } from '@playwright/test';
import type {
  BundleMergeChoices,
  BundleMergePreview,
  BundleMergeResult,
} from '../../studio-server-shared/workflow-bundle-types';
import type { WorkflowFolderItem } from '../dashboard/types';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.use({ actionTimeout: 10_000 });

const sourceId = '9f686d79-e2e5-469b-b416-655bd2965794';
const destinationId = 'dc009ab3-a5fb-4692-af49-fda35fa8f876';
const sourceNamespace = '9f686d79-e2e5-469b-b416-655bd2965795';
const destinationNamespace = 'dc009ab3-a5fb-4692-af49-fda35fa8f877';
const sourceProjects = [
  { projectId: 'a1', title: 'A1', relativePath: 'A.rivet-project' },
  { projectId: 'b1', title: 'B1', relativePath: 'B.rivet-project' },
  { projectId: 'c1', title: 'C1', relativePath: 'C.rivet-project' },
  { projectId: 'x1', title: 'X', relativePath: 'X.rivet-project' },
  { projectId: 'unused1', title: 'Unrelated', relativePath: 'Unused.rivet-project' },
];
const targetProjects = ['A', 'B', 'X'].map((title) => ({
  projectId: title.toLowerCase(),
  title,
  relativePath: `${title}.rivet-project`,
}));
const source = {
  bundleId: sourceId,
  namespaceId: sourceNamespace,
  name: 'Working',
  relativePath: 'Working',
  projects: sourceProjects,
};
const destination = {
  bundleId: destinationId,
  namespaceId: destinationNamespace,
  name: 'Original',
  relativePath: 'Original',
  projects: targetProjects,
};

function preview(choices: BundleMergeChoices): BundleMergePreview {
  const needed =
    choices.actions.some((action) => action.sourceProjectId === 'a1' || action.sourceProjectId === 'b1') &&
    !choices.actions.some((action) => action.sourceProjectId === 'x1');
  const ready =
    choices.actions.length > 0 && (!needed || choices.dependencies.some((value) => value.sourceProjectId === 'x1'));
  const addedDependency = needed
    ? choices.dependencies.find((choice) => choice.sourceProjectId === 'x1' && choice.kind === 'add')
    : undefined;
  const actions = [
    ...choices.actions,
    ...(addedDependency?.kind === 'add' ? [{ ...addedDependency, kind: 'add' as const }] : []),
  ];
  return {
    source,
    destination,
    actions,
    requiredProjects: needed
      ? [
          {
            project: sourceProjects[3]!,
            sites: [{ projectId: 'a1', projectTitle: 'A1', graphName: 'Main', nodeId: 'call-x', active: true }],
          },
        ]
      : [],
    requiredGraphs: [],
    mappedGraphs: [],
    suggestions: [
      { sourceProjectId: 'a1', state: 'changed', targetProjectId: 'a' },
      { sourceProjectId: 'b1', state: 'changed', targetProjectId: 'b' },
      { sourceProjectId: 'c1', state: 'new' },
      { sourceProjectId: 'x1', state: 'unchanged', targetProjectId: 'x' },
      { sourceProjectId: 'unused1', state: 'unchanged' },
    ],
    blockers: [],
    warnings: [],
    rewrites: choices.actions.length,
    versionChanges: 0,
    datasets: ready ? actions.map((action) => ({ sourceProjectId: action.sourceProjectId, count: 0 })) : [],
    ...(ready ? { fingerprint: String(choices.actions.length).repeat(64) } : {}),
  };
}
const folder = (catalog: typeof source): WorkflowFolderItem => ({
  id: catalog.relativePath,
  namespaceId: catalog.namespaceId,
  bundleId: catalog.bundleId,
  name: catalog.name,
  relativePath: catalog.relativePath,
  absolutePath: `/managed/workflows/${catalog.relativePath}`,
  updatedAt: '',
  folders: [],
  projects: catalog.projects.map((project) => ({
    id: project.projectId,
    projectMetadataId: project.projectId,
    namespaceProtocol: 1,
    revisionId: 'old-' + project.projectId,
    name: project.title,
    fileName: project.relativePath,
    relativePath: `${catalog.relativePath}/${project.relativePath}`,
    absolutePath: `/managed/workflows/${catalog.relativePath}/${project.relativePath}`,
    updatedAt: '',
    bundleId: catalog.bundleId,
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  })),
});

async function openLibrary(page: Page, mergeEnabled = true) {
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/managed/workflows',
        capabilities: { explicitBundles: true, namespaceMutations: true, bundleMerge: mergeEnabled },
        folders: [folder(source), folder(destination)],
        projects: [],
      },
    }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
}
async function openMerge(page: Page) {
  await openLibrary(page);
  await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true }).click();
  await select(page, 'Destination bundle', 'Original — Original');
  return page.getByRole('dialog', { name: 'Merge bundle', exact: true });
}
async function select(page: Page, label: string | RegExp, option: string, section?: string) {
  const modal = page.getByRole('dialog', { name: 'Merge bundle', exact: true });
  const scope = section ? modal.getByRole('region', { name: section, exact: true }) : modal;
  await scope.getByRole('combobox', { name: label }).click();
  // This Atlaskit version renders option text without an ARIA option role.
  // The portal follows the selected-value text in document order.
  const choice = page.getByText(option, { exact: true }).last();
  await expect(choice).toBeVisible();
  await choice.click();
}

async function expectModalInsets(modal: Locator) {
  // Read one layout snapshot: the centered dialog can move between browser RPCs.
  const { bounds, close, title, field, cancel } = await modal.evaluate((element) => {
    const rect = (target: Element | null | undefined) => {
      if (!target) throw new Error('A bundle merge layout element is missing.');
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      bounds: rect(element),
      close: rect(element.querySelector('.project-settings-close-button')),
      title: rect(element.querySelector('.project-settings-modal-title')),
      field: rect(element.querySelector('label[for="bundle-merge-destination"]')),
      cancel: rect([...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel')),
    };
  });
  expect(Math.abs(close.x + close.width - bounds.x - bounds.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(close.y - bounds.y)).toBeLessThanOrEqual(2);
  expect(title.x - bounds.x).toBeGreaterThanOrEqual(17);
  expect(title.x - bounds.x).toBeLessThanOrEqual(20);
  expect(Math.abs(title.x - field.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(title.x - cancel.x)).toBeLessThanOrEqual(1);
}

async function captureTreeWrites(page: Page) {
  const writes: string[] = [];
  await page.route(
    (url) => /\/workflows\/(?:namespace\/mutate|move|bundles\/[^/]+\/merge)$/.test(url.pathname),
    (route) => {
      writes.push(route.request().url());
      return route.fulfill({ status: 409, json: { error: 'Opening a merge review must not write to the library.' } });
    },
  );
  return writes;
}

test('bundle drag feedback uses the menu merge icon only over a merge target and clears on cancellation', async ({
  page,
}, testInfo) => {
  const writes = await captureTreeWrites(page);
  await openLibrary(page);
  const sourceRow = page.getByRole('button', { name: 'Expand Working bundle', exact: true });
  const targetRow = page.getByRole('button', { name: 'Expand Original bundle', exact: true });
  await expect(sourceRow).toHaveAttribute('draggable', 'true');
  await sourceRow.click({ button: 'right' });
  const menuIcon = await page
    .getByRole('menuitem', { name: 'Merge into another bundle…', exact: true })
    .locator('svg')
    .innerHTML();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'drag-editor-surface';
    frame.srcdoc = '<body>Editor surface</body>';
    frame.style.cssText = 'position: fixed; left: 400px; top: 200px; width: 300px; height: 200px; z-index: 100;';
    document.body.append(frame);
  });
  await expect(page.frameLocator('#drag-editor-surface').getByText('Editor surface')).toBeVisible();
  const start = (await sourceRow.boundingBox())!;
  const target = (await targetRow.boundingBox())!;
  const point = { x: target.x + 100, y: target.y + target.height / 2 };
  await page.mouse.move(start.x + 100, start.y + start.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(start.x + 120, start.y + start.height / 2, { steps: 4 });
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.move(point.x + 1, point.y);
    const feedback = page.getByTestId('workflow-bundle-drag-preview');
    const icon = page.getByTestId('bundle-merge-drag-icon');
    await expect(icon).toBeVisible();
    expect(await icon.innerHTML()).toBe(menuIcon);
    await expect(feedback).toHaveCSS('pointer-events', 'none');
    const bounds = (await feedback.boundingBox())!;
    expect(Math.abs(bounds.x - (point.x + 13))).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.y - (point.y + 16))).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath('bundle-merge-drag-preview.png') });
    await page.mouse.move(500, point.y, { steps: 5 });
    await page.mouse.move(501, point.y);
    await expect(icon).toHaveCount(0);
    await expect(feedback).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('bundle-drag-over-editor.png') });
    await page.mouse.move(point.x + 1, point.y, { steps: 5 });
    await page.mouse.move(point.x + 2, point.y);
    await expect(icon).toBeVisible();
  } finally {
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await expect(page.getByTestId('workflow-bundle-drag-preview')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Merge bundle', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('dragging one bundle onto another opens its merge review without moving or committing', async ({ page }) => {
  const writes = await captureTreeWrites(page);
  const reviews: BundleMergeChoices[] = [];
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    const choices: BundleMergeChoices = route.request().postDataJSON();
    reviews.push(choices);
    return route.fulfill({ json: preview(choices) });
  });
  await openLibrary(page);
  const sourceRow = page.getByRole('button', { name: /(?:Expand|Collapse) Working bundle/, exact: true });
  const targetRow = page.getByRole('button', { name: /(?:Expand|Collapse) Original bundle/, exact: true });
  await expect(sourceRow).toHaveAttribute('draggable', 'true');
  await sourceRow.dragTo(targetRow);
  const modal = page.getByRole('dialog', { name: 'Merge bundle', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Original — Original', { exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeEnabled();
  expect(reviews.length).toBeGreaterThan(0);
  expect(reviews.every((choices) => choices.destinationBundleId === destinationId)).toBe(true);
  expect(writes).toEqual([]);
  await expect(page.locator('.folder-row.dragging, .folder-row.drag-over')).toHaveCount(0);
  await expect(page.getByTestId('workflow-bundle-drag-preview')).toHaveCount(0);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(targetRow).toBeFocused();
  await sourceRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true }).click();
  await expect(modal.getByText('Choose a bundle…', { exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

for (const scenario of ['same bundle', 'unsupported server'] as const) {
  test(`bundle drop rejects ${scenario} without nesting or opening a merge`, async ({ page }) => {
    const writes = await captureTreeWrites(page);
    let reviews = 0;
    await page.route('**/api/workflows/bundles/*/merge/preview*', (route) => {
      reviews++;
      return route.fulfill({ json: preview(route.request().postDataJSON()) });
    });
    await openLibrary(page, scenario !== 'unsupported server');
    const sourceRow = page.getByRole('button', { name: 'Expand Working bundle', exact: true });
    const targetRow =
      scenario === 'same bundle'
        ? sourceRow
        : page.getByRole('button', { name: 'Expand Original bundle', exact: true });
    await expect(sourceRow).toHaveAttribute('draggable', 'true');
    await sourceRow.dragTo(targetRow, { sourcePosition: { x: 40, y: 10 }, targetPosition: { x: 100, y: 15 } });
    await expect(page.locator('.folder-row.dragging')).toHaveCount(0);
    await expect(page.getByTestId('workflow-bundle-drag-preview')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Merge bundle', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(reviews).toBe(0);
  });
}

for (const outcome of ['success', 'recovered with failed refresh'] as const) {
  test(`bundle merge only maps needed references and submits once (${outcome})`, async ({ page }, testInfo) => {
    let committed = false,
      submissions = 0,
      receiptReads = 0;
    let result: BundleMergeResult;
    await page.route('**/api/workflows/tree', (route) =>
      committed && outcome !== 'success'
        ? route.fulfill({ status: 503, json: { error: 'Tree unavailable' } })
        : route.fulfill({
            json: {
              root: '/managed/workflows',
              capabilities: { explicitBundles: true, namespaceMutations: true, bundleMerge: true },
              folders: [folder(source), folder(destination)],
              projects: [],
            },
          }),
    );
    await page.route(`**/api/workflows/bundles/${sourceId}/merge/preview*`, (route) =>
      route.fulfill({ json: preview(route.request().postDataJSON()) }),
    );
    await page.route(`**/api/workflows/bundles/${sourceId}/merge`, async (route) => {
      submissions++;
      const request = route.request().postDataJSON();
      expect(request.choices.actions).toHaveLength(3);
      expect(request.choices.dependencies).toEqual([{ sourceProjectId: 'x1', kind: 'existing', targetProjectId: 'x' }]);
      expect(request.mutation.expectedSource.id).toBe(sourceNamespace);
      expect(request.mutation.expectedDestinationId).toBe(destinationNamespace);
      expect(route.request().headers()['x-rivet-bundle-intent']).toBe('1');
      result = {
        operationId: request.mutation.operationId,
        folder: folder(destination),
        projectMapping: { a1: 'a', b1: 'b', x1: 'x', c1: 'new-c' },
        projects: [
          { projectId: 'a', path: '/managed/workflows/Original/A.rivet-project', revisionId: 'new-a', added: false },
        ],
        warnings: [],
      };
      committed = true;
      return outcome === 'success' ? route.fulfill({ json: result }) : route.abort('failed');
    });
    await page.route('**/api/workflows/namespace/receipt', (route) => {
      receiptReads++;
      return route.fulfill({ json: { state: 'committed', result } });
    });
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Merge bundle', exact: true });
    await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeDisabled();
    await expectModalInsets(modal);
    await select(page, 'Destination bundle', 'Original — Original');
    await select(page, /^A1/, 'Replace A');
    await expect(modal.getByRole('heading', { name: 'Match referenced projects' })).toBeVisible();
    await expect(modal.getByRole('combobox', { name: /^X/ })).toHaveCount(1); // The unchanged dependency appears only in the mapping section.
    await select(page, /^B1/, 'Replace B');
    await select(page, /^C1/, 'Add as a new project');
    await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeEnabled();
    await expect(modal.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
    await expect(modal.getByText(/1 kept counterpart/)).toBeVisible();
    await modal.getByText('Referenced in 1 place', { exact: true }).click();
    await expect(modal.getByText('Working/A / Main / (call-x)', { exact: true })).toBeVisible();
    if (outcome === 'success') {
      await page.setViewportSize({ width: 1280, height: 900 });
      await modal.getByRole('heading', { name: 'Choose project changes', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('bundle-merge-projects-desktop.png') });
    }
    await expect(page.getByTestId('workflow-bundle-merge-modal--blanket')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0.56)',
    );
    await expect(modal).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await page.setViewportSize({ width: 620, height: 560 });
    await expectModalInsets(modal);
    await select(page, /^B1/, 'Replace B');
    const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
    await expect(submit).toBeEnabled();
    const bounds = await submit.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
    if (outcome === 'success') {
      await modal.getByRole('heading', { name: 'Review changes', exact: true }).scrollIntoViewIfNeeded();
      await expect(modal.getByText('Merge bundle', { exact: true })).toBeInViewport();
      expect((await submit.boundingBox())!.y).toBeCloseTo(bounds!.y, 0);
      await page.screenshot({ path: testInfo.outputPath('bundle-merge-review.png') });
    }
    await submit.dblclick();
    await expect(modal).toHaveCount(0);
    expect(submissions).toBe(1);
    expect(receiptReads).toBe(outcome === 'success' ? 0 : 1);
    if (outcome !== 'success')
      await expect(page.getByText(/Merge completed, but the project list could not refresh/)).toBeVisible();
  });
}

test('an obsolete preview cannot enable merging after project selection changes', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/managed/workflows',
        capabilities: { explicitBundles: true, namespaceMutations: true, bundleMerge: true },
        folders: [folder(source), folder(destination)],
        projects: [],
      },
    }),
  );
  await page.route(`**/api/workflows/bundles/${sourceId}/merge/preview*`, async (route) => {
    const choices: BundleMergeChoices = route.request().postDataJSON();
    const path = choices.actions.find((action) => action.kind === 'add');
    if (path?.kind === 'add' && path.relativePath === 'Old/Chosen.rivet-project') {
      waiting = true;
      await held;
    }
    const value = preview(choices);
    if (path?.kind === 'add' && path.relativePath === 'Blocked/Chosen.rivet-project') {
      delete value.fingerprint;
      value.blockers = [{ id: 'blocked', message: 'The current selection is blocked.' }];
    }
    return route.fulfill({ json: value });
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true }).click();
  await select(page, 'Destination bundle', 'Original — Original');
  const modal = page.getByRole('dialog', { name: 'Merge bundle', exact: true });
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  await expect(submit).toBeEnabled();
  const path = modal.getByRole('textbox', { name: 'Project name for C1', exact: true });
  await path.fill('Old/Chosen');
  await expect.poll(() => waiting).toBe(true);
  await path.fill('Blocked/Chosen');
  await expect(modal.getByRole('alert')).toContainText('The current selection is blocked.');
  release();
  await expect(submit).toBeDisabled();
  await path.fill('Valid/Chosen');
  await expect(submit).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand Working bundle', exact: true })).toBeFocused();
});

test('required graph correspondence and warning acknowledgement gate the current review', async ({ page }) => {
  let latestChoices: BundleMergeChoices | undefined;
  await page.route(`**/api/workflows/bundles/${sourceId}/merge/preview*`, (route) => {
    const choices: BundleMergeChoices = route.request().postDataJSON();
    latestChoices = choices;
    const value = preview(choices);
    if (choices.dependencies.some((choice) => choice.kind === 'existing')) {
      const graph = {
        sourceProjectId: 'x1',
        sourceGraphId: 'child-main',
        sourceGraphName: 'Child',
        targetProjectId: 'x',
        options: [
          { id: 'other-child', name: 'Child' },
          { id: 'sibling', name: 'Sibling' },
        ],
        sites: [],
      };
      if (!choices.graphs.length) {
        delete value.fingerprint;
        value.requiredGraphs = [graph];
      } else value.mappedGraphs = [{ ...graph, selectedGraphId: choices.graphs[0]!.targetGraphId }];
    }
    value.warnings = [{ id: 'a'.repeat(64), message: 'An existing caller needs review.' }];
    return route.fulfill({ json: value });
  });
  const modal = await openMerge(page);
  await select(page, /^A1/, 'Replace A');
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  await expect(submit).toBeDisabled();
  await select(page, /Graph match for X/, 'Child');
  await expect(modal.getByRole('combobox', { name: /Graph match for X/ })).toBeVisible();
  await expect(submit).toBeDisabled();
  await modal.getByRole('checkbox', { name: 'An existing caller needs review.' }).check();
  await expect(submit).toBeEnabled();
  await select(page, /Graph match for X/, 'Sibling');
  await expect(submit).toBeDisabled();
  await expect(modal.getByRole('checkbox', { name: 'An existing caller needs review.' })).not.toBeChecked();
  await modal.getByRole('checkbox', { name: 'An existing caller needs review.' }).check();
  await expect(submit).toBeEnabled();
  await expect(modal.getByText('Sibling', { exact: true })).toBeVisible();
  await expect(modal.getByRole('combobox', { name: /Graph match for X/ })).toBeVisible();
  await select(page, /^X/, 'Add as a new project', 'Required project references');
  await expect.poll(() => latestChoices?.graphs.length).toBe(0);
  await expect(modal.getByRole('combobox', { name: /Graph match for X/ })).toHaveCount(0);
  await select(page, /^X/, 'Use existing X', 'Required project references');
  await expect(modal.getByRole('combobox', { name: /Graph match for X/ })).toBeVisible();
  await expect.poll(() => latestChoices?.graphs.length).toBe(0);
  await expect(submit).toBeDisabled();
  await select(page, /Graph match for X/, 'Child');
  await modal.getByRole('checkbox', { name: 'An existing caller needs review.' }).check();
  await expect(submit).toBeEnabled();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('an unconfirmed merge acknowledgement remains explicit and cannot be submitted twice', async ({ page }) => {
  let submissions = 0,
    reads = 0;
  await page.route(`**/api/workflows/bundles/${sourceId}/merge/preview*`, (route) =>
    route.fulfill({ json: preview(route.request().postDataJSON()) }),
  );
  await page.route(`**/api/workflows/bundles/${sourceId}/merge`, (route) => {
    submissions++;
    return route.abort('failed');
  });
  await page.route('**/api/workflows/namespace/receipt', (route) => {
    reads++;
    return route.fulfill({ json: { state: 'unknown' } });
  });
  const modal = await openMerge(page);
  await select(page, /^C1/, 'Add as a new project');
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal.getByRole('alert')).toContainText('outcome is unknown');
  await expect(submit).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Refresh review' })).toBeDisabled();
  expect(submissions).toBe(1);
  expect(reads).toBe(1);
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
});

test('an older managed API keeps existing bundle actions without advertising unsupported merging', async ({ page }) => {
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/managed/workflows',
        capabilities: { explicitBundles: true, namespaceMutations: true },
        folders: [folder(source), folder(destination)],
        projects: [],
      },
    }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true })).toHaveCount(0);
});

test('a failed merge review stays blocked and clears its error after a successful manual refresh', async ({ page }) => {
  let unavailable = false,
    reviews = 0,
    writes = 0;
  await page.route(`**/api/workflows/bundles/${sourceId}/merge/preview*`, (route) => {
    reviews++;
    return unavailable
      ? route.fulfill({
          status: 503,
          json: { error: 'Could not read the saved project from storage. Refresh the review.' },
        })
      : route.fulfill({ json: preview(route.request().postDataJSON()) });
  });
  await page.route(`**/api/workflows/bundles/${sourceId}/merge`, (route) => {
    writes++;
    return route.fulfill({ status: 500, json: { error: 'Unexpected mutation' } });
  });
  const modal = await openMerge(page);
  await select(page, /^C1/, 'Add as a new project');
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  await expect(submit).toBeEnabled();
  const beforeFailure = reviews;
  unavailable = true;
  await modal.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('Could not read the saved project from storage');
  await expect(submit).toBeDisabled();
  expect(reviews).toBe(beforeFailure + 1);
  expect(writes).toBe(0);
  unavailable = false;
  await modal.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await expect(submit).toBeEnabled();
  await expect(modal.getByRole('alert')).toHaveCount(0);
  expect(reviews).toBe(beforeFailure + 2);
  expect(writes).toBe(0);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('only saved changes are listed with automatic suggested choices and familiar section cards', async ({ page }) => {
  let reads = 0;
  const extra = Array.from({ length: 40 }, (_, index) => ({
    projectId: 'extra-' + index,
    title: 'Extra ' + index,
    relativePath: 'More/Extra-' + index + '.rivet-project',
  }));
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    reads++;
    const value = preview(route.request().postDataJSON());
    value.source = { ...source, projects: [...sourceProjects, ...extra] };
    value.suggestions!.push(
      ...extra.map((project) => ({ sourceProjectId: project.projectId, state: 'unchanged' as const })),
    );
    return route.fulfill({ json: value });
  });
  const modal = await openMerge(page);
  const changes = modal.getByRole('region', { name: 'Project changes', exact: true });
  const row = (name: RegExp) =>
    changes.locator('.workflow-bundle-merge-row').filter({ has: page.getByRole('combobox', { name }) });
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  await expect(submit).toBeEnabled();
  await expect(changes.getByRole('combobox')).toHaveCount(3);
  await expect(row(/^A1/)).toContainText('Replace A');
  await expect(row(/^C1/)).toContainText('Add as a new project');
  await expect(changes.getByRole('columnheader')).toHaveText(['Source project in Working', 'Destination in Original']);
  await expect(
    modal.getByRole('region', { name: 'Required project references', exact: true }).getByRole('columnheader'),
  ).toHaveText(['Source project in Working', 'Destination in Original']);
  await expect(changes.getByText('Only changed and newly added projects are listed', { exact: true })).toBeVisible();
  await expect(
    modal.getByText('The projects above reference these other projects. Choose their counterparts in Original.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(modal).not.toContainText(/datasets/i);
  await expect(modal).not.toContainText('.rivet-project');
  await expect(modal.getByText(/\d+ projects? selected/)).toHaveCount(0);
  await expect(changes.getByRole('textbox', { name: 'Project name for C1', exact: true })).toHaveValue('C');
  await expect(changes.getByText('Project name', { exact: true })).toBeVisible();
  await expect(modal.getByText('Destination path', { exact: true })).toHaveCount(0);
  await expect(modal.getByText('Copy selected saved projects into another bundle.', { exact: false })).toHaveCount(0);
  await expect(row(/^A1/).locator('.workflow-bundle-merge-option code')).toHaveText('A');
  await expect(
    modal
      .getByRole('region', { name: 'Required project references', exact: true })
      .locator('.workflow-bundle-merge-option code'),
  ).toHaveText('X');
  await expect(changes.getByRole('textbox', { name: 'Filter source projects' })).toHaveCount(0);
  await expect(changes.getByRole('checkbox', { name: 'Show selected only' })).toHaveCount(0);
  await expect(modal.getByText('Working → Original', { exact: true })).toBeVisible();
  for (const section of [
    changes,
    modal.getByRole('region', { name: 'Required project references', exact: true }),
    modal.getByRole('region', { name: 'Merge review', exact: true }),
  ]) {
    await expect(section).toHaveClass(/workflow-project-bundle-card/);
    await expect(section).toHaveCSS('border-radius', '12px');
  }
  for (const region of ['Project changes', 'Required project references', 'Merge review']) {
    const section = modal.getByRole('region', { name: region, exact: true });
    await expect(section.getByRole('columnheader')).toHaveCount(2);
    const heading = section.getByRole('columnheader', { name: 'Source project in Working', exact: true });
    await expect(heading).toHaveCSS('padding', '8px');
    await expect(heading).toHaveCSS('border-bottom-style', 'solid');
    await expect(heading).toHaveCSS('border-bottom-width', '1px');
  }
  await changes.getByRole('combobox', { name: /^B1/ }).click();
  await expect(page.locator('[aria-disabled="true"]').filter({ hasText: 'Replace A' })).toBeVisible();
  await expect(page.locator('[aria-disabled="true"]').filter({ hasText: 'Replace A' }).locator('code')).toHaveText('A');
  await page.keyboard.press('Escape');
  await expect(modal).toBeVisible();
  await changes.getByRole('combobox', { name: /^C1/ }).click();
  await expect(page.getByText('Suggested', { exact: true }).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(submit).toBeEnabled();
  const before = reads;
  await select(page, /^C1/, 'Add as a new project');
  expect(reads).toBe(before);
  await select(page, /^C1/, 'Skip');
  await expect(submit).toBeEnabled();
  await modal.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await expect(submit).toBeEnabled();
  await expect(row(/^C1/)).toContainText('Skip');
  await expect(modal.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
  await modal.getByRole('heading', { name: 'Review changes', exact: true }).scrollIntoViewIfNeeded();
  await expect(modal.getByText('Merge bundle', { exact: true })).toBeInViewport();
  await expect(modal.getByRole('table', { name: 'Selected project changes', exact: true })).toBeInViewport();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('one changed project among three is preselected and its unchanged dependency is matched automatically', async ({
  page,
}) => {
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    const value = preview(route.request().postDataJSON());
    value.source = {
      ...source,
      projects: sourceProjects.filter((project) => ['a1', 'b1', 'x1'].includes(project.projectId)),
    };
    value.suggestions = [
      { sourceProjectId: 'a1', state: 'changed', targetProjectId: 'a' },
      { sourceProjectId: 'b1', state: 'unchanged', targetProjectId: 'b' },
      { sourceProjectId: 'x1', state: 'unchanged', targetProjectId: 'x' },
    ];
    return route.fulfill({ json: value });
  });
  const modal = await openMerge(page);
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeEnabled();
  const changes = modal.getByRole('region', { name: 'Project changes', exact: true });
  await expect(changes.getByRole('combobox')).toHaveCount(1);
  await expect(changes).toContainText('Replace A');
  const references = modal.getByRole('region', { name: 'Required project references', exact: true });
  await expect(references).toContainText('Use existing X');
  await references.getByRole('combobox', { name: /^X/ }).click();
  await expect(page.getByText('Use existing X', { exact: true }).last().locator('code')).toHaveText('X');
  await expect(page.getByText('Suggested', { exact: true }).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await select(page, /^A1/, 'Skip');
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeDisabled();
  await expect(changes.getByRole('combobox')).toHaveCount(1);
  await expect(modal.getByText('No saved project changes to merge.', { exact: false })).toHaveCount(0);
  await select(page, /^A1/, 'Replace A');
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeEnabled();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('an unchanged duplicate shows no project actions and cannot submit an empty merge', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    reads++;
    const value = preview(route.request().postDataJSON());
    value.source = {
      ...source,
      projects: sourceProjects.filter((project) => ['a1', 'b1', 'x1'].includes(project.projectId)),
    };
    value.suggestions = value.source.projects.map((project) => ({
      sourceProjectId: project.projectId,
      state: 'unchanged' as const,
      targetProjectId: project.projectId.slice(0, -1),
    }));
    return route.fulfill({ json: value });
  });
  const modal = await openMerge(page);
  await expect(modal.getByRole('region', { name: 'Project changes', exact: true })).toHaveCount(0);
  await expect(modal.getByRole('heading', { name: 'Choose project changes', exact: true })).toHaveCount(0);
  await expect(modal.getByText('Only changed and newly added projects are listed', { exact: true })).toHaveCount(0);
  const notice = modal.getByRole('status').filter({ hasText: 'The projects already match the destination.' });
  await expect(notice).toHaveText('No saved project changes to merge. The projects already match the destination.');
  await expect(notice).toHaveCSS('color', 'rgb(255, 207, 128)');
  await expect(notice).toHaveCSS('border-width', '1px');
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeDisabled();
  expect(reads).toBe(1);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('required addition paths retain focus and remain editable through review errors', async ({ page }) => {
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    const choices: BundleMergeChoices = route.request().postDataJSON();
    const dependency = choices.dependencies.find((choice) => choice.kind === 'add');
    return dependency?.kind === 'add' && dependency.relativePath === 'X.rivet-project'
      ? route.fulfill({
          status: 409,
          json: { error: 'Destination X.rivet-project already exists. Choose another path.' },
        })
      : route.fulfill({ json: preview(choices) });
  });
  const modal = await openMerge(page);
  await select(page, /^A1/, 'Replace A');
  await select(page, /^X/, 'Add as a new project', 'Required project references');
  await expect(modal.getByRole('alert')).toContainText('already exists');
  const path = modal.getByRole('textbox', { name: 'Referenced project name for X', exact: true });
  await path.fill('Dependencies/Shared');
  await expect(path).toBeFocused();
  await path.press('Home');
  await path.pressSequentially('New/');
  await expect(path).toHaveValue('New/Dependencies/Shared');
  await expect(path).toBeFocused();
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeEnabled();
  await expect(modal.getByRole('alert')).toHaveCount(0);
  await expect(modal.getByRole('table', { name: 'Selected project changes', exact: true })).toContainText(
    'New/Dependencies/Shared',
  );
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('reselecting the current destination or action preserves choices without another preview', async ({ page }) => {
  let reads = 0;
  let lastChoices: BundleMergeChoices | undefined;
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    reads++;
    lastChoices = route.request().postDataJSON();
    return route.fulfill({ json: preview(lastChoices!) });
  });
  const modal = await openMerge(page);
  await select(page, /^C1/, 'Add as a new project');
  const path = modal.getByRole('textbox', { name: 'Project name for C1', exact: true });
  await path.fill('Nested/Chosen');
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeEnabled();
  expect(lastChoices?.actions.find((action) => action.sourceProjectId === 'c1')).toEqual({
    sourceProjectId: 'c1',
    kind: 'add',
    relativePath: 'Nested/Chosen.rivet-project',
  });
  const before = reads;
  await select(page, /^C1/, 'Add as a new project');
  await expect(path).toHaveValue('Nested/Chosen');
  await select(page, 'Destination bundle', 'Original — Original');
  await expect(path).toHaveValue('Nested/Chosen');
  await expect(modal.getByRole('table', { name: 'Selected project changes', exact: true })).toContainText(
    'Nested/Chosen',
  );
  expect(reads).toBe(before);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('content-heavy merge dialogs grow on tall screens and retain margins on smaller screens', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  const extra = Array.from({ length: 20 }, (_, index) => ({
    projectId: 'extra-' + index,
    title: 'Extra ' + index,
    relativePath: 'Extra ' + index + '.rivet-project',
  }));
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    const value = preview(route.request().postDataJSON());
    value.source = { ...source, projects: [...sourceProjects, ...extra] };
    value.suggestions!.push(...extra.map((project) => ({ sourceProjectId: project.projectId, state: 'new' as const })));
    return route.fulfill({ json: value });
  });
  const modal = await openMerge(page);
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  await expect(submit).toBeEnabled();
  const tall = await modal.boundingBox();
  expect(tall!.height).toBeGreaterThan(1100);
  expect(tall!.y).toBeGreaterThanOrEqual(19);
  expect(tall!.y + tall!.height).toBeLessThanOrEqual(1381);
  await expectModalInsets(modal);
  await page.screenshot({ path: testInfo.outputPath('bundle-merge-tall.png') });
  await page.setViewportSize({ width: 640, height: 560 });
  await expect(submit).toBeInViewport();
  const small = await modal.boundingBox();
  expect(small!.y).toBeGreaterThanOrEqual(19);
  expect(small!.y + small!.height).toBeLessThanOrEqual(541);
  await expect(modal.getByText('Merge bundle', { exact: true })).toBeInViewport();
  await expectModalInsets(modal);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('bundle menus separate creation actions and finish bundle operations with conversion', async ({
  page,
}, testInfo) => {
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) =>
    route.fulfill({ json: preview(route.request().postDataJSON()) }),
  );
  const modal = await openMerge(page);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const name of ['Working', 'Original']) {
    await page.getByRole('button', { name: `Expand ${name} bundle`, exact: true }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `Actions for ${name}`, exact: true });
    const actions = await menu
      .locator(':scope > [role="menuitem"], :scope > [role="separator"]')
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute('role') === 'separator' ? 'separator' : element.textContent?.trim(),
        ),
      );
    expect(actions).toEqual([
      'Rename bundle',
      'Download bundle',
      'Duplicate bundle',
      'Merge into another bundle…',
      'Convert to ordinary folder',
      'separator',
      'New folder',
      'separator',
      'New project',
      'Upload project',
      'separator',
      'Delete bundle',
    ]);
    await expect(
      menu.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true }).locator('svg'),
    ).toBeVisible();
    if (name === 'Working') await page.screenshot({ path: testInfo.outputPath('bundle-context-menu.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
});

test('a missing destination explains how to create one without issuing a preview', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/managed/workflows',
        capabilities: { explicitBundles: true, namespaceMutations: true, bundleMerge: true },
        folders: [folder(source)],
        projects: [],
      },
    }),
  );
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    reads++;
    return route.fulfill({ json: preview(route.request().postDataJSON()) });
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Expand Working bundle', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Merge into another bundle…', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Merge bundle', exact: true });
  await expect(modal.getByRole('combobox', { name: 'Destination bundle', exact: true })).toBeFocused();
  await expect(
    modal.getByText('Convert another folder to a bundle to create a destination.', { exact: true }),
  ).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Merge projects', exact: true })).toBeDisabled();
  expect(reads).toBe(0);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});

for (const empty of ['source', 'destination'] as const) {
  test('empty ' + empty + ' bundles have an actionable merge state', async ({ page }) => {
    await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
      const value = preview(route.request().postDataJSON());
      value[empty] = { ...value[empty], projects: [] };
      value.suggestions =
        empty === 'source'
          ? []
          : sourceProjects.map((project) => ({ sourceProjectId: project.projectId, state: 'new' }));
      return route.fulfill({ json: value });
    });
    const modal = await openMerge(page);
    const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
    if (empty === 'source') {
      await expect(modal.getByText('This bundle has no saved projects to merge.', { exact: true })).toBeVisible();
      await expect(submit).toBeDisabled();
    } else {
      await select(page, /^C1/, 'Add as a new project');
      await expect(submit).toBeEnabled();
      await expect(modal.getByRole('table', { name: 'Selected project changes', exact: true })).toContainText('Add');
    }
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
}

test('a pending merge blocks dismissal and shows success only after its acknowledged refresh', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) =>
    route.fulfill({ json: preview(route.request().postDataJSON()) }),
  );
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge', async (route) => {
    writes++;
    const request = route.request().postDataJSON();
    await held;
    return route.fulfill({
      json: {
        operationId: request.mutation.operationId,
        folder: folder(destination),
        projectMapping: { c1: 'new-c' },
        projects: [
          { projectId: 'new-c', path: '/managed/workflows/Original/C.rivet-project', revisionId: 'new-c', added: true },
        ],
        warnings: [],
      } satisfies BundleMergeResult,
    });
  });
  const modal = await openMerge(page);
  await select(page, /^C1/, 'Add as a new project');
  await modal.getByRole('button', { name: 'Merge projects', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('Merging saved project changes');
  await expect(modal.getByRole('button', { name: 'Close bundle merge', exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(modal).toBeVisible();
  expect(writes).toBe(1);
  release();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('Project changes merged into Original.', { exact: true })).toBeVisible();
});

test('long errors on a narrow screen keep actions and error details accessible', async ({ page }, testInfo) => {
  const path = 'Nested/'.repeat(110) + 'Existing';
  await page.setViewportSize({ width: 320, height: 560 });
  await page.route('**/api/workflows/bundles/' + sourceId + '/merge/preview*', (route) => {
    const choices: BundleMergeChoices = route.request().postDataJSON();
    return choices.actions.some((action) => action.kind === 'add' && action.relativePath === path + '.rivet-project')
      ? route.fulfill({ status: 409, json: { error: 'Destination ' + path + ' already exists. Choose another path.' } })
      : route.fulfill({ json: preview(choices) });
  });
  const modal = await openMerge(page);
  await select(page, /^C1/, 'Add as a new project');
  await modal.getByRole('textbox', { name: 'Project name for C1', exact: true }).fill(path);
  await expect(modal.getByRole('alert')).toContainText('already exists');
  const submit = modal.getByRole('button', { name: 'Merge projects', exact: true });
  const bounds = await submit.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await modal.getByRole('button', { name: 'View error', exact: true }).click();
  await expect(modal.getByRole('alert')).toBeFocused();
  await expect(modal.getByRole('alert')).toBeInViewport();
  await expect(modal.getByText('Merge bundle', { exact: true })).toBeInViewport();
  await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('bundle-merge-narrow-error.png') });
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
});
