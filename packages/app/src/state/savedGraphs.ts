import { atom } from 'jotai';
import { atomWithStorage, atomFamily } from 'jotai/utils';
import { nanoid } from 'nanoid/non-secure';
import { produce } from 'immer';
import {
  type NodeId,
  type DataId,
  type GraphId,
  type NodeGraph,
  type Project,
  type ProjectId,
  type ChartNode,
  type DataValue,
  reconcileProjectUiGraphBindings,
} from '@valerypopoff/rivet2-core';
import { blankProject } from '../utils/blankProject.js';
import { entries, values } from '../utils/typeSafety';
import { createHybridStorage } from './storage.js';
import type { ProjectExecutorMode } from '../utils/projectExecutorMode.js';

/** Project context values stored in the IDE and not in the project file. Available in Context nodes. */
export type ProjectContext = Record<
  string,
  {
    value: DataValue;
  }
>;

const { storage } = createHybridStorage('project');

// What's the data of the last loaded project?
export const projectState = atomWithStorage<Omit<Project, 'data'>>(
  'projectState',
  {
    metadata: {
      id: nanoid() as ProjectId,
      description: '',
      title: 'Untitled Project',
    },
    graphs: {},
    plugins: [],
  },
  storage,
);

export const referencedProjectsState = atom<Record<ProjectId, Project>>({});

// The active payload is workspace recovery state, not an authority inferred
// from a global cache that might still belong to a previously selected tab.
export const projectDataState = atomWithStorage<Record<DataId, string> | undefined>(
  'projectDataState',
  undefined,
  storage,
);

export const projectMetadataState = atom(
  (get) => get(projectState).metadata,
  (get, set, newValue: Project['metadata'] | undefined) => {
    set(projectState, {
      ...get(projectState),
      metadata: newValue ?? blankProject().metadata,
    });
  },
);

export const projectGraphInfoState = atom((get) => {
  const project = get(projectState);
  return {
    graphs: Object.fromEntries(
      entries(project.graphs).map(([id, graph]) => [
        id,
        {
          id,
          name: graph.metadata!.name,
          description: graph.metadata!.description,
        },
      ]),
    ),
    metadata: project.metadata,
  };
});

// Which project file was loaded last and where is it?
export const loadedProjectState = atomWithStorage<{
  loaded: boolean;
  path: string | null;
}>(
  'loadedProjectState',
  {
    path: null,
    loaded: false,
  },
  storage,
);

export const savedGraphsState = atom(
  (get) => values(get(projectState).graphs ?? {}),
  (get, set, newValue: NodeGraph[] | ((prev: NodeGraph[]) => NodeGraph[])) => {
    const project = get(projectState);
    const currentGraphs = Object.values(project.graphs ?? {});
    const nextGraphs = typeof newValue === 'function' ? newValue(currentGraphs) : newValue;

    const newProject = produce(project, (draft) => {
      draft.graphs = {};
      for (const graph of nextGraphs) {
        if (graph.metadata == null) {
          graph.metadata = {
            id: nanoid() as GraphId,
            name: 'Untitled graph',
            description: '',
          };
        } else if (graph.metadata.id == null) {
          graph.metadata.id = nanoid() as GraphId;
        }

        draft.graphs[graph.metadata!.id!] = graph;
      }
    });

    set(projectState, replaceProjectGraphs(project, newProject.graphs, project.metadata.mainGraphId));
  },
);

/**
 * Replaces the project's graph collection while keeping graph-owned project
 * metadata valid. Call this for in-place graph collection mutations,
 * including Graph Builder history publication, rather than setting
 * `projectState.graphs` directly.
 */
export function replaceProjectGraphs<TProject extends Project>(
  project: TProject,
  graphs: TProject['graphs'],
  mainGraphId: GraphId | undefined,
): TProject {
  const nextMainGraphId = mainGraphId && graphs[mainGraphId] ? mainGraphId : undefined;
  const nextProject = {
    ...project,
    graphs,
    metadata:
      project.metadata.mainGraphId === nextMainGraphId
        ? project.metadata
        : { ...project.metadata, mainGraphId: nextMainGraphId },
  } as TProject;

  return reconcileProjectUiGraphBindings(project, nextProject);
}

export const projectPluginsState = atom(
  (get) => get(projectState).plugins ?? [],
  (get, set, newValue: Project['plugins'] | ((prev: Project['plugins']) => Project['plugins']) | undefined) => {
    const currentProject = get(projectState);

    const currentPlugins = currentProject.plugins ?? blankProject().plugins;

    const nextPlugins = typeof newValue === 'function' ? newValue(currentPlugins) : newValue ?? blankProject().plugins;

    set(projectState, {
      ...currentProject,
      plugins: nextPlugins,
    });
  },
);

export type OpenedProjectInfo = {
  projectId: ProjectId;
  title: string;
  fsPath?: string | null;
  openedGraph?: GraphId;
  executorMode?: ProjectExecutorMode;
};

export type OpenedProjectSnapshot = {
  project: Omit<Project, 'data'>;
  data?: Project['data'];
};

export type OpenedProjectsInfo = {
  openedProjects: Record<ProjectId, OpenedProjectInfo>;
  openedProjectsSortedIds: ProjectId[];
};

export const projectsState = atomWithStorage<OpenedProjectsInfo>(
  'projectsState',
  {
    openedProjects: {},
    openedProjectsSortedIds: [],
  },
  storage,
);

export const openedProjectSnapshotsState = atomWithStorage<Record<ProjectId, OpenedProjectSnapshot>>(
  'openedProjectSnapshotsState',
  {},
  storage,
);

// Baselines and flags must survive with the recovered workspace, otherwise a
// reload can silently certify unsaved snapshots as the new clean state.
export const savedProjectContentDigestsState = atomWithStorage<Record<ProjectId, string | undefined>>(
  'savedProjectContentDigestsState',
  {},
  storage,
);

export const projectUnsavedChangesState = atomWithStorage<Record<ProjectId, boolean | undefined>>(
  'projectUnsavedChangesState',
  {},
  storage,
);

export const projectDataUnsavedChangesState = atomWithStorage<Record<ProjectId, boolean | undefined>>(
  'projectDataUnsavedChangesState',
  {},
  storage,
);

export const openedProjectsState = atom(
  (get) => get(projectsState).openedProjects,
  (get, set, newValue: Record<ProjectId, OpenedProjectInfo> | undefined) => {
    set(projectsState, {
      ...get(projectsState),
      openedProjects: {
        ...get(projectsState).openedProjects,
        ...newValue,
      },
    });
  },
);

export const openedProjectsSortedIdsState = atom(
  (get) => get(projectsState).openedProjectsSortedIds,
  (get, set, newValue: ProjectId[] | ((prev: ProjectId[]) => ProjectId[]) | undefined) => {
    const currentProjects = get(projectsState);
    const currentIds = currentProjects.openedProjectsSortedIds ?? [];

    const nextIds = typeof newValue === 'function' ? newValue(currentIds) : newValue ?? [];

    set(projectsState, {
      ...currentProjects,
      openedProjectsSortedIds: nextIds,
    });
  },
);

export const projectContextState = atomFamily((projectId: ProjectId) =>
  atomWithStorage<ProjectContext>(`projectContext__"${projectId}"`, {}, storage),
);

export function releaseProjectContextState(projectId: ProjectId): void {
  projectContextState.remove(projectId);
}
