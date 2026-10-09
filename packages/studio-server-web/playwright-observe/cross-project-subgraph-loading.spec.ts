import { expect, test } from '@playwright/test';
import {
  createBuiltInRegistry,
  deserializeProject,
  getGraphBoundary,
  serializeProject,
  type GraphId,
  type NodeConnection,
  type Project,
  type ProjectId,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

const registry = createBuiltInRegistry();
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

function fixture(version: 'latest' | 'published') {
  const source = registry.createDynamic('text');
  source.id = 'source' as typeof source.id;
  source.data.text = 'Input';
  source.visualData = { x: 100, y: 250, width: 200 };
  const subgraph = registry.createDynamic('subGraph');
  subgraph.id = 'external-call' as typeof subgraph.id;
  subgraph.title = 'External call';
  subgraph.visualData = { x: 450, y: 250, width: 260 };
  subgraph.data = { graphId: 'child', targetProjectId: 'external-project', targetVersion: version };
  // Older authored callers can legitimately omit a saved targetBoundary.
  const sink = registry.createDynamic('text');
  sink.id = 'sink' as typeof sink.id;
  sink.data.text = '{{answer}}';
  sink.visualData = { x: 850, y: 250, width: 200 };
  const input = registry.createDynamic('graphInput');
  input.data.id = 'prompt';
  input.data.dataType = 'string';
  const output = registry.createDynamic('graphOutput');
  output.data.id = 'answer';
  output.data.dataType = 'string';
  const connections = [
    { outputNodeId: source.id, outputId: 'output', inputNodeId: subgraph.id, inputId: 'prompt' },
    { outputNodeId: subgraph.id, outputId: 'answer', inputNodeId: sink.id, inputId: 'answer' },
  ] as NodeConnection[];
  const project: Project = {
    metadata: { id: 'caller' as ProjectId, title: 'External caller', description: '', mainGraphId: 'main' as GraphId },
    graphs: {
      main: { metadata: { id: 'main' as GraphId, name: 'Main' }, nodes: [source, subgraph, sink], connections },
    },
  };
  const target: Project = {
    metadata: { id: 'external-project' as ProjectId, title: 'Reusable target', description: '' },
    graphs: {
      child: { metadata: { id: 'child' as GraphId, name: 'Child graph' }, nodes: [input, output], connections: [] },
    },
  };
  // Serialization groups outgoing wires by node; compare against the actual
  // persisted ordering rather than this fixture's hand-built array ordering.
  const [persisted] = deserializeProject(serializeProject(project));
  return { project: persisted, target, connections: persisted.graphs.main!.connections };
}

test('new external graph input survives connection, tab switches and saved-file reopen', async ({ page }) => {
  const { project, target } = fixture('latest');
  const call = project.graphs.main!.nodes.find((node) => node.id === 'external-call')! as SubGraphNode;
  call.data.targetBoundary = getGraphBoundary(target, 'child' as GraphId);
  const secondSource = registry.createDynamic('text');
  secondSource.id = 'second-source' as typeof secondSource.id;
  secondSource.data.text = 'Second input';
  secondSource.visualData = { x: 100, y: 500, width: 200 };
  project.graphs.main!.nodes.push(secondSource);
  target.metadata.mainGraphId = 'child' as GraphId;
  target.graphs.child!.nodes.forEach((node, index) => {
    node.visualData = { x: 100 + index * 400, y: 200, width: 200 };
  });
  const paths = new Map([
    ['/workflows/caller.rivet-project', project],
    ['/workflows/target.rivet-project', target],
  ]);
  const saves = new Map<string, number>();
  const workflows = [...paths].map(([absolutePath, saved]) => ({
    id: saved.metadata.id,
    projectMetadataId: saved.metadata.id,
    name: saved.metadata.title,
    fileName: absolutePath.split('/').pop(),
    relativePath: absolutePath.slice('/workflows/'.length),
    absolutePath,
    updatedAt: '2026-10-09T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  }));
  await page.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 503, json: { error: 'Unavailable in this fixture' } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'expanded-subgraph', revision: 0 }, folders: [], projects: workflows },
    }),
  );
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({
      json: {
        contents: serializeProject(paths.get(route.request().postDataJSON().path)!),
        datasetsContents: null,
        revisionId: null,
      },
    }),
  );
  await page.route('**/api/projects/save', (route) => {
    const body = route.request().postDataJSON();
    paths.set(body.path, deserializeProject(body.contents)[0]);
    saves.set(body.path, (saves.get(body.path) ?? 0) + 1);
    return route.fulfill({ json: { path: body.path, revisionId: null } });
  });
  let previewRequests = 0;
  let holdPreview = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workflows/subgraph-projects/external-project/preview?version=latest', async (route) => {
    previewRequests++;
    if (holdPreview) await gate;
    await route.fulfill({ json: { project: paths.get('/workflows/target.rivet-project') } });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const callerRow = page.locator('.project-row', { hasText: project.metadata.title });
    await callerRow.dblclick();
    const node = frame.locator('.node[data-nodeid="external-call"]');
    await expect(node.locator('.input-port[data-portid="prompt"]')).toBeVisible();
    await page.locator('.project-row', { hasText: target.metadata.title }).dblclick();
    // Add the second input using the real editor, then save B. Preview resolves
    // B's saved content, not an injected atom or an unsaved open-tab snapshot.
    await frame.locator('.node-canvas').click({ button: 'right', position: { x: 350, y: 450 } });
    await frame.getByPlaceholder('Type in node name...').fill('Graph Input');
    await frame
      .locator('.context-menu-label-text')
      .filter({ hasText: /^Graph Input$/ })
      .click();
    const inputs = frame.locator('.node', { has: frame.locator('.node-title', { hasText: /^Graph Input$/ }) });
    await expect(inputs).toHaveCount(2);
    await inputs.last().hover();
    await inputs.last().locator('.edit-button').click();
    await frame.getByLabel('ID', { exact: true }).fill('second');
    await frame.locator('body').press('Escape');
    await frame.locator('body').press(`${modifier}+S`);
    await expect.poll(() => saves.get('/workflows/target.rivet-project')).toBe(1);
    const callerTab = frame.locator('.projects-container .project', { hasText: /^(External caller|caller)$/ });
    const targetTab = frame.locator('.projects-container .project', { hasText: /^(Reusable target|target)$/ });
    await callerTab.click();
    await expect(node.locator('.input-port[data-portid="second"]')).toBeVisible();
    await expect(callerTab).not.toHaveClass(/has-unsaved-changes/);
    const output = frame.locator('.node[data-nodeid="second-source"] .output-port[data-portid="output"]');
    const input = node.locator('.input-port[data-portid="second"]');
    const from = (await output.boundingBox())!;
    const to = (await input.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(frame.locator('path.wire')).toHaveCount(3);
    await frame.locator('body').press(`${modifier}+Z`);
    await expect(frame.locator('path.wire')).toHaveCount(2);
    await frame.locator('body').press(`${modifier}+Shift+Z`);
    await expect(frame.locator('path.wire')).toHaveCount(3);
    await frame.locator('body').press(`${modifier}+S`);
    await expect.poll(() => saves.get('/workflows/caller.rivet-project')).toBe(1);
    const saved = paths.get('/workflows/caller.rivet-project')!;
    expect(saved.graphs.main!.connections).toHaveLength(3);
    expect(
      (saved.graphs.main!.nodes.find((entry) => entry.id === call.id)! as SubGraphNode).data.targetBoundary!.inputs.map(
        (port) => port.id,
      ),
    ).toEqual(['prompt', 'second']);
    await targetTab.click();
    holdPreview = true;
    const before = previewRequests;
    await callerTab.click();
    await expect.poll(() => previewRequests).toBeGreaterThan(before);
    await expect(node.locator('.input-port[data-portid="second"]')).toBeVisible();
    await expect(frame.locator('path.wire')).toHaveCount(3);
    await expect(callerTab).not.toHaveClass(/has-unsaved-changes/);
    release();
    // Close A, then reopen its mocked saved file rather than workspace recovery.
    await callerTab.hover();
    await callerTab.locator('.close-project').click();
    await expect(callerTab).toHaveCount(0);
    await callerRow.dblclick();
    await expect(node.locator('.input-port[data-portid="second"]')).toBeVisible();
    await expect(frame.locator('path.wire')).toHaveCount(3);
    await expect(callerTab).not.toHaveClass(/has-unsaved-changes/);
    await frame.locator('body').press(`${modifier}+S`);
    await expect.poll(() => saves.get('/workflows/caller.rivet-project')).toBe(2);
    expect(paths.get('/workflows/caller.rivet-project')!.graphs.main!.connections).toEqual(
      saved.graphs.main!.connections,
    );
    // Rename the very same target nodes through the real editor. Their stable
    // identities, not editable ID fields, keep both sides of A's wires attached.
    await targetTab.click();
    for (const [type, name] of [
      ['graphInput', 'prompt2'],
      ['graphOutput', 'answer2'],
    ] as const) {
      const targetNode = target.graphs.child!.nodes.find((entry) => entry.type === type)!;
      const rendered = frame.locator(`.node[data-nodeid="${targetNode.id}"]`);
      await rendered.hover();
      await rendered.locator('.edit-button').click();
      await frame.getByLabel('ID', { exact: true }).fill(name);
      await frame.locator('body').press('Escape');
    }
    await frame.locator('body').press(`${modifier}+S`);
    await expect.poll(() => saves.get('/workflows/target.rivet-project')).toBe(2);
    await callerTab.click();
    await expect(node).toContainText('prompt2');
    await expect(node).toContainText('answer2');
    await expect(node.locator('.input-port[data-portid="prompt"]')).toBeVisible();
    await expect(node.locator('.output-port[data-portid="answer"]')).toBeVisible();
    await expect(frame.locator('path.wire')).toHaveCount(3);
    await expect(callerTab).not.toHaveClass(/has-unsaved-changes/);
    await callerTab.hover();
    await callerTab.locator('.close-project').click();
    await expect(callerTab).toHaveCount(0);
    await callerRow.dblclick();
    await expect(node).toContainText('prompt2');
    await expect(node).toContainText('answer2');
    await expect(frame.locator('path.wire')).toHaveCount(3);
    await frame.locator('body').press(`${modifier}+S`);
    await expect.poll(() => saves.get('/workflows/caller.rivet-project')).toBe(3);
    expect(paths.get('/workflows/caller.rivet-project')!.graphs.main!.connections).toEqual(
      saved.graphs.main!.connections,
    );
  } finally {
    release();
  }
});

for (const version of ['latest', 'published'] as const) {
  for (const scenario of ['delay', 'failure', 'reference-load', 'reference-failure', 'shared-refresh'] as const) {
    const fails = scenario === 'failure';
    const referenceRace = scenario.startsWith('reference-');
    test(`${version} subgraph ${scenario} preserves wires through loading and neighboring edits`, async ({ page }) => {
      const { project, target, connections } = fixture(version);
      if (scenario === 'shared-refresh') {
        const peer = structuredClone(project.graphs.main!.nodes.find((node) => node.id === 'external-call')!);
        peer.id = 'external-peer' as typeof peer.id;
        peer.title = 'External peer';
        peer.visualData = { x: 450, y: 650, width: 260 };
        project.graphs.main!.nodes.push(peer);
      }
      if (referenceRace) {
        project.references = [
          { id: 'legacy-reference' as ProjectId, title: 'Legacy reference', hintPaths: ['legacy.rivet-project'] },
        ];
      }
      const path = '/workflows/caller.rivet-project';
      const workflow = {
        id: project.metadata.id,
        name: project.metadata.title,
        fileName: 'caller.rivet-project',
        relativePath: 'caller.rivet-project',
        absolutePath: path,
        updatedAt: '2026-10-08T00:00:00.000Z',
        settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
      };
      await page.addInitScript(() =>
        localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
      );
      // Every API path is isolated from real workflows, including Save.
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => route.fulfill({ status: 503, json: { error: 'Unavailable in this fixture' } }),
      );
      await mockHostedEditorBootstrap(page);
      await page.route('**/api/workflows/tree', (route) =>
        route.fulfill({
          json: {
            root: '/workflows',
            sync: { epoch: 'subgraph-loading', revision: 0 },
            folders: [],
            projects: [workflow],
          },
        }),
      );
      let loads = 0;
      await page.route('**/api/projects/load', (route) => {
        loads++;
        return route.fulfill({
          json: { contents: serializeProject(project), datasetsContents: null, revisionId: null },
        });
      });
      let savedContents: string | undefined;
      let saves = 0;
      await page.route('**/api/projects/save', async (route) => {
        const body = route.request().postDataJSON();
        expect(body.path).toBe(path);
        savedContents = body.contents;
        saves++;
        await route.fulfill({ json: { path, revisionId: null } });
      });
      let releasePreview!: () => void;
      const previewGate = new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
      let previewStarted = false;
      let refresh = false;
      let releaseReference!: () => void;
      const referenceGate = new Promise<void>((resolve) => {
        releaseReference = resolve;
      });
      let referenceSettled = false;
      if (referenceRace) {
        await page.route('**/api/native/read-relative', async (route) => {
          await referenceGate;
          await route.fulfill(
            scenario === 'reference-failure'
              ? { status: 503, json: { error: 'Reference unavailable' } }
              : {
                  json: {
                    contents: serializeProject({
                      metadata: { id: 'legacy-reference' as ProjectId, title: 'Legacy reference', description: '' },
                      graphs: {},
                    }),
                  },
                },
          );
          referenceSettled = true;
        });
      }
      await page.route('**/api/workflows/subgraph-projects/external-project/preview?version=*', async (route) => {
        expect(new URL(route.request().url()).searchParams.get('version')).toBe(version);
        previewStarted = true;
        await previewGate;
        await route.fulfill(
          fails
            ? { status: 503, json: { error: 'Preview unavailable' } }
            : {
                json: {
                  project: {
                    ...target,
                    metadata: { ...target.metadata, title: refresh ? 'Refreshed target' : target.metadata.title },
                  },
                },
              },
        );
      });
      try {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await authenticateIfNeeded(page);
        await waitForDashboardReady(page);
        await page.locator('.project-row', { hasText: project.metadata.title }).dblclick();
        const frame = page.frameLocator('iframe.dashboard-editor-frame');
        const tab = frame.locator('.projects-container .project:not(.opening)');
        const node = frame.locator('.node[data-nodeid="external-call"]');
        await expect(node).toBeVisible();
        await expect(tab).toHaveCount(1);
        await expect.poll(() => previewStarted).toBe(true);
        // Allow canvas effects to settle while the preview is still blocked.
        await node.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        await expect(tab).not.toHaveClass(/has-unsaved-changes/);
        // Editing either peer must not classify the unresolved Subgraph's
        // authored ports as removed. Saving checks both directions below.
        for (const id of ['source', 'sink']) {
          const peer = frame.locator(`.node[data-nodeid="${id}"]`);
          await peer.hover();
          await peer.locator('.edit-button').click();
          await frame.getByRole('button', { name: 'Edit node title', exact: true }).click();
          const title = frame.locator('.node-title-field input');
          await title.fill(`Edited ${id}`);
          await title.press('Enter');
          await frame.locator('body').press('Escape');
        }
        await expect(tab).toHaveClass(/has-unsaved-changes/);
        await frame.locator('body').press(`${modifier}+S`);
        await expect.poll(() => saves).toBe(1);
        expect(deserializeProject(savedContents!)[0].graphs.main!.connections).toEqual(connections);
        await expect(tab).not.toHaveClass(/has-unsaved-changes/);
        releasePreview();
        if (fails) {
          await expect(node).toContainText('Could not refresh the target preview');
        } else {
          await expect(node.locator('.input-port[data-portid="prompt"]')).toBeVisible();
          await expect(node.locator('.output-port[data-portid="answer"]')).toBeVisible();
          await expect(frame.locator('path.wire')).toHaveCount(2);
        }
        await expect(tab).not.toHaveClass(/has-unsaved-changes/);
        if (scenario === 'shared-refresh') {
          const peer = frame.locator('.node[data-nodeid="external-peer"]');
          await expect(peer).toContainText(target.metadata.title);
          refresh = true;
          await node.locator('.subgraph-node-body-select input').click();
          await expect(node).toContainText('Refreshed target');
          await expect(peer).toContainText('Refreshed target');
          await frame.locator('body').press('Escape');
          await expect(frame.locator('path.wire')).toHaveCount(2);
          await expect(tab).not.toHaveClass(/has-unsaved-changes/);
        }
        if (referenceRace) {
          releaseReference();
          await expect.poll(() => referenceSettled).toBe(true);
          await node.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          );
          await expect(node.locator('.input-port[data-portid="prompt"]')).toBeVisible();
          await expect(node.locator('.output-port[data-portid="answer"]')).toBeVisible();
          await expect(frame.locator('path.wire')).toHaveCount(2);
          await expect(tab).not.toHaveClass(/has-unsaved-changes/);
          // A same-project reload resets the shared definition cache. Ports
          // must recover from the current saved target, without losing wires.
          await page.evaluate(
            ({ path, projectId }) => {
              document.querySelector<HTMLIFrameElement>('iframe.dashboard-editor-frame')!.contentWindow!.postMessage(
                {
                  type: 'open-project',
                  path,
                  expectedProjectId: projectId,
                  preferredGraphId: 'main',
                  reloadFromDisk: true,
                  replaceCurrent: false,
                },
                window.location.origin,
              );
            },
            { path, projectId: project.metadata.id },
          );
          await expect.poll(() => loads).toBe(2);
          await expect(frame.locator('.node[data-nodeid="source"]')).not.toContainText('Edited source');
          await expect(node.locator('.input-port[data-portid="prompt"]')).toBeVisible();
          await expect(node.locator('.output-port[data-portid="answer"]')).toBeVisible();
          await expect(frame.locator('path.wire')).toHaveCount(2);
          await expect(tab).not.toHaveClass(/has-unsaved-changes/);
        }
        await frame.locator('body').press(`${modifier}+S`);
        await expect.poll(() => saves).toBe(2);
        const [saved] = deserializeProject(savedContents!);
        expect(saved.graphs.main!.connections).toEqual(connections);
        await expect(tab).not.toHaveClass(/has-unsaved-changes/);
      } finally {
        releasePreview();
        releaseReference();
      }
    });
  }
}
