import type { GraphId, NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationDataset, EvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import type { ProjectCompareSideLabels } from '../../state/projectComparison.js';
import type { ProjectTabUiState } from '../../state/projectTabUi.js';
import type { OpeningProjectTabId } from '../../state/openingProjectTabs.js';
import type { ProjectPathMovesInput } from '../../utils/openedProjects.js';
import type { ProjectMetadataPatch } from '../../utils/projectMetadataUpdates.js';
import type { ProjectExecutorMode } from '../../utils/projectExecutorMode.js';

export type RivetProjectSnapshotInput = {
  project: Project | Omit<Project, 'data'>;
  data?: Project['data'];
  path?: string | null;
  openedGraph?: GraphId;
  graphToLoad?: NodeGraph;
  evaluationData?: EvaluationProjectData;
  evaluationDatasets?: EvaluationDataset[];
};

export type MoveProjectPathsInput = ProjectPathMovesInput;

export type RivetProjectCleanBaselineSnapshotInput = {
  project: Project | Omit<Project, 'data'>;
  // Accepted for parity with save/open snapshots. Static data is not included
  // in the content digest, but mark-clean calls clear its dirty flag.
  data?: Project['data'];
};

export type RivetProjectCompareOptions = {
  labels?: ProjectCompareSideLabels;
};

export type RivetProjectTabUiState = ProjectTabUiState;

export type RivetProjectOpenOptions = {
  /** Initial runtime selection for a newly opened virtual project tab. */
  executorMode?: ProjectExecutorMode;
  tabUi?: RivetProjectTabUiState;
};

export type RivetProjectReplaceOptions = RivetProjectOpenOptions;

export type RivetOpeningProjectTabInput = {
  title: string;
  path?: string | null;
};

export type RivetOpeningProjectTabOptions = RivetProjectOpenOptions & {
  replaceCurrent?: boolean;
};

export type RivetOpeningProjectTabHandle = {
  openingTabId: string;
};

export type RivetProjectMetadataUpdateOptions = {
  path?: string | null;
  persistedExternally?: boolean;
  changeSource?: 'external-wrapper-rename';
};

export type RivetProjectMetadataPatch = ProjectMetadataPatch;

export type WorkspaceHostOpenProjectSnapshotOptions = RivetProjectOpenOptions & {
  replaceCurrent?: boolean;
  replaceProjectId?: ProjectId;
  selectedOpeningProjectTabIdToClear?: OpeningProjectTabId | 'all';
};

export type WorkspaceHostOpenProjectSnapshot = (
  snapshot: RivetProjectSnapshotInput,
  options?: WorkspaceHostOpenProjectSnapshotOptions,
) => Promise<boolean>;

export type RivetWorkspaceHost = {
  /**
   * Saves the active project through Rivet's normal workspace transition.
   * Resolves false when no project can be saved, Save As is cancelled, or
   * persistence fails through the normal handled-error path.
   */
  saveCurrentProject(): Promise<boolean>;
  openProjectSnapshot(snapshot: RivetProjectSnapshotInput, options?: RivetProjectOpenOptions): Promise<boolean>;
  openProjectPath(path: string): Promise<boolean>;
  closeProject(projectId?: ProjectId): Promise<boolean>;
  moveProjectPaths(moves: MoveProjectPathsInput): void;
  setProjectTabUiState(projectId: ProjectId, state?: RivetProjectTabUiState): Promise<boolean>;
  startOpeningProjectTab(
    input: RivetOpeningProjectTabInput,
    options?: RivetOpeningProjectTabOptions,
  ): Promise<RivetOpeningProjectTabHandle | false>;
  finishOpeningProjectTab(
    openingTabId: string,
    snapshot: RivetProjectSnapshotInput,
    options?: RivetProjectOpenOptions,
  ): Promise<boolean>;
  cancelOpeningProjectTab(openingTabId: string): Promise<boolean>;
  updateProjectMetadata(
    projectId: ProjectId,
    metadataPatch: RivetProjectMetadataPatch,
    options?: RivetProjectMetadataUpdateOptions,
  ): Promise<boolean>;
  /** Replace an existing active or inactive tab from an externally loaded snapshot. */
  replaceProjectSnapshot(projectId: ProjectId, snapshot: RivetProjectSnapshotInput): Promise<boolean>;
  replaceCurrent(snapshot: RivetProjectSnapshotInput, options?: RivetProjectReplaceOptions): Promise<boolean>;
  markCurrentProjectClean(snapshot?: RivetProjectCleanBaselineSnapshotInput): Promise<boolean>;
  markProjectClean(projectId: ProjectId, snapshot?: RivetProjectCleanBaselineSnapshotInput): Promise<boolean>;
  startProjectCompare(
    referenceProject: Project,
    referencePath?: string | null,
    options?: RivetProjectCompareOptions,
  ): Promise<boolean>;
  stopProjectCompare(projectId?: ProjectId): Promise<boolean>;
};
