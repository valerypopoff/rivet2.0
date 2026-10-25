import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createStore, Provider } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { ProvidersProvider, type ProviderOverrides } from '../providers/ProvidersContext.js';
import { ExecutorSessionProvider } from '../providers/ExecutorSessionContext.js';
import { graphState } from '../state/graph.js';
import { selectedExecutorState } from '../state/settings.js';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  projectState,
  projectsState,
  projectUnsavedChangesState,
} from '../state/savedGraphs.js';
import { configureHybridStorageBackend, MemoryAsyncStorage } from '../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { addOpenedProject, removeOpenedProject } from '../utils/openedProjects.js';
import { useSyncCurrentStateIntoOpenedProjects } from './useSyncCurrentStateIntoOpenedProjects.js';

async function mount(t: TestContext, providers?: ProviderOverrides) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const keys = ['React', 'document', 'localStorage', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [React, dom.window.document, dom.window.localStorage, dom.window.navigator, dom.window, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  const oldStorage = configureHybridStorageBackend(new MemoryAsyncStorage());
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      configureHybridStorageBackend(oldStorage);
      keys.forEach((key, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
      dom.window.close();
    }
  });
  const store = createStore();
  const project = createBlankProjectWithDefaultGraph();
  project.metadata.title = 'Authored title';
  store.set(projectState, project);
  store.set(graphState, project.graphs[project.metadata.mainGraphId!]!);
  store.set(loadedProjectState, { loaded: true, path: 'Saved.rivet-project' });
  store.set(
    projectsState,
    addOpenedProject({ openedProjects: {}, openedProjectsSortedIds: [] }, project, { fsPath: 'Saved.rivet-project' }),
  );
  store.set(openedProjectSnapshotsState, { [project.metadata.id]: { project, data: undefined } });
  function Harness({ enabled, beforeSync }: { enabled: boolean; beforeSync?: () => void }) {
    React.useLayoutEffect(() => {
      beforeSync?.();
    }, [beforeSync]);
    useSyncCurrentStateIntoOpenedProjects({ enabled });
    return null;
  }
  const render = async (enabled = true, beforeSync?: () => void) =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <ProvidersProvider providers={providers}>
            <ExecutorSessionProvider>
              <Harness enabled={enabled} beforeSync={beforeSync} />
            </ExecutorSessionProvider>
          </ProvidersProvider>
        </Provider>,
      ),
    );
  return { store, project, render };
}

test('a project switch between render and effect cannot persist the previous tab executor into the new tab', async (t) => {
  const { store, render } = await mount(t, { openedProjectSync: { mode: 'explicit-tabs' } });
  const other = createBlankProjectWithDefaultGraph();
  const nodeMode = { type: 'local', executor: 'nodejs' } as const;
  store.set(selectedExecutorState, 'browser');
  store.set(projectsState, (previous) =>
    addOpenedProject(previous, other, { fsPath: 'Other.rivet-project', executorMode: nodeMode }),
  );
  store.set(openedProjectSnapshotsState, (previous) => ({
    ...previous,
    [other.metadata.id]: { project: other, data: undefined },
  }));
  const observedModes: unknown[] = [];
  const unsubscribe = store.sub(projectsState, () =>
    observedModes.push(store.get(projectsState).openedProjects[other.metadata.id]?.executorMode),
  );
  t.after(unsubscribe);
  await render(true, () => {
    store.set(projectState, other);
    store.set(graphState, other.graphs[other.metadata.mainGraphId!]!);
    store.set(loadedProjectState, { loaded: true, path: 'Other.rivet-project' });
    store.set(selectedExecutorState, 'nodejs');
  });
  for (const mode of observedModes) {
    assert.deepEqual(mode, nodeMode, 'Even intermediate persisted metadata must belong to the new tab');
  }
  assert.deepEqual(store.get(projectsState).openedProjects[other.metadata.id]!.executorMode, nodeMode);
});

for (const mode of ['default', 'explicit'] as const) {
  test(`${mode} synchronization preserves authored content, dirty state and stable registry identity`, async (t) => {
    const notifications: ProjectId[][] = [];
    const fixture = await mount(
      t,
      mode === 'explicit'
        ? {
            openedProjectSync: {
              mode: 'explicit-tabs',
              resolveTitle: () => 'Host title',
              onOpenProjectIdsChanged: (ids) => notifications.push([...ids]),
            },
          }
        : undefined,
    );
    await fixture.render();
    const { store, project } = fixture;
    const first = store.get(projectsState);
    assert.equal(
      first.openedProjects[project.metadata.id]!.title,
      mode === 'explicit' ? 'Host title' : 'Authored title',
    );
    assert.equal(store.get(projectState), project);
    assert.equal(store.get(projectUnsavedChangesState)[project.metadata.id], true, 'No saved baseline is manufactured');
    await fixture.render();
    assert.equal(store.get(projectsState), first);
    if (mode === 'explicit') assert.deepEqual(notifications.at(-1), [project.metadata.id]);
    await act(async () => store.set(selectedExecutorState, 'nodejs'));
    assert.deepEqual(store.get(projectsState).openedProjects[project.metadata.id]!.executorMode, {
      type: 'local',
      executor: 'nodejs',
    });
    await act(async () => store.set(selectedExecutorState, 'browser'));
    assert.equal(store.get(projectState), project, 'Executor selection cannot rewrite authored content');
  });
}

for (const explicit of [false, true]) {
  test(`${explicit ? 'explicit' : 'default'} mode preserves its scratch registration policy`, async (t) => {
    const fixture = await mount(t, explicit ? { openedProjectSync: { mode: 'explicit-tabs' } } : undefined);
    fixture.store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
    fixture.store.set(loadedProjectState, { loaded: false, path: '' });
    await fixture.render();
    assert.deepEqual(
      fixture.store.get(projectsState).openedProjectsSortedIds,
      explicit ? [] : [fixture.project.metadata.id],
    );
  });
}

test('explicit tab closure prunes its snapshot/cache identity and never resurrects the active scratch project', async (t) => {
  const notifications: ProjectId[][] = [];
  const { store, project, render } = await mount(t, {
    openedProjectSync: {
      mode: 'explicit-tabs',
      onOpenProjectIdsChanged: (ids) => notifications.push([...ids]),
    },
  });
  await render();
  await act(async () => store.set(projectsState, (previous) => removeOpenedProject(previous, project.metadata.id)));
  assert.deepEqual(store.get(projectsState).openedProjectsSortedIds, []);
  assert.deepEqual(store.get(openedProjectSnapshotsState), {});
  assert.equal(store.get(loadedProjectState).path, '');
  assert.deepEqual(notifications.at(-1), []);
  await render();
  assert.deepEqual(store.get(projectsState).openedProjectsSortedIds, []);
  await act(async () =>
    store.set(projectsState, (previous) => addOpenedProject(previous, project, { fsPath: 'Saved.rivet-project' })),
  );
  assert.deepEqual(
    store.get(projectsState).openedProjectsSortedIds,
    [project.metadata.id],
    'An explicit reopen is accepted',
  );
});

test('recovering a legacy active file without tab metadata keeps the loaded path coherent', async (t) => {
  const { store, project, render } = await mount(t, { openedProjectSync: { mode: 'explicit-tabs' } });
  store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
  store.set(openedProjectSnapshotsState, {});
  await render();
  assert.deepEqual(store.get(projectsState).openedProjectsSortedIds, [project.metadata.id]);
  assert.equal(store.get(projectsState).openedProjects[project.metadata.id]!.fsPath, 'Saved.rivet-project');
  assert.deepEqual(store.get(loadedProjectState), { loaded: true, path: 'Saved.rivet-project' });
});

for (const timing of ['before-first-effect', 'while-disabled'] as const) {
  test(`closing the active tab ${timing} cannot be mistaken for legacy recovery`, async (t) => {
    const { store, project, render } = await mount(t, { openedProjectSync: { mode: 'explicit-tabs' } });
    const close = () => store.set(projectsState, (previous) => removeOpenedProject(previous, project.metadata.id));
    if (timing === 'before-first-effect') await render(true, close);
    else {
      await render(false);
      await act(async () => close());
      await render(true);
    }
    assert.deepEqual(store.get(projectsState).openedProjectsSortedIds, []);
    assert.equal(store.get(loadedProjectState).path, '');
    assert.deepEqual(store.get(openedProjectSnapshotsState), {});
  });
}

test('disabled synchronization is inert until enabled and never borrows another tab path/graph', async (t) => {
  const { store, project, render } = await mount(t, {
    openedProjectSync: { mode: 'explicit-tabs', resolveTitle: (_project, path) => path ?? 'Scratch' },
  });
  const other = createBlankProjectWithDefaultGraph();
  store.set(projectsState, (previous) => addOpenedProject(previous, other, { fsPath: 'Other.rivet-project' }));
  store.set(openedProjectSnapshotsState, (previous) => ({
    ...previous,
    [other.metadata.id]: { project: other, data: undefined },
  }));
  store.set(loadedProjectState, { loaded: true, path: 'Other.rivet-project' });
  store.set(graphState, other.graphs[other.metadata.mainGraphId!]!);
  const before = store.get(projectsState);
  await render(false);
  assert.equal(store.get(projectsState), before);
  await render();
  const info = store.get(projectsState).openedProjects[project.metadata.id]!;
  assert.equal(info.fsPath, 'Saved.rivet-project');
  assert.equal(info.title, 'Saved.rivet-project');
  assert.equal(info.openedGraph, project.metadata.mainGraphId);
});
