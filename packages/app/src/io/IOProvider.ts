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
  saveGraphData(graphData: NodeGraph): Promise<void>;

  saveProjectData(project: Project): Promise<string | undefined>;

  loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void>;

  loadProjectData(callback: (data: { project: Project; evaluation: EvaluationProjectFileData; path: string }) => void): Promise<void>;

  loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void>;

  saveString(content: string, defaultFileName: string): Promise<void>;

  readFileAsString(callback: (data: string, fileName: string) => void): Promise<void>;

  readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void>;
}

/** Extended interface for platforms with path-based file system access (Tauri, Node.js). */
export interface PathBasedIOProvider extends IOProvider {
  saveProjectDataNoPrompt(project: Project, path: string): Promise<void>;

  loadProjectDataNoPrompt(path: string): Promise<{ project: Project; evaluation: EvaluationProjectFileData }>;

  openDirectory(): Promise<string | string[] | null>;

  openFilePath(): Promise<string>;

  readPathAsString(path: string): Promise<string>;

  readPathAsBinary(path: string): Promise<Uint8Array>;
}

/** Type guard to check if an IOProvider supports path-based operations. */
export function isPathBasedIOProvider(provider: IOProvider): provider is PathBasedIOProvider {
  return 'readPathAsString' in provider && 'openFilePath' in provider;
}
