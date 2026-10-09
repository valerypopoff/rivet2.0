import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { serializeProject } from '@valerypopoff/rivet2-core';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { TauriIOProvider } from './TauriIOProvider.js';
import type { AppDatasetProvider } from '../providers/ProvidersContext.js';

/** Exercise the real Tauri API adapter without a native process or real files. */
function nativeFixture(t: TestContext, asBundle = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const project = createBlankProjectWithDefaultGraph();
  const calls: string[] = [];
  const dialogs: { cmd: string; options?: { filters?: { name: string; extensions: string[] }[] } }[] = [];
  let selectedPath: string | null = asBundle ? '/fixture/rivet-bundle.json' : '/fixture/project.rivet-project';
  let failWrite = false;
  const runtime: Record<string, unknown> = { __TAURI__: {}, crypto: globalThis.crypto };
  runtime.__TAURI_IPC__ = (request: {
    callback: number;
    error: number;
    cmd?: string;
    message?: { cmd: string; options?: { filters?: { name: string; extensions: string[] }[] } };
  }) => {
    const command = request.message?.cmd ?? request.cmd!;
    calls.push(command);
    if (command === 'openDialog' || command === 'saveDialog') dialogs.push(request.message!);
    const error = command === 'writeFile' && failWrite;
    const callback = runtime[`_${error ? request.error : request.callback}`] as (value: unknown) => void;
    callback(
      error
        ? 'native write failed'
        : command === 'openDialog' || command === 'saveDialog'
          ? selectedPath
          : command === 'read_project_bundle' && asBundle
            ? {
                manifestPath: '/fixture/rivet-bundle.json',
                selectedProjectPath: null,
                manifestContents: JSON.stringify({
                  format: 'rivet-project-bundle',
                  schemaVersion: 1,
                  requiredLoaderVersion: 2,
                  exportingRuntimeVersion: 'fixture',
                  rootArtifact: 'root',
                  targets: [],
                  references: [],
                  plugins: [],
                  artifacts: [
                    {
                      id: 'root',
                      projectId: project.metadata.id,
                      title: project.metadata.title,
                      version: 'latest',
                      revision: 'original',
                      project: { path: 'projects/root.rivet-project' },
                    },
                  ],
                }),
                files: [
                  {
                    path: 'projects/root.rivet-project',
                    sourceProjectPath: '/fixture/projects/root.rivet-project',
                    contents: serializeProject(project),
                  },
                ],
              }
            : command === 'readTextFile'
              ? serializeProject(project)
              : false,
    );
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: runtime });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  let imports = 0;
  const provider = new TauriIOProvider(
    {
      importDatasetsForProject: async () => {
        imports++;
      },
      exportDatasetsForProject: async () => [],
    } as unknown as AppDatasetProvider,
    { allowDataFileNeighbor: async () => {} },
  );
  return {
    provider,
    calls,
    dialogs,
    cancelDialog: () => {
      selectedPath = null;
    },
    project,
    imports: () => imports,
    failWrite: () => {
      failWrite = true;
    },
  };
}

test('native Open picker offers project and explicit bundle filters and opens a selected JSON manifest', async (t) => {
  const fixture = nativeFixture(t, true);
  let loadedPath: string | undefined;
  await fixture.provider.loadProjectData(
    (loaded) => {
      loadedPath = loaded.path;
      assert.equal(loaded.project.metadata.id, fixture.project.metadata.id);
      assert.equal(fixture.imports(), 0);
    },
    { deferCommit: true },
  );
  assert.equal(loadedPath, '/fixture/projects/root.rivet-project');
  assert.deepEqual(fixture.calls, ['openDialog', 'read_project_bundle']);
  assert.deepEqual(fixture.dialogs[0]?.options?.filters, [
    { name: 'Rivet Project or Bundle', extensions: ['rivet-project', 'json'] },
    { name: 'Rivet Bundle (rivet-bundle.json)', extensions: ['json'] },
    { name: 'Rivet Project', extensions: ['rivet-project'] },
  ]);
});

test('cancelling the native Open picker performs no project reads or dataset imports', async (t) => {
  const fixture = nativeFixture(t, true);
  fixture.cancelDialog();
  await fixture.provider.loadProjectData(() => assert.fail('Cancelled picker must not open a project'));
  assert.deepEqual(fixture.calls, ['openDialog']);
  assert.equal(fixture.imports(), 0);
});

test('native Save picker stays project-only', async (t) => {
  const fixture = nativeFixture(t, true);
  fixture.cancelDialog();
  await fixture.provider.saveProjectData(fixture.project);
  assert.deepEqual(fixture.dialogs[0]?.options?.filters, [{ name: 'Rivet Project', extensions: ['rivet-project'] }]);
  assert.deepEqual(fixture.calls, ['saveDialog']);
});

test('native reads prepare datasets without side effects and honor guarded commit', async (t) => {
  const fixture = nativeFixture(t);
  const controller = new AbortController();
  const result = await fixture.provider.loadProjectDataNoPrompt('fixture.rivet-project', {
    deferCommit: true,
    signal: controller.signal,
  });
  assert.equal(result.project.metadata.id, fixture.project.metadata.id);
  assert.equal(fixture.imports(), 0);
  assert.equal(await result.commit!(() => false), false);
  assert.equal(fixture.imports(), 0);
  assert.equal(await result.commit!(() => true), true);
  assert.equal(fixture.imports(), 1);
  controller.abort();
  assert.equal(await result.commit!(() => true), false);
  assert.equal(fixture.imports(), 1);
});

test('opening a native bundle manifest returns its actual project save path and imports only after guarded commit', async (t) => {
  const fixture = nativeFixture(t, true);
  const result = await fixture.provider.loadProjectDataNoPrompt('/fixture/rivet-bundle.json', { deferCommit: true });
  assert.equal(result.path, '/fixture/projects/root.rivet-project');
  assert.equal(result.project.metadata.id, fixture.project.metadata.id);
  assert.equal(fixture.imports(), 0);
  assert.equal(await result.commit!(() => true), true);
  assert.equal(fixture.imports(), 1);
  assert.deepEqual(fixture.calls, ['read_project_bundle']);
});

test('a pre-cancelled native load performs no filesystem IO', async (t) => {
  const fixture = nativeFixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fixture.provider.loadProjectDataNoPrompt('fixture.rivet-project', { signal: controller.signal }),
    /abort/i,
  );
  assert.deepEqual(fixture.calls, []);
});

test('native save rejects a failed write instead of acknowledging persistence', async (t) => {
  const fixture = nativeFixture(t);
  fixture.failWrite();
  await assert.rejects(
    fixture.provider.saveProjectDataNoPrompt(fixture.project, 'fixture.rivet-project'),
    (error) => error === 'native write failed',
  );
  assert.deepEqual(fixture.calls, ['writeFile']);
});
