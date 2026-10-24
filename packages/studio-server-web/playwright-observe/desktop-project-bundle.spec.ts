import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TextNodeImpl,
  GetDatasetRowNodeImpl,
  GraphOutputNodeImpl,
  CodeNodeImpl,
  serializeProject,
  type PortId,
  type DatasetId,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';

test('desktop bundle IO opens a real project path, runs dependencies, preserves unsaved edits and saves the member', async ({
  page,
}) => {
  const fixture = projectBundleFixture();
  const childGraph = fixture.child.project.graphs[fixture.child.project.metadata.mainGraphId!]!;
  childGraph.metadata!.name = 'Utilities/generatePreflightAuditWithClassifierChainAndContextContracts';
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/src').replaceAll('\\', '/');
  const edited = structuredClone(fixture.root.project);
  const graph = edited.graphs[edited.metadata.mainGraphId!]!;
  const subgraph = graph.nodes.find((node) => node.type === 'subGraph')!;
  subgraph.visualData.width = 300;
  const output = graph.nodes.find((node) => node.type === 'graphOutput')!;
  const suffix = TextNodeImpl.create();
  suffix.title = 'Visible unsaved edit';
  suffix.data.text = '{{input}} + unsaved';
  graph.nodes.push(suffix);
  graph.connections = [
    { outputNodeId: subgraph.id, outputId: 'result' as PortId, inputNodeId: suffix.id, inputId: 'input' as PortId },
    { outputNodeId: suffix.id, outputId: 'output' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
  ];
  const native = {
    manifestPath: '/bundle/rivet-bundle.json',
    selectedProjectPath: null,
    manifestContents: JSON.stringify({
      format: 'rivet-project-bundle',
      schemaVersion: 1,
      requiredLoaderVersion: 4,
      workspace: {
        name: 'Desktop feature',
        folders: ['Nested', 'Empty'],
        members: [fixture.root.project, fixture.child.project].map((project, index) => ({
          projectId: project.metadata.id,
          relativePath: index ? 'Child.rivet-project' : 'Nested/Root.rivet-project',
        })),
      },
      versionPolicy: 'latest',
      exportingRuntimeVersion: 'fixture',
      rootArtifact: 'root',
      plugins: [],
      references: [],
      artifacts: [fixture.root.project, fixture.child.project].map((project, index) => ({
        id: index ? 'child' : 'root',
        projectId: project.metadata.id,
        title: project.metadata.title,
        version: 'latest',
        revision: 'original',
        project: { path: `projects/${index ? 'child' : 'nested/root'}.rivet-project` },
      })),
      targets: ['latest', 'published'].map((version) => ({
        projectId: fixture.child.project.metadata.id,
        version,
        artifact: 'child',
      })),
    }),
    files: [fixture.root.project, fixture.child.project].map((project, index) => ({
      path: `projects/${index ? 'child' : 'nested/root'}.rivet-project`,
      sourceProjectPath: `/bundle/projects/${index ? 'child' : 'nested/root'}.rivet-project`,
      contents: serializeProject(project) as string,
    })),
  };
  await page.addInitScript(
    ({ native, edited }) => {
      (window as any).bundleFixture = native;
      (window as any).editedFixture = edited;
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
    },
    { native, edited },
  );
  // Mount the real editor and desktop IO adapter with test-owned filesystem replies.
  // Native containment and byte limits are exercised by the Rust reader tests.
  await page.route('**/desktop-bundle-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `
    <html><head><link rel="stylesheet" href="/@fs/${app}/host.css"></head><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      await import('/shims/install-process-shim.ts');
      const { default: React } = await import('/@id/react');
      const { default: ReactDOM } = await import('/@id/react-dom/client');
      const { RivetAppHost } = await import('/@fs/${app}/host.tsx');
      const { TauriIOProvider } = await import('/@fs/${app}/io/TauriIOProvider.ts');
      const { BrowserDatasetProvider } = await import('/@fs/${app}/io/BrowserDatasetProvider.ts');
      const { prepareDesktopProjectBundle } = await import('/@fs/${app}/io/DesktopProjectBundle.ts');
      const datasets = new BrowserDatasetProvider();
      window.bundleDatasets = datasets;
      const io = new TauriIOProvider(datasets, { allowDataFileNeighbor: async () => {} });
      // Exercise Open through the dialog adapter, not just openProjectPath.
      // Hosted Vite maps Tauri's dialog API to the browser picker; unit tests
      // independently assert the options reaching the actual native IPC API.
      window.showOpenFilePicker = async (options) => {
        window.bundlePickerOptions = options;
        return [{ name: '/bundle/rivet-bundle.json' }];
      };
      const openWithDialog = io.loadProjectData.bind(io);
      io.loadProjectData = async (...args) => {
        window.__TAURI__ = {};
        try { return await openWithDialog(...args); }
        finally { delete window.__TAURI__; }
      };
      io.readProjectBundle = async (path, manifestPath) => {
        (window.bundleReadRequests ??= []).push({ path, manifestPath });
        // Match native discovery: a nested member cannot rediscover the
        // manifest. Runs must use the bundle membership recorded at Open.
        if (!manifestPath && path.endsWith('/nested/root.rivet-project')) return undefined;
        if (window.blockNextBundleRead) {
          window.blockNextBundleRead = false;
          window.bundleReadBlocked = true;
          await new Promise((resolve) => { window.releaseBundleRead = resolve; });
        }
        return prepareDesktopProjectBundle({ ...window.bundleFixture,
          selectedProjectPath: path.endsWith('rivet-bundle.json') ? null : path });
      };
      io.saveProjectDataNoPrompt = async (project, path) => { window.savedBundlePath = path; };
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RivetAppHost, {
        providers: { io, datasets, environment: { getEnvVar: async () => {
          if (window.blockEnvironmentReads) {
            window.environmentReadBlocked = true;
            await window.environmentReadGate;
          }
          return undefined;
        } } },
        onWorkspaceHostReady: (host) => { window.bundleHost = host; },
        ui: { checkForUpdates: false, preloadCodeEditor: false },
      }));
    </script></body></html>`,
    }),
  );
  const initializationError = new Promise<never>((_resolve, reject) => page.once('pageerror', reject));
  void initializationError.catch(() => {});
  await page.goto('/desktop-bundle-harness', { waitUntil: 'domcontentloaded' });
  await Promise.race([
    page.waitForFunction(() => Boolean((window as any).bundleHost), { timeout: 120_000 }),
    initializationError,
  ]);
  await page.locator('.file-menu-button').click();
  await page.getByRole('menuitem', { name: 'Open project', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).bundlePickerOptions));
  expect(await page.evaluate(() => (window as any).bundlePickerOptions.types)).toContainEqual({
    description: 'Rivet Bundle (rivet-bundle.json)',
    accept: { 'application/octet-stream': ['.json'] },
  });
  const childOutput = fixture.child.project.graphs[fixture.child.project.metadata.mainGraphId!]!.nodes.find(
    (node) => node.type === 'graphOutput',
  )!;
  // Manifest opening creates every tab; called dataflow survives inactive/active switching.
  await expect(page.locator('.projects-container .project')).toHaveCount(2);
  await expect(page.locator(`.node[data-nodeid="${subgraph.id}"]`)).toBeVisible();
  const targetLabel = page.locator(`.node[data-nodeid="${subgraph.id}"] .subgraph-node-body-select-wrap`);
  await expect(targetLabel).toHaveText(`${fixture.child.project.metadata.title} / ${childGraph.metadata!.name}`);
  expect(await targetLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByText('Run this target from an extracted bundle', { exact: false })).toHaveCount(0);
  await expect(page.getByText('This project target can only be edited or run in Rivet Studio Server.')).toHaveCount(0);
  // Reference discovery must retain the same binding as execution. Verify it
  // before Run so its reads cannot accidentally satisfy the regression.
  await page.waitForFunction(() =>
    (window as any).bundleReadRequests?.some(
      (request: any) =>
        request.path === '/bundle/projects/nested/root.rivet-project' &&
        request.manifestPath === '/bundle/rivet-bundle.json',
    ),
  );
  const run = page.locator('.run-button button').first();
  await run.click();
  await expect(page.locator(`.node[data-nodeid="${output.id}"]`)).toContainText('child-result');
  await expect(run).toBeEnabled();
  expect(
    await page.evaluate((id) => (window as any).bundleHost.activateProject(id), fixture.child.project.metadata.id),
  ).toBe(true);
  await expect(page.locator(`.node[data-nodeid="${childOutput.id}"]`)).toContainText('child-result');
  // Desktop activation names this saved project after its file. The tab also
  // displays the filename suffix, which is not part of the target label.
  await expect(page.locator('.projects-container .project.active .project-name')).toHaveText(
    'child [child.rivet-project]',
  );
  expect(
    await page.evaluate((id) => (window as any).bundleHost.activateProject(id), fixture.root.project.metadata.id),
  ).toBe(true);
  await expect(targetLabel).toHaveText(`${fixture.child.project.metadata.title} / ${childGraph.metadata!.name}`);
  await page.evaluate(() => {
    (window as any).bundleReadBlocked = false;
    (window as any).blockNextBundleRead = true;
  });
  expect(
    await page.evaluate(() =>
      (window as any).bundleHost.replaceProjectSnapshot((window as any).editedFixture.metadata.id, {
        project: { ...(window as any).editedFixture, references: [] },
        path: '/bundle/projects/nested/root.rivet-project',
      }),
    ),
  ).toBe(true);
  await page.waitForFunction(() => (window as any).bundleReadBlocked === true);
  // Snapshot refresh clears the previous reference definitions. Pending
  // discovery keeps the tab title without inventing a resolved graph name.
  await expect(targetLabel).toHaveText(`child / ${(subgraph as SubGraphNode).data.graphId}`);
  await page.evaluate(() => (window as any).releaseBundleRead());
  await expect(targetLabel).toHaveText(`${fixture.child.project.metadata.title} / ${childGraph.metadata!.name}`);
  await expect(page.locator(`.node[data-nodeid="${suffix.id}"]`)).toBeVisible();
  await run.click();
  await expect(page.locator(`.node[data-nodeid="${output.id}"]`)).toContainText('child-result + unsaved');
  await expect(page.locator('.Toastify__toast--error')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).bundleHost.saveCurrentProject())).toBe(true);
  expect(await page.evaluate(() => (window as any).savedBundlePath)).toBe('/bundle/projects/nested/root.rivet-project');
  await page.evaluate(() => {
    (window as any).bundleReadBlocked = false;
    (window as any).blockNextBundleRead = true;
  });
  await run.click();
  await page.waitForFunction(() => (window as any).bundleReadBlocked === true);
  await expect(run).toContainText('Abort');
  await run.click();
  await page.evaluate(() => (window as any).releaseBundleRead());
  await expect(run).not.toContainText('Abort');
  await expect(page.locator('.Toastify__toast--error')).toHaveCount(0);
  // A preflight error emits no GraphProcessor error event. It must still be
  // visible, release its run reservation, and allow a repaired bundle to run.
  await page.evaluate(() => {
    const manifest = JSON.parse((window as any).bundleFixture.manifestContents);
    manifest.targets = [];
    (window as any).bundleFixture.manifestContents = JSON.stringify(manifest);
  });
  await run.click();
  await expect(page.locator('.Toastify__toast--error')).toHaveCount(1);
  await expect(page.locator('.Toastify__toast--error')).toContainText('Bundle is missing Subgraph');
  await expect(run).not.toContainText('Abort');
  await page.evaluate((manifestContents) => {
    (window as any).bundleFixture.manifestContents = manifestContents;
  }, native.manifestContents);
  await run.click();
  await expect(page.locator(`.node[data-nodeid="${output.id}"]`)).toContainText('child-result + unsaved');
  await expect(run).not.toContainText('Abort');
  // Capture the entry data before a slow read. Selecting another tab's dataset
  // provider while loading must not change what the visible entry executes.
  const datasetProject = structuredClone(edited);
  const row = GetDatasetRowNodeImpl.create();
  row.data.datasetId = 'shared' as DatasetId;
  row.data.rowId = 'row';
  const rowOutput = GraphOutputNodeImpl.create();
  rowOutput.data.id = 'entryData';
  const rowText = TextNodeImpl.create();
  rowText.data.text = '{{row.data[0]}}';
  rowText.visualData.x = 350;
  rowOutput.visualData.x = 700;
  datasetProject.graphs[datasetProject.metadata.mainGraphId!]!.nodes = [row, rowText, rowOutput];
  datasetProject.graphs[datasetProject.metadata.mainGraphId!]!.connections = [
    { outputNodeId: row.id, outputId: 'row' as PortId, inputNodeId: rowText.id, inputId: 'row' as PortId },
    { outputNodeId: rowText.id, outputId: 'output' as PortId, inputNodeId: rowOutput.id, inputId: 'value' as PortId },
  ];
  await page.evaluate(async (project) => {
    const datasets = (window as any).bundleDatasets;
    await datasets.putDatasetMetadata({
      id: 'shared',
      projectId: project.metadata.id,
      name: 'Shared',
      description: '',
    });
    await datasets.putDatasetRow('shared', { id: 'row', data: ['entry-at-run-start'] });
    (window as any).bundleHost.replaceProjectSnapshot(project.metadata.id, {
      project,
      path: '/bundle/projects/nested/root.rivet-project',
    });
    (window as any).bundleReadBlocked = false;
    (window as any).blockNextBundleRead = true;
  }, datasetProject);
  await run.click();
  await page.waitForFunction(() => (window as any).bundleReadBlocked === true);
  await page.evaluate(async () => {
    const datasets = (window as any).bundleDatasets;
    await datasets.loadDatasets('other-tab');
    await datasets.putDatasetMetadata({ id: 'shared', projectId: 'other-tab', name: 'Shared', description: '' });
    await datasets.putDatasetRow('shared', { id: 'row', data: ['wrong-tab'] });
    (window as any).releaseBundleRead();
  });
  await expect(page.locator(`.node[data-nodeid="${rowOutput.id}"]`)).toContainText('entry-at-run-start');
  await expect(run).not.toContainText('Abort');

  // Aborting after bundle preparation, while resolving environment settings,
  // must not start the processor when that final asynchronous step completes.
  const cancelledProject = structuredClone(datasetProject);
  const cancelledText = TextNodeImpl.create();
  cancelledText.data.text = 'only-after-retry';
  const cancelledOutput = GraphOutputNodeImpl.create();
  cancelledOutput.data.id = 'cancelledResult';
  cancelledOutput.visualData.x = 350;
  cancelledProject.graphs[cancelledProject.metadata.mainGraphId!]!.nodes = [cancelledText, cancelledOutput];
  cancelledProject.graphs[cancelledProject.metadata.mainGraphId!]!.connections = [
    {
      outputNodeId: cancelledText.id,
      outputId: 'output' as PortId,
      inputNodeId: cancelledOutput.id,
      inputId: 'value' as PortId,
    },
  ];
  await page.evaluate(async (project) => {
    await (window as any).bundleDatasets.loadDatasets(project.metadata.id);
    (window as any).bundleHost.replaceProjectSnapshot(project.metadata.id, {
      project,
      path: '/bundle/projects/nested/root.rivet-project',
    });
    (window as any).environmentReadGate = new Promise<void>((resolve) => {
      (window as any).releaseEnvironmentRead = () => {
        (window as any).blockEnvironmentReads = false;
        resolve();
      };
    });
    (window as any).blockEnvironmentReads = true;
  }, cancelledProject);
  await run.click();
  await page.waitForFunction(() => (window as any).environmentReadBlocked === true);
  await expect(run).toContainText('Abort');
  await run.click();
  await page.evaluate(() => (window as any).releaseEnvironmentRead());
  await expect(run).not.toContainText('Abort');
  await expect(page.locator(`.node[data-nodeid="${cancelledOutput.id}"]`)).not.toContainText('only-after-retry');
  await run.click();
  await expect(page.locator(`.node[data-nodeid="${cancelledOutput.id}"]`)).toContainText('only-after-retry');
  await expect(run).not.toContainText('Abort');
  // Display replacement must fence old events, not cancel an accepted live
  // processor. The second code node proves execution continued after the gate.
  const acceptedProject = structuredClone(cancelledProject);
  const gate = CodeNodeImpl.create();
  gate.data.code = `window.bindingRunSteps.push('accepted');
    await window.bindingRunGate;
    return { output: { type: 'string', value: 'old-binding-result' } };`;
  gate.data.outputNames = ['output'];
  const continued = CodeNodeImpl.create();
  continued.data.code = `window.bindingRunSteps.push('continued'); return inputs;`;
  continued.data.inputNames = ['output'];
  continued.data.outputNames = ['output'];
  continued.visualData.x = 350;
  acceptedProject.graphs[acceptedProject.metadata.mainGraphId!]!.nodes = [gate, continued, cancelledOutput];
  acceptedProject.graphs[acceptedProject.metadata.mainGraphId!]!.connections = [
    { outputNodeId: gate.id, outputId: 'output' as PortId, inputNodeId: continued.id, inputId: 'output' as PortId },
    {
      outputNodeId: continued.id,
      outputId: 'output' as PortId,
      inputNodeId: cancelledOutput.id,
      inputId: 'value' as PortId,
    },
  ];
  await page.evaluate((project) => {
    (window as any).bindingRunSteps = [];
    (window as any).bindingRunGate = new Promise<void>((resolve) => {
      (window as any).releaseBindingRun = resolve;
    });
    (window as any).bundleHost.replaceProjectSnapshot(project.metadata.id, {
      project,
      path: '/bundle/projects/nested/root.rivet-project',
    });
  }, acceptedProject);
  await run.click();
  await expect.poll(() => page.evaluate(() => (window as any).bindingRunSteps)).toEqual(['accepted']);
  expect(
    await page.evaluate(
      (project) =>
        (window as any).bundleHost.replaceProjectSnapshot(project.metadata.id, {
          project,
          path: '/bundle/projects/nested/root.rivet-project',
        }),
      cancelledProject,
    ),
  ).toBe(true);
  await page.evaluate(() => (window as any).releaseBindingRun());
  await expect.poll(() => page.evaluate(() => (window as any).bindingRunSteps)).toEqual(['accepted', 'continued']);
  await expect(page.locator(`.node[data-nodeid="${cancelledOutput.id}"]`)).not.toContainText('old-binding-result');

  // A stale *preparation* has not accepted execution yet. Replacing its binding
  // while environment resolution is suspended must prevent it from starting.
  await page.evaluate((project) => {
    (window as any).bundleHost.replaceProjectSnapshot(project.metadata.id, {
      project,
      path: '/bundle/projects/nested/root.rivet-project',
    });
    (window as any).bindingRunSteps = [];
    (window as any).environmentReadBlocked = false;
    (window as any).environmentReadGate = new Promise<void>((resolve) => {
      (window as any).releaseEnvironmentRead = () => {
        (window as any).blockEnvironmentReads = false;
        resolve();
      };
    });
    (window as any).blockEnvironmentReads = true;
  }, acceptedProject);
  await run.click();
  await page.waitForFunction(() => (window as any).environmentReadBlocked === true);
  expect(
    await page.evaluate(
      (project) =>
        (window as any).bundleHost.replaceProjectSnapshot(project.metadata.id, {
          project,
          path: '/bundle/projects/nested/root.rivet-project',
        }),
      cancelledProject,
    ),
  ).toBe(true);
  await page.evaluate(() => (window as any).releaseEnvironmentRead());
  // A fresh command succeeds on the replacement after the old preparation
  // settles; none of the obsolete authored code may have run in the meantime.
  await run.click();
  await expect(page.locator(`.node[data-nodeid="${cancelledOutput.id}"]`)).toContainText('only-after-retry');
  expect(await page.evaluate(() => (window as any).bindingRunSteps)).toEqual([]);
});
