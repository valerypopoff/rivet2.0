import { type NodeGraph, type Project, type ExecutionRecorder } from '@valerypopoff/rivet2-core';
import { type EvaluationDataset, type EvaluationProjectData } from '@valerypopoff/rivet2-evaluations';

export type EvaluationProjectFileData = {
  evaluationData: EvaluationProjectData;
  evaluationDatasets: EvaluationDataset[];
};

/** Base IO interface - all platforms (browser, Tauri, web) support these methods. */
export interface IOProvider {
  saveGraphData(graphData: NodeGraph): Promise<void>;

  saveProjectData(project: Project, evaluation: EvaluationProjectFileData): Promise<string | undefined>;

  loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void>;

  loadProjectData(callback: (data: { project: Project; evaluation: EvaluationProjectFileData; path: string }) => void): Promise<void>;

  loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void>;

  saveString(content: string, defaultFileName: string): Promise<void>;

  readFileAsString(callback: (data: string, fileName: string) => void): Promise<void>;

  readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void>;
}

/** Extended interface for platforms with path-based file system access (Tauri, Node.js). */
export interface PathBasedIOProvider extends IOProvider {
  saveProjectDataNoPrompt(project: Project, evaluation: EvaluationProjectFileData, path: string): Promise<void>;

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
