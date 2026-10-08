import { expect, test } from '@playwright/test';
import {
  createBuiltInRegistry,
  deserializeProject,
  serializeProject,
  type GraphId,
  type NodeConnection,
  type Project,
  type ProjectId,
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
      await page.route('**/api/**', (route) =>
        route.fulfill({ status: 503, json: { error: 'Unavailable in this fixture' } }),
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
