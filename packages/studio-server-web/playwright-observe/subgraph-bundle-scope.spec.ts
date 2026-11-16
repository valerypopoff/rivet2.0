import { expect, test } from '@playwright/test';
import { serializeProject, type ProjectId, type Project } from '@valerypopoff/rivet2-core';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import {
  openBundleActions,
  authenticateIfNeeded,
  mockHostedEditorBootstrap,
  waitForDashboardReady,
} from './helpers/hostedEditorObserve';

test('Subgraph source separates same-bundle members from ordinary projects and excludes other bundles', async ({
  page,
}) => {
  const fixture = projectBundleFixture();
  const root = fixture.root.project,
    child = fixture.child.project;
  root.metadata.title = 'Bundle caller';
  child.metadata.title = 'Sibling project';
  for (let index = 0; index < 40; index++) {
    const id = `menu-graph-${index}` as keyof typeof root.graphs;
    root.graphs[id] = {
      metadata: { id, name: index === 39 ? 'Group/Nested/Deep/Deeply nested graph' : `Menu graph ${index}` },
      nodes: [],
      connections: [],
    };
  }
  const ordinary = structuredClone(root);
  ordinary.metadata = { ...ordinary.metadata, id: 'ordinary' as ProjectId, title: 'Ordinary project' };
  const foreign = structuredClone(child);
  foreign.metadata = { ...foreign.metadata, id: 'foreign' as ProjectId, title: 'Foreign project' };
  const peer = structuredClone(child);
  peer.metadata = { ...peer.metadata, id: 'peer' as ProjectId, title: 'Peer project' };
  Object.values(peer.graphs)[0]!.metadata!.name = 'Peer graph';
  const menuProjects = Array.from({ length: 40 }, (_, index) => {
    const project = structuredClone(child);
    project.metadata = { ...project.metadata, id: `menu-project-${index}` as ProjectId, title: `Menu project ${index}` };
    return project;
  });
  const call = Object.values(root.graphs)[0]!.nodes.find((n) => n.type === 'subGraph')!;
  call.visualData = { x: 200, y: 180, width: 260 };
  const item = (project: Project, folder: string, bundleId: string | null) => ({
    id: project.metadata.id,
    projectMetadataId: project.metadata.id,
    name: project.metadata.title,
    bundleId,
    fileName: `${project.metadata.id}.rivet-project`,
    relativePath: `${folder ? folder + '/' : ''}${project.metadata.id}.rivet-project`,
    absolutePath: `/workflows/${folder ? folder + '/' : ''}${project.metadata.id}.rivet-project`,
    updatedAt: '',
    settings: { status: 'unpublished', endpointName: '', publishedWebApps: [] },
  });
  const one = 'e70b502d-cf31-4236-a91d-7779264adaed',
    two = '6429775d-d55a-487f-bd31-bc5875ffd070';
  const items = [
    item(root, 'Feature', one),
    item(child, 'Feature/Nested', one),
    item(ordinary, '', null),
    item(foreign, 'Other feature', two),
    item(peer, 'Feature', one),
  ];
  const folder = (name: string, id: string | null, projects: typeof items, folders: any[] = []) => ({
    id: name,
    name,
    bundleId: id,
    relativePath: name,
    absolutePath: `/workflows/${name}`,
    updatedAt: '',
    projects,
    folders,
  });
  const tree = {
    root: '/workflows',
    capabilities: { explicitBundles: true },
    projects: [items[2], ...menuProjects.map((project) => item(project, '', null))],
    folders: [
      folder('Feature', one, [items[0]!, items[4]!], [folder('Nested', null, [items[1]!])]),
      folder('Other feature', two, [items[3]!]),
    ],
  };
  const projects = [root, child, ordinary, foreign, peer, ...menuProjects];
  const saved: Project[] = [];
  let treeUnavailable = false;
  let holdPreview = false;
  let releasePreview!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree')
        return route.fulfill(
          treeUnavailable ? { status: 503, json: { error: 'Catalog refresh unavailable' } } : { json: tree },
        );
      if (url.pathname === '/api/workflows/bundles/kind') {
        expect(route.request().postDataJSON()).toMatchObject({ relativePath: 'Feature', enabled: false });
        tree.folders[0]!.bundleId = null;
        items[0]!.bundleId = null;
        items[1]!.bundleId = null;
        return route.fulfill({ json: { folder: tree.folders[0] } });
      }
      if (url.pathname === '/api/projects/load') {
        const entry = items.find((i) => i.absolutePath === route.request().postDataJSON().path)!;
        return route.fulfill({
          json: {
            contents: serializeProject(projects.find((p) => p.metadata.id === entry.projectMetadataId)!),
            datasetsContents: null,
            revisionId: null,
          },
        });
      }
      if (url.pathname === '/api/projects/save') {
        const { deserializeProject } = await import('@valerypopoff/rivet2-core');
        saved.push(deserializeProject(route.request().postDataJSON().contents)[0]);
        return route.fulfill({ json: { path: route.request().postDataJSON().path, revisionId: null } });
      }
      if (url.pathname.includes('/subgraph-projects/')) {
        expect([root.metadata.id, ordinary.metadata.id]).toContain(url.searchParams.get('callerProjectId'));
        const id = url.pathname.split('/')[4];
        if (
          id === 'foreign' ||
          (id === child.metadata.id && url.searchParams.get('callerProjectId') === ordinary.metadata.id)
        )
          return route.fulfill({ status: 403, json: { error: 'Outside bundle' } });
        if (url.searchParams.get('version') === 'published')
          return route.fulfill({ status: 409, json: { error: 'No publication' } });
        if (holdPreview && id === child.metadata.id) {
          await previewGate;
          return route.fulfill({ status: 403, json: { error: 'Target is no longer accessible' } });
        }
        return route.fulfill({ json: { project: projects.find((p) => p.metadata.id === id) } });
      }
      return route.fulfill({ status: 503, json: { error: 'Unowned fixture route' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Expand Feature bundle', exact: true }).click();
  await page.locator('.project-row').filter({ hasText: 'Bundle caller' }).dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const node = frame.locator(`.node[data-nodeid="${call.id}"]`);
  await node.hover();
  await node.locator('.edit-button').click();
  const source = frame.getByRole('group', { name: 'Subgraph graph source' });
  await expect(source.getByRole('button', { name: 'Same bundle', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const paths = frame.locator('.subgraph-target-path');
  await expect(paths).toHaveCount(2);
  for (const path of await paths.all()) {
    await expect(path).toContainText('Sibling project');
    await expect(path).toContainText('Child');
    await expect(path).not.toContainText('>');
    const icon = path.locator('svg.subgraph-target-path-separator');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    const size = await path.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;height:1cap;width:1px;pointer-events:none;';
      element.appendChild(probe);
      const capHeight = probe.getBoundingClientRect().height;
      probe.remove();
      const icon = element.querySelector('svg')!.getBoundingClientRect();
      return { capHeight, iconHeight: icon.height, iconWidth: icon.width };
    });
    expect(Math.abs(size.iconHeight - size.capHeight)).toBeLessThan(0.5);
    expect(size.iconWidth).toBeGreaterThan(3);
  }
  const picker = frame.getByRole('combobox', { name: 'Subgraph graph', exact: true }).last();
  await picker.click();
  const options = frame.locator('.subgraph-node-body-select').last();
  const menuOptions = options.locator('[id*="-option-"]');
  await expect(options).not.toContainText('Foreign project');
  await expect(options).not.toContainText('Ordinary project');
  await expect(menuOptions.getByText('Feature', { exact: true })).toHaveCount(0);
  await expect(menuOptions.getByText('Peer project', { exact: true })).toBeVisible();
  await menuOptions.getByText('Nested', { exact: true }).click();
  await expect(menuOptions.getByText('Sibling project', { exact: true })).toBeVisible();
  await picker.press('Escape');
  holdPreview = true;
  try {
    await picker.click();
    const cachedGraph = options.locator('[id*="-option-"]').filter({ hasText: /^Child$/ });
    await expect(cachedGraph).toHaveAttribute('aria-disabled', 'true');
    await cachedGraph.click({ force: true });
    releasePreview();
    await expect(frame.getByRole('alert').filter({ hasText: 'Target is no longer accessible' })).toBeVisible();
    await expect(cachedGraph).toHaveAttribute('aria-disabled', 'true');
    await cachedGraph.click({ force: true });
    // A successful request for a different project must not rehabilitate the
    // failed preview, or a shared cache could authorize the wrong choice.
    await menuOptions.getByText('Peer project', { exact: true }).click();
    const peerGraph = options.locator('[id*="-option-"]').filter({ hasText: /^Peer graph$/ });
    await expect(peerGraph).toHaveAttribute('aria-disabled', 'false');
    await expect(cachedGraph).toHaveAttribute('aria-disabled', 'true');
    await expect(frame.locator('.projects-container .project:not(.opening)')).not.toHaveClass(/has-unsaved-changes/);
  } finally {
    releasePreview();
    holdPreview = false;
  }
  await picker.press('Escape');
  await source.getByRole('button', { name: 'Other projects', exact: true }).click();
  await picker.click();
  await expect(options).toContainText('Ordinary project');
  await expect(options).not.toContainText('Sibling project');
  await expect(options).not.toContainText('Foreign project');
  await picker.press('Escape');
  await source.getByRole('button', { name: 'Same bundle', exact: true }).click();
  await picker.click();
  const childOption = menuOptions.getByText('Child', { exact: true });
  if (!(await childOption.isVisible())) await menuOptions.getByText('Sibling project', { exact: true }).click();
  await childOption.click();
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => saved.length).toBe(1);
  expect(Object.values(saved[0]!.graphs)[0]!.nodes.find((n) => n.id === call.id)!.data).toMatchObject({
    targetScope: 'same-bundle',
    targetProjectId: child.metadata.id,
  });
  treeUnavailable = true;
  await picker.click();
  await expect(frame.getByRole('alert').filter({ hasText: 'Catalog refresh unavailable' })).toBeVisible();
  await expect(options.locator('[id*="-option-"]')).toHaveCount(0);
  await expect(frame.locator('.projects-container .project:not(.opening)')).not.toHaveClass(/has-unsaved-changes/);
  await picker.press('Escape');
  treeUnavailable = false;
  // Another user moves only the target out of the bundle. Opening the picker
  // refreshes membership, not the authored target or its wires.
  tree.folders[0]!.folders[0]!.projects = [];
  items[1]!.bundleId = null;
  tree.projects.push(items[1]!);
  await picker.click();
  await expect(source.getByRole('button', { name: 'Other projects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(options).toContainText('Ordinary project');
  await expect(options).not.toContainText('Foreign project');
  await picker.press('Escape');
  expect(saved).toHaveLength(1);
  await expect(frame.locator('.projects-container .project:not(.opening)')).not.toHaveClass(/has-unsaved-changes/);
  // Move it back: both controls must agree again without replacing the node.
  tree.projects.pop();
  tree.folders[0]!.folders[0]!.projects = [items[1]!];
  items[1]!.bundleId = one;
  await picker.click();
  await expect(source.getByRole('button', { name: 'Same bundle', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await picker.press('Escape');
  await page.getByRole('button', { name: 'Collapse Feature bundle', exact: true }).click({ button: 'right' });
  await openBundleActions(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: 'Convert to ordinary folder', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Same bundle', exact: true })).toHaveCount(0);
  await expect(source.getByRole('button', { name: 'Other projects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await picker.click();
  await expect(options).toContainText('Ordinary project');
  await expect(options).not.toContainText('Foreign project');
  await picker.press('Escape');
  await page.locator('.project-row').filter({ hasText: 'Ordinary project' }).dblclick();
  const ordinaryNode = frame.locator(`.node[data-nodeid="${call.id}"]`);
  await ordinaryNode.hover();
  await ordinaryNode.locator('.edit-button').click();
  await expect(source.getByRole('button', { name: 'Same bundle', exact: true })).toHaveCount(0);

  // Both picker implementations grow before scrolling, then fit a smaller viewport.
  for (const scope of ['This project', 'Other projects']) {
    await source.getByRole('button', { name: scope, exact: true }).click();
    let tallHeight = 0;
    const list = options.locator('[id$="-listbox"]');
    for (const height of [1400, 650]) {
      await page.setViewportSize({ width: 1600, height });
      if (height === 650) await expect(list).toHaveCount(0);
      await picker.click();
      await expect(list.locator('[id*="-option-"]')).not.toHaveCount(0);
      const readBounds = () => list.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          viewportHeight: window.innerHeight,
          scrollable: [element, ...element.querySelectorAll('*')].some(
            (candidate) => candidate.clientHeight > 0 && candidate.scrollHeight > candidate.clientHeight
              && /^(auto|scroll)$/.test(getComputedStyle(candidate).overflowY),
          ),
        };
      });
      await expect.poll(async () => {
        const bounds = await readBounds();
        return bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight;
      }).toBe(true);
      const bounds = await readBounds();
      expect(bounds.scrollable).toBe(true);
      if (height === 1400) {
        expect(bounds.height).toBeGreaterThan(300);
        tallHeight = bounds.height;
      } else expect(bounds.height).toBeLessThan(tallHeight);
      const lastOption = list.locator('[id*="-option-"]').last();
      await lastOption.scrollIntoViewIfNeeded();
      await expect(lastOption).toBeInViewport();
      if (height === 650) await picker.press('Escape');
    }
    if (scope === 'This project') {
      await picker.click();
      await picker.fill('Group/Nested/Deep');
      const nested = options.locator('[id*="-option-"]').filter({ hasText: /^Deeply nested graph$/ });
      await expect(options.locator('[id*="-option-"]').filter({ hasText: /^Menu graph 0$/ })).toHaveCount(0);
      const indent = await nested.locator('span[style]').evaluate((element) => getComputedStyle(element).paddingLeft);
      expect(Number.parseFloat(indent)).toBeGreaterThan(0);
      await picker.press('End');
      await picker.press('Enter');
      const values = frame.locator('.subgraph-node-body-select [class*="-singleValue"]');
      await expect(values).toHaveText(['Deeply nested graph', 'Deeply nested graph']);
      await picker.click();
      await picker.fill('Group/Nested');
      await page.setViewportSize({ width: 1600, height: 900 });
      await expect(list).toHaveCount(0);
      await expect(picker).toHaveValue('');
      await expect(values).toHaveText(['Deeply nested graph', 'Deeply nested graph']);
      for (const value of await values.all()) {
        const inset = await value.evaluate((element) => {
          const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.selectNodeContents(text);
          return range.getBoundingClientRect().left - element.getBoundingClientRect().left;
        });
        expect(Math.abs(inset)).toBeLessThan(1);
      }
    }
  }
});
