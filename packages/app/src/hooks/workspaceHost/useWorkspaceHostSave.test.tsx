import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { IOProvider } from '../../io/IOProvider.js';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getDefaultStore } from 'jotai';
import { ProvidersProvider } from '../../providers/ProvidersContext.js';
import { MemoryStaticDataStore } from '../../providers/StaticDataStore.js';
import { HostCallbacksProvider, type RivetAppHostProjectSavedEvent } from '../../providers/HostCallbacksContext.js';
import { ExecutorSessionProvider } from '../../providers/ExecutorSessionContext.js';
import { graphState } from '../../state/graph.js';
import { selectedOpeningProjectTabIdState } from '../../state/openingProjectTabs.js';
import { projectEditorStateByProjectIdState } from '../../state/projectEditor.js';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  projectDataState,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
  projectsState,
  savedProjectContentDigestsState,
} from '../../state/savedGraphs.js';
import { configureHybridStorageBackend, MemoryAsyncStorage } from '../../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../../utils/blankProject.js';
import { addOpenedProject } from '../../utils/openedProjects.js';
import type { RivetWorkspaceHost } from '../../host.js';
import { useWorkspaceHostSave } from './useWorkspaceHostSave.js';

type SaveableIOProvider = IOProvider & {
  canSaveProjectDataNoPrompt(path: string): boolean;
  saveProjectDataNoPrompt(project: Project, path: string): Promise<string | void>;
};

type MountedSaveHost = {
  saveCurrentProject: RivetWorkspaceHost['saveCurrentProject'];
  unmount(): Promise<void>;
};

test('public workspace save shares one persistence operation, marks the project clean, and emits once', async () => {
  let persistenceCount = 0;
  let savedEventCount = 0;
  let savedEvent: RivetAppHostProjectSavedEvent | undefined;
  let persistedProject: Project | undefined;
  let resolvePersistence!: () => void;
  let persistenceStarted!: () => void;
  const persistenceStartedPromise = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  const persistenceGate = new Promise<void>((resolve) => {
    resolvePersistence = resolve;
  });
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt(project) {
      persistenceCount += 1;
      persistedProject = project;
      persistenceStarted();
      await persistenceGate;
    },
  });
  const fixture = await mountSaveHost(ioProvider, (event) => {
    savedEventCount += 1;
    savedEvent = event;
  });
  const store = getDefaultStore();
  const projectId = store.get(projectState).metadata.id as ProjectId;

  try {
    let firstSave!: Promise<boolean>;
    let secondSave!: Promise<boolean>;
    await act(async () => {
      firstSave = fixture.saveCurrentProject();
      secondSave = fixture.saveCurrentProject();
      await persistenceStartedPromise;
    });
    assert.strictEqual(secondSave, firstSave);

    assert.equal(persistenceCount, 1);
    let results: boolean[] = [];
    await act(async () => {
      resolvePersistence();
      results = await Promise.all([firstSave, secondSave]);
    });

    assert.deepEqual(results, [true, true]);
    assert.equal(savedEventCount, 1);
    assert.equal(savedEvent?.project.metadata.id, projectId);
    assert.equal(savedEvent?.path, 'project.rivet-project');
    assert.equal(savedEvent?.saveAs, false);
    const persistedMainGraph = persistedProject?.graphs[persistedProject.metadata.mainGraphId as GraphId];
    assert.equal(persistedMainGraph?.metadata?.description, 'Unsaved live graph edit');
    assert.equal(store.get(projectUnsavedChangesState)[projectId], false);
    assert.equal(store.get(projectDataUnsavedChangesState)[projectId], false);
    assert.equal(typeof store.get(savedProjectContentDigestsState)[projectId], 'string');
  } finally {
    await fixture.unmount();
  }
});

test('an in-flight save cannot replace another active tab path or redirect its next save', async () => {
  const savedPaths: string[] = [];
  let resolveFirstSave!: () => void;
  let firstSaveStarted!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveGate = new Promise<void>((resolve) => {
    resolveFirstSave = resolve;
  });
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt(_project, path) {
      savedPaths.push(path);
      if (savedPaths.length === 1) {
        firstSaveStarted();
        await firstSaveGate;
      }
    },
  });
  const fixture = await mountSaveHost(ioProvider, undefined, { loaded: true, path: 'project-a.rivet-project' });
  const store = getDefaultStore();
  const projectA = store.get(projectState);
  const projectAId = projectA.metadata.id as ProjectId;
  const projectBWithData = createBlankProjectWithDefaultGraph();
  const { data: _projectBData, ...projectB } = projectBWithData;
  const projectBId = projectB.metadata.id as ProjectId;
  const projectBGraph = projectB.graphs[projectB.metadata.mainGraphId as GraphId]!;

  try {
    let firstSave!: Promise<boolean>;
    await act(async () => {
      firstSave = fixture.saveCurrentProject();
      await firstSaveStartedPromise;
    });

    await act(async () => {
      store.set(projectState, projectB);
      store.set(graphState, projectBGraph);
      store.set(loadedProjectState, { loaded: true, path: 'project-b.rivet-project' });
      store.set(
        projectsState,
        addOpenedProject(
          addOpenedProject({ openedProjects: {}, openedProjectsSortedIds: [] }, projectA, {
            fsPath: 'project-a.rivet-project',
          }),
          projectB,
          { fsPath: 'project-b.rivet-project' },
        ),
      );
      store.set(projectUnsavedChangesState, { [projectAId]: true, [projectBId]: true });
      resolveFirstSave();
      assert.equal(await firstSave, true);
    });

    assert.equal(store.get(loadedProjectState).path, 'project-b.rivet-project');
    assert.equal(store.get(projectsState).openedProjects[projectAId]?.fsPath, 'project-a.rivet-project');
    assert.equal(store.get(projectsState).openedProjects[projectBId]?.fsPath, 'project-b.rivet-project');

    await act(async () => {
      assert.equal(await fixture.saveCurrentProject(), true);
    });

    assert.deepEqual(savedPaths, ['project-a.rivet-project', 'project-b.rivet-project']);
  } finally {
    await fixture.unmount();
  }
});

test('an in-place provider can return the canonical path after a remote move', async () => {
  let savedEvent: RivetAppHostProjectSavedEvent | undefined;
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt(_project, path) {
      assert.equal(path, 'project-before-move.rivet-project');
      return 'Moved/project-after-move.rivet-project';
    },
  });
  const fixture = await mountSaveHost(
    ioProvider,
    (event) => {
      savedEvent = event;
    },
    { loaded: true, path: 'project-before-move.rivet-project' },
  );
  const store = getDefaultStore();
  const projectId = store.get(projectState).metadata.id as ProjectId;

  try {
    await act(async () => {
      assert.equal(await fixture.saveCurrentProject(), true);
    });

    assert.equal(store.get(loadedProjectState).path, 'Moved/project-after-move.rivet-project');
    assert.equal(store.get(projectsState).openedProjects[projectId]?.fsPath, 'Moved/project-after-move.rivet-project');
    assert.equal(savedEvent?.path, 'Moved/project-after-move.rivet-project');
    assert.equal(savedEvent?.pathChangedWhileSaving, false);
  } finally {
    await fixture.unmount();
  }
});

test('a completed older save preserves newer inactive project state, path, and tab metadata', async () => {
  let savedEvent: RivetAppHostProjectSavedEvent | undefined;
  let resolveSave!: () => void;
  let saveStarted!: () => void;
  const saveStartedPromise = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  const saveGate = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt() {
      saveStarted();
      await saveGate;
    },
  });
  const fixture = await mountSaveHost(
    ioProvider,
    (event) => {
      savedEvent = event;
    },
    { loaded: true, path: 'project-a.rivet-project' },
  );
  const store = getDefaultStore();
  const projectA = store.get(projectState);
  const projectAId = projectA.metadata.id as ProjectId;
  const projectAData = store.get(projectDataState);
  const projectBWithData = createBlankProjectWithDefaultGraph();
  const { data: _projectBData, ...projectB } = projectBWithData;
  const projectBGraph = projectB.graphs[projectB.metadata.mainGraphId as GraphId]!;
  const newerProjectA = {
    ...projectA,
    metadata: {
      ...projectA.metadata,
      title: 'Renamed while save was pending',
      description: 'Edited after the save started',
    },
  };
  const newerProjectAData = { ...(projectAData ?? {}), 'data-after-save': 'newer' };

  try {
    let save!: Promise<boolean>;
    await act(async () => {
      save = fixture.saveCurrentProject();
      await saveStartedPromise;
    });

    await act(async () => {
      store.set(projectState, projectB);
      store.set(graphState, projectBGraph);
      store.set(loadedProjectState, { loaded: true, path: 'project-b.rivet-project' });
      store.set(
        projectsState,
        addOpenedProject(
          addOpenedProject(store.get(projectsState), newerProjectA, {
            fsPath: 'renamed-project-a.rivet-project',
          }),
          projectB,
          { fsPath: 'project-b.rivet-project' },
        ),
      );
      store.set(openedProjectSnapshotsState, {
        [projectAId]: { project: newerProjectA, data: newerProjectAData },
      });
      resolveSave();
      assert.equal(await save, true);
    });
    assert.equal(store.get(projectsState).openedProjects[projectAId]?.title, 'Renamed while save was pending');
    assert.equal(store.get(projectsState).openedProjects[projectAId]?.fsPath, 'renamed-project-a.rivet-project');

    assert.equal(store.get(loadedProjectState).path, 'project-b.rivet-project');
    assert.equal(
      store.get(openedProjectSnapshotsState)[projectAId]?.project.metadata.description,
      'Edited after the save started',
    );
    assert.deepEqual(store.get(openedProjectSnapshotsState)[projectAId]?.data, newerProjectAData);
    assert.equal(store.get(projectUnsavedChangesState)[projectAId], true);
    assert.equal(store.get(projectDataUnsavedChangesState)[projectAId], true);
    assert.equal(savedEvent?.hasNewerUnsavedChanges, true);
    assert.equal(savedEvent?.pathChangedWhileSaving, true);
  } finally {
    await fixture.unmount();
  }
});

test('public workspace save returns false when Save As is cancelled', async () => {
  let savedEventCount = 0;
  const ioProvider = createSaveableIOProvider({
    async saveProjectData() {
      return undefined;
    },
  });
  const fixture = await mountSaveHost(
    ioProvider,
    () => {
      savedEventCount += 1;
    },
    { loaded: false, path: null },
  );
  const store = getDefaultStore();
  const projectId = store.get(projectState).metadata.id as ProjectId;

  try {
    let saved = true;
    await act(async () => {
      saved = await fixture.saveCurrentProject();
    });
    assert.equal(saved, false);
    assert.equal(savedEventCount, 0);
    assert.equal(store.get(projectUnsavedChangesState)[projectId], true);
    assert.equal(store.get(projectDataUnsavedChangesState)[projectId], true);
  } finally {
    await fixture.unmount();
  }
});

test('public workspace save remains successful when the host save observer throws', async () => {
  let persistenceCount = 0;
  let savedEventCount = 0;
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt() {
      persistenceCount += 1;
    },
  });
  const fixture = await mountSaveHost(ioProvider, () => {
    savedEventCount += 1;
    throw new Error('host observer failed');
  });
  const store = getDefaultStore();
  const projectId = store.get(projectState).metadata.id as ProjectId;

  try {
    let saved = false;
    await act(async () => {
      saved = await fixture.saveCurrentProject();
    });
    assert.equal(saved, true);
    assert.equal(persistenceCount, 1);
    assert.equal(savedEventCount, 1);
    assert.equal(store.get(projectUnsavedChangesState)[projectId], false);
    assert.equal(store.get(projectDataUnsavedChangesState)[projectId], false);
  } finally {
    await fixture.unmount();
  }
});

test('public workspace save returns false when persistence fails', async () => {
  let savedEventCount = 0;
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt() {
      throw new Error('persistence failed');
    },
  });
  const fixture = await mountSaveHost(ioProvider, () => {
    savedEventCount += 1;
  });
  const store = getDefaultStore();
  const projectId = store.get(projectState).metadata.id as ProjectId;

  try {
    let saved = true;
    await act(async () => {
      saved = await fixture.saveCurrentProject();
    });
    assert.equal(saved, false);
    assert.equal(savedEventCount, 0);
    assert.equal(store.get(projectUnsavedChangesState)[projectId], true);
    assert.equal(store.get(projectDataUnsavedChangesState)[projectId], true);
  } finally {
    await fixture.unmount();
  }
});

test('public workspace save returns false when save preparation fails', async () => {
  let persistenceCount = 0;
  let savedEventCount = 0;
  const ioProvider = createSaveableIOProvider({
    canSaveProjectDataNoPrompt() {
      throw new Error('capability check failed');
    },
    async saveProjectDataNoPrompt() {
      persistenceCount += 1;
    },
  });
  const fixture = await mountSaveHost(ioProvider, () => {
    savedEventCount += 1;
  });

  try {
    let saved = true;
    await act(async () => {
      saved = await fixture.saveCurrentProject();
    });
    assert.equal(saved, false);
    assert.equal(persistenceCount, 0);
    assert.equal(savedEventCount, 0);
  } finally {
    await fixture.unmount();
  }
});

test('public workspace save returns false when there is no active saveable project', async () => {
  let persistenceCount = 0;
  const ioProvider = createSaveableIOProvider({
    async saveProjectDataNoPrompt() {
      persistenceCount += 1;
    },
  });
  const fixture = await mountSaveHost(ioProvider, undefined, undefined, false);

  try {
    assert.equal(await fixture.saveCurrentProject(), false);
    assert.equal(persistenceCount, 0);
  } finally {
    await fixture.unmount();
  }
});

async function mountSaveHost(
  ioProvider: SaveableIOProvider,
  onProjectSaved?: (event: RivetAppHostProjectSavedEvent) => void,
  loadedProject: { loaded: boolean; path: string | null } = { loaded: true, path: 'project.rivet-project' },
  openProject = true,
): Promise<MountedSaveHost> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const restoreGlobals = installDomGlobals(dom);
  const restoreStorageBackend = configureHybridStorageBackend(new MemoryAsyncStorage());
  const store = getDefaultStore();
  const projectWithData = createBlankProjectWithDefaultGraph();
  const { data: _data, ...project } = projectWithData;
  const projectId = project.metadata.id as ProjectId;
  const mainGraph = project.graphs[project.metadata.mainGraphId as GraphId]!;
  const previousState = {
    graph: store.get(graphState),
    loadedProject: store.get(loadedProjectState),
    openedProjectSnapshots: store.get(openedProjectSnapshotsState),
    projectData: store.get(projectDataState),
    project: store.get(projectState),
    projectEditorStateByProjectId: store.get(projectEditorStateByProjectIdState),
    projectDataUnsavedChanges: store.get(projectDataUnsavedChangesState),
    projectUnsavedChanges: store.get(projectUnsavedChangesState),
    projects: store.get(projectsState),
    savedProjectContentDigests: store.get(savedProjectContentDigestsState),
    selectedOpeningProjectTabId: store.get(selectedOpeningProjectTabIdState),
  };

  store.set(projectState, project);
  store.set(graphState, {
    ...mainGraph,
    metadata: {
      ...mainGraph.metadata!,
      description: 'Unsaved live graph edit',
    },
  });
  store.set(projectDataState, projectWithData.data);
  store.set(loadedProjectState, loadedProject);
  store.set(
    projectsState,
    openProject
      ? addOpenedProject({ openedProjects: {}, openedProjectsSortedIds: [] }, project)
      : { openedProjects: {}, openedProjectsSortedIds: [] },
  );
  store.set(openedProjectSnapshotsState, {});
  store.set(selectedOpeningProjectTabIdState, undefined);
  store.set(projectUnsavedChangesState, { [projectId]: true });
  store.set(projectDataUnsavedChangesState, { [projectId]: true });
  store.set(savedProjectContentDigestsState, {});

  let saveCurrentProject: (() => Promise<boolean>) | undefined;
  function Harness() {
    saveCurrentProject = useWorkspaceHostSave();
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => {
    root.render(
      <ProvidersProvider providers={{ io: ioProvider, staticData: new MemoryStaticDataStore() }}>
        <HostCallbacksProvider callbacks={{ onProjectSaved }}>
          <ExecutorSessionProvider>
            <Harness />
          </ExecutorSessionProvider>
        </HostCallbacksProvider>
      </ProvidersProvider>,
    );
  });
  assert.ok(saveCurrentProject);

  return {
    saveCurrentProject,
    async unmount() {
      await act(async () => root.unmount());
      store.set(graphState, previousState.graph);
      store.set(loadedProjectState, previousState.loadedProject);
      store.set(openedProjectSnapshotsState, previousState.openedProjectSnapshots);
      store.set(projectState, previousState.project);
      store.set(projectDataState, previousState.projectData);
      store.set(projectEditorStateByProjectIdState, previousState.projectEditorStateByProjectId);
      store.set(projectDataUnsavedChangesState, previousState.projectDataUnsavedChanges);
      store.set(projectUnsavedChangesState, previousState.projectUnsavedChanges);
      store.set(projectsState, previousState.projects);
      store.set(savedProjectContentDigestsState, previousState.savedProjectContentDigests);
      store.set(selectedOpeningProjectTabIdState, previousState.selectedOpeningProjectTabId);
      configureHybridStorageBackend(restoreStorageBackend);
      restoreGlobals();
      dom.window.close();
    },
  };
}

function createSaveableIOProvider(
  overrides: Partial<
    Pick<SaveableIOProvider, 'canSaveProjectDataNoPrompt' | 'saveProjectData' | 'saveProjectDataNoPrompt'>
  >,
): SaveableIOProvider {
  return {
    canSaveProjectDataNoPrompt: () => true,
    async loadGraphData() {},
    async loadProjectData() {},
    async loadRecordingData() {},
    async readFileAsBinary() {},
    async readFileAsString() {},
    async saveGraphData() {},
    async saveProjectData() {
      return 'project.rivet-project';
    },
    async saveProjectDataNoPrompt() {},
    async saveString() {},
    ...overrides,
  };
}

function installDomGlobals(dom: JSDOM): () => void {
  const previous = {
    React: (globalThis as typeof globalThis & { React?: typeof React }).React,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    navigator: globalThis.navigator,
    window: globalThis.window,
  };
  Object.defineProperties(globalThis, {
    React: { configurable: true, value: React },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return () => {
    Object.defineProperties(globalThis, {
      React: { configurable: true, value: previous.React },
      document: { configurable: true, value: previous.document },
      localStorage: { configurable: true, value: previous.localStorage },
      navigator: { configurable: true, value: previous.navigator },
      window: { configurable: true, value: previous.window },
    });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  };
}
