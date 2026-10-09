import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Provider, createStore } from 'jotai';
import { createEmptyEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import type { DataId, GraphId } from '@valerypopoff/rivet2-core';
import type { PathBasedIOProvider } from '../io/IOProvider.js';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import { MemoryStaticDataStore } from '../providers/StaticDataStore.js';
import { ExecutorSessionProvider } from '../providers/ExecutorSessionContext.js';
import { HostCallbacksProvider } from '../providers/HostCallbacksContext.js';
import { graphState } from '../state/graph.js';
import { selectedOpeningProjectTabIdState } from '../state/openingProjectTabs.js';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  projectDataState,
  projectDataUnsavedChangesState,
  projectState,
  projectsState,
  projectUnsavedChangesState,
  savedProjectContentDigestsState,
} from '../state/savedGraphs.js';
import {
  configureHybridStorageBackend,
  flushHybridStorageGroup,
  getWorkspaceRecoveryStorage,
  MemoryAsyncStorage,
} from '../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { addOpenedProject } from '../utils/openedProjects.js';
import { useLoadProject } from './useLoadProject.js';
import { useBundleExecutionRouting } from './useBundleExecutionRouting.js';
import { useLoadProjectWithFileBrowser } from './useLoadProjectWithFileBrowser.js';
import { useWorkspaceHostCloseProject } from './workspaceHost/useWorkspaceHostCloseProject.js';
import { useWorkspaceHostOpenProject } from './workspaceHost/useWorkspaceHostOpenProject.js';
import { useWorkspaceHostOpeningTabs } from './workspaceHost/useWorkspaceHostOpeningTabs.js';
import { useWorkspaceHostProjectMetadata } from './workspaceHost/useWorkspaceHostProjectMetadata.js';
import { useSyncProjectDirtyState } from './useSyncProjectDirtyState.js';
import { useWorkspaceHostCleanBaseline } from './workspaceHost/useWorkspaceHostCleanBaseline.js';
import { useSetStaticData } from './useSetStaticData.js';
import { useLoadStaticData } from './useLoadStaticData.js';
import { runLatestProjectActivation } from '../utils/projectActivationCoordinator.js';
import { getOrCreateCodeEditorModel, clearCodeEditorModelCache } from '../utils/monaco/codeEditorModelCache.js';
import { markProjectClean } from '../utils/projectUnsavedChanges.js';
import { evaluationLibraryState } from '../state/evaluations.js';
import {
  createEmptyProjectExecutionSnapshot,
  graphStartTimeState,
  lastRunDataByNodeState,
  projectExecutionSnapshotsState,
} from '../state/dataFlow.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('file-picker reopening an existing project activates it without importing saved data or clearing live edits', async () => {
  const fixture = await mount(async () => {
    throw new Error('Unexpected path load');
  });
  let commits = 0;
  fixture.io.loadProjectData = async (callback, options) => {
    assert.equal(options?.deferCommit, true);
    await callback({
      project: fixture.a,
      path: 'a.rivet-project',
      evaluation: {
        evaluationData: createEmptyEvaluationProjectData(),
        evaluationDatasets: [],
      },
      commit: async () => {
        commits++;
        return true;
      },
    });
  };
  try {
    await act(async () => fixture.openFile());
    assert.equal(commits, 0);
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Unsaved live edit');
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('a file-picker result after a newer tab selection cannot import or open its project', async () => {
  const fixture = await mount(async () => {
    throw new Error('Unexpected path load');
  });
  const gate = deferred();
  let commits = 0;
  fixture.io.loadProjectData = async (callback) => {
    await gate.promise;
    await callback({
      project: createBlankProjectWithDefaultGraph(),
      path: 'new.rivet-project',
      evaluation: {
        evaluationData: createEmptyEvaluationProjectData(),
        evaluationDatasets: [],
      },
      commit: async () => {
        commits++;
        return true;
      },
    });
  };
  try {
    const opening = fixture.openFile();
    await act(async () => fixture.activate(fixture.info(fixture.a.metadata.id)));
    gate.resolve();
    await act(async () => opening);
    assert.equal(commits, 0);
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(Object.keys(fixture.store.get(projectsState).openedProjects).length, 2);
  } finally {
    await fixture.cleanup();
  }
});

async function mount(load: PathBasedIOProvider['loadProjectDataNoPrompt']) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const keys = ['React', 'document', 'localStorage', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [React, dom.window.document, dom.window.localStorage, dom.window.navigator, dom.window, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  const storage = new MemoryAsyncStorage();
  const previousStorage = configureHybridStorageBackend(storage);
  const store = createStore();
  const a = createBlankProjectWithDefaultGraph();
  const b = createBlankProjectWithDefaultGraph();
  const aPath = 'a.rivet-project';
  const bPath = 'b.rivet-project';
  store.set(projectState, a);
  store.set(projectDataState, undefined);
  store.set(graphState, {
    ...a.graphs[a.metadata.mainGraphId as GraphId]!,
    metadata: {
      ...a.graphs[a.metadata.mainGraphId as GraphId]!.metadata!,
      description: 'Unsaved live edit',
    },
  });
  store.set(loadedProjectState, { loaded: true, path: aPath });
  store.set(
    projectsState,
    addOpenedProject(
      addOpenedProject({ openedProjects: {}, openedProjectsSortedIds: [] }, a, {
        fsPath: aPath,
      }),
      b,
      { fsPath: bPath },
    ),
  );
  store.set(openedProjectSnapshotsState, { [b.metadata.id]: { project: b, data: undefined } });
  store.set(savedProjectContentDigestsState, markProjectClean({}, { project: a }));
  store.set(projectUnsavedChangesState, {});
  const staticData = new MemoryStaticDataStore();
  const io: PathBasedIOProvider = {
    async loadGraphData() {},
    async loadProjectData() {},
    async loadRecordingData() {},
    async readFileAsBinary() {},
    async readFileAsString() {},
    async saveGraphData() {},
    async saveProjectData() {
      return undefined;
    },
    async saveProjectDataNoPrompt() {},
    async saveString() {},
    async openDirectory() {
      return null;
    },
    async openFilePath() {
      return '';
    },
    async readPathAsString() {
      return '';
    },
    async readPathAsBinary() {
      return new Uint8Array();
    },
    loadProjectDataNoPrompt: load,
  };
  let activate!: ReturnType<typeof useLoadProject>;
  let routeBundle!: ReturnType<typeof useBundleExecutionRouting>;
  let openFile!: ReturnType<typeof useLoadProjectWithFileBrowser>;
  let closeProject!: ReturnType<typeof useWorkspaceHostCloseProject>;
  let open!: ReturnType<typeof useWorkspaceHostOpenProject>;
  let opening!: ReturnType<typeof useWorkspaceHostOpeningTabs>;
  let metadata!: ReturnType<typeof useWorkspaceHostProjectMetadata>;
  let baseline!: ReturnType<typeof useWorkspaceHostCleanBaseline>;
  let setStaticData!: ReturnType<typeof useSetStaticData>;
  function StaticDataRecovery() {
    useLoadStaticData();
    return null;
  }
  const errors: unknown[] = [];
  function Harness() {
    activate = useLoadProject();
    routeBundle = useBundleExecutionRouting();
    openFile = useLoadProjectWithFileBrowser();
    closeProject = useWorkspaceHostCloseProject();
    open = useWorkspaceHostOpenProject();
    opening = useWorkspaceHostOpeningTabs(open.openProjectSnapshot);
    metadata = useWorkspaceHostProjectMetadata();
    baseline = useWorkspaceHostCleanBaseline();
    setStaticData = useSetStaticData();
    useSyncProjectDirtyState(true);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  const render = (recoverStaticData = false) =>
    root.render(
      <Provider store={store}>
        <ProvidersProvider providers={{ io, staticData }}>
          <HostCallbacksProvider callbacks={{ onOpenError: (event) => errors.push(event.error) }}>
            <ExecutorSessionProvider>
              <Harness />
              {recoverStaticData && <StaticDataRecovery />}
            </ExecutorSessionProvider>
          </HostCallbacksProvider>
        </ProvidersProvider>
      </Provider>,
    );
  await act(async () => render());
  const restoreStaticData = () => act(async () => render(true));
  return {
    a,
    b,
    store,
    staticData,
    storage,
    errors,
    activate,
    routeBundle,
    openFile,
    io,
    closeProject,
    open,
    opening,
    metadata,
    baseline,
    restoreStaticData,
    get setStaticData() {
      return setStaticData;
    },
    info: (id: typeof a.metadata.id) => store.get(projectsState).openedProjects[id]!,
    async cleanup() {
      await act(async () => root.unmount());
      configureHybridStorageBackend(previousStorage);
      keys.forEach((key, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
      dom.window.close();
    },
  };
}

const evaluation = { evaluationData: createEmptyEvaluationProjectData(), evaluationDatasets: [] };

test('bundle execution targets inactive and active dependency tabs without taking run ownership', async () => {
  const fixture = await mount(async () => {
    throw new Error('Unexpected read');
  });
  const childGraph = fixture.b.graphs[fixture.b.metadata.mainGraphId!]!;
  const node = { id: 'shared-node', type: 'text', data: { text: 'result' } };
  const execution = {
    projectId: fixture.b.metadata.id,
    graphId: childGraph.metadata!.id,
    rootRunId: 'root-run',
    graphRunId: 'child-run',
    parentGraphRunId: 'entry-run',
    projectScope: 'child:latest',
  };
  try {
    await act(async () => fixture.baseline.markProjectClean(fixture.b.metadata.id, { project: fixture.b }));
    fixture.store.set(projectsState, (previous) => ({
      ...previous,
      openedProjects: Object.fromEntries(
        Object.entries(previous.openedProjects).map(([id, info]) => [
          id,
          { ...info, bundleManifestPath: 'rivet-bundle.json' },
        ]),
      ),
    }));
    await act(async () => {
      fixture.routeBundle(fixture.a.metadata.id, 'graphStart', { graph: childGraph, execution } as never);
      fixture.routeBundle(fixture.a.metadata.id, 'nodeFinish', {
        node,
        processId: 'process',
        outputs: { output: { type: 'string', value: 'first' } },
        execution,
      } as never);
    });
    const inactive = fixture.store.get(projectExecutionSnapshotsState)[fixture.b.metadata.id]!;
    assert.equal(inactive.lastRunDataByNode['shared-node' as never]![0]!.parentGraphRunId, undefined);
    assert.equal(inactive.graphRunning, false, 'dependency display is not an independent root run');
    assert.equal(
      fixture.store.get(lastRunDataByNodeState)['shared-node' as never],
      undefined,
      'caller canvas remains isolated',
    );
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.b.metadata.id)), true));
    await act(async () =>
      fixture.routeBundle(fixture.a.metadata.id, 'nodeFinish', {
        node,
        processId: 'process',
        outputs: { output: { type: 'string', value: 'second' } },
        execution,
      } as never),
    );
    assert.equal(fixture.store.get(lastRunDataByNodeState)['shared-node' as never]![0]!.data.status?.type, 'ok');
    assert.deepEqual(
      fixture.store.get(lastRunDataByNodeState)['shared-node' as never]![0]!.data.outputData?.['output' as never],
      {
        type: 'string',
        storage: 'inline',
        value: 'second',
      },
    );
    const beforeReplay = fixture.store.get(lastRunDataByNodeState);
    await act(async () =>
      fixture.routeBundle(fixture.a.metadata.id, 'nodeFinish', {
        node,
        processId: 'replay',
        outputs: {},
        execution,
        replayRecordedAt: 1,
      } as never),
    );
    assert.equal(
      fixture.store.get(lastRunDataByNodeState),
      beforeReplay,
      'replay is not projected as a live bundle run',
    );
    fixture.store.set(projectsState, (previous) => ({
      ...previous,
      openedProjects: {
        ...previous.openedProjects,
        [fixture.b.metadata.id]: {
          ...previous.openedProjects[fixture.b.metadata.id]!,
          bundleManifestPath: 'other-bundle.json',
        },
      },
    }));
    await act(async () =>
      fixture.routeBundle(fixture.a.metadata.id, 'nodeFinish', {
        node,
        processId: 'foreign',
        outputs: {},
        execution,
      } as never),
    );
    assert.equal(fixture.store.get(lastRunDataByNodeState), beforeReplay, 'unrelated bundles are excluded');
  } finally {
    await fixture.cleanup();
  }
});

test('manifest opening adds every missing tab, selects root and preserves existing edits and baselines', async () => {
  const child = createBlankProjectWithDefaultGraph();
  const childEvaluation = {
    ...evaluation,
    evaluationDatasets: [{ id: 'child-dataset', name: 'Child', fields: [], cases: [] }],
  };
  const fixture = await mount(async () => {
    throw new Error('Unexpected read');
  });
  let skipped: ReadonlySet<typeof child.metadata.id> | undefined;
  const root = createBlankProjectWithDefaultGraph();
  fixture.io.loadProjectDataNoPrompt = async () => ({
    path: 'root.rivet-project',
    project: root,
    evaluation,
    bundleManifestPath: 'rivet-bundle.json',
    bundleProjects: [
      { project: root, path: 'root.rivet-project', evaluation },
      { project: fixture.a, path: 'a.rivet-project', evaluation },
      { project: child, path: 'child.rivet-project', evaluation: childEvaluation },
    ],
    commit: async (_isCurrent, skip) => {
      skipped = skip;
      return true;
    },
  });
  try {
    await act(async () => assert.equal(await fixture.open.openProjectPath('rivet-bundle.json'), true));
    assert.equal(fixture.store.get(projectState).metadata.id, root.metadata.id);
    assert.equal(fixture.store.get(projectsState).openedProjectsSortedIds.length, 4);
    assert.equal(fixture.info(child.metadata.id).bundleManifestPath, 'rivet-bundle.json');
    assert.ok(fixture.store.get(savedProjectContentDigestsState)[child.metadata.id]);
    assert.ok(fixture.store.get(evaluationLibraryState).migratedLegacyProjectIds.includes(child.metadata.id));
    assert.ok(fixture.store.get(evaluationLibraryState).datasets.some((dataset) => dataset.name === 'Child'));
    assert.ok(skipped!.has(fixture.a.metadata.id));
    assert.equal(
      fixture.store.get(openedProjectSnapshotsState)[fixture.a.metadata.id]!.project.graphs[
        fixture.a.metadata.mainGraphId!
      ]!.metadata!.description,
      'Unsaved live edit',
    );
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.a.metadata.id)), true));
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Unsaved live edit');
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('manifest reopening an already active root uses one activation intent and preserves live edits', async () => {
  const fixture = await mount(async () => {
    throw new Error('Unexpected read');
  });
  const child = createBlankProjectWithDefaultGraph();
  fixture.store.set(selectedOpeningProjectTabIdState, 'loading-tab');
  fixture.io.loadProjectDataNoPrompt = async () => ({
    project: fixture.a,
    path: 'a.rivet-project',
    evaluation,
    bundleManifestPath: 'rivet-bundle.json',
    bundleProjects: [
      { project: fixture.a, path: 'a.rivet-project', evaluation },
      { project: child, path: 'child.rivet-project', evaluation },
    ],
    commit: async (isCurrent, skip) => {
      assert.ok(skip?.has(fixture.a.metadata.id));
      return isCurrent();
    },
  });
  try {
    await act(async () => assert.equal(await fixture.open.openProjectPath('rivet-bundle.json'), true));
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Unsaved live edit');
    assert.equal(fixture.store.get(projectsState).openedProjectsSortedIds.length, 3);
    assert.equal(fixture.info(child.metadata.id).bundleManifestPath, 'rivet-bundle.json');
    assert.equal(fixture.store.get(selectedOpeningProjectTabIdState), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('superseding an inactive bundle root activation cannot add its dependency tabs later', async () => {
  const fixture = await mount(async () => {
    throw new Error('Unexpected read');
  });
  const child = createBlankProjectWithDefaultGraph();
  const started = deferred(),
    gate = deferred();
  fixture.io.loadProjectDataNoPrompt = async (path) => {
    if (path === 'b.rivet-project') {
      started.resolve();
      await gate.promise;
      return { project: fixture.b, evaluation };
    }
    return {
      project: fixture.b,
      path: 'b.rivet-project',
      evaluation,
      bundleManifestPath: 'rivet-bundle.json',
      bundleProjects: [
        { project: fixture.b, path: 'b.rivet-project', evaluation },
        { project: child, path: 'child.rivet-project', evaluation },
      ],
      commit: async (isCurrent) => isCurrent(),
    };
  };
  try {
    await act(async () => {
      const pending = fixture.open.openProjectPath('rivet-bundle.json');
      await started.promise;
      assert.equal(await fixture.activate(fixture.info(fixture.a.metadata.id)), true);
      gate.resolve();
      assert.equal(await pending, false);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.store.get(projectsState).openedProjects[child.metadata.id], undefined);
    assert.equal(fixture.info(fixture.b.metadata.id).bundleManifestPath, undefined);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('closing or moving a bundle member during import prevents late workspace registration', async () => {
  for (const change of ['close', 'move'] as const) {
    const fixture = await mount(async () => {
      throw new Error('Unexpected read');
    });
    const root = createBlankProjectWithDefaultGraph();
    const started = deferred(),
      gate = deferred();
    fixture.io.loadProjectDataNoPrompt = async () => ({
      project: root,
      path: 'root.rivet-project',
      evaluation,
      bundleManifestPath: 'rivet-bundle.json',
      bundleProjects: [
        { project: root, path: 'root.rivet-project', evaluation },
        { project: fixture.b, path: 'b.rivet-project', evaluation },
      ],
      commit: async (isCurrent) => {
        started.resolve();
        await gate.promise;
        return isCurrent();
      },
    });
    try {
      await act(async () => {
        const pending = fixture.open.openProjectPath('rivet-bundle.json');
        await started.promise;
        fixture.store.set(projectsState, (previous) => {
          const openedProjects = { ...previous.openedProjects };
          if (change === 'close') delete openedProjects[fixture.b.metadata.id];
          else
            openedProjects[fixture.b.metadata.id] = {
              ...openedProjects[fixture.b.metadata.id]!,
              fsPath: 'moved.rivet-project',
            };
          return {
            ...previous,
            openedProjects,
            openedProjectsSortedIds: previous.openedProjectsSortedIds.filter(
              (id) => change !== 'close' || id !== fixture.b.metadata.id,
            ),
          };
        });
        gate.resolve();
        assert.equal(await pending, false);
      });
      assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
      assert.equal(fixture.store.get(projectsState).openedProjects[root.metadata.id], undefined);
      assert.equal(fixture.info(fixture.a.metadata.id).bundleManifestPath, undefined);
    } finally {
      gate.resolve();
      await fixture.cleanup();
    }
  }
});

test('conflicting bundle identity rejects the complete workspace before importing any datasets', async () => {
  const fixture = await mount(async () => {
    throw new Error('Unexpected read');
  });
  const root = createBlankProjectWithDefaultGraph();
  let imports = 0;
  fixture.io.loadProjectDataNoPrompt = async () => ({
    project: root,
    path: 'root.rivet-project',
    evaluation,
    bundleManifestPath: 'rivet-bundle.json',
    bundleProjects: [
      { project: root, path: 'root.rivet-project', evaluation },
      { project: fixture.a, path: 'different/a.rivet-project', evaluation },
    ],
    commit: async () => {
      imports++;
      return true;
    },
  });
  try {
    await act(async () => assert.equal(await fixture.open.openProjectPath('rivet-bundle.json'), false));
    assert.equal(imports, 0);
    assert.equal(fixture.store.get(projectsState).openedProjectsSortedIds.length, 2);
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.errors.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('selecting the active tab cancels delayed restore and keeps its live edits', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = await mount(async () => {
    started.resolve();
    await gate.promise;
    return { project: fixture.b, evaluation };
  });
  try {
    await act(async () => {
      const pending = fixture.activate(fixture.info(fixture.b.metadata.id));
      await started.promise;
      const latest = fixture.activate(fixture.info(fixture.a.metadata.id));
      gate.resolve();
      assert.deepEqual(await Promise.all([pending, latest]), [false, true]);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Unsaved live edit');
    assert.equal(fixture.store.get(loadedProjectState).path, 'a.rivet-project');
  } finally {
    await fixture.cleanup();
  }
});

test('closing the current tab does not override a newer selection or clear its execution state', async () => {
  const gate = deferred();
  const started = deferred();
  const c = createBlankProjectWithDefaultGraph();
  const loads: string[] = [];
  const fixture = await mount(async (path) => {
    loads.push(path);
    if (path === 'b.rivet-project') {
      started.resolve();
      await gate.promise;
      return { project: fixture.b, evaluation };
    }
    return { project: c, evaluation };
  });
  try {
    await act(async () => {
      fixture.store.set(
        projectsState,
        addOpenedProject(fixture.store.get(projectsState), c, { fsPath: 'c.rivet-project' }),
      );
      fixture.store.set(openedProjectSnapshotsState, (snapshots) => ({
        ...snapshots,
        [c.metadata.id]: { project: c },
      }));
      fixture.store.set(projectExecutionSnapshotsState, {
        [c.metadata.id]: {
          ...createEmptyProjectExecutionSnapshot(),
          graphStartTime: 12345,
        },
      });
      const closing = fixture.closeProject(fixture.a.metadata.id);
      await started.promise;
      const selection = fixture.activate(fixture.info(c.metadata.id));
      gate.resolve();
      assert.deepEqual(await Promise.all([closing, selection]), [true, true]);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, c.metadata.id);
    assert.equal(fixture.store.get(graphStartTimeState), 12345);
    assert.equal(fixture.store.get(projectsState).openedProjects[fixture.a.metadata.id], undefined);
    assert.deepEqual(loads, ['b.rivet-project', 'c.rivet-project']);
  } finally {
    await fixture.cleanup();
  }
});

test('a closed target or changed path cannot be revived by delayed IO', async () => {
  for (const change of ['close', 'move']) {
    const gate = deferred();
    const started = deferred();
    const fixture = await mount(async () => {
      started.resolve();
      await gate.promise;
      return { project: fixture.b, evaluation };
    });
    try {
      await act(async () => {
        const pending = fixture.activate(fixture.info(fixture.b.metadata.id));
        await started.promise;
        const projects = fixture.store.get(projectsState);
        const openedProjects = { ...projects.openedProjects };
        if (change === 'close') delete openedProjects[fixture.b.metadata.id];
        else
          openedProjects[fixture.b.metadata.id] = {
            ...openedProjects[fixture.b.metadata.id]!,
            fsPath: 'moved.rivet-project',
          };
        fixture.store.set(projectsState, { ...projects, openedProjects });
        gate.resolve();
        assert.equal(await pending, false);
      });
      assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('closing or moving a target during its deferred import prevents final activation', async () => {
  for (const change of ['close', 'move']) {
    const started = deferred();
    const gate = deferred();
    let committed = false;
    const fixture = await mount(async () => ({
      project: fixture.b,
      evaluation,
      commit: async (isCurrent) => {
        started.resolve();
        await gate.promise;
        committed = isCurrent();
        return committed;
      },
    }));
    try {
      fixture.store.set(openedProjectSnapshotsState, {});
      await act(async () => {
        const pending = fixture.activate(fixture.info(fixture.b.metadata.id));
        await started.promise;
        fixture.store.set(projectsState, (projects) => {
          const openedProjects = { ...projects.openedProjects };
          if (change === 'close') delete openedProjects[fixture.b.metadata.id];
          else
            openedProjects[fixture.b.metadata.id] = {
              ...openedProjects[fixture.b.metadata.id]!,
              fsPath: 'moved.rivet-project',
            };
          return { ...projects, openedProjects };
        });
        gate.resolve();
        assert.equal(await pending, false);
      });
      assert.equal(committed, false);
      assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
      assert.equal(fixture.store.get(savedProjectContentDigestsState)[fixture.b.metadata.id], undefined);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('restoring a snapshot can read a missing baseline without importing saved datasets or revisions', async () => {
  let imports = 0;
  let reads = 0;
  const fixture = await mount(async () => {
    reads++;
    return {
      project: fixture.b,
      evaluation,
      commit: async () => {
        imports++;
        return true;
      },
    };
  });
  try {
    const edited = structuredClone(fixture.b);
    edited.metadata.description = 'Recovered unsaved edit';
    fixture.store.set(openedProjectSnapshotsState, { [fixture.b.metadata.id]: { project: edited } });
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.b.metadata.id)), true));
    assert.equal(imports, 0);
    assert.equal(fixture.store.get(projectState).metadata.description, 'Recovered unsaved edit');
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.b.metadata.id], true);
    await act(async () => {
      await fixture.activate(fixture.info(fixture.a.metadata.id));
      await fixture.activate(fixture.info(fixture.b.metadata.id));
    });
    assert.equal(reads, 1, 'verified native tab snapshots need no repeated disk read');
    assert.equal(imports, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('reselecting the closing tab cancels its pending close and preserves live edits', async () => {
  const gate = deferred();
  const started = deferred();
  const fixture = await mount(async () => {
    started.resolve();
    await gate.promise;
    return { project: fixture.b, evaluation };
  });
  try {
    await act(async () => {
      const closing = fixture.closeProject(fixture.a.metadata.id);
      await started.promise;
      const selection = fixture.activate(fixture.info(fixture.a.metadata.id));
      gate.resolve();
      assert.deepEqual(await Promise.all([closing, selection]), [false, true]);
    });
    assert.ok(fixture.store.get(projectsState).openedProjects[fixture.a.metadata.id]);
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Unsaved live edit');
  } finally {
    await fixture.cleanup();
  }
});

test('a genuine close fallback IO failure still tries the next recoverable tab', async () => {
  const c = createBlankProjectWithDefaultGraph();
  const loads: string[] = [];
  const fixture = await mount(async (path) => {
    loads.push(path);
    if (path === 'b.rivet-project') throw new Error('Unreadable replacement');
    return { project: c, evaluation };
  });
  try {
    await act(async () => {
      fixture.store.set(
        projectsState,
        addOpenedProject(fixture.store.get(projectsState), c, { fsPath: 'c.rivet-project' }),
      );
      assert.equal(await fixture.closeProject(fixture.a.metadata.id), true);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, c.metadata.id);
    assert.deepEqual(loads, ['b.rivet-project', 'c.rivet-project']);
    assert.equal(fixture.errors.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('queued activation reads current tab metadata rather than an obsolete path', async () => {
  const gate = deferred();
  const started = deferred();
  const c = createBlankProjectWithDefaultGraph();
  const loads: string[] = [];
  const fixture = await mount(async (path) => {
    loads.push(path);
    if (path === 'c.rivet-project') {
      started.resolve();
      await gate.promise;
      return { project: c, evaluation };
    }
    return { project: fixture.b, evaluation };
  });
  try {
    await act(async () => {
      fixture.store.set(
        projectsState,
        addOpenedProject(fixture.store.get(projectsState), c, { fsPath: 'c.rivet-project' }),
      );
      const blocked = fixture.activate(fixture.info(c.metadata.id));
      await started.promise;
      const selection = fixture.activate(fixture.info(fixture.b.metadata.id));
      fixture.store.set(projectsState, (projects) => ({
        ...projects,
        openedProjects: {
          ...projects.openedProjects,
          [fixture.b.metadata.id]: {
            ...projects.openedProjects[fixture.b.metadata.id]!,
            fsPath: 'moved-b.rivet-project',
          },
        },
      }));
      gate.resolve();
      assert.deepEqual(await Promise.all([blocked, selection]), [false, true]);
    });
    assert.deepEqual(loads, ['c.rivet-project', 'moved-b.rivet-project']);
    assert.equal(fixture.store.get(loadedProjectState).path, 'moved-b.rivet-project');
  } finally {
    await fixture.cleanup();
  }
});

test('reused disk path fails identity validation instead of mixing project and Evaluation data', async () => {
  const fixture = await mount(async () => ({ project: fixture.a, evaluation }));
  try {
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.b.metadata.id)), false));
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
  } finally {
    await fixture.cleanup();
  }
});

test('restoring an edited snapshot does not resurrect deleted static data or miss newer edits', async () => {
  const gate = deferred();
  const started = deferred();
  const fixture = await mount(async () => {
    started.resolve();
    await gate.promise;
    return { project: { ...fixture.b, data: { old: 'deleted' } }, evaluation };
  });
  try {
    await act(async () => {
      const pending = fixture.activate(fixture.info(fixture.b.metadata.id));
      await started.promise;
      const liveGraph = fixture.store.get(graphState);
      fixture.store.set(graphState, {
        ...liveGraph,
        metadata: { ...liveGraph.metadata!, description: 'Edited during IO' },
      });
      fixture.store.set(openedProjectSnapshotsState, {
        [fixture.b.metadata.id]: {
          project: { ...fixture.b, metadata: { ...fixture.b.metadata, description: 'Newer snapshot' } },
          data: undefined,
        },
      });
      gate.resolve();
      assert.equal(await pending, true);
    });
    assert.equal(fixture.store.get(projectState).metadata.description, 'Newer snapshot');
    assert.deepEqual(fixture.store.get(projectDataState), {});
    assert.deepEqual(await fixture.staticData.getAll(), []);
    assert.equal(
      fixture.store.get(openedProjectSnapshotsState)[fixture.a.metadata.id]?.project.graphs[
        fixture.a.metadata.mainGraphId as GraphId
      ]?.metadata?.description,
      'Edited during IO',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('path metadata changes with project identity and cannot overwrite a move during hydration', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  const clear = fixture.staticData.clear.bind(fixture.staticData);
  fixture.staticData.clear = async () => {
    started.resolve();
    await gate.promise;
    await clear();
  };
  try {
    await act(async () => {
      const selection = fixture.activate(fixture.info(fixture.b.metadata.id));
      await started.promise;
      assert.equal(fixture.store.get(projectState).metadata.id, fixture.b.metadata.id);
      assert.equal(fixture.store.get(loadedProjectState).path, 'b.rivet-project');
      fixture.store.set(loadedProjectState, { loaded: true, path: 'moved-b.rivet-project' });
      fixture.store.set(projectsState, (projects) => ({
        ...projects,
        openedProjects: {
          ...projects.openedProjects,
          [fixture.b.metadata.id]: {
            ...projects.openedProjects[fixture.b.metadata.id]!,
            fsPath: 'moved-b.rivet-project',
          },
        },
      }));
      gate.resolve();
      assert.equal(await selection, true);
    });
    assert.equal(fixture.store.get(loadedProjectState).path, 'moved-b.rivet-project');
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('a fresh snapshot open supersedes a delayed tab activation through the same queue', async () => {
  const started = deferred();
  const gate = deferred();
  const c = createBlankProjectWithDefaultGraph();
  const fixture = await mount(async () => {
    started.resolve();
    await gate.promise;
    return { project: fixture.b, evaluation };
  });
  try {
    await act(async () => {
      const oldSelection = fixture.activate(fixture.info(fixture.b.metadata.id));
      await started.promise;
      const newSelection = fixture.open.openProjectSnapshot({ project: c, path: 'c.rivet-project' });
      gate.resolve();
      assert.deepEqual(await Promise.all([oldSelection, newSelection]), [false, true]);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, c.metadata.id);
    assert.equal(fixture.info(c.metadata.id).fsPath, 'c.rivet-project');
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('reselecting the current tab cancels a delayed fresh path open', async () => {
  const started = deferred();
  const gate = deferred();
  const c = createBlankProjectWithDefaultGraph();
  const fixture = await mount(async () => {
    started.resolve();
    await gate.promise;
    return { project: c, evaluation };
  });
  try {
    await act(async () => {
      const opening = fixture.open.openProjectPath('c.rivet-project');
      await started.promise;
      const selection = fixture.activate(fixture.info(fixture.a.metadata.id));
      gate.resolve();
      assert.deepEqual(await Promise.all([opening, selection]), [false, true]);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.info(c.metadata.id), undefined);
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Unsaved live edit');
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('new tab registration cannot overwrite edits or path moves made during cache hydration', async () => {
  const started = deferred();
  const gate = deferred();
  const c = createBlankProjectWithDefaultGraph();
  const fixture = await mount(async (path) => ({
    project: path === 'a.rivet-project' ? fixture.a : fixture.b,
    evaluation,
  }));
  const clear = fixture.staticData.clear.bind(fixture.staticData);
  fixture.staticData.clear = async () => {
    started.resolve();
    await gate.promise;
    await clear();
  };
  try {
    await act(async () => {
      const opening = fixture.open.openProjectSnapshot({ project: c, path: 'c.rivet-project' });
      await started.promise;
      assert.equal(fixture.info(c.metadata.id).fsPath, 'c.rivet-project');
      const graph = fixture.store.get(graphState);
      fixture.store.set(graphState, { ...graph, metadata: { ...graph.metadata!, description: 'New live edit' } });
      fixture.metadata.moveProjectPaths([{ from: 'c.rivet-project', to: 'moved-c.rivet-project' }]);
      gate.resolve();
      assert.equal(await opening, true);
    });
    assert.equal(fixture.info(c.metadata.id).fsPath, 'moved-c.rivet-project');
    assert.equal(fixture.store.get(loadedProjectState).path, 'moved-c.rivet-project');
    assert.equal(fixture.store.get(projectUnsavedChangesState)[c.metadata.id], true);
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.a.metadata.id)), true));
    assert.equal(
      fixture.store.get(openedProjectSnapshotsState)[c.metadata.id]?.project.graphs[c.metadata.mainGraphId!]!.metadata
        ?.description,
      'New live edit',
    );
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('cancelled or unselected opening placeholders cannot steal the active project', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  const c = createBlankProjectWithDefaultGraph();
  try {
    await act(async () => {
      const placeholder = await fixture.opening.startOpeningProjectTab({ title: 'C' });
      assert.ok(placeholder);
      await fixture.open.activateProject(fixture.a.metadata.id);
      assert.equal(await fixture.opening.finishOpeningProjectTab(placeholder.openingTabId, { project: c }), false);
      const second = await fixture.opening.startOpeningProjectTab({ title: 'C' });
      assert.ok(second);
      const finishing = fixture.opening.finishOpeningProjectTab(second.openingTabId, { project: c });
      await fixture.opening.cancelOpeningProjectTab(second.openingTabId);
      assert.equal(await finishing, false);
    });
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.equal(fixture.info(c.metadata.id), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('externally persisted rename updates only the saved metadata, preserving live edits and undo', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await act(async () => {
      assert.equal(
        await fixture.metadata.updateProjectMetadata(
          fixture.a.metadata.id,
          { title: 'Renamed' },
          { persistedExternally: true },
        ),
        true,
      );
    });
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
    await act(async () => fixture.store.set(graphState, fixture.a.graphs[fixture.a.metadata.mainGraphId!]!));
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], false);
    assert.equal(fixture.store.get(projectState).metadata.title, 'Renamed');
    // Consecutive moves before React rerenders must read current store paths.
    await act(async () => {
      fixture.metadata.moveProjectPaths([{ from: 'a.rivet-project', to: 'first.rivet-project' }]);
      fixture.metadata.moveProjectPaths([{ from: 'first.rivet-project', to: 'second.rivet-project' }]);
    });
    assert.equal(fixture.store.get(loadedProjectState).path, 'second.rivet-project');
  } finally {
    await fixture.cleanup();
  }
});

test('an old workspace with an explicit dirty flag is not silently assigned a clean baseline', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await act(async () => {
      fixture.store.set(savedProjectContentDigestsState, {});
      fixture.store.set(projectUnsavedChangesState, { [fixture.a.metadata.id]: true });
    });
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
    assert.equal(fixture.store.get(savedProjectContentDigestsState)[fixture.a.metadata.id], undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('certifying an earlier snapshot cannot clear newer live edits', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await act(async () => assert.equal(await fixture.baseline.markCurrentProjectClean({ project: fixture.a }), true));
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('failed close replacements retain the only usable active tab', async () => {
  const fixture = await mount(async () => {
    throw new Error('All replacement IO failed');
  });
  try {
    await act(async () => assert.equal(await fixture.closeProject(fixture.a.metadata.id), false));
    assert.equal(fixture.store.get(projectState).metadata.id, fixture.a.metadata.id);
    assert.ok(fixture.info(fixture.a.metadata.id));
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('a recovered file-backed workspace without a saved baseline stays conservatively dirty', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await act(async () => {
      fixture.store.set(savedProjectContentDigestsState, {});
      fixture.store.set(projectUnsavedChangesState, {});
    });
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
    assert.equal(fixture.store.get(savedProjectContentDigestsState)[fixture.a.metadata.id], undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('an external rename cannot certify a recovered workspace without a saved baseline', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await act(async () => {
      fixture.store.set(savedProjectContentDigestsState, {});
      fixture.store.set(projectUnsavedChangesState, {});
      await fixture.metadata.updateProjectMetadata(
        fixture.a.metadata.id,
        { title: 'Recovered renamed project' },
        { persistedExternally: true },
      );
    });
    assert.equal(fixture.store.get(savedProjectContentDigestsState)[fixture.a.metadata.id], undefined);
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('recovering an inactive workspace establishes the disk baseline without replacing its edits', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    const graphId = fixture.b.metadata.mainGraphId!;
    const graph = fixture.b.graphs[graphId]!;
    await act(async () => {
      fixture.store.set(openedProjectSnapshotsState, {
        [fixture.b.metadata.id]: {
          project: {
            ...fixture.b,
            graphs: {
              ...fixture.b.graphs,
              [graphId]: { ...graph, metadata: { ...graph.metadata!, description: 'Recovered unsaved edit' } },
            },
          },
        },
      });
      assert.equal(await fixture.activate(fixture.info(fixture.b.metadata.id)), true);
    });
    assert.equal(fixture.store.get(graphState).metadata?.description, 'Recovered unsaved edit');
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.b.metadata.id], true);
    await act(async () => fixture.store.set(graphState, graph));
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.b.metadata.id], false);
  } finally {
    await fixture.cleanup();
  }
});

test('recovering an older scratch tab never certifies its edits as saved', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await act(async () => {
      fixture.store.set(projectsState, (projects) => ({
        ...projects,
        openedProjects: {
          ...projects.openedProjects,
          [fixture.a.metadata.id]: { ...projects.openedProjects[fixture.a.metadata.id]!, fsPath: null },
        },
      }));
      fixture.store.set(savedProjectContentDigestsState, {});
      fixture.store.set(projectUnsavedChangesState, {});
      await fixture.metadata.updateProjectMetadata(
        fixture.a.metadata.id,
        { title: 'Recovered scratch' },
        { persistedExternally: true },
      );
    });
    assert.equal(fixture.store.get(projectUnsavedChangesState)[fixture.a.metadata.id], true);
    assert.equal(fixture.store.get(savedProjectContentDigestsState)[fixture.a.metadata.id], undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('static-data edits during hydration survive in both the live payload and shared cache', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  const c = createBlankProjectWithDefaultGraph();
  const oldId = 'saved-data' as DataId;
  const newId = 'edited-data' as DataId;
  const clear = fixture.staticData.clear.bind(fixture.staticData);
  fixture.staticData.clear = async () => {
    started.resolve();
    await gate.promise;
    await clear();
  };
  let opening!: Promise<boolean>;
  try {
    await act(async () => {
      opening = fixture.open.openProjectSnapshot({ project: c, data: { [oldId]: 'saved payload' } });
      await started.promise;
    });
    await act(async () => {
      const editing = fixture.setStaticData({ [newId]: 'new payload' });
      gate.resolve();
      await editing;
      assert.equal(await opening, true);
    });
    assert.deepEqual(fixture.store.get(projectDataState), { [oldId]: 'saved payload', [newId]: 'new payload' });
    assert.deepEqual(await fixture.staticData.getAll(), [
      { id: oldId, data: 'saved payload' },
      { id: newId, data: 'new payload' },
    ]);
    assert.equal(fixture.store.get(projectDataUnsavedChangesState)[c.metadata.id], true);
  } finally {
    gate.resolve();
    await opening;
    await fixture.cleanup();
  }
});

test('a stale static-data callback cannot write into the project selected afterward', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    const oldCallback = fixture.setStaticData;
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.b.metadata.id)), true));
    await act(async () => oldCallback({ ['old-callback' as DataId]: 'wrong project' }));
    assert.deepEqual(fixture.store.get(projectDataState), {});
    assert.deepEqual(await fixture.staticData.getAll(), []);
    assert.notEqual(fixture.store.get(projectDataUnsavedChangesState)[fixture.b.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('a failed cache clear preserves live data without mixing caches or blocking the next activation', async () => {
  const fixture = await mount(async (path) => ({
    project: path === 'a.rivet-project' ? fixture.a : fixture.b,
    evaluation,
  }));
  const c = createBlankProjectWithDefaultGraph();
  const oldId = 'previous-project-data' as DataId;
  const newId = 'loaded-project-data' as DataId;
  const clear = fixture.staticData.clear.bind(fixture.staticData);
  try {
    await fixture.staticData.insert(oldId, 'previous payload');
    fixture.staticData.clear = async () => {
      throw new Error('Cache clear unavailable');
    };
    await act(async () => {
      assert.equal(await fixture.open.openProjectSnapshot({ project: c, data: { [newId]: 'loaded payload' } }), true);
    });
    assert.deepEqual(fixture.store.get(projectDataState), { [newId]: 'loaded payload' });
    assert.deepEqual(await fixture.staticData.getAll(), [{ id: oldId, data: 'previous payload' }]);

    fixture.staticData.clear = clear;
    await act(async () => assert.equal(await fixture.activate(fixture.info(fixture.a.metadata.id)), true));
    assert.deepEqual(fixture.store.get(projectDataState), {});
    assert.deepEqual(await fixture.staticData.getAll(), []);
  } finally {
    fixture.staticData.clear = clear;
    await fixture.cleanup();
  }
});

test('closing can finish when its failed replacement was itself closed during IO', async () => {
  const started = deferred();
  const gate = deferred();
  const fixture = await mount(async () => {
    started.resolve();
    await gate.promise;
    return { project: fixture.b, evaluation };
  });
  try {
    await act(async () => {
      const closing = fixture.closeProject(fixture.a.metadata.id);
      await started.promise;
      assert.equal(await fixture.closeProject(fixture.b.metadata.id), true);
      gate.resolve();
      assert.equal(await closing, true);
    });
    assert.deepEqual(fixture.store.get(projectsState).openedProjectsSortedIds, []);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('legacy cache recovery preserves existing entries and edits arriving during its read', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  const started = deferred();
  const gate = deferred();
  const oldId = '__proto__' as DataId;
  const newId = 'new-payload' as DataId;
  const getAll = fixture.staticData.getAll.bind(fixture.staticData);
  fixture.staticData.getAll = async () => {
    const data = await getAll();
    started.resolve();
    await gate.promise;
    return data;
  };
  try {
    await fixture.staticData.insert(oldId, 'retained');
    await fixture.restoreStaticData();
    await started.promise;
    await act(async () => {
      const editing = fixture.setStaticData({ [newId]: 'edited' });
      gate.resolve();
      await editing;
    });
    assert.deepEqual(fixture.store.get(projectDataState), { [oldId]: 'retained', [newId]: 'edited' });
    await flushHybridStorageGroup('project');
    const persisted = JSON.parse((await fixture.storage.getItem(getWorkspaceRecoveryStorage().key))!).groups.project;
    assert.deepEqual(persisted.projectDataState, { [oldId]: 'retained', [newId]: 'edited' });
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('a legacy cache payload is unsaved until a real project save, not certified by recovery', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  try {
    await fixture.staticData.insert('recovered' as DataId, 'not yet in the project file');
    await fixture.restoreStaticData();
    assert.deepEqual(fixture.store.get(projectDataState), { recovered: 'not yet in the project file' });
    assert.equal(fixture.store.get(projectDataUnsavedChangesState)[fixture.a.metadata.id], true);
  } finally {
    await fixture.cleanup();
  }
});

test('legacy cache recovery cannot mix data into a newer load of the same project', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  const started = deferred();
  const gate = deferred();
  fixture.staticData.getAll = async () => {
    started.resolve();
    await gate.promise;
    return [{ id: 'stale' as DataId, data: 'old cache' }];
  };
  try {
    await fixture.restoreStaticData();
    await started.promise;
    await act(async () => {
      await runLatestProjectActivation(fixture.store, async () => {
        fixture.store.set(projectDataState, {});
        return true;
      });
      gate.resolve();
    });
    assert.deepEqual(fixture.store.get(projectDataState), {});
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test('a persisted active payload never restores another project from the global cache', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  let reads = 0;
  fixture.staticData.getAll = async () => {
    reads += 1;
    return [{ id: 'wrong-project' as DataId, data: 'residual' }];
  };
  try {
    await act(async () => fixture.store.set(projectDataState, { ['active' as DataId]: 'correct payload' }));
    await fixture.restoreStaticData();
    assert.equal(reads, 0);
    assert.deepEqual(fixture.store.get(projectDataState), { active: 'correct payload' });
  } finally {
    await fixture.cleanup();
  }
});

test('delayed close cleanup cannot dispose code models used by an immediately reopened tab', async () => {
  const fixture = await mount(async () => ({ project: fixture.b, evaluation }));
  const timeouts: (() => void)[] = [];
  const originalTimeout = window.setTimeout;
  window.setTimeout = ((callback: () => void) => {
    timeouts.push(callback);
    return 1;
  }) as typeof window.setTimeout;
  const model = {
    disposed: false,
    getValue: () => 'code',
    dispose() {
      this.disposed = true;
    },
  };
  try {
    await act(async () => assert.equal(await fixture.closeProject(fixture.b.metadata.id), true));
    await act(async () => assert.equal(await fixture.open.openProjectSnapshot({ project: fixture.b }), true));
    getOrCreateCodeEditorModel({
      cacheKey: `project:${fixture.b.metadata.id}|graph:main|node:code`,
      text: 'code',
      createModel: () => model as never,
    });
    timeouts.forEach((callback) => callback());
    await import('../utils/monaco/codeEditorModelCache.js');
    assert.equal(model.disposed, false);
  } finally {
    window.setTimeout = originalTimeout;
    clearCodeEditorModelCache();
    await fixture.cleanup();
  }
});
