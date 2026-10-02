import { type NodeGraph, type Project, type ExecutionRecorder } from '@valerypopoff/rivet2-core';
import {
  createEmptyEvaluationProjectData,
  deserializeEvaluationProjectData,
  type EvaluationDataset,
  type EvaluationProjectData,
} from '@valerypopoff/rivet2-evaluations';

export type EvaluationProjectFileData = {
  /** Legacy load/import envelope. New saves never write this data to a project. */
  evaluationData: EvaluationProjectData;
  /** Legacy load/import envelope. New saves never write this data to a project. */
  evaluationDatasets: EvaluationDataset[];
};

export type ProjectLoadOptions = {
  signal?: AbortSignal;
  deferCommit?: boolean;
  /** Refresh an inactive snapshot without replacing the live dataset owner. */
  activateDatasets?: boolean;
};
export type LoadedProjectData = {
  project: Project;
  evaluation: EvaluationProjectFileData;
  /** Optional provider preparation, invoked only while this selection is current. */
  commit?: (isCurrent: () => boolean) => Promise<boolean>;
};

/**
 * Evaluation attachments are an optional, one-way migration input. A bad
 * legacy payload must not prevent the project itself from opening or replace
 * the durable local evaluation library.
 */
export function deserializeLegacyEvaluationProjectData(value: unknown): EvaluationProjectData {
  if (value === undefined) return createEmptyEvaluationProjectData();
  try {
    return deserializeEvaluationProjectData(value);
  } catch {
    return createEmptyEvaluationProjectData();
  }
}

/** Base IO interface - all platforms (browser, Tauri, web) support these methods. */
export interface IOProvider {
  /** Download-only providers cannot confirm a completed storage write. */
  readonly projectSaveConfirmation?: 'download-only';
  saveGraphData(graphData: NodeGraph): Promise<void>;

  saveProjectData(project: Project): Promise<string | undefined>;

  loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void>;

  loadProjectData(
    callback: (data: LoadedProjectData & { path: string }) => void | Promise<void>,
    options?: ProjectLoadOptions,
  ): Promise<void>;

  loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void>;

  saveString(content: string, defaultFileName: string): Promise<void>;

  readFileAsString(callback: (data: string, fileName: string) => void): Promise<void>;

  readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void>;
}

/** Extended interface for platforms with path-based file system access (Tauri, Node.js). */
export interface PathBasedIOProvider extends IOProvider {
  /** Returns the canonical persisted path when the storage provider rebases a stale path. */
  saveProjectDataNoPrompt(project: Project, path: string): Promise<string | void>;

  loadProjectDataNoPrompt(path: string, options?: ProjectLoadOptions): Promise<LoadedProjectData>;

  openDirectory(): Promise<string | string[] | null>;

  openFilePath(): Promise<string>;

  readPathAsString(path: string): Promise<string>;

  readPathAsBinary(path: string): Promise<Uint8Array>;
}

/** Type guard to check if an IOProvider supports path-based operations. */
export function isPathBasedIOProvider(provider: IOProvider): provider is PathBasedIOProvider {
  return 'readPathAsString' in provider && 'openFilePath' in provider;
}
