import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { serializeProject } from '@valerypopoff/rivet2-core';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { TauriIOProvider } from './TauriIOProvider.js';
import type { AppDatasetProvider } from '../providers/ProvidersContext.js';

/** Exercise the real Tauri API adapter without a native process or real files. */
function nativeFixture(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const project = createBlankProjectWithDefaultGraph();
  const calls: string[] = [];
  let failWrite = false;
  const runtime: Record<string, unknown> = { __TAURI__: {}, crypto: globalThis.crypto };
  runtime.__TAURI_IPC__ = (request: { callback: number; error: number; message: { cmd: string } }) => {
    const command = request.message.cmd;
    calls.push(command);
    const error = command === 'writeFile' && failWrite;
    const callback = runtime[`_${error ? request.error : request.callback}`] as (value: unknown) => void;
    callback(error ? 'native write failed' : command === 'readTextFile' ? serializeProject(project) : false);
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
    project,
    imports: () => imports,
    failWrite: () => {
      failWrite = true;
    },
  };
}

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
